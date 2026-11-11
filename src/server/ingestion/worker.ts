import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import type { IngestionJobKind } from "@/lib/domain/sources";
import { AppError } from "@/server/http/errors";
import { collectFromArchive, validateDueBoards } from "@/server/sources/board-directory";
import { HANDLERS, jobContext } from "./handlers";
import { detectYcBoards } from "@/server/sources/yc";
import { analyzeSharedJobs, categorizeBoardJobs } from "./shared-jobs";
import { claimNext, ENRICHMENT_KINDS, enqueue, markDone, markFailed, postpone, type JobRow } from "./queue";

/**
 * One "tick" of background processing: queue each workspace's daily checks (from its Services &
 * ICP, no setup needed), then run queued jobs one at a time until the time budget is used. Called
 * every few minutes by the scheduler (`/api/v1/internal/tick`) and by "Run now".
 */

export type TickResult = { processed: number; failed: number; postponed: number };

/** Stop claiming new jobs after this long, so the request ends well inside the hosting limit. */
const DEFAULT_BUDGET_MS = 40_000;

/** Workspace-wide checks that run once a day for every workspace with services. */
const DAILY_KINDS = ["discover_companies", "discover_cqc", "evaluate_boards", "scan_tenders", "match_osm", "discover_npi", "discover_theirstack", "discover_yc"] as const;

/**
 * Queues today's discovery and tender checks for workspaces that have services, each a day after
 * the last one finished. The open-job unique index keeps it to one queued job per kind.
 */
export async function queueDailyChecks(workspaceId?: string): Promise<void> {
  for (const kind of DAILY_KINDS) {
    await db.execute(sql`
      insert into ingestion_jobs (workspace_id, kind, entity_id, run_after)
      select w.id, ${kind}::ingestion_job_kind, w.id,
        coalesce((select max(j.finished_at) + interval '1 day' from ingestion_jobs j
                  where j.workspace_id = w.id and j.kind = ${kind}::ingestion_job_kind and j.status in ('done', 'skipped', 'failed')), now())
      from workspaces w
      where exists (select 1 from services s where s.workspace_id = w.id)
        ${workspaceId ? sql`and w.id = ${workspaceId}` : sql``}
      on conflict do nothing`);
  }
}

/** A workspace's matching runs again at most this often when new jobs reach the shared pool. */
const REMATCH_MS = 15 * 60_000;

/**
 * New jobs just reached the shared pool: each workspace's queued matching, scheduled for its daily
 * run, is brought forward, unless that workspace matched within the last 15 minutes. New jobs
 * reach every workspace within minutes, not the next day.
 */
async function matchSoon(): Promise<void> {
  await db.execute(sql`
    update ingestion_jobs j set run_after = now()
    where j.kind = 'evaluate_boards' and j.status = 'queued' and j.run_after > now()
      and not exists (
        select 1 from ingestion_jobs r
        where r.workspace_id = j.workspace_id and r.kind = 'evaluate_boards' and r.status = 'done'
          and r.finished_at > now() - make_interval(secs => ${REMATCH_MS / 1000}))`);
}

/** "Run now" / services just saved: the workspace's discovery and tender checks, due immediately. */
export async function queueChecksNow(workspaceId: string): Promise<void> {
  for (const kind of DAILY_KINDS) {
    await db.execute(sql`
      update ingestion_jobs set run_after = now()
      where workspace_id = ${workspaceId} and kind = ${kind}::ingestion_job_kind and status = 'queued'`);
    await enqueue(db, { workspaceId, kind, entityId: workspaceId });
  }
}

/** Lanes that only find websites and contacts, beside the one general lane. */
const ENRICHMENT_LANES = 8;
/** Share of a tick's budget given to shared job-board discovery before workspace jobs run. */
const SHARED_SHARE = 0.4;
/** Below this many boards waiting to be checked, read more candidates from the archive. */
const MIN_UNCHECKED = 25;
/** YC companies whose job board is looked for per tick (a website read, ~20 s each). */
const YC_BOARDS_PER_TICK = 1;
/** Boards checked per tick (one request each to the provider). */
const BOARDS_PER_TICK = 10;
/** Shared AI readings started per tick (each up to a few seconds on the free plan). */
const AI_READINGS_PER_TICK = 3;

/**
 * Job-board discovery shared by every workspace: read more candidates from the archive when few
 * are waiting, then validate and cache the boards that are due. Skipped when the source is not
 * approved platform-wide. A failure here never stops the workspace jobs.
 */
async function runSharedStep(deadline: number): Promise<void> {
  const [source] = await db.select({ status: sources.authorizationStatus }).from(sources).where(eq(sources.slug, "board_directory"));
  if (source?.status !== "approved") return;
  // Quickest and most important first, so a slow step later never starves them: sort the new jobs
  // (free, milliseconds) and tell the workspaces; then a few AI readings; then refresh job boards;
  // last, with whatever time is left, find one YC company's board (a website read, ~20 s).
  await shared("job sorting", async () => {
    if ((await categorizeBoardJobs()) > 0) await matchSoon();
  });
  await shared("job analysis", () => analyzeSharedJobs({ deadline, limit: AI_READINGS_PER_TICK }), deadline);
  await shared(
    "job boards",
    async () => {
      const [{ waiting }] = await db.execute<{ waiting: number }>(sql`
        select count(*)::int as waiting from job_board_directory where validation_status = 'unverified'`);
      if (waiting < MIN_UNCHECKED) await collectFromArchive();
      if (Date.now() < deadline) await validateDueBoards({ limit: BOARDS_PER_TICK, deadline });
    },
    deadline,
  );
  await shared(
    "YC boards",
    async () => {
      const [yc] = await db.select({ status: sources.authorizationStatus }).from(sources).where(eq(sources.slug, "yc_directory"));
      if (yc?.status === "approved") await detectYcBoards({ limit: YC_BOARDS_PER_TICK, deadline });
    },
    deadline,
  );
}

/** One shared step: skipped past the deadline, and a failure never stops the others. */
async function shared(name: string, step: () => Promise<unknown>, deadline = Infinity): Promise<void> {
  if (Date.now() >= deadline) return;
  try {
    await step();
  } catch (error) {
    console.error(`[ingestion] shared step "${name}" failed`, error);
  }
}

export async function runTick({ workspaceId, budgetMs = DEFAULT_BUDGET_MS }: { workspaceId?: string; budgetMs?: number } = {}): Promise<TickResult> {
  const startedAt = Date.now();
  const result: TickResult = { processed: 0, failed: 0, postponed: 0 };
  await queueDailyChecks(workspaceId);
  // Shared work first (archive reading, board checks), within a slice of the budget.
  await runSharedStep(startedAt + budgetMs * SHARED_SHARE);

  // Lanes run side by side, each claiming jobs until the budget is used: one takes jobs in the
  // usual order (matching and discovery first), the others take only per-company website and
  // contact jobs, so a matching run that adds 40 companies never holds their contacts back, and
  // workspace-wide jobs keep their order in the one lane (discovery before matching places to it). Website reads mostly
  // wait on other servers, and each site still gets one request at a time (`politeGet`).
  const lane = async (only: readonly IngestionJobKind[]) => {
    while (Date.now() - startedAt < budgetMs) {
      const job = await claimNext(workspaceId, { only });
      if (!job) return;
      result[await runJob(job)]++;
    }
  };
  await Promise.all([lane([]), ...Array.from({ length: ENRICHMENT_LANES }, () => lane(ENRICHMENT_KINDS))]);
  return result;
}

async function runJob(job: JobRow): Promise<keyof TickResult> {
  const context = jobContext(job);
  try {
    const { followUps, skipped } = await HANDLERS[job.kind](context);
    await markDone(job, context.aiCalls(), skipped ? "skipped" : "done");
    for (const followUp of followUps) {
      await enqueue(db, { workspaceId: job.workspaceId, kind: followUp.kind, entityId: followUp.entityId, runAfter: followUp.runAfter });
    }
    return "processed";
  } catch (error) {
    if (error instanceof AppError && (error.code === "AI_BUSY" || error.code === "RATE_LIMITED")) {
      // The AI's per-minute limit: try again shortly. The daily budget: try again in an hour.
      const delay = error.code === "AI_BUSY" ? 2 * 60_000 : 60 * 60_000;
      await postpone(job, delay, error.message, context.aiCalls());
      return "postponed";
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ingestion] ${job.kind} ${job.entityId} failed (attempt ${job.attempts})`, error);
    await markFailed(job, message, context.aiCalls());
    return "failed";
  }
}

/**
 * Right after a service is saved: this workspace's queued jobs, matching first (it goes before
 * other kinds and needs no AI), within a short budget. Errors are logged, never thrown: the
 * regular tick picks up whatever is left.
 */
export async function matchNow(workspaceId: string): Promise<void> {
  try {
    await runTick({ workspaceId, budgetMs: 25_000 });
  } catch (error) {
    console.error("[ingestion] matching after a service change failed", error);
  }
}
