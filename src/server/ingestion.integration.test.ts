import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { companies, companyIdentifiers, companyJobBoards, companyLocations, contactPoints, ingestionJobs, jobBoardDirectory, osmMatches, osmPlaces, signals, users, workspaces } from "@/db/schema";
import type { SignalAnalysis } from "@/lib/api/types";
import { personSchema } from "@/lib/validation/companies";
import { opportunityExportQuerySchema, opportunityListQuerySchema } from "@/lib/validation/opportunities";
import { serviceSchema } from "@/lib/validation/services";
import { signalSchema, todayIso } from "@/lib/validation/signals";
import { analyzeSignal } from "@/server/ai/signal-analysis";
import { extractWebsiteFacts } from "@/server/ai/website-extract";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { addFoundPeople, resolveCompany } from "@/server/ingestion/resolve";
import { queueChecksNow, runTick } from "@/server/ingestion/worker";
import { systemActor } from "@/server/auth/actor";
import { rescoreCompany } from "@/server/scoring/rescore";
import { registerOwner } from "@/server/services/auth.service";
import { getCompany, listCompanies } from "@/server/services/companies.service";
import { getCompanySources, refreshCompany, setDataSourceEnabled } from "@/server/services/data-sources.service";
import { exportOpportunities } from "@/server/services/exports.service";
import { getOpportunity, listOpportunities } from "@/server/services/opportunities.service";
import { listCompanyPeople, updatePerson } from "@/server/services/people.service";
import { createService } from "@/server/services/services.service";
import { createSignal, listCompanySignals } from "@/server/services/signals.service";
import type { DiscoveryCriteria, FoundCompany } from "@/server/sources";
import { companiesHouse } from "@/server/sources/companies-house";
import { loadDirectory, type CqcLocation } from "@/server/sources/cqc";
import { findWebsite, readWebsite } from "@/server/sources/company-website";
import { parseSearch, searchOrganizations } from "@/server/sources/nppes";
import { searchTenders, type Tender } from "@/server/sources/uk-tenders";

/**
 * The automatic pipeline against the real database (`npm run test:integration`), with every
 * external source and the AI replaced by fakes: from the workspace's Services & ICP alone, it finds
 * companies on the register, adds directors, finds and reads websites, connects job boards and
 * records tender signals; re-runs are idempotent, switched-off sources are skipped, a failing
 * source doesn't block the rest, and other workspaces see nothing.
 */

vi.mock("@/server/sources/companies-house", () => ({
  companiesHouse: { slug: "companies_house", isConfigured: () => true, healthCheck: vi.fn(), discoverCompanies: vi.fn(), findPeople: vi.fn() },
  findCompanyNumber: vi.fn(async () => null),
}));
// The shared job-board step reads the web archive; covered in job-boards.integration.test.ts.
vi.mock("@/server/sources/board-directory", async (original) => ({
  ...(await original<typeof import("@/server/sources/board-directory")>()),
  collectFromArchive: vi.fn(async () => 0),
  validateDueBoards: vi.fn(async () => 0),
}));
vi.mock("@/server/sources/cqc", async (original) => ({
  ...(await original<typeof import("@/server/sources/cqc")>()),
  loadDirectory: vi.fn(async () => []),
  fetchLocationDetail: vi.fn(async () => null),
}));
// Only the network calls are faked; the pure website rules (checks, parsing) run for real.
vi.mock("@/server/sources/company-website", async (original) => ({
  ...(await original<typeof import("@/server/sources/company-website")>()),
  findWebsite: vi.fn(),
  readWebsite: vi.fn(),
}));
vi.mock("@/server/sources/uk-tenders", async (original) => ({
  ...(await original<typeof import("@/server/sources/uk-tenders")>()),
  searchTenders: vi.fn(),
}));
vi.mock("@/server/sources/nppes", async (original) => ({
  ...(await original<typeof import("@/server/sources/nppes")>()),
  searchOrganizations: vi.fn(async () => []),
}));
vi.mock("@/server/ai/signal-analysis", () => ({ analyzeSignal: vi.fn() }));
vi.mock("@/server/ai/website-extract", () => ({ extractWebsiteFacts: vi.fn() }));
vi.mock("@/server/jobs/detect", () => ({ detectBoard: vi.fn(async () => null) }));
vi.mock("@/server/jobs/fetch-jobs", () => ({ fetchBoardJobs: vi.fn(async () => []), MAX_JOBS_PER_BOARD: 500 }));

const run = randomUUID().slice(0, 8);
const number = (n: number) => `T${run.slice(0, 5)}${n}`.slice(0, 8);
let owner: AuthContext;
let other: AuthContext;

const registerCompany = (n: number, name: string, foundedOn: string): FoundCompany => ({
  name,
  domain: null,
  industry: "dental",
  hq: { city: "Leeds", region: null, country: "GB" },
  identifiers: [{ scheme: "gb_company_number", value: number(n) }],
  foundedOn,
  record: {
    sourceSlug: "companies_house",
    externalId: `company:${number(n)}`,
    url: `https://find-and-update.company-information.service.gov.uk/company/${number(n)}`,
    recordType: "company_profile",
    publishedAt: null,
    data: {},
  },
});

const REGISTER = [registerCompany(1, `Newsmile Dental ${run}`, new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10)), registerCompany(2, `Oldtown Dental ${run}`, "2015-04-01")];

const tender: Tender = {
  id: `t-${run}`,
  title: "New website for the council",
  description: "The council requires a new accessible website by March.",
  buyer: `Leeds Test Council ${run}`,
  url: `https://www.contractsfinder.service.gov.uk/notice/t-${run}`,
  publishedAt: new Date(),
  deadline: "2026-12-01",
  valueLow: 40_000,
  valueHigh: 60_000,
  region: "Yorkshire and The Humber",
  postcode: null,
  record: { sourceSlug: "uk_tenders", externalId: `notice:t-${run}`, url: `https://www.contractsfinder.service.gov.uk/notice/t-${run}`, recordType: "tender", publishedAt: new Date(), data: {} },
};

const rfp = (overrides: Partial<SignalAnalysis> = {}): SignalAnalysis => ({
  isSignal: true,
  signalType: "rfp_tender",
  intentLevel: "explicit",
  urgency: "medium",
  serviceCategories: ["web_development"],
  summary: "The council is buying a new website.",
  excerpt: "The council requires a new accessible website by March.",
  evidenceLabel: "observed",
  confidence: 90,
  occurredOn: null,
  model: "fake",
  ...overrides,
});

async function signUp(who: string): Promise<AuthContext> {
  const me = await registerOwner({ name: `Ingest ${who}`, email: `ingest-${who}-${run}@ingest.test`, password: "Ingest-test-1", workspaceName: `Ingest ${who} ${run}` });
  return { userId: me.user.id, workspaceId: me.workspace.id, role: "owner" };
}

/** "Run now", then what the scheduler does: keep ticking until nothing is due. */
async function runNow(auth: AuthContext) {
  await queueChecksNow(auth.workspaceId);
  await drain(auth);
}

async function drain(auth: AuthContext) {
  for (let i = 0; i < 20; i++) {
    const tick = await runTick({ workspaceId: auth.workspaceId, budgetMs: 20_000 });
    if (tick.processed + tick.failed + tick.postponed === 0) return;
  }
}

async function companyNamed(auth: AuthContext, name: string) {
  const list = (await listCompanies(auth, name)).items;
  return list.find((c) => c.name === name);
}

beforeAll(async () => {
  owner = await signUp("owner");
  other = await signUp("other");
  await createService(
    owner,
    serviceSchema.parse({
      name: "Websites",
      description: "",
      categories: ["web_development"],
      // The ICP the automatic search runs from.
      targetIndustries: ["dental"],
      targetJobFunctions: [],
      targetCountries: [],
      companySizeMin: null,
      companySizeMax: null,
    }),
  );
  // Shared job-board discovery is tested in job-boards.integration.test.ts, which runs alongside
  // and fills the shared board tables; this workspace leaves it out so the two don't interfere.
  for (const auth of [owner, other]) await setDataSourceEnabled(auth, "board_directory", false);
});

beforeEach(() => {
  vi.mocked(companiesHouse.discoverCompanies!).mockReset().mockImplementation(async (criteria: DiscoveryCriteria) =>
    REGISTER.filter((c) => !criteria.known.has(c.identifiers[0].value)),
  );
  vi.mocked(companiesHouse.findPeople!).mockReset().mockImplementation(async (company) => ({
    people: [{ name: `Sophie Clarke ${company.identifiers[0].value}`, title: "Director (Dentist)", seniority: "owner", jobFunction: "founder_executive", relationship: "board_member", confidence: 90 }],
    record: { sourceSlug: "companies_house", externalId: `officers:${company.identifiers[0].value}`, url: null, recordType: "officer_list", publishedAt: null, data: {} },
  }));
  // Only the new practice has a website.
  vi.mocked(findWebsite).mockReset().mockImplementation(async (c) => (c.name.startsWith("Newsmile") ? { domain: `newsmile-${run}.example`, confidence: 95 } : null));
  vi.mocked(readWebsite).mockReset().mockImplementation(async (domain) => ({
    domain,
    pages: [{ url: `https://${domain}/team`, kind: "team", text: "Meet Priya Shah, Practice Manager.", contentHash: "h1" }],
    emails: [`hello@${domain}`],
    phones: ["01134960000"],
    jobBoard: { provider: "lever", boardToken: `newsmile${run}` },
    structured: { telephone: null, email: null, employees: null, people: [] },
    checks: { homeUrl: `https://${domain}/`, secure: true, generator: null, booking: null, pagesChecked: [`https://${domain}/team`] },
  }));
  vi.mocked(extractWebsiteFacts).mockReset().mockResolvedValue({ description: "A new family dental practice in Leeds.", team: [{ name: "Priya Shah", title: "Practice Manager" }] });
  vi.mocked(searchTenders).mockReset().mockResolvedValue([tender]);
  vi.mocked(analyzeSignal).mockReset().mockResolvedValue(rfp());
});

afterAll(async () => {
  await db.delete(workspaces).where(inArray(workspaces.id, [owner, other].filter(Boolean).map((c) => c.workspaceId)));
  await db.delete(users).where(inArray(users.id, [owner, other].filter(Boolean).map((c) => c.userId)));
  // The shared board directory isn't workspace data: remove this run's boards too.
  await db.delete(jobBoardDirectory).where(like(jobBoardDirectory.boardToken, `%${run}%`));
});

describe("automatic ingestion", () => {
  it("finds, enriches and scores companies from the ICP alone", async () => {
    await runNow(owner);

    const newsmile = await companyNamed(owner, REGISTER[0].name);
    const oldtown = await companyNamed(owner, REGISTER[1].name);
    expect(newsmile?.discoveredBy).toBe("companies_house");
    expect(oldtown).toBeDefined();

    // Register: directors; website: domain, description, team, contacts, job board.
    const detail = await getCompany(owner, newsmile!.id);
    expect(detail).toMatchObject({ domain: `newsmile-${run}.example`, description: "A new family dental practice in Leeds." });
    expect(detail.people.map((p) => [p.name, p.source]).sort()).toEqual([
      ["Priya Shah", "company_website"],
      [`Sophie Clarke ${number(1)}`, "companies_house"],
    ]);
    expect(detail.people.find((p) => p.name === "Priya Shah")).toMatchObject({ seniority: "manager", jobFunction: "operations", identity: "likely" });
    const [board] = await db.select().from(companyJobBoards).where(eq(companyJobBoards.companyId, newsmile!.id));
    expect(board).toMatchObject({ provider: "lever", autoDetected: true });

    const sources = await getCompanySources(owner, newsmile!.id);
    expect(sources).toMatchObject({ discoveredBy: "companies_house", companyNumber: number(1), website: { confidence: 95, matchedBy: "company_number" } });
    expect(sources.contacts.map((c) => c.value).sort()).toEqual(["01134960000", `hello@newsmile-${run}.example`]);

    // A company formed this year is a new-startup signal, straight from the register.
    const found = await listCompanySignals(owner, newsmile!.id);
    const formation = found.find((s) => s.signalType === "new_startup");
    expect(formation).toMatchObject({ source: "provider", origin: "companies_house" });
    // A dental site without online booking: a possible problem for a website service, by rule, not AI.
    expect(found.find((s) => s.signalType === "no_online_booking")).toMatchObject({
      intentLevel: "low",
      source: "provider",
      origin: "company_website",
      evidenceLabel: "derived",
      confidence: 60,
      serviceCategories: ["web_development"],
    });
    expect((await getCompany(owner, newsmile!.id)).opportunity).not.toBeNull();
    expect(await listCompanySignals(owner, oldtown!.id)).toEqual([]);

    // The tender's buyer becomes a company with an explicit RFP signal.
    const council = await companyNamed(owner, tender.buyer);
    const [rfpSignal] = await listCompanySignals(owner, council!.id);
    expect(rfpSignal).toMatchObject({ signalType: "rfp_tender", intentLevel: "explicit", origin: "uk_tenders", evidence: { sourceUrl: tender.url } });

    // No job hit an error, including ones queued again for a retry (which aren't marked failed).
    const errors = await db
      .select({ kind: ingestionJobs.kind, error: ingestionJobs.lastError })
      .from(ingestionJobs)
      .where(and(eq(ingestionJobs.workspaceId, owner.workspaceId), isNotNull(ingestionJobs.lastError)));
    expect(errors).toEqual([]);
  });

  it("adds nothing twice when it runs again", async () => {
    const before = (await listCompanies(owner)).total;
    await runNow(owner);

    expect((await listCompanies(owner)).total).toBe(before);
    expect(analyzeSignal).not.toHaveBeenCalled(); // the tender was analysed last time
    const identifiers = await db.select().from(companyIdentifiers).where(eq(companyIdentifiers.workspaceId, owner.workspaceId));
    expect(identifiers).toHaveLength(2);
  });

  it("runs again by itself a day after the last run, not before", async () => {
    await drain(owner);
    const queued = await db
      .select()
      .from(ingestionJobs)
      .where(and(eq(ingestionJobs.workspaceId, owner.workspaceId), eq(ingestionJobs.kind, "discover_companies"), eq(ingestionJobs.status, "queued")));
    expect(queued).toHaveLength(1);
    expect(queued[0].runAfter.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it("replaces the website's contacts when it is read again, never keeping a placeholder", async () => {
    const newsmile = await companyNamed(owner, REGISTER[0].name);
    const domain = `newsmile-${run}.example`;
    const usual = vi.mocked(readWebsite).getMockImplementation()!;
    vi.mocked(readWebsite).mockImplementation(async (d) => ({
      ...(await usual(d))!,
      // The site changed its address; a template leftover is on the page too.
      emails: [`info@${domain}`, "changeme@client-domain.co.uk"],
      phones: [],
    }));
    await refreshCompany(owner, newsmile!.id);
    await drain(owner);
    vi.mocked(readWebsite).mockImplementation(usual);
    const sources = await getCompanySources(owner, newsmile!.id);
    // The old hello@ is gone; the phone stays, since this read found none rather than a new one.
    expect(sources.contacts.map((c) => c.value).sort()).toEqual(["01134960000", `info@${domain}`]);
  });

  it("skips a source the workspace switched off", async () => {
    await setDataSourceEnabled(owner, "uk_tenders", false);
    await runNow(owner);
    expect(searchTenders).not.toHaveBeenCalled();
    await setDataSourceEnabled(owner, "uk_tenders", true);
  });

  it("keeps going when one source fails, and retries it later", async () => {
    vi.mocked(companiesHouse.discoverCompanies!).mockResolvedValue([registerCompany(3, `Thirdway Dental ${run}`, "2018-01-01")]);
    vi.mocked(findWebsite).mockResolvedValue({ domain: `thirdway-${run}.example`, confidence: 95 });
    vi.mocked(readWebsite).mockRejectedValue(new Error("Site is down"));

    await runNow(owner);

    const thirdway = await companyNamed(owner, `Thirdway Dental ${run}`);
    expect((await getCompany(owner, thirdway!.id)).people).toHaveLength(1); // the register still worked
    const [websiteJob] = await db
      .select()
      .from(ingestionJobs)
      .where(and(eq(ingestionJobs.entityId, thirdway!.id), eq(ingestionJobs.kind, "scan_website")));
    expect(websiteJob).toMatchObject({ status: "queued", lastError: "Site is down", attempts: 1 });
  });

  it("keeps found companies private to the workspace", async () => {
    const council = await companyNamed(owner, tender.buyer);
    await expect(getCompanySources(other, council!.id)).rejects.toSatisfy((e) => e instanceof AppError && e.code === "NOT_FOUND");
    // The other workspace has no services, so nothing is searched for it.
    await runNow(other);
    expect((await listCompanies(other)).items).toEqual([]);
    expect(await db.select().from(companies).where(eq(companies.workspaceId, other.workspaceId))).toEqual([]);
  });
});

describe("matching found companies and people", () => {
  /** A found company with no registry number, as a non-register source would give it. */
  const found = (name: string, postalCode: string | null, sourceSlug: FoundCompany["record"]["sourceSlug"], externalId: string): FoundCompany => ({
    name,
    domain: null,
    industry: null,
    hq: { city: "Leeds", region: null, country: "GB", postalCode },
    identifiers: [],
    foundedOn: null,
    record: { sourceSlug, externalId, url: null, recordType: "test", publishedAt: null, data: {} },
  });
  const resolve = (company: FoundCompany) => db.transaction((tx) => resolveCompany(tx, systemActor(owner.workspaceId), company));

  it("matches a name only together with the same postcode, and starts unregistered companies provisional", async () => {
    const first = await resolve(found(`Harbour Dental ${run}`, "LS1 4AP", "company_website", `a-${run}`));
    expect(first.created).toBe(true);
    const [row] = await db.select({ identity: companies.identityStatus }).from(companies).where(eq(companies.id, first.companyId));
    expect(row.identity).toBe("provisional");

    // Same name and postcode from another source: the same company.
    expect((await resolve(found(`Harbour Dental ${run}`, "ls14ap", "uk_tenders", `b-${run}`))).companyId).toBe(first.companyId);
    // Same name, different postcode: a different business.
    expect((await resolve(found(`Harbour Dental ${run}`, "M1 1AA", "uk_tenders", `c-${run}`))).created).toBe(true);
  });

  it("merges nothing when a name and postcode fit more than one company", async () => {
    const name = `Twin Clinic ${run}`;
    const a = await resolve(found(name, "B1 1AA", "company_website", `d-${run}`));
    const b = await resolve(found(name, "B1 1AA", "uk_tenders", `e-${run}`)); // matched to a
    expect(b.companyId).toBe(a.companyId);
    // A second, separate company with that name and postcode (added by hand), then a third sighting.
    const [manual] = await db.insert(companies).values({ workspaceId: owner.workspaceId, canonicalName: name }).returning({ id: companies.id });
    await db.insert(companyLocations).values({ companyId: manual.id, type: "headquarters", postalCode: "B1 1AA" });
    const third = await resolve(found(name, "B1 1AA", "board_directory", `f-${run}`));
    expect(third.created).toBe(true);
    expect([a.companyId, manual.id]).not.toContain(third.companyId);
  });

  it("never merges people on name alone across sources, but doesn't repeat a source's own person", async () => {
    const { companyId } = await resolve(found(`People Co ${run}`, "LS2 9JT", "company_website", `g-${run}`));
    const person = { name: "Alex Smith", title: "Director", seniority: "owner" as const, jobFunction: null, relationship: "board_member" as const, confidence: 90 };
    const add = (source: "companies_house" | "company_website") => db.transaction((tx) => addFoundPeople(tx, systemActor(owner.workspaceId), companyId, [person], source));
    expect(await add("companies_house")).toBe(1);
    expect(await add("companies_house")).toBe(0); // the same source again
    expect(await add("company_website")).toBe(1); // same name, another source: kept separate
  });

  it("keeps an inferred email unverified, until a person saves it as their own", async () => {
    const { companyId } = await resolve(found(`Email Co ${run}`, "LS3 1AA", "company_website", `h-${run}`));
    await db.transaction((tx) =>
      addFoundPeople(tx, systemActor(owner.workspaceId), companyId, [{ name: "Priya Shah", title: "Practice Manager", seniority: "manager", jobFunction: null, relationship: "employee", confidence: 80 }], "company_website"),
    );
    const [priya] = await listCompanyPeople(owner, companyId);
    await db.insert(contactPoints).values({ personId: priya.id, type: "email", value: "priya.shah@email-co.example", isPrimary: true, verification: "unknown", source: "pattern_inferred" });
    expect((await listCompanyPeople(owner, companyId))[0].emailVerification).toEqual({ state: "unknown", checkedAt: null, origin: "inferred" });

    // Saving the person with the same address (as the form does) works and makes it theirs.
    await updatePerson(
      owner,
      companyId,
      priya.id,
      personSchema.parse({ name: "Priya Shah", title: "Practice Manager", seniority: "manager", jobFunction: null, relationship: "employee", email: "priya.shah@email-co.example", phone: null, professionalUrl: null, location: null }),
    );
    const emails = await db.select().from(contactPoints).where(and(eq(contactPoints.personId, priya.id), eq(contactPoints.type, "email")));
    expect(emails.map((e) => [e.source, e.isPrimary])).toEqual([["manual", true]]);
  });
});

describe("CQC providers and their practices", () => {
  const practice = (locationId: string, name: string, postcode: string, website: string | null): CqcLocation => ({
    locationId: `${locationId}-${run}`,
    providerId: `1-prov-${run}`,
    name,
    address: `1 High Street,${name.split(" ")[0]}`,
    postcode,
    phone: "01134960000",
    website,
    serviceTypes: ["Dentist"],
    providerName: `Smiles Group ${run} Ltd`,
    localAuthority: "Leeds",
    region: "Yorkshire & Humberside",
    url: `https://www.cqc.org.uk/location/${locationId}`,
  });

  it("makes one company per provider, with each practice as its own location, and doesn't repeat on re-runs", async () => {
    vi.mocked(loadDirectory).mockResolvedValue([
      practice("1-a", "Smiles Leeds", "LS1 4AP", `smiles-leeds-${run}.example`),
      practice("1-b", "Smiles York", "YO1 7HH", `smiles-york-${run}.example`),
    ]);
    await runNow(owner);
    await runNow(owner); // a second run must not duplicate anything

    const found = (await listCompanies(owner, `Smiles Group ${run}`)).items[0];
    expect(found).toMatchObject({ discoveredBy: "cqc" });
    const detail = await getCompany(owner, found.id);
    // Practices list different websites, so the provider itself gets none.
    expect(detail.domain).toBeNull();
    const sites = await db.select().from(companyLocations).where(eq(companyLocations.companyId, found.id));
    expect(sites.map((l) => [l.name, l.website, l.postalCode, l.type]).sort()).toEqual([
      ["Smiles Leeds", `smiles-leeds-${run}.example`, "LS1 4AP", "branch"],
      ["Smiles York", `smiles-york-${run}.example`, "YO1 7HH", "branch"],
    ]);
    const [row] = await db.select({ identity: companies.identityStatus }).from(companies).where(eq(companies.id, found.id));
    expect(row.identity).toBe("verified");

    // No person is known yet, but the practice phone is a way in: shown on the opportunity and exported.
    await createSignal(
      owner,
      found.id,
      signalSchema.parse({
        signalType: "service_request",
        intentLevel: "explicit",
        urgency: "high",
        serviceCategories: ["staff_augmentation"],
        summary: "Wants extra developers.",
        personId: null,
        occurredOn: todayIso(),
        sourceUrl: null,
        excerpt: null,
        evidenceLabel: "observed",
        source: "manual",
        confidence: null,
      }),
    );
    await rescoreCompany(owner.workspaceId, found.id);
    const listed = (await listOpportunities(owner, opportunityListQuerySchema.parse({ group: "open", q: `Smiles Group ${run}` }))).items[0];
    expect(listed.companyContact).toEqual({ phone: "01134960000", email: null, fromOpenStreetMap: false });
    const opportunity = await getOpportunity(owner, listed.id);
    // Both practices share one number: listed once, named after its practice, credited to CQC.
    expect(opportunity.companyContacts).toEqual([
      { type: "phone", value: "01134960000", label: "Smiles Leeds", source: "cqc", url: `smiles-leeds-${run}.example` },
    ]);
    const { csv } = await exportOpportunities(owner, opportunityExportQuerySchema.parse({ group: "open", q: `Smiles Group ${run}` }));
    // Only what a salesperson works from, as on the Leads page.
    // (The file starts with a byte-order mark, so Excel reads it as UTF-8.)
    expect(csv.replace(/^﻿/, "").split(/\r?\n/)[0]).toBe("company,website,contact_name,contact_title,phone,email,contact_type,matched_service,signal,signal_link,status,latest_signal_date");
    expect(csv).toContain("Company line");
    expect(csv).toContain("01134960000");
    vi.mocked(loadDirectory).mockResolvedValue([]);
  });

  it("gives a chain the website most practices list, and records a practice it opens later as a signal", async () => {
    const chain = (id: string, name: string, website: string | null, serviceTypes = ["Dentist"]): CqcLocation => ({
      ...practice(id, name, "LS2 7EE", website),
      providerId: `2-prov-${run}`,
      providerName: `Brightway Dental ${run} Ltd`,
      serviceTypes,
    });
    const site = `brightway-${run}.example`;
    const opening = [chain("2-a", "Brightway Leeds", site), chain("2-b", "Brightway Otley", site), chain("2-c", "Otley Smiles", `otley-${run}.example`)];
    vi.mocked(loadDirectory).mockResolvedValue(opening);
    await runNow(owner);
    const found = (await listCompanies(owner, `Brightway Dental ${run}`)).items[0];
    expect(found.domain).toBe(site);
    const signalsOf = () => db.select({ type: signals.signalType, summary: signals.summary }).from(signals).where(eq(signals.companyId, found.id));
    expect((await signalsOf()).filter((s) => s.type === "new_location")).toEqual([]);

    // Next week: one new dental practice, plus a care home that was never part of the ICP.
    vi.mocked(loadDirectory).mockResolvedValue([...opening, chain("2-d", "Brightway Ilkley", site), chain("2-e", "Brightway Care Home", null, ["Residential homes"])]);
    await runNow(owner);
    await runNow(owner); // seen once, signalled once
    const opened = (await signalsOf()).filter((s) => s.type === "new_location");
    expect(opened).toHaveLength(1);
    expect(opened[0].summary).toContain("Brightway Ilkley");
    const sites = await db.select({ name: companyLocations.name }).from(companyLocations).where(eq(companyLocations.companyId, found.id));
    expect(sites.map((s) => s.name).sort()).toEqual(["Brightway Ilkley", "Brightway Leeds", "Brightway Otley", "Otley Smiles"]);
    vi.mocked(loadDirectory).mockResolvedValue([]);
  });
});

describe("OpenStreetMap contacts", () => {
  const ids = [1, 2, 3].map((n) => 9_000_000_000 + Number.parseInt(run.slice(0, 6), 16) * 10 + n);
  const practice = (id: string, name: string, postcode: string, phone: string | null): CqcLocation => ({
    locationId: `${id}-${run}`,
    providerId: `3-prov-${run}`,
    name,
    address: `2 Market Place,${name.split(" ")[1]}`,
    postcode,
    phone,
    website: null,
    serviceTypes: ["Dentist"],
    providerName: `Osmwell Dental ${run} Ltd`,
    localAuthority: null,
    region: "Yorkshire & Humberside",
    url: null,
  });
  const place = (osmId: number, values: Partial<typeof osmPlaces.$inferInsert>) => ({ osmType: "node", osmId, name: "x", category: "amenity=dentist", ...values });

  afterAll(async () => {
    await db.delete(osmPlaces).where(inArray(osmPlaces.osmId, ids));
  });

  it("adds what OpenStreetMap publishes for each practice, after the company's own contacts, credited and never merged", async () => {
    vi.mocked(loadDirectory).mockResolvedValue([
      practice("3-a", "Osmwell Harrogate", "HG1 1AA", "01423111111"),
      practice("3-b", "Osmwell Ripon", "HG4 1AB", null),
    ]);
    await db.insert(osmPlaces).values([
      // Carries the Harrogate practice's CQC id: an exact link, whatever its name.
      place(ids[0], { name: "Harrogate Smile Studio", cqcLocationRef: `3-a-${run}`, phone: "01423999999", email: `info@osmwell-${run}.example` }),
      // Same postcode and name as the Ripon practice, which has no phone of its own.
      place(ids[1], { name: `Osmwell Dental Ripon`, postcode: "HG41AB", phone: "01765222222" }),
      // Same postcode, another business: not linked.
      place(ids[2], { name: "Ripon Family Dentists", postcode: "HG41AB", phone: "01765333333" }),
    ]);
    await runNow(owner); // discovers the provider, then the daily OSM match runs

    const found = (await listCompanies(owner, `Osmwell Dental ${run}`)).items[0];
    const links = await db.select().from(osmMatches).where(eq(osmMatches.companyId, found.id));
    expect(links.map((l) => [l.osmId, l.method, l.verification]).sort()).toEqual([
      [ids[0], "cqc_ref", "unknown"],
      [ids[1], "postcode_name", "unknown"],
    ]);
    // Two practices, two links: each keeps its own place.
    expect(new Set(links.map((l) => l.companyLocationId)).size).toBe(2);
    // Nothing from OSM is written into our own records.
    const sites = await db.select({ phone: companyLocations.phone }).from(companyLocations).where(eq(companyLocations.companyId, found.id));
    expect(sites.map((s) => s.phone).sort()).toEqual(["01423111111", null]);
    const sources = await getCompanySources(owner, found.id);
    expect(sources.contacts).toEqual([]);
    expect(sources.openStreetMap.map((p) => p.url).sort()).toEqual(ids.slice(0, 2).map((id) => `https://www.openstreetmap.org/node/${id}`).sort());

    // On the opportunity: the CQC phone first; the email exists only on OSM, so it is shown and credited.
    await createSignal(
      owner,
      found.id,
      signalSchema.parse({
        signalType: "service_request",
        intentLevel: "explicit",
        urgency: "high",
        serviceCategories: ["staff_augmentation"],
        summary: "Wants a new website.",
        personId: null,
        occurredOn: todayIso(),
        sourceUrl: null,
        excerpt: null,
        evidenceLabel: "observed",
        source: "manual",
        confidence: null,
      }),
    );
    await rescoreCompany(owner.workspaceId, found.id);
    const query = { group: "open" as const, q: `Osmwell Dental ${run}` };
    const listed = (await listOpportunities(owner, opportunityListQuerySchema.parse(query))).items[0];
    expect(listed.companyContact).toEqual({ phone: "01423111111", email: `info@osmwell-${run}.example`, fromOpenStreetMap: true });
    const detail = await getOpportunity(owner, listed.id);
    expect(detail.companyContacts.filter((c) => c.source === "openstreetmap").map((c) => [c.type, c.value]).sort()).toEqual([
      ["email", `info@osmwell-${run}.example`],
      ["phone", "01423999999"],
      ["phone", "01765222222"],
    ]);
    const { csv } = await exportOpportunities(owner, opportunityExportQuerySchema.parse(query));
    expect(csv).toContain("© OpenStreetMap contributors");

    // A place gone from the latest extract stops matching.
    await db.update(osmPlaces).set({ removedAt: new Date() }).where(eq(osmPlaces.osmId, ids[1]));
    await runNow(owner);
    expect((await db.select().from(osmMatches).where(eq(osmMatches.companyId, found.id))).map((l) => l.osmId)).toEqual([ids[0]]);
    // Another workspace has no links of its own.
    expect(await db.select().from(osmMatches).where(eq(osmMatches.workspaceId, other.workspaceId))).toEqual([]);
    vi.mocked(loadDirectory).mockResolvedValue([]);
  });
});

describe("US NPI Registry", () => {
  const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const org = (number: string, name: string, enumerated: string, taxonomy = "1223G0001X") => ({
    number,
    enumeration_type: "NPI-2",
    basic: {
      organization_name: name,
      enumeration_date: enumerated,
      status: "A",
      authorized_official_first_name: "MARIA",
      authorized_official_last_name: `GARCIA${number.slice(-3)}`,
      authorized_official_title_or_position: "Owner",
      authorized_official_telephone_number: "5125550142",
    },
    addresses: [{ address_purpose: "LOCATION", address_1: "100 CONGRESS AVE", city: "AUSTIN", state: "TX", postal_code: "787011234", telephone_number: "512-555-0100" }],
    taxonomies: [{ code: taxonomy, desc: "Dentist, General Practice", primary: true }],
  });

  it("adds new US practices with their phone and authorized official, a new-practice signal, and nothing twice", async () => {
    const number = (n: number) => `19${run.replace(/\D/g, "").padEnd(7, "0").slice(0, 7)}${n}`;
    vi.mocked(searchOrganizations).mockResolvedValueOnce(
      parseSearch({
        results: [
          org(number(1), `LONE STAR SMILES ${run} PLLC`, recent),
          org(number(2), `OLD TOWN DENTAL ${run} PA`, "2009-03-01"),
          // A pharmacy listed under a dental search: not a dental practice.
          org(number(3), `CORNER PHARMACY ${run}`, recent, "3336C0003X"),
        ],
      }),
    );
    await runNow(owner);
    await runNow(owner); // nothing twice

    const found = (await listCompanies(owner, `Lone Star Smiles ${run}`)).items;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ discoveredBy: "us_npi", headquarters: { city: "Austin", country: "US" } });
    expect((await listCompanies(owner, `Corner Pharmacy ${run}`)).total).toBe(0);

    const detail = await getCompany(owner, found[0].id);
    expect(detail.people).toMatchObject([{ name: `Maria Garcia${number(1).slice(-3)}`, title: "Owner", phone: "512-555-0142", source: "us_npi" }]);
    const [site] = await db.select().from(companyLocations).where(and(eq(companyLocations.companyId, found[0].id), eq(companyLocations.sourceSlug, "us_npi")));
    expect(site).toMatchObject({ phone: "512-555-0100", postalCode: "78701", country: "US", externalId: number(1) });

    // Registered last month: a new practice. The 2009 one is not.
    const [signal] = await listCompanySignals(owner, found[0].id);
    expect(signal).toMatchObject({ signalType: "new_startup", origin: "us_npi" });
    expect(signal.summary).toContain("with the US NPI Registry");
    const old = (await listCompanies(owner, `Old Town Dental ${run}`)).items[0];
    expect(await listCompanySignals(owner, old.id)).toEqual([]);
    expect((await getCompany(owner, found[0].id)).opportunity).not.toBeNull();
  });
});
