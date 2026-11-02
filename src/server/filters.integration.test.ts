import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { users, workspaces } from "@/db/schema";
import { companySchema } from "@/lib/validation/companies";
import { opportunityExportQuerySchema, opportunityListQuerySchema } from "@/lib/validation/opportunities";
import { serviceSchema } from "@/lib/validation/services";
import { signalSchema } from "@/lib/validation/signals";
import type { AuthContext } from "@/server/auth/session";
import { rescoreCompany } from "@/server/scoring/rescore";
import { registerOwner } from "@/server/services/auth.service";
import { createCompany } from "@/server/services/companies.service";
import { exportOpportunities } from "@/server/services/exports.service";
import { listOpportunities } from "@/server/services/opportunities.service";
import { createService } from "@/server/services/services.service";
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
    .map((item) => item.company.name)
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
