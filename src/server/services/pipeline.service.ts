import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { auditLogs, opportunities, pipelineStages } from "@/db/schema";
import { QUALIFY_MIN_SCORE } from "@/lib/domain/opportunities";
import { DASHBOARD_DAYS, DEFAULT_STAGES, MAX_STAGES, STAGE_KIND_LABELS, type DashboardReport, type PipelineReport, type PipelineReportRow, type PipelineStage, type StageKind, type StageRef } from "@/lib/domain/pipeline";
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

/**
 * The dashboard: the funnel from found to won, how the AI judged what it read, the last 30 days of
 * finds and new leads, and which sources they came from. Counts only what the team works with:
 * archived and competitor-hidden opportunities are left out.
 */
export async function dashboardReport(auth: AuthContext): Promise<DashboardReport> {
  const intake = await intakeStageId(db, auth.workspaceId);
  const visible = and(eq(opportunities.workspaceId, auth.workspaceId), isNull(opportunities.hiddenReason), isNull(opportunities.archivedAt));
  const isLead = sql`${opportunities.qualification} in ('hot', 'warm')`;
  const foundAt = sql`coalesce(${opportunities.discoveredAt}, ${opportunities.createdAt})`;
  const n = (condition: ReturnType<typeof sql>) => sql<number>`(count(*) filter (where ${condition}))::int`;
  const daysAgo = (days: number) => sql`now() - make_interval(days => ${days})`;
  const day = (at: ReturnType<typeof sql>) => sql<string>`to_char(${at} at time zone 'UTC', 'YYYY-MM-DD')`;
  const category = sql<DashboardReport["sources"][number]["category"]>`coalesce(${opportunities.category}::text, 'signal')`;

  const [[t], foundDaily, leadDaily, sources] = await Promise.all([
    db
      .select({
        found: sql<number>`count(*)::int`,
        checked: n(sql`${opportunities.qualification} is not null`),
        hot: n(sql`${opportunities.qualification} = 'hot'`),
        warm: n(sql`${opportunities.qualification} = 'warm'`),
        notFit: n(sql`${opportunities.qualification} = 'not_fit'`),
        awaiting: n(sql`${opportunities.qualification} is null and coalesce(${opportunities.opportunityScore}, 0) >= ${QUALIFY_MIN_SCORE}`),
        tooWeak: n(sql`${opportunities.qualification} is null and coalesce(${opportunities.opportunityScore}, 0) < ${QUALIFY_MIN_SCORE}`),
        worked: n(sql`${isLead} and ${opportunities.stageId} <> ${intake}`),
        won: n(sql`${isLead} and ${pipelineStages.kind} = 'won'`),
        foundThisWeek: n(sql`${foundAt} >= ${daysAgo(7)}`),
        foundLastWeek: n(sql`${foundAt} >= ${daysAgo(14)} and ${foundAt} < ${daysAgo(7)}`),
        leadsThisWeek: n(sql`${isLead} and ${opportunities.qualifiedAt} >= ${daysAgo(7)}`),
        leadsLastWeek: n(sql`${isLead} and ${opportunities.qualifiedAt} >= ${daysAgo(14)} and ${opportunities.qualifiedAt} < ${daysAgo(7)}`),
      })
      .from(opportunities)
      .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
      .where(visible),
    db
      .select({ date: day(foundAt), count: sql<number>`count(*)::int` })
      .from(opportunities)
      .where(and(visible, sql`${foundAt} >= ${daysAgo(DASHBOARD_DAYS)}`))
      .groupBy(day(foundAt)),
    db
      .select({ date: day(sql`${opportunities.qualifiedAt}`), count: sql<number>`count(*)::int` })
      .from(opportunities)
      .where(and(visible, isLead, sql`${opportunities.qualifiedAt} >= ${daysAgo(DASHBOARD_DAYS)}`))
      .groupBy(day(sql`${opportunities.qualifiedAt}`)),
    db
      .select({ category, found: sql<number>`count(*)::int`, leads: n(isLead) })
      .from(opportunities)
      .where(visible)
      .groupBy(category),
  ]);

  // Every day in the window, including the ones with nothing found.
  const found = new Map(foundDaily.map((r) => [r.date, r.count]));
  const leads = new Map(leadDaily.map((r) => [r.date, r.count]));
  const today = new Date();
  const daily = Array.from({ length: DASHBOARD_DAYS }, (_, i) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (DASHBOARD_DAYS - 1 - i))).toISOString().slice(0, 10);
    return { date, found: found.get(date) ?? 0, leads: leads.get(date) ?? 0 };
  });

  return {
    funnel: { found: t.found, checked: t.checked, leads: t.hot + t.warm, worked: t.worked, won: t.won },
    quality: { hot: t.hot, warm: t.warm, notFit: t.notFit, awaiting: t.awaiting, tooWeak: t.tooWeak },
    thisWeek: { found: t.foundThisWeek, leads: t.leadsThisWeek },
    lastWeek: { found: t.foundLastWeek, leads: t.leadsLastWeek },
    daily,
    sources: sources.filter((s) => s.found > 0).sort((a, b) => b.found - a.found),
  };
}
