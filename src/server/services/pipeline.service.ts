import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { auditLogs, opportunities, pipelineStages } from "@/db/schema";
import { DEFAULT_STAGES, MAX_STAGES, STAGE_KIND_LABELS, type PipelineReport, type PipelineReportRow, type PipelineStage, type StageKind, type StageRef } from "@/lib/domain/pipeline";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";

type Conn = Tx | typeof db;

/** Gives a workspace the spec's default stages when it has none (new workspaces, and any created before the pipeline existed). */
export async function ensureDefaultStages(conn: Conn, workspaceId: string): Promise<void> {
  const [existing] = await conn.select({ id: pipelineStages.id }).from(pipelineStages).where(eq(pipelineStages.workspaceId, workspaceId)).limit(1);
  if (existing) return;
  await conn
    .insert(pipelineStages)
    .values(DEFAULT_STAGES.map((s, position) => ({ workspaceId, name: s.name, kind: s.kind, position })))
    .onConflictDoNothing();
}

/** Where a new opportunity lands: the workspace's first open stage. */
export async function intakeStageId(conn: Conn, workspaceId: string): Promise<string> {
  await ensureDefaultStages(conn, workspaceId);
  const [stage] = await conn
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(and(eq(pipelineStages.workspaceId, workspaceId), eq(pipelineStages.kind, "open")))
    .orderBy(asc(pipelineStages.position))
    .limit(1);
  if (!stage) throw new AppError("VALIDATION_FAILED", "The pipeline has no open stage.");
  return stage.id;
}

export async function loadStage(conn: Conn, workspaceId: string, stageId: string): Promise<StageRef> {
  const [stage] = await conn
    .select({ id: pipelineStages.id, name: pipelineStages.name, kind: pipelineStages.kind })
    .from(pipelineStages)
    .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.workspaceId, workspaceId)));
  if (!stage) throw new AppError("NOT_FOUND", "Stage not found.");
  return stage;
}

/** The stages in order, each with how many opportunities are in it; the first open stage is the intake. */
export async function listPipeline(auth: AuthContext): Promise<PipelineStage[]> {
  await ensureDefaultStages(db, auth.workspaceId);
  const rows = await db
    .select({
      id: pipelineStages.id,
      name: pipelineStages.name,
      kind: pipelineStages.kind,
      position: pipelineStages.position,
      // Qualified by hand: inside a subquery drizzle renders a bare "id", which would resolve to the opportunity's own id.
      opportunityCount: sql<number>`(select count(*)::int from opportunities o where o.stage_id = pipeline_stages.id)`,
    })
    .from(pipelineStages)
    .where(eq(pipelineStages.workspaceId, auth.workspaceId))
    .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt));
  const intakeId = rows.find((r) => r.kind === "open")?.id;
  return rows.map((r) => ({ ...r, intake: r.id === intakeId }));
}

const audit = (tx: Tx, auth: AuthContext, action: string, entityId: string | null, metadata: Record<string, unknown>) =>
  tx.insert(auditLogs).values({ workspaceId: auth.workspaceId, actorId: auth.userId, action, entityType: "pipeline_stage", entityId, metadata });

/** Rewrites positions 0..n-1 in the given order. */
async function renumber(tx: Tx, workspaceId: string, orderedIds: string[]): Promise<void> {
  for (const [position, stageId] of orderedIds.entries()) {
    await tx.update(pipelineStages).set({ position }).where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.workspaceId, workspaceId)));
  }
}

async function orderedStages(conn: Conn, workspaceId: string) {
  return conn
    .select({ id: pipelineStages.id, name: pipelineStages.name, kind: pipelineStages.kind })
    .from(pipelineStages)
    .where(eq(pipelineStages.workspaceId, workspaceId))
    .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt));
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export async function createStage(auth: AuthContext, input: { name: string; kind: StageKind }): Promise<PipelineStage[]> {
  await ensureDefaultStages(db, auth.workspaceId);
  await db.transaction(async (tx) => {
    const stages = await orderedStages(tx, auth.workspaceId);
    if (stages.length >= MAX_STAGES) throw new AppError("VALIDATION_FAILED", `A pipeline can have at most ${MAX_STAGES} stages.`);
    if (stages.some((s) => sameName(s.name, input.name))) throw new AppError("ALREADY_EXISTS", `There is already a stage called "${input.name}".`);

    const [created] = await tx
      .insert(pipelineStages)
      .values({ workspaceId: auth.workspaceId, name: input.name.trim(), kind: input.kind, position: stages.length })
      .returning({ id: pipelineStages.id });
    // A new open stage goes after the last open one (before Won/Lost); a Won or Lost stage goes at the end.
    const ids = stages.map((s) => s.id);
    const lastOpen = stages.map((s) => s.kind).lastIndexOf("open");
    ids.splice(input.kind === "open" ? lastOpen + 1 : ids.length, 0, created.id);
    await renumber(tx, auth.workspaceId, ids);
    await audit(tx, auth, "pipeline.stage_created", created.id, { name: input.name, kind: input.kind });
  });
  return listPipeline(auth);
}

/** Renaming never changes a stage's kind, so reporting on Won and Lost keeps working under any label. */
export async function renameStage(auth: AuthContext, stageId: string, name: string): Promise<PipelineStage[]> {
  await db.transaction(async (tx) => {
    const stages = await orderedStages(tx, auth.workspaceId);
    const stage = stages.find((s) => s.id === stageId);
    if (!stage) throw new AppError("NOT_FOUND", "Stage not found.");
    if (stages.some((s) => s.id !== stageId && sameName(s.name, name))) throw new AppError("ALREADY_EXISTS", `There is already a stage called "${name}".`);
    await tx.update(pipelineStages).set({ name: name.trim() }).where(eq(pipelineStages.id, stageId));
    await audit(tx, auth, "pipeline.stage_renamed", stageId, { from: stage.name, to: name });
  });
  return listPipeline(auth);
}

export async function reorderStages(auth: AuthContext, stageIds: string[]): Promise<PipelineStage[]> {
  await db.transaction(async (tx) => {
    const stages = await orderedStages(tx, auth.workspaceId);
    const known = new Set(stages.map((s) => s.id));
    if (stageIds.length !== stages.length || new Set(stageIds).size !== stageIds.length || !stageIds.every((id) => known.has(id))) {
      throw new AppError("VALIDATION_FAILED", "Send every stage exactly once.");
    }
    await renumber(tx, auth.workspaceId, stageIds);
    await audit(tx, auth, "pipeline.reordered", null, { order: stageIds });
  });
  return listPipeline(auth);
}

/**
 * Removes a stage. A workspace keeps at least one stage of each kind, so Won and Lost outcomes stay
 * identifiable; opportunities in the stage move to `moveTo`, which is required when there are any.
 */
export async function deleteStage(auth: AuthContext, stageId: string, moveTo: string | null): Promise<PipelineStage[]> {
  await db.transaction(async (tx) => {
    const stages = await orderedStages(tx, auth.workspaceId);
    const stage = stages.find((s) => s.id === stageId);
    if (!stage) throw new AppError("NOT_FOUND", "Stage not found.");
    if (stages.filter((s) => s.kind === stage.kind).length < 2) {
      throw new AppError("VALIDATION_FAILED", `Keep at least one "${STAGE_KIND_LABELS[stage.kind]}" stage. Add another before removing "${stage.name}".`);
    }
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(opportunities)
      .where(and(eq(opportunities.stageId, stageId), eq(opportunities.workspaceId, auth.workspaceId)));
    if (count > 0) {
      if (!moveTo || moveTo === stageId || !stages.some((s) => s.id === moveTo)) {
        throw new AppError("VALIDATION_FAILED", `${count} ${count === 1 ? "opportunity is" : "opportunities are"} in "${stage.name}". Choose a stage to move them to.`);
      }
      await tx.update(opportunities).set({ stageId: moveTo }).where(and(eq(opportunities.stageId, stageId), eq(opportunities.workspaceId, auth.workspaceId)));
    }
    await tx.delete(pipelineStages).where(eq(pipelineStages.id, stageId));
    await renumber(tx, auth.workspaceId, stages.filter((s) => s.id !== stageId).map((s) => s.id));
    await audit(tx, auth, "pipeline.stage_deleted", stageId, { name: stage.name, kind: stage.kind, moved: count, moveTo });
  });
  return listPipeline(auth);
}

const CATEGORY_ORDER: PipelineReportRow["category"][] = ["signal", "intent", "funded_company", "freelance_project"];

const finish = (row: Omit<PipelineReportRow, "winRate">): PipelineReportRow => ({ ...row, winRate: row.won + row.lost > 0 ? Math.round((row.won / (row.won + row.lost)) * 100) : null });

/**
 * Outcomes by source (spec section 12): how many opportunities are open, won or lost and the win rate,
 * for each category. Archived ones are counted on their own and are not an outcome. Won and Lost are
 * read from stage kind, so renaming them never changes the numbers.
 */
export async function pipelineReport(auth: AuthContext): Promise<PipelineReport> {
  const rows = await db
    .select({
      category: sql<PipelineReportRow["category"]>`coalesce(${opportunities.category}::text, 'signal')`,
      total: sql<number>`count(*)::int`,
      archived: sql<number>`(count(*) filter (where ${opportunities.archivedAt} is not null))::int`,
      open: sql<number>`(count(*) filter (where ${opportunities.archivedAt} is null and ${pipelineStages.kind} = 'open'))::int`,
      won: sql<number>`(count(*) filter (where ${opportunities.archivedAt} is null and ${pipelineStages.kind} = 'won'))::int`,
      lost: sql<number>`(count(*) filter (where ${opportunities.archivedAt} is null and ${pipelineStages.kind} = 'lost'))::int`,
    })
    .from(opportunities)
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .where(eq(opportunities.workspaceId, auth.workspaceId))
    .groupBy(sql`coalesce(${opportunities.category}::text, 'signal')`);

  const byCategory = new Map(rows.map((r) => [r.category, r]));
  const ordered = CATEGORY_ORDER.map((category) => finish(byCategory.get(category) ?? { category, total: 0, open: 0, won: 0, lost: 0, archived: 0 }));
  const sum = (key: "total" | "open" | "won" | "lost" | "archived") => ordered.reduce((acc, r) => acc + r[key], 0);
  return { rows: ordered, total: finish({ category: "signal", total: sum("total"), open: sum("open"), won: sum("won"), lost: sum("lost"), archived: sum("archived") }) };
}
