import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { companies, companyIdentifiers, companyJobBoards, ingestionJobs, users, workspaces } from "@/db/schema";
import type { SignalAnalysis } from "@/lib/api/types";
import { serviceSchema } from "@/lib/validation/services";
import { analyzeSignal } from "@/server/ai/signal-analysis";
import { extractWebsiteFacts } from "@/server/ai/website-extract";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { queueChecksNow, runTick } from "@/server/ingestion/worker";
import { registerOwner } from "@/server/services/auth.service";
import { getCompany, listCompanies } from "@/server/services/companies.service";
import { getCompanySources, setDataSourceEnabled } from "@/server/services/data-sources.service";
import { createService } from "@/server/services/services.service";
import { listCompanySignals } from "@/server/services/signals.service";
import type { DiscoveryCriteria, FoundCompany } from "@/server/sources";
import { companiesHouse } from "@/server/sources/companies-house";
import { findWebsite, readWebsite } from "@/server/sources/company-website";
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
}));
vi.mock("@/server/sources/company-website", () => ({
  companyWebsite: { slug: "company_website", isConfigured: () => true, healthCheck: vi.fn() },
  findWebsite: vi.fn(),
  readWebsite: vi.fn(),
}));
vi.mock("@/server/sources/uk-tenders", async (original) => ({
  ...(await original<typeof import("@/server/sources/uk-tenders")>()),
  searchTenders: vi.fn(),
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
  const list = await listCompanies(auth, name);
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
  }));
  vi.mocked(extractWebsiteFacts).mockReset().mockResolvedValue({ description: "A new family dental practice in Leeds.", team: [{ name: "Priya Shah", title: "Practice Manager" }] });
  vi.mocked(searchTenders).mockReset().mockResolvedValue([tender]);
  vi.mocked(analyzeSignal).mockReset().mockResolvedValue(rfp());
});

afterAll(async () => {
  await db.delete(workspaces).where(inArray(workspaces.id, [owner, other].filter(Boolean).map((c) => c.workspaceId)));
  await db.delete(users).where(inArray(users.id, [owner, other].filter(Boolean).map((c) => c.userId)));
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
    const [formation] = await listCompanySignals(owner, newsmile!.id);
    expect(formation).toMatchObject({ signalType: "new_startup", source: "provider", origin: "companies_house" });
    expect((await getCompany(owner, newsmile!.id)).opportunity).not.toBeNull();
    expect(await listCompanySignals(owner, oldtown!.id)).toEqual([]);

    // The tender's buyer becomes a company with an explicit RFP signal.
    const council = await companyNamed(owner, tender.buyer);
    const [rfpSignal] = await listCompanySignals(owner, council!.id);
    expect(rfpSignal).toMatchObject({ signalType: "rfp_tender", intentLevel: "explicit", origin: "uk_tenders", evidence: { sourceUrl: tender.url } });

    const failed = await db.select().from(ingestionJobs).where(and(eq(ingestionJobs.workspaceId, owner.workspaceId), eq(ingestionJobs.status, "failed")));
    expect(failed).toEqual([]);
  });

  it("adds nothing twice when it runs again", async () => {
    const before = (await listCompanies(owner)).length;
    await runNow(owner);

    expect((await listCompanies(owner)).length).toBe(before);
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
    expect(await listCompanies(other)).toEqual([]);
    expect(await db.select().from(companies).where(eq(companies.workspaceId, other.workspaceId))).toEqual([]);
  });
});
