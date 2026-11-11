import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { opportunities, opportunityDiscoveries, opportunityEvidence, pipelineStages, workspaces } from "@/db/schema";
import { and } from "drizzle-orm";
import { registerOwner } from "@/server/services/auth.service";
import { ingestItem } from "./ingest";
import { scoreItem } from "./score-item";
import type { DiscoveredItem } from "./types";

/**
 * Spec §9 and §12 against the real database (`npm run test:integration`): rediscovery enriches and
 * never duplicates, keeps the sales stage, and keeps evidence and history. Removes what it creates.
 */

const run = randomUUID().slice(0, 8);
let workspaceId: string;
const now = new Date("2026-11-11T12:00:00Z");
const targeting = { countries: ["US"], industries: [], serviceIds: [] };

const item = (over: Partial<DiscoveredItem> = {}): DiscoveredItem => ({
  capability: "freelance", category: "freelance_project", sourceSlug: "freelancer", platform: "Freelancer.com", externalId: `p-${run}`,
  url: `https://www.freelancer.com/projects/${run}`, title: "Build an MVP", text: "Need an MVP mobile app built", postedAt: now,
  buyerName: null, buyerProfileUrl: null, companyName: null, companyDomain: null, country: "US", city: null, industry: null, remote: true,
  clientType: "company", budget: { min: 5000, max: 8000, currency: "USD", usd: 8000 }, funding: null, intentHint: null, verification: "unverified", metadata: {}, ...over,
});

const score = (i: DiscoveredItem) => scoreItem({ item: i, targeting, serviceTerms: ["mvp", "mobile"], freelance: { minBudgetUsd: 5000 }, now });

beforeAll(async () => {
  const me = await registerOwner({ name: "Engine", email: `engine-${run}@engine.test`, password: "Engine-test-1", workspaceName: `Engine ${run}` });
  workspaceId = me.workspace.id;
});

afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
});

describe("ingestItem", () => {
  it("creates an opportunity with no company, evidence and a history row", async () => {
    const i = item();
    const result = await ingestItem({ workspaceId, runId: null, item: i, score: score(i), now });
    expect(result.outcome).toBe("created");
    const [row] = await db.select().from(opportunities).where(eq(opportunities.id, result.id));
    expect(row.companyId).toBeNull();
    expect(row.category).toBe("freelance_project");
    // Discoveries land in the workspace's first open stage.
    const [intake] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, row.stageId));
    expect(intake).toMatchObject({ name: "New", kind: "open" });
    expect(row.opportunityScore).toBeGreaterThan(0);
    expect(await db.select().from(opportunityEvidence).where(eq(opportunityEvidence.opportunityId, result.id))).toHaveLength(1);
  });

  it("rediscovery updates the same row, keeps the sales status, and records what changed", async () => {
    const first = item({ externalId: `q-${run}`, url: `https://www.freelancer.com/projects/q-${run}` });
    const created = await ingestItem({ workspaceId, runId: null, item: first, score: score(first), now });
    // The team works the opportunity.
    const [contacted] = await db.select().from(pipelineStages).where(and(eq(pipelineStages.workspaceId, workspaceId), eq(pipelineStages.name, "Contacted")));
    await db.update(opportunities).set({ stageId: contacted.id }).where(eq(opportunities.id, created.id));

    const again = item({ externalId: first.externalId, url: first.url, budget: { min: 5000, max: 20000, currency: "USD", usd: 20000 }, verification: "verified" });
    const updated = await ingestItem({ workspaceId, runId: null, item: again, score: score(again), now: new Date(now.getTime() + 3_600_000) });

    expect(updated.outcome).toBe("updated");
    expect(updated.id).toBe(created.id);
    expect(updated.changed).toEqual(expect.arrayContaining(["budgetUsd", "verification"]));

    const [row] = await db.select().from(opportunities).where(eq(opportunities.id, created.id));
    expect(row.stageId).toBe(contacted.id); // discovery never resets sales progress
    expect(row.budgetUsd).toBe(20000);
    expect(await db.select().from(opportunities).where(eq(opportunities.sourceExternalId, first.externalId))).toHaveLength(1);
    expect(await db.select().from(opportunityDiscoveries).where(eq(opportunityDiscoveries.opportunityId, created.id))).toHaveLength(2);
    expect(await db.select().from(opportunityEvidence).where(eq(opportunityEvidence.opportunityId, created.id))).toHaveLength(1);
  });

  it("never downgrades verified evidence to unverified", async () => {
    const verified = item({ externalId: `v-${run}`, url: `https://example.test/v-${run}`, verification: "verified" });
    const { id } = await ingestItem({ workspaceId, runId: null, item: verified, score: score(verified), now });
    const weaker = { ...verified, verification: "unverified" as const };
    await ingestItem({ workspaceId, runId: null, item: weaker, score: score(weaker), now });
    const [row] = await db.select().from(opportunities).where(eq(opportunities.id, id));
    expect(row.verification).toBe("verified");
  });

  it("keeps the same source ID in two workspaces separate", async () => {
    const other = await registerOwner({ name: "Other", email: `other-${run}@engine.test`, password: "Engine-test-1", workspaceName: `Other ${run}` });
    try {
      const i = item({ externalId: `x-${run}`, url: `https://example.test/x-${run}` });
      const a = await ingestItem({ workspaceId, runId: null, item: i, score: score(i), now });
      const b = await ingestItem({ workspaceId: other.workspace.id, runId: null, item: i, score: score(i), now });
      expect(a.id).not.toBe(b.id);
      expect(b.outcome).toBe("created");
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, other.workspace.id));
    }
  });
});
