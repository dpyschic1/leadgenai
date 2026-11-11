import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { opportunities, workspaces } from "@/db/schema";
import { DEFAULT_ENGINE_WEIGHTS, engineWeightsSchema } from "@/lib/domain/engine";
import type { AuthContext } from "@/server/auth/session";
import { registerOwner } from "@/server/services/auth.service";
import { getEngine, saveEngineWeights } from "@/server/services/engine.service";
import { ingestItem } from "./ingest";
import { refreshEngineScores } from "./rescore";
import { scoreItem } from "./score-item";
import { timingPoints } from "./scoring";
import type { DiscoveredItem } from "./types";

/** Engine scores stay honest as items age and when the workspace changes its weights. Removes what it creates. */

const run = randomUUID().slice(0, 8);
const found = new Date("2026-11-01T12:00:00Z");
const targeting = { countries: [], industries: [], serviceIds: [] };
let auth: AuthContext;
let id: string;

const item: DiscoveredItem = {
  capability: "freelance", category: "freelance_project", sourceSlug: "freelancer", platform: "Freelancer.com", externalId: `rs-${run}`,
  url: `https://example.test/rs-${run}`, title: "Website redesign", text: "redesign our website", postedAt: found, buyerName: null, buyerProfileUrl: null,
  companyName: null, companyDomain: null, country: "US", city: null, industry: null, remote: null, clientType: null,
  budget: { min: 6000, max: 6000, currency: "USD", usd: 6000 }, funding: null, intentHint: null, verification: "verified", metadata: {},
};

const row = async () => (await db.select().from(opportunities).where(eq(opportunities.id, id)))[0];
const factors = async () => (await row()).scoreFactors as Record<string, number>;

beforeAll(async () => {
  const me = await registerOwner({ name: "Rescore", email: `rescore-${run}@engine.test`, password: "Engine-test-1", workspaceName: `Rescore ${run}` });
  auth = { userId: me.user.id, workspaceId: me.workspace.id, role: "owner" };
  const score = scoreItem({ item, targeting, serviceTerms: ["website"], freelance: { minBudgetUsd: 5000 }, now: found });
  id = (await ingestItem({ workspaceId: auth.workspaceId, runId: null, item, score, now: found })).id;
});

afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, auth.workspaceId));
});

describe("score freshness", () => {
  it("stores when the source says it was posted", async () => {
    expect((await row()).sourcePostedAt?.toISOString()).toBe(found.toISOString());
    expect((await factors()).timing).toBe(timingPoints(found, found)); // 100: posted just now
  });

  it("lowers the timing factor and the total as the post ages, leaving the other factors alone", async () => {
    const before = await row();
    const later = new Date(found.getTime() + 20 * 86_400_000);
    expect(await refreshEngineScores(auth.workspaceId, later)).toBe(1);
    const after = await row();
    const f = after.scoreFactors as Record<string, number>;
    expect(f.timing).toBe(timingPoints(found, later)); // 45 at 20 days
    expect(f.timing).toBeLessThan((before.scoreFactors as Record<string, number>).timing);
    expect(after.opportunityScore!).toBeLessThan(before.opportunityScore!);
    expect(f.serviceFit).toBe((before.scoreFactors as Record<string, number>).serviceFit);
  });

  it("does not touch a score that is still fresh", async () => {
    const later = new Date(found.getTime() + 20 * 86_400_000);
    expect(await refreshEngineScores(auth.workspaceId, later)).toBe(0); // scored moments ago relative to `later`
  });
});

describe("workspace scoring weights", () => {
  it("reports the spec's defaults until the workspace changes them", async () => {
    const state = await getEngine(auth);
    expect(state.weights).toEqual(DEFAULT_ENGINE_WEIGHTS);
    expect(state.customWeights).toBe(false);
  });

  it("re-ranks existing discoveries from their stored factors when weights change", async () => {
    const f = await factors();
    await saveEngineWeights(auth, { serviceFit: 0, intent: 0, icpFit: 0, budget: 100, timing: 0, evidence: 0 });
    expect((await row()).opportunityScore).toBe(f.budget); // only budget counts now
    expect(((await row()).scoreFactors as { weights: Record<string, number> }).weights.budget).toBe(100);
    const state = await getEngine(auth);
    expect(state.customWeights).toBe(true);

    await saveEngineWeights(auth, null); // reset
    expect((await getEngine(auth)).customWeights).toBe(false);
    const expected = Math.round(
      (f.serviceFit * 25 + f.intent * 25 + f.icpFit * 20 + f.budget * 15 + f.timing * 10 + f.evidence * 5) / 100,
    );
    expect((await row()).opportunityScore).toBe(expected);
  });

  it("only accepts weights that add up to 100", () => {
    expect(engineWeightsSchema.safeParse({ serviceFit: 50, intent: 50, icpFit: 10, budget: 0, timing: 0, evidence: 0 }).success).toBe(false);
    expect(engineWeightsSchema.safeParse(DEFAULT_ENGINE_WEIGHTS).success).toBe(true);
  });
});
