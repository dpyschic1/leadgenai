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

/** Priority of work a person is waiting for. */
const WANTED = 10;

/**
 * Someone opened this company (or its opportunity) and it has no contacts yet: its queued website
 * and contact jobs go to the front of the queue, due now, and a website search is queued when none
 * is. The next tick (within a minute) picks them up.
 */
export async function contactsWanted(workspaceId: string, companyId: string): Promise<void> {
  const bumped = await db
    .update(ingestionJobs)
    .set({ priority: WANTED, runAfter: sql`least(${ingestionJobs.runAfter}, now())` })
    .where(
      and(
        eq(ingestionJobs.workspaceId, workspaceId),
        eq(ingestionJobs.entityId, companyId),
        eq(ingestionJobs.status, "queued"),
        sql`${ingestionJobs.kind} in ('enrich_company', 'scan_website')`,
      ),
    )
    .returning({ id: ingestionJobs.id });
  if (bumped.length === 0) {
    await db.insert(ingestionJobs).values({ workspaceId, kind: "enrich_company", entityId: companyId, priority: WANTED }).onConflictDoNothing();
  }
}

/** The jobs that find a company's website and contacts: all the enrichment lanes take. */
export const ENRICHMENT_KINDS = ["enrich_company", "scan_website", "scan_job_board"] as const;

/**
 * Claims the next due job (optionally for one workspace, or `only` of some kinds), marking it
 * running.
 */
export async function claimNext(workspaceId?: string, { only = [] }: { only?: readonly IngestionJobKind[] } = {}): Promise<JobRow | null> {
  const scope = sql`${workspaceId ? sql`and workspace_id = ${workspaceId}` : sql``} ${only.length > 0 ? sql`and kind in (${sql.join(only.map((k) => sql`${k}::ingestion_job_kind`), sql`, `)})` : sql``}`;
  const rows = await db.execute<{ id: string }>(sql`
    update ingestion_jobs set status = 'running', started_at = now(), attempts = attempts + 1
    where id = (
      select id from ingestion_jobs j
      where ((status = 'queued' and run_after <= now())
          or (status = 'running' and started_at < now() - make_interval(secs => ${STALE_RUNNING_MS / 1000})))
        ${scope}
      -- The once-a-day discovery jobs go before routine per-company checks, so "Run now" isn't stuck
      -- behind a backlog of slow website reads. Matching the shared jobs (evaluate_boards) needs no
      -- AI and takes seconds, so it goes first too: it is what fills a new workspace.
      -- Workspaces take turns: the one that started the fewest jobs in the last 10 minutes goes
      -- next, so a new workspace isn't stuck behind another's backlog (the AI allows ~1 job a minute).
      -- A person waiting (an opportunity opened without contacts) goes first of all, then
      -- discovery; among per-company jobs, the best opportunities first.
      -- Contact work in contact order: reading a known website gives contacts now; finding a
      -- website comes next; a job-board scan adds jobs, not contacts, so it waits.
      order by priority desc,
        case kind when 'scan_website' then 0 when 'enrich_company' then 1 when 'scan_job_board' then 2 else 0 end,
        (kind in ('discover_companies', 'discover_cqc', 'discover_npi', 'discover_theirstack', 'discover_yc', 'scan_tenders', 'evaluate_boards')) desc,
        (select count(*) from ingestion_jobs r
          where r.workspace_id = j.workspace_id and r.started_at > now() - interval '10 minutes'),
        (select o.opportunity_score from opportunities o where o.company_id = j.entity_id and o.workspace_id = j.workspace_id) desc nulls last,
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
