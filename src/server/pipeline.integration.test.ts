import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { opportunities, workspaces } from "@/db/schema";
import { opportunityListQuerySchema } from "@/lib/validation/opportunities";
import type { AuthContext } from "@/server/auth/session";
import { ingestItem } from "@/server/engine/ingest";
import { scoreItem } from "@/server/engine/score-item";
import type { DiscoveredItem } from "@/server/engine/types";
import { AppError } from "@/server/http/errors";
import { registerOwner } from "@/server/services/auth.service";
import { getOpportunity, listOpportunities, updateOpportunity } from "@/server/services/opportunities.service";
import { createStage, deleteStage, listPipeline, pipelineReport, renameStage, reorderStages } from "@/server/services/pipeline.service";

/** The sales pipeline (spec section 12) against the real database. Removes what it creates. */

const run = randomUUID().slice(0, 8);
const now = new Date("2026-11-11T12:00:00Z");
let auth: AuthContext;
let other: AuthContext;
const oppIds: string[] = [];

const item = (n: number): DiscoveredItem => ({
  capability: "freelance", category: "freelance_project", sourceSlug: "freelancer", platform: "Freelancer.com", externalId: `pl-${n}-${run}`,
  url: `https://example.test/pl-${n}-${run}`, title: `Project ${n}`, text: "website", postedAt: now, buyerName: null, buyerProfileUrl: null,
  companyName: null, companyDomain: null, country: "US", city: null, industry: null, remote: null, clientType: null,
  budget: { min: 6000, max: 6000, currency: "USD", usd: 6000 }, funding: null, intentHint: null, verification: "verified", metadata: {},
});

async function signUp(who: string): Promise<AuthContext> {
  const me = await registerOwner({ name: `Pipeline ${who}`, email: `pipeline-${who}-${run}@pipeline.test`, password: "Pipeline-test-1", workspaceName: `Pipeline ${who} ${run}` });
  return { userId: me.user.id, workspaceId: me.workspace.id, role: "owner" };
}
const stageNamed = async (name: string) => (await listPipeline(auth)).find((s) => s.name === name)!;
const tab = async (group: string) => (await listOpportunities(auth, opportunityListQuerySchema.parse({ group }))).items.map((i) => i.id);
const rejects = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
};

beforeAll(async () => {
  auth = await signUp("a");
  other = await signUp("b");
  for (const n of [1, 2, 3]) {
    const i = item(n);
    oppIds.push((await ingestItem({ workspaceId: auth.workspaceId, runId: null, item: i, score: scoreItem({ item: i, targeting: { countries: [], industries: [], serviceIds: [] }, serviceTerms: ["website"], freelance: { minBudgetUsd: 5000 }, now }), now })).id);
  }
});

afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, auth.workspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, other.workspaceId));
});

describe("default pipeline", () => {
  it("gives a new workspace the spec's seven stages, with New as the intake", async () => {
    const stages = await listPipeline(auth);
    expect(stages.map((s) => s.name)).toEqual(["New", "Contacted", "Responded", "Meeting Scheduled", "Proposal Sent", "Won", "Lost"]);
    expect(stages.filter((s) => s.intake).map((s) => s.name)).toEqual(["New"]);
    expect(stages.map((s) => s.kind)).toEqual(["open", "open", "open", "open", "open", "won", "lost"]);
  });

  it("puts every discovery in the intake stage", async () => {
    expect((await stageNamed("New")).opportunityCount).toBe(3);
    expect(await tab("open")).toHaveLength(3);
  });
});

describe("moving opportunities between stages and tabs", () => {
  it("derives the tabs from stage kind and archive state", async () => {
    const [a, b, c] = oppIds;
    await updateOpportunity(auth, a, { stageId: (await stageNamed("Contacted")).id });
    await updateOpportunity(auth, b, { stageId: (await stageNamed("Won")).id });
    expect(await tab("open")).toEqual([c]);
    expect(await tab("inProgress")).toEqual([a]);
    expect(await tab("won")).toEqual([b]);

    await updateOpportunity(auth, c, { stageId: (await stageNamed("Lost")).id });
    expect(await tab("closed")).toEqual([c]);

    // Archiving hides it from the working tabs and puts it under Closed, keeping its stage.
    await updateOpportunity(auth, a, { archived: true });
    expect(await tab("inProgress")).toEqual([]);
    expect((await tab("closed")).sort()).toEqual([a, c].sort());
    expect((await getOpportunity(auth, a)).stage.name).toBe("Contacted");
    await updateOpportunity(auth, a, { archived: false });
    expect(await tab("inProgress")).toEqual([a]);
  });

  it("reports tab counts for every tab", async () => {
    const counts = (await listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open" }))).counts;
    expect(counts).toEqual({ open: 0, inProgress: 1, won: 1, closed: 1 });
  });

  it("refuses a stage from another workspace", async () => {
    const theirs = (await listPipeline(other))[0];
    await rejects(updateOpportunity(auth, oppIds[0], { stageId: theirs.id }), "NOT_FOUND");
  });
});

describe("customizing the pipeline", () => {
  it("adds a stage after the last open one and renames without changing its kind", async () => {
    const stages = await createStage(auth, { name: "Negotiation", kind: "open" });
    expect(stages.map((s) => s.name)).toEqual(["New", "Contacted", "Responded", "Meeting Scheduled", "Proposal Sent", "Negotiation", "Won", "Lost"]);
    const renamed = await renameStage(auth, (await stageNamed("Won")).id, "Closed won");
    expect(renamed.find((s) => s.name === "Closed won")?.kind).toBe("won");
  });

  it("rejects duplicate names, case-insensitively", async () => {
    await rejects(createStage(auth, { name: "negotiation", kind: "open" }), "ALREADY_EXISTS");
    await rejects(renameStage(auth, (await stageNamed("Contacted")).id, "NEW"), "ALREADY_EXISTS");
  });

  it("reorders, and the first open stage becomes the intake", async () => {
    const stages = await listPipeline(auth);
    const ids = stages.map((s) => s.id);
    [ids[0], ids[1]] = [ids[1], ids[0]]; // Contacted before New
    const after = await reorderStages(auth, ids);
    expect(after[0].name).toBe("Contacted");
    expect(after.find((s) => s.intake)?.name).toBe("Contacted");
    await reorderStages(auth, stages.map((s) => s.id)); // back
    await rejects(reorderStages(auth, ids.slice(1)), "VALIDATION_FAILED"); // must send every stage
  });

  it("keeps at least one stage of each kind", async () => {
    // "Closed won" is the only Won stage and "Lost" the only Lost one.
    await rejects(deleteStage(auth, (await stageNamed("Closed won")).id, null), "VALIDATION_FAILED");
    await rejects(deleteStage(auth, (await stageNamed("Lost")).id, null), "VALIDATION_FAILED");
    // With a second Lost stage, the first can go.
    await createStage(auth, { name: "Not a fit", kind: "lost" });
    await deleteStage(auth, (await stageNamed("Lost")).id, (await stageNamed("Not a fit")).id);
    expect((await listPipeline(auth)).filter((s) => s.kind === "lost").map((s) => s.name)).toEqual(["Not a fit"]);
  });

  it("moves a stage's opportunities when it is deleted, and requires a destination", async () => {
    const contacted = await stageNamed("Contacted");
    expect(contacted.opportunityCount).toBe(1);
    await rejects(deleteStage(auth, contacted.id, null), "VALIDATION_FAILED");
    await rejects(deleteStage(auth, contacted.id, contacted.id), "VALIDATION_FAILED");
    await deleteStage(auth, contacted.id, (await stageNamed("Responded")).id);
    expect((await stageNamed("Responded")).opportunityCount).toBe(1);
    const rows = await db.select().from(opportunities).where(eq(opportunities.workspaceId, auth.workspaceId));
    expect(rows).toHaveLength(3); // nothing was lost
  });

  it("keeps each workspace's pipeline separate", async () => {
    expect((await listPipeline(other)).map((s) => s.name)).toEqual(["New", "Contacted", "Responded", "Meeting Scheduled", "Proposal Sent", "Won", "Lost"]);
    await rejects(deleteStage(other, (await stageNamed("Responded")).id, null), "NOT_FOUND");
  });
});

describe("pipeline report", () => {
  it("counts outcomes by source from stage kind, so renaming Won or Lost changes nothing", async () => {
    // By now: one project is open (Responded), one is in the renamed Won stage, one in the replacement Lost stage.
    const report = await pipelineReport(auth);
    const freelance = report.rows.find((r) => r.category === "freelance_project")!;
    expect(freelance).toMatchObject({ total: 3, open: 1, won: 1, lost: 1, archived: 0, winRate: 50 });
    expect(report.rows.find((r) => r.category === "intent")).toMatchObject({ total: 0, winRate: null });
    expect(report.total).toMatchObject({ total: 3, won: 1, lost: 1, winRate: 50 });
  });

  it("does not count an archived opportunity as an outcome", async () => {
    await updateOpportunity(auth, oppIds[1], { archived: true }); // the won one
    const report = await pipelineReport(auth);
    expect(report.total).toMatchObject({ total: 3, won: 0, lost: 1, archived: 1, winRate: 0 });
    await updateOpportunity(auth, oppIds[1], { archived: false });
  });
});
