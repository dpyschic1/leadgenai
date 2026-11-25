import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { boardJobs, companies, companyContactPoints, companyJobBoards, jobBoardDirectory, jobPostings, opportunities, signalEvidence, signals, users, workspaces } from "@/db/schema";
import { companySchema, personSchema } from "@/lib/validation/companies";
import { feedbackSchema } from "@/lib/validation/feedback";
import { leadContactsQuerySchema, leadListQuerySchema, opportunityExportQuerySchema, opportunityListQuerySchema } from "@/lib/validation/opportunities";
import { serviceSchema } from "@/lib/validation/services";
import { signalSchema } from "@/lib/validation/signals";
import type { AuthContext } from "@/server/auth/session";
import { rescoreCompany } from "@/server/scoring/rescore";
import { registerOwner } from "@/server/services/auth.service";
import { createCompany, listCompanies } from "@/server/services/companies.service";
import { exportOpportunities } from "@/server/services/exports.service";
import { giveFeedback } from "@/server/services/feedback.service";
import { listLeadContacts, listLeads, listOpportunities, updateOpportunity } from "@/server/services/opportunities.service";
import { intakeStageId, listPipeline } from "@/server/services/pipeline.service";
import { addPerson } from "@/server/services/people.service";
import { createService, listServices, updateService } from "@/server/services/services.service";
import { createSignal } from "@/server/services/signals.service";

/**
 * Feed filters (PRD §22) against the real database (`npm run test:integration`): every filter
 * narrows the feed and the tab counts, and the CSV export follows them. Removes what it creates.
 */

const run = randomUUID().slice(0, 8);
let auth: AuthContext;
let webServiceId: string;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** Three companies that differ in every filterable way. */
const COMPANIES = [
  {
    name: "Northbridge Legal",
    industry: "legal",
    country: "GB",
    signal: { signalType: "service_request", intentLevel: "explicit", urgency: "high", serviceCategories: ["web_development"], days: 2 },
  },
  {
    name: "Medisync Health",
    industry: "healthcare",
    country: "US",
    signal: { signalType: "engineering_hiring", intentLevel: "high", urgency: "low", serviceCategories: ["staff_augmentation"], days: 60 },
  },
  {
    name: "Ledgerline",
    industry: "accounting",
    country: "GB",
    signal: { signalType: "funding", intentLevel: "medium", urgency: "medium", serviceCategories: ["mvp_development"], days: 10 },
  },
] as const;

const feed = async (filters: Record<string, unknown>) =>
  (await listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open", ...filters }))).items
    .map((item) => item.company?.name)
    .sort();

beforeAll(async () => {
  const me = await registerOwner({
    name: "Filter Owner",
    email: `filters-${run}@filters.test`,
    password: "Filters-test-1",
    workspaceName: `Filters ${run}`,
  });
  auth = { userId: me.user.id, workspaceId: me.workspace.id, role: "owner" };

  const service = (name: string, categories: string[]) =>
    serviceSchema.parse({
      name,
      description: "",
      categories,
      targetIndustries: [],
      targetJobFunctions: [],
      targetCountries: [],
      companySizeMin: null,
      companySizeMax: null,
    });
  webServiceId = (await createService(auth, service("Website redesign", ["web_development"]))).id;
  await createService(auth, service("Dedicated developers", ["staff_augmentation"]));

  for (const c of COMPANIES) {
    const company = await createCompany(
      auth,
      companySchema.parse({
        name: c.name,
        domain: `${c.name.toLowerCase().replace(/\W+/g, "")}-${run}.example`,
        industry: c.industry,
        employeeCount: 50,
        description: null,
        hqCity: null,
        hqRegion: null,
        hqCountry: c.country,
      }),
    );
    await createSignal(
      auth,
      company.id,
      signalSchema.parse({
        signalType: c.signal.signalType,
        intentLevel: c.signal.intentLevel,
        urgency: c.signal.urgency,
        serviceCategories: c.signal.serviceCategories,
        summary: `${c.name} signal.`,
        personId: null,
        occurredOn: daysAgo(c.signal.days),
        sourceUrl: null,
        excerpt: null,
        evidenceLabel: "observed",
        source: "manual",
        confidence: null,
      }),
    );
    await rescoreCompany(auth.workspaceId, company.id);
  }
});

afterAll(async () => {
  if (!auth) return;
  await db.delete(workspaces).where(inArray(workspaces.id, [auth.workspaceId]));
  await db.delete(users).where(inArray(users.id, [auth.userId]));
});

describe("feed filters", () => {
  it("show everything when empty", async () => {
    expect(await feed({})).toEqual(["Ledgerline", "Medisync Health", "Northbridge Legal"]);
  });

  it("filter by headquarters country and industry", async () => {
    expect(await feed({ countries: "GB" })).toEqual(["Ledgerline", "Northbridge Legal"]);
    expect(await feed({ industries: "healthcare,legal" })).toEqual(["Medisync Health", "Northbridge Legal"]);
  });

  it("filter by signal category", async () => {
    expect(await feed({ signals: "workforce" })).toEqual(["Medisync Health"]);
    expect(await feed({ signals: "company_event,explicit_buying" })).toEqual(["Ledgerline", "Northbridge Legal"]);
  });

  it("filter by urgency, recency and score", async () => {
    expect(await feed({ urgency: "high" })).toEqual(["Northbridge Legal"]);
    expect(await feed({ withinDays: 30 })).toEqual(["Ledgerline", "Northbridge Legal"]);
    const scores = (await listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open" }))).items.map((i) => i.score!);
    const cutoff = Math.max(...scores);
    expect(await feed({ minScore: cutoff })).toHaveLength(scores.filter((s) => s >= cutoff).length);
  });

  it("filter by matched service and opportunity type", async () => {
    expect(await feed({ services: webServiceId })).toEqual(["Northbridge Legal"]);
    expect(await feed({ types: "staff_augmentation" })).toEqual(["Medisync Health"]);
  });

  it("combine filters, each one narrowing the result", async () => {
    expect(await feed({ countries: "GB", urgency: "medium" })).toEqual(["Ledgerline"]);
    expect(await feed({ countries: "US", urgency: "high" })).toEqual([]);
  });

  it("are counted in the status tabs", async () => {
    const list = await listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open", countries: "GB" }));
    expect(list.counts.open).toBe(2);
  });

  it("are followed by the CSV export", async () => {
    const { count, csv } = await exportOpportunities(auth, opportunityExportQuerySchema.parse({ group: "open", signals: "workforce" }));
    expect(count).toBe(1);
    expect(csv).toContain("Medisync Health");
    expect(csv).not.toContain("Northbridge Legal");
  });
});

describe("pagination", () => {
  const openPage = (page: number, pageSize: number) =>
    listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open", page: String(page), pageSize: String(pageSize) }));

  it("splits the feed into pages that neither overlap nor skip, in priority order", async () => {
    const all = await openPage(1, 100);
    expect(all.total).toBeGreaterThan(2);
    expect(all.total).toBe(all.counts.open);
    const pages = [];
    for (let page = 1; page <= Math.ceil(all.total / 2); page++) {
      const result = await openPage(page, 2);
      expect(result).toMatchObject({ page, pageSize: 2, total: all.total });
      pages.push(...result.items.map((i) => i.id));
    }
    expect(pages).toEqual(all.items.map((i) => i.id));
    // Past the end: no rows, but the total still says where the list ends.
    expect(await openPage(99, 2)).toMatchObject({ items: [], total: all.total });
  });

  it("still exports every matching opportunity, not one page", async () => {
    const { count } = await exportOpportunities(auth, opportunityExportQuerySchema.parse({ group: "open" }));
    expect(count).toBe((await openPage(1, 100)).total);
  });

  it("pages companies and services the same way", async () => {
    const all = await listCompanies(auth, undefined, { page: 1, pageSize: 100 });
    const first = await listCompanies(auth, undefined, { page: 1, pageSize: 2 });
    const second = await listCompanies(auth, undefined, { page: 2, pageSize: 2 });
    expect(first.total).toBe(all.total);
    expect([...first.items, ...second.items].map((c) => c.id)).toEqual(all.items.slice(0, 4).map((c) => c.id));
    const services = await listServices(auth, { page: 1, pageSize: 1 });
    expect(services.items).toHaveLength(1);
    expect(services.total).toBeGreaterThanOrEqual(1);
  });

  it("rejects a page size over the limit", () => {
    expect(() => opportunityListQuerySchema.parse({ pageSize: "500" })).toThrow();
  });
});

describe("contacts and the Leads page", () => {
  const ids = new Map<string, string>();

  beforeAll(async () => {
    for (const company of (await listCompanies(auth, undefined, { page: 1, pageSize: 100 })).items) ids.set(company.name, company.id);
    // Northbridge: a named person with an email. Ledgerline: only the company's own line. Medisync: nothing.
    await addPerson(
      auth,
      ids.get("Northbridge Legal")!,
      personSchema.parse({
        name: "James Whitaker",
        title: "Managing Partner",
        seniority: "owner",
        jobFunction: null,
        relationship: "employee",
        email: `james-${run}@northbridge.example`,
        phone: null,
        professionalUrl: null,
        location: null,
        identity: "likely",
        emailVerification: "unknown",
      }),
    );
    await db.insert(companyContactPoints).values({ companyId: ids.get("Ledgerline")!, type: "phone", value: "0113 496 0000", sourceSlug: "company_website" });
    // Medisync has no contact, but its signal links to where it was found.
    await createSignal(
      auth,
      ids.get("Medisync Health")!,
      signalSchema.parse({
        signalType: "engineering_hiring",
        intentLevel: "high",
        urgency: "medium",
        serviceCategories: ["staff_augmentation"],
        summary: "Hiring three React engineers.",
        personId: null,
        occurredOn: daysAgo(1),
        sourceUrl: `https://jobs.example/medisync-${run}`,
        excerpt: null,
        evidenceLabel: "observed",
        source: "manual",
        confidence: null,
      }),
    );
    for (const id of ids.values()) await rescoreCompany(auth.workspaceId, id);
  });

  const leads = (query: Record<string, unknown>) => listLeads(auth, leadListQuerySchema.parse(query));

  it("lists only opportunities judged a real buyer: unchecked and not-a-fit stay off the Leads page", async () => {
    expect((await leads({})).counts.all).toBe(0);
    expect(await feed({ leadStatus: "unchecked" })).toEqual(["Ledgerline", "Medisync Health", "Northbridge Legal"]);

    // The AI's verdicts: two leads, one not a fit.
    const verdict = (name: string, qualification: string, score: number) =>
      db
        .update(opportunities)
        .set({ qualification, qualificationScore: score, qualificationReason: `${name} verdict.`, qualifiedBy: "ai", qualifiedAt: new Date() })
        .where(and(eq(opportunities.workspaceId, auth.workspaceId), eq(opportunities.companyId, ids.get(name)!)));
    await verdict("Northbridge Legal", "warm", 55);
    await verdict("Medisync Health", "hot", 85);
    await verdict("Ledgerline", "not_fit", 20);
    const listed = await leads({});
    // Hot before warm.
    expect(listed.items.map((i) => [i.company?.name, i.lead.status])).toEqual([["Medisync Health", "hot"], ["Northbridge Legal", "warm"]]);
    expect(await feed({ leadStatus: "lead" })).toEqual(["Medisync Health", "Northbridge Legal"]);
    expect(await feed({ leadStatus: "not_fit" })).toEqual(["Ledgerline"]);

    // The team's call wins, and can be handed back to the AI.
    const [ledger] = (await listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open", leadStatus: "not_fit" }))).items;
    const marked = await updateOpportunity(auth, ledger.id, { qualification: "warm" });
    expect(marked.lead).toMatchObject({ status: "warm", by: "team" });
    expect((await leads({})).counts.all).toBe(3);
    const handedBack = await updateOpportunity(auth, ledger.id, { qualification: null });
    // Back to the AI: no verdict until it reads it again.
    expect(handedBack.lead).toMatchObject({ by: null, reason: null });
    expect(["checking", "unchecked"]).toContain(handedBack.lead.status);
    await updateOpportunity(auth, ledger.id, { qualification: "warm" });
  });

  it("gives a lead with no contact the website and the page its signal was found on", async () => {
    const [lead] = (await leads({ tab: "none" })).items;
    expect(lead.company).toMatchObject({ name: "Medisync Health", domain: `medisynchealth-${run}.example` });
    expect(lead.evidence).toEqual({ url: `https://jobs.example/medisync-${run}`, summary: "Hiring three React engineers." });
  });

  it("sorts every active lead by how it can be reached, with a count per tab", async () => {
    const all = await leads({});
    expect(all.counts).toEqual({ all: 3, email: 1, phone: 1, person: 1, company: 1, none: 1 });
    expect(all.total).toBe(3);

    const [named] = (await leads({ tab: "person" })).items;
    expect(named.company?.name).toBe("Northbridge Legal");
    expect(named.contact).toMatchObject({ name: "James Whitaker", email: `james-${run}@northbridge.example`, phone: null });
    const [line] = (await leads({ tab: "company" })).items;
    expect(line).toMatchObject({ company: { name: "Ledgerline" }, companyContact: { phone: "0113 496 0000" } });
    expect((await leads({ tab: "none" })).items.map((i) => i.company?.name)).toEqual(["Medisync Health"]);
    // Search narrows every tab's count.
    expect((await leads({ q: "ledger" })).counts).toEqual({ all: 1, email: 0, phone: 1, person: 0, company: 1, none: 0 });
  });

  it("lists every matching lead's email and phone for copying", async () => {
    const withEmail = await listLeadContacts(auth, leadContactsQuerySchema.parse({ tab: "email" }));
    expect(withEmail.items).toEqual([expect.objectContaining({ name: "Northbridge Legal", contact: "James Whitaker", email: `james-${run}@northbridge.example` })]);
    const withPhone = await listLeadContacts(auth, leadContactsQuerySchema.parse({ tab: "phone" }));
    expect(withPhone.items).toEqual([expect.objectContaining({ name: "Ledgerline", email: null, phone: "0113 496 0000" })]);
  });

  it("splits leads into B2B and job openings, as the Opportunities page does, with a count for each", async () => {
    const all = await leads({});
    const { startup, established } = all.stageCounts;
    // Every lead is one or the other, and each choice lists what its count says.
    expect(startup + established).toBe(all.counts.all);
    const b2b = await leads({ companyStage: "startup" });
    const openings = await leads({ companyStage: "established" });
    expect(b2b.counts.all).toBe(startup);
    expect(openings.counts.all).toBe(established);
    // The counts leave the choice itself out, so they stay the same whichever is picked.
    expect(b2b.stageCounts).toEqual(all.stageCounts);
    // Copying follows the choice.
    expect((await listLeadContacts(auth, leadContactsQuerySchema.parse({ companyStage: "startup" }))).total).toBe(startup);
  });

  it("gives a lead with no job posts the roles the AI found fit, for the role filter", async () => {
    await db
      .update(opportunities)
      .set({ qualificationHints: { fittingRoles: ["Senior React Engineer"] } })
      .where(and(eq(opportunities.workspaceId, auth.workspaceId), eq(opportunities.companyId, ids.get("Northbridge Legal")!)));
    const frontend = await leads({ role: "frontend" });
    expect(frontend.items.map((i) => [i.company?.name, i.roles])).toEqual([["Northbridge Legal", ["Senior React Engineer"]]]);
    expect(frontend.roleCounts.frontend).toBe(1);
  });

  it("filters the feed and the export to leads someone can be contacted at", async () => {
    expect(await feed({ contact: "any" })).toEqual(["Ledgerline", "Northbridge Legal"]);
    expect(await feed({ contact: "none" })).toEqual(["Medisync Health"]);
    const { count } = await exportOpportunities(auth, opportunityExportQuerySchema.parse({ group: "open", contact: "any" }));
    expect(count).toBe(2);
  });

  it("leaves won and closed leads off the Leads page", async () => {
    const { items } = await leads({ tab: "none" });
    const stages = await listPipeline(auth);
    const stage = (kind: string) => stages.find((s) => s.kind === kind)!.id;
    await updateOpportunity(auth, items[0].id, { stageId: stage("won") });
    expect((await leads({})).counts.all).toBe(2);
    await updateOpportunity(auth, items[0].id, { archived: true });
    expect((await leads({})).counts.all).toBe(2); // an archived lead is off the Leads page too
    await updateOpportunity(auth, items[0].id, { stageId: stages.find((s) => s.intake)!.id, archived: false });
  });
});

describe("likely competitors", () => {
  it("are hidden from the feed and the Leads page, found with the hidden filter, and come back when marked a good fit", async () => {
    const company = await createCompany(
      auth,
      companySchema.parse({ name: `Rivet Consulting ${run}`, domain: `rivet-${run}.example`, industry: null, employeeCount: 40, description: null, hqCity: null, hqRegion: null, hqCountry: "GB" }),
    );
    await createSignal(
      auth,
      company.id,
      signalSchema.parse({
        signalType: "engineering_hiring",
        intentLevel: "high",
        urgency: "medium",
        serviceCategories: ["staff_augmentation"],
        summary: "Rivet is hiring engineers.",
        personId: null,
        occurredOn: daysAgo(1),
        sourceUrl: null,
        excerpt: null,
        evidenceLabel: "observed",
        source: "manual",
        confidence: null,
      }),
    );
    await rescoreCompany(auth.workspaceId, company.id);
    const rivet = `Rivet Consulting ${run}`;

    expect(await feed({})).not.toContain(rivet);
    expect((await listLeads(auth, leadListQuerySchema.parse({ q: "rivet" }))).counts.all).toBe(0);
    expect(await feed({ hidden: "true" })).toEqual([rivet]);
    const [hidden] = (await listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open", hidden: "true" }))).items;

    const change = await giveFeedback(auth, hidden.id, feedbackSchema.parse({ verdict: "good_fit" }));
    expect(change.correctsMatch).toBe(true);
    await rescoreCompany(auth.workspaceId, company.id);
    expect(await feed({})).toContain(rivet);
    expect(await feed({ hidden: "true" })).toEqual([]);
  });
});

describe("remote work", () => {
  it("narrows the feed and the export to leads hiring remotely", async () => {
    // Medisync's job says remote; Ledgerline's says it isn't.
    const job = async (company: string, location: string) => {
      const [signal] = await db
        .select({ id: signals.id, companyId: signals.companyId })
        .from(signals)
        .innerJoin(companies, eq(companies.id, signals.companyId))
        .where(and(eq(signals.workspaceId, auth.workspaceId), eq(companies.canonicalName, company)));
      await db.insert(jobPostings).values({
        workspaceId: auth.workspaceId,
        companyId: signal.companyId,
        provider: "greenhouse",
        externalId: `${company}-${run}`,
        title: "Software Engineer",
        location,
        url: `https://example.com/${run}`,
        signalId: signal.id,
      });
    };
    await job("Medisync Health", "Remote - US");
    await job("Ledgerline", "London (not remote)");

    expect(await feed({ remote: "true" })).toEqual(["Medisync Health"]);
    // Off, the filter leaves every lead in.
    expect(await feed({})).toEqual(expect.arrayContaining(["Ledgerline", "Medisync Health", "Northbridge Legal"]));
    const { count } = await exportOpportunities(auth, opportunityExportQuerySchema.parse({ group: "open", remote: "true" }));
    expect(count).toBe(1);
  });
});

describe("job sites in the source filter", () => {
  it("finds leads with a job posted on LinkedIn or Indeed, not a company named after them", async () => {
    const evidence = async (company: string, sourceUrl: string) => {
      const [signal] = await db
        .select({ id: signals.id })
        .from(signals)
        .innerJoin(companies, eq(companies.id, signals.companyId))
        .where(and(eq(signals.workspaceId, auth.workspaceId), eq(companies.canonicalName, company)));
      await db.insert(signalEvidence).values({ signalId: signal.id, sourceUrl });
    };
    await evidence("Northbridge Legal", "https://www.linkedin.com/jobs/view/4470411870/");
    await evidence("Medisync Health", "https://uk.indeed.com/viewjob?jk=abc123");
    // LinkedIn's own careers board on another site isn't a job posted on LinkedIn.
    await evidence("Ledgerline", "https://jobs.smartrecruiters.com/LinkedIn3/744000159942579");

    expect(await feed({ sources: "linkedin" })).toEqual(["Northbridge Legal"]);
    expect(await feed({ sources: "indeed" })).toEqual(["Medisync Health"]);
    expect(await feed({ sources: "linkedin,indeed" })).toEqual(["Medisync Health", "Northbridge Legal"]);
    // Combined with a discovery source, either one matches.
    expect(await feed({ sources: "linkedin,freelancer" })).toEqual(["Northbridge Legal"]);
  });
});

describe("who the services are sold to", () => {
  it("shows only kinds of client a service is sold to, and keeps the choice and work type on the service", async () => {
    // A post by someone with no company: an individual.
    await db.insert(opportunities).values({
      workspaceId: auth.workspaceId,
      stageId: await intakeStageId(db, auth.workspaceId),
      category: "intent",
      type: "software_development",
      title: `Build a React dashboard ${run}`,
      sourceSlug: "reddit",
      sourceExternalId: `post-${run}`,
      opportunityScore: 50,
    });
    const titles = async () =>
      (await listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open" }))).items.map((i) => i.company?.name ?? i.engine?.title);
    expect(await titles()).toContain(`Build a React dashboard ${run}`);

    const { items } = await listServices(auth);
    const companiesOnly = async (clientTypes: string[], workType: string) => {
      for (const s of items) {
        const saved = await updateService(auth, s.id, serviceSchema.parse({ ...s, clientTypes, workType }));
        expect(saved).toMatchObject({ clientTypes, workType, targetIndustries: [], targetJobFunctions: [] });
      }
    };
    await companiesOnly(["company"], "remote");
    expect(await titles()).not.toContain(`Build a React dashboard ${run}`);
    expect(await titles()).toEqual(expect.arrayContaining(["Ledgerline", "Medisync Health", "Northbridge Legal"]));

    // Ticked again, the post comes back: nothing was deleted.
    await companiesOnly(["company", "individual"], "any");
    expect(await titles()).toContain(`Build a React dashboard ${run}`);
  });
});

describe("job posts beside the contacts", () => {
  it("lists each job post by position, with its link", async () => {
    const { getOpportunity, positionOf } = await import("@/server/services/opportunities.service");
    const [medisync] = (await listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open", q: "Medisync" }))).items;
    const detail = await getOpportunity(auth, medisync.id);
    // The job board's record (title and place) and the signal's own evidence link.
    expect(detail.jobLinks).toEqual(
      expect.arrayContaining([
        { title: "Software Engineer", url: `https://example.com/${run}`, location: "Remote - US" },
        expect.objectContaining({ url: `https://jobs.example/medisync-${run}` }),
      ]),
    );
    expect(positionOf("Kita is hiring a Creative AI Engineer (San Francisco, CA), with 2 open postings for this role. Posted 2026-11-23.")).toEqual({
      title: "Creative AI Engineer",
      location: "San Francisco, CA",
    });
    expect(positionOf("Cairhealth is hiring a Software Engineer (Remote (USA timezones)). Posted 2026-11-23.")).toEqual({ title: "Software Engineer", location: "Remote (USA timezones)" });
    expect(positionOf("AssemblyAI posted a job for an Applied AI Engineer in its Customer Experience department.").title).toBe("Applied AI Engineer");
  });
});

describe("companies and individuals", () => {
  it("tells B2B opportunities from individuals' posts, with a count for each", async () => {
    // The post by someone with no company (added for the client-type test) is an individual's.
    const list = (clientType?: string) => listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open", ...(clientType ? { clientType } : {}) }));
    const all = await list();
    expect(all.clientTypeCounts.individual).toBe(1);
    expect(all.clientTypeCounts.company + all.clientTypeCounts.individual).toBe(all.total);
    const individuals = await list("individual");
    expect(individuals.items.map((i) => [i.engine?.title, i.clientType])).toEqual([[`Build a React dashboard ${run}`, "individual"]]);
    const b2b = await list("company");
    expect(b2b.total).toBe(all.clientTypeCounts.company);
    expect(b2b.items.every((i) => i.clientType === "company")).toBe(true);
  });
});

describe("startups and job openings", () => {
  it("files companies that need the work you do as B2B, and ordinary hiring as job openings", async () => {
    const list = (companyStage?: string) => listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open", ...(companyStage ? { companyStage } : {}) }));
    const stageOf = async (name: string) => (await list()).items.find((i) => i.company?.name === name)?.companyStage;
    const ids = new Map((await listCompanies(auth, undefined, { page: 1, pageSize: 100 })).items.map((c) => [c.name, c.id]));

    // Asking for a service is B2B at any size (Northbridge's signal is a service request).
    await db.update(companies).set({ employeeCount: 5000 }).where(eq(companies.id, ids.get("Northbridge Legal")!));
    expect(await stageOf("Northbridge Legal")).toBe("startup");
    await db.update(companies).set({ employeeCount: 50 }).where(eq(companies.id, ids.get("Northbridge Legal")!));

    // A small company hiring only for work your services don't cover (MVP work here; the test services
    // are web development and staff augmentation) is ordinary hiring...
    expect(await stageOf("Ledgerline")).toBe("established");
    // ...until it opens a role your services cover.
    await createSignal(
      auth,
      ids.get("Ledgerline")!,
      signalSchema.parse({
        signalType: "engineering_hiring",
        intentLevel: "high",
        urgency: "medium",
        serviceCategories: ["web_development"],
        summary: "Ledgerline is hiring a Frontend Engineer.",
        personId: null,
        occurredOn: daysAgo(2),
        sourceUrl: null,
        excerpt: null,
        evidenceLabel: "observed",
        source: "manual",
        confidence: null,
      }),
    );
    await rescoreCompany(auth.workspaceId, ids.get("Ledgerline")!);
    expect(await stageOf("Ledgerline")).toBe("startup");

    // Every company is in one group; the individual's post is in neither.
    const after = await list();
    expect(after.clientTypeCounts.startup + after.clientTypeCounts.established).toBe(after.total - after.clientTypeCounts.individual);
    expect((await list("startup")).items.every((i) => i.companyStage === "startup")).toBe(true);
  });

  it("files a large company growing a team as job openings: over 200 staff, or 50+ open jobs when its size is unknown", async () => {
    const stageOf = async (name: string) =>
      (await listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open" }))).items.find((i) => i.company?.name === name)?.companyStage;
    const [medisync] = await db.select({ id: companies.id }).from(companies).where(and(eq(companies.workspaceId, auth.workspaceId), eq(companies.canonicalName, "Medisync Health")));
    // Three open roles the services cover: growing a team.
    for (const role of ["Frontend Engineer", "Backend Engineer", "Web Developer"]) {
      await createSignal(
        auth,
        medisync.id,
        signalSchema.parse({
          signalType: "engineering_hiring",
          intentLevel: "medium",
          urgency: "unknown",
          serviceCategories: ["web_development"],
          summary: `Medisync Health is hiring a ${role}.`,
          personId: null,
          occurredOn: daysAgo(3),
          sourceUrl: null,
          excerpt: null,
          evidenceLabel: "observed",
          source: "manual",
          confidence: null,
        }),
      );
    }
    await rescoreCompany(auth.workspaceId, medisync.id);
    expect(await stageOf("Medisync Health")).toBe("startup");

    // Large by its own staff count: it fills those roles itself.
    await db.update(companies).set({ employeeCount: 3000 }).where(eq(companies.id, medisync.id));
    expect(await stageOf("Medisync Health")).toBe("established");

    // Size unknown: 49 open jobs on its board say too little, 50 say large.
    await db.update(companies).set({ employeeCount: null }).where(eq(companies.id, medisync.id));
    const token = `medisync-${run}`;
    // A board every workspace shares (the directory), followed by this company.
    await db.insert(jobBoardDirectory).values({ provider: "greenhouse", boardToken: token });
    await db.insert(companyJobBoards).values({ companyId: medisync.id, workspaceId: auth.workspaceId, provider: "greenhouse", boardToken: token });
    const job = (i: number) => ({ provider: "greenhouse" as const, boardToken: token, externalId: String(i), title: `Role ${i}`, url: `https://example.com/${token}/${i}` });
    await db.insert(boardJobs).values(Array.from({ length: 49 }, (_, i) => job(i)));
    expect(await stageOf("Medisync Health")).toBe("startup");
    await db.insert(boardJobs).values(job(49));
    expect(await stageOf("Medisync Health")).toBe("established");

    await db.delete(boardJobs).where(eq(boardJobs.boardToken, token));
    await db.delete(companyJobBoards).where(eq(companyJobBoards.companyId, medisync.id));
    await db.delete(jobBoardDirectory).where(eq(jobBoardDirectory.boardToken, token));
  });
});
