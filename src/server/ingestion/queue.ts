import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { ingestionJobs, sources, workspaceSources } from "@/db/schema";
import type { IngestionJobKind, SourceSlug } from "@/lib/domain/sources";
import { SOURCE_ADAPTERS } from "@/server/sources";

/**
 * The background job queue (Postgres): enqueue is idempotent (one open job per thing to do), the
 * worker claims due jobs with SKIP LOCKED so parallel ticks never run the same job, and failures
 * back off exponentially before giving up.
 */

export type JobRow = typeof ingestionJobs.$inferSelect;

/** Attempts before a failing job is given up as `failed`. */
export const MAX_ATTEMPTS = 4;
/** A job left `running` this long (its worker died) is picked up again. */
const STALE_RUNNING_MS = 5 * 60 * 1000;

export async function enqueue(
  conn: Tx | typeof db,
  job: { workspaceId: string; kind: IngestionJobKind; entityId: string; runAfter?: Date },
): Promise<boolean> {
  const rows = await conn
    .insert(ingestionJobs)
    .values({
      workspaceId: job.workspaceId,
      kind: job.kind,
      entityId: job.entityId,
      runAfter: job.runAfter ?? new Date(),
    })
    // The partial unique index on open jobs: already queued or running means nothing to add.
    .onConflictDoNothing()
    .returning({ id: ingestionJobs.id });
  return rows.length > 0;
}

/** Claims the next due job (optionally for one workspace), marking it running. */
export async function claimNext(workspaceId?: string): Promise<JobRow | null> {
  const scope = workspaceId ? sql`and workspace_id = ${workspaceId}` : sql``;
  const rows = await db.execute<{ id: string }>(sql`
    update ingestion_jobs set status = 'running', started_at = now(), attempts = attempts + 1
    where id = (
      select id from ingestion_jobs j
      where ((status = 'queued' and run_after <= now())
          or (status = 'running' and started_at < now() - make_interval(secs => ${STALE_RUNNING_MS / 1000})))
        ${scope}
      -- The once-a-day discovery jobs go before routine per-company checks, so "Run now" isn't stuck
      -- behind a backlog of slow website reads. Board evaluation repeats every few minutes while
      -- boards wait, so it takes its turn by time instead of starving the website reads.
      -- Workspaces take turns: the one that started the fewest jobs in the last 10 minutes goes
      -- next, so a new workspace isn't stuck behind another's backlog (the AI allows ~1 job a minute).
      order by (kind in ('discover_companies', 'discover_cqc', 'discover_npi', 'discover_theirstack', 'discover_yc', 'scan_tenders')) desc,
        (select count(*) from ingestion_jobs r
          where r.workspace_id = j.workspace_id and r.started_at > now() - interval '10 minutes'),
        run_after
      limit 1
      for update skip locked
    )
    returning id`);
  const id = rows[0]?.id;
  if (!id) return null;
  const [job] = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, id));
  return job ?? null;
}

export async function markDone(job: JobRow, aiCalls: number, status: "done" | "skipped" = "done"): Promise<void> {
  await db
    .update(ingestionJobs)
    .set({ status, finishedAt: new Date(), aiCalls: sql`${ingestionJobs.aiCalls} + ${aiCalls}`, lastError: null })
    .where(eq(ingestionJobs.id, job.id));
}

/** Puts the job back for later without counting the attempt (e.g. the AI's per-minute limit). */
export async function postpone(job: JobRow, delayMs: number, reason: string, aiCalls: number): Promise<void> {
  await db
    .update(ingestionJobs)
    .set({
      status: "queued",
      runAfter: new Date(Date.now() + delayMs),
      attempts: sql`greatest(${ingestionJobs.attempts} - 1, 0)`,
      lastError: reason,
      aiCalls: sql`${ingestionJobs.aiCalls} + ${aiCalls}`,
    })
    .where(eq(ingestionJobs.id, job.id));
}

/** Retries with backoff (1, 4, 16 minutes), then gives up. Other jobs are never blocked. */
export async function markFailed(job: JobRow, error: string, aiCalls: number): Promise<void> {
  const giveUp = job.attempts >= MAX_ATTEMPTS;
  await db
    .update(ingestionJobs)
    .set({
      status: giveUp ? "failed" : "queued",
      runAfter: new Date(Date.now() + 60_000 * 4 ** (job.attempts - 1)),
      finishedAt: giveUp ? new Date() : null,
      lastError: error.slice(0, 500),
      aiCalls: sql`${ingestionJobs.aiCalls} + ${aiCalls}`,
    })
    .where(and(eq(ingestionJobs.id, job.id)));
}

/**
 * Whether a source may run for a workspace (SRS §11.3, FR-SIG-005): the platform has approved it,
 * the workspace hasn't switched it off, and the adapter has what it needs (e.g. an API key).
 */
export async function sourceRunnable(workspaceId: string, slug: SourceSlug): Promise<boolean> {
  if (!SOURCE_ADAPTERS[slug].isConfigured()) return false;
  const [row] = await db
    .select({ status: sources.authorizationStatus, enabled: workspaceSources.enabled })
    .from(sources)
    .leftJoin(workspaceSources, and(eq(workspaceSources.sourceSlug, sources.slug), eq(workspaceSources.workspaceId, workspaceId)))
    .where(eq(sources.slug, slug))
    .limit(1);
  return row?.status === "approved" && row.enabled !== false;
}
