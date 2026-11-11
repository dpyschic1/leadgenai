import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { workspaces } from "@/db/schema";
import { opportunityListQuerySchema } from "@/lib/validation/opportunities";
import type { AuthContext } from "@/server/auth/session";
import { registerOwner } from "@/server/services/auth.service";
import { getOpportunity, listOpportunities } from "@/server/services/opportunities.service";
import { ingestItem } from "./ingest";
import { scoreItem } from "./score-item";
import type { DiscoveredItem } from "./types";

/**
 * The Opportunities feed with engine opportunities in it (spec section 11): they appear without a company,
 * filter by category, source and intent, and are found by title or buyer. Removes what it creates.
 */

const run = randomUUID().slice(0, 8);
const now = new Date("2026-11-11T12:00:00Z");
const targeting = { countries: [], industries: [], serviceIds: [] };
let auth: AuthContext;
let workspaceId: string;
const ids: Record<string, string> = {};

const base: DiscoveredItem = {
  capability: "intent", category: "intent", sourceSlug: "serpapi", platform: "Reddit", externalId: "", url: "", title: "", text: "", postedAt: now,
  buyerName: null, buyerProfileUrl: null, companyName: null, companyDomain: null, country: null, city: null, industry: null, remote: null,
  clientType: null, budget: null, funding: null, intentHint: null, verification: "unverified", metadata: {},
};

async function add(key: string, item: Partial<DiscoveredItem>) {
  const full = { ...base, externalId: `${key}-${run}`, url: `https://example.test/${key}-${run}`, ...item } as DiscoveredItem;
  const score = scoreItem({ item: full, targeting, serviceTerms: ["website", "mvp"], freelance: { minBudgetUsd: 5000 }, now });
  ids[key] = (await ingestItem({ workspaceId, runId: null, item: full, score, now })).id;
}

const list = (extra: Record<string, unknown> = {}) => listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open", ...extra }));

beforeAll(async () => {
  const me = await registerOwner({ name: "Feed", email: `feed-${run}@engine.test`, password: "Engine-test-1", workspaceName: `Feed ${run}` });
  workspaceId = me.workspace.id;
  auth = { userId: me.user.id, workspaceId, role: "owner" };
  await add("intent", { title: "Looking for an agency to build our MVP", text: "need an mvp", intentHint: "high", buyerName: "jane_doe" });
  await add("funded", {
    capability: "funded", category: "funded_company", sourceSlug: "sec_form_d", platform: "SEC EDGAR (Form D)", title: "Acme Robotics filed a Form D", companyName: "Acme Robotics",
    country: "US", funding: { amountUsd: 2_000_000, stage: "Seed", date: "2026-10-30", investors: [] }, verification: "verified",
  });
  await add("freelance", {
    capability: "freelance", category: "freelance_project", sourceSlug: "freelancer", platform: "Freelancer.com", title: "Website redesign", text: "redesign our website",
    country: "GB", budget: { min: 5000, max: 9000, currency: "USD", usd: 9000 }, verification: "verified",
  });
});

afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
});

describe("feed with engine opportunities", () => {
  it("lists company-less opportunities, with their engine details and no company", async () => {
    const all = await list();
    expect(all.total).toBe(3);
    const intent = all.items.find((i) => i.id === ids.intent)!;
    expect(intent.company).toBeNull();
    expect(intent.engine).toMatchObject({ category: "intent", buyerName: "jane_doe", platform: "Reddit", verification: "unverified" });
    expect(intent.score).not.toBeNull();
  });

  it("filters by category", async () => {
    expect((await list({ categories: "funded_company" })).items.map((i) => i.id)).toEqual([ids.funded]);
    expect((await list({ categories: "freelance_project,intent" })).total).toBe(2);
    expect((await list({ categories: "signal" })).total).toBe(0); // none of these come from the company-signal flow
  });

  it("filters by source, intent level and country (a stated country counts)", async () => {
    expect((await list({ sources: "sec_form_d" })).items.map((i) => i.id)).toEqual([ids.funded]);
    // A posted freelance project is an explicit request to hire, so it is "high" too; a funding round is "low".
    expect((await list({ intents: "high" })).items.map((i) => i.id).sort()).toEqual([ids.intent, ids.freelance].sort());
    expect((await list({ intents: "low" })).items.map((i) => i.id)).toEqual([ids.funded]);
    expect((await list({ countries: "GB" })).items.map((i) => i.id)).toEqual([ids.freelance]);
  });

  it("finds opportunities by title or buyer name", async () => {
    expect((await list({ q: "redesign" })).items.map((i) => i.id)).toEqual([ids.freelance]);
    expect((await list({ q: "jane_doe" })).items.map((i) => i.id)).toEqual([ids.intent]);
  });

  it("opens an engine opportunity with its evidence and discovery history", async () => {
    const detail = await getOpportunity(auth, ids.funded);
    expect(detail.company).toBeNull();
    expect(detail.engineEvidence).toHaveLength(1);
    expect(detail.engineEvidence[0]).toMatchObject({ platform: "SEC EDGAR (Form D)", verification: "verified" });
    expect(detail.discoveries[0].change).toBe("created");
    expect(detail.engineFactors?.map((f) => f.key)).toEqual(["serviceFit", "intent", "icpFit", "budget", "timing", "evidence"]);
    expect(detail.engineFactors?.reduce((sum, f) => sum + f.weight, 0)).toBe(100);
  });
});

describe("Leads page", () => {
  it("includes discovered buyers and projects, which have no contact yet", async () => {
    const { listLeads } = await import("@/server/services/opportunities.service");
    const { leadListQuerySchema } = await import("@/lib/validation/opportunities");
    const all = await listLeads(auth, leadListQuerySchema.parse({}));
    expect(all.counts.all).toBe(3);
    // None of these carries a named person or a company line.
    expect(all.counts.none).toBe(3);
    expect(all.items.map((i) => i.id).sort()).toEqual([ids.intent, ids.funded, ids.freelance].sort());
  });
});
