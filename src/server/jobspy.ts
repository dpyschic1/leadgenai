import "server-only";
import { count, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { JobspyJobRow, JobspyRunRow, JobspyStatus } from "@/lib/api/jobspy";
import { JOBSPY_BOARDS, JOBSPY_COOLDOWN_MINUTES, type JobspyBoard, jobspyRunSchema } from "@/lib/validation/jobspy";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { jobspyEnabled } from "@/server/jobspy-opportunities";
import type { z } from "zod";

/**
 * JobSpy import (Settings → JobSpy import). Calls the separate JobSpy service (jobspy-service/)
 * and stores what it returns in its own tables. They reach Opportunities only through
 * jobspy-opportunities.ts, in workspaces that switch it on.
 */

const COOLDOWN_MS = JOBSPY_COOLDOWN_MINUTES * 60_000;
/** The route may run 60 s; leave time to save. */
const SERVICE_TIMEOUT_MS = 50_000;
const MAX_DESCRIPTION = 20_000;
/** A run with no status after this long was cut off (timeout, restart). */
const STALE_RUN_MS = 2 * 60_000;

const serviceUrl = () => (process.env.JOBSPY_SERVICE_URL ?? "").replace(/\/+$/, "");
const serviceKey = () => process.env.JOBSPY_SERVICE_KEY ?? "";
const configured = () => Boolean(serviceUrl() && serviceKey());

const { jobspyRuns: runs, jobspyJobs: jobs } = schema;

function toRunRow(run: typeof runs.$inferSelect): JobspyRunRow {
  const stale = !run.status && Date.now() - run.startedAt.getTime() > STALE_RUN_MS;
  return {
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    status: run.status ?? (stale ? "interrupted" : "running"),
    searchTerm: run.searchTerm,
    location: run.location,
    boards: run.boards,
    resultsPerBoard: run.resultsPerBoard,
    found: run.found,
    created: run.created,
    errors: run.errors,
  };
}

export async function jobspyStatus(workspaceId: string): Promise<JobspyStatus> {
  const [lastRun] = await db.select().from(runs).orderBy(desc(runs.startedAt)).limit(1);
  const totals = await db.select({ board: jobs.board, jobs: count() }).from(jobs).groupBy(jobs.board);
  const recent = await db
    .select({
      id: jobs.id,
      board: jobs.board,
      title: jobs.title,
      company: jobs.company,
      location: jobs.location,
      jobUrl: jobs.jobUrl,
      datePosted: jobs.datePosted,
      firstSeenAt: jobs.firstSeenAt,
    })
    .from(jobs)
    .orderBy(desc(jobs.firstSeenAt), desc(jobs.datePosted))
    .limit(10);

  return {
    configured: configured(),
    sendToOpportunities: await jobspyEnabled(workspaceId),
    cooldownMinutes: JOBSPY_COOLDOWN_MINUTES,
    nextRunAt: lastRun ? new Date(lastRun.startedAt.getTime() + COOLDOWN_MS).toISOString() : null,
    lastRun: lastRun ? toRunRow(lastRun) : null,
    totals: Object.fromEntries(totals.map((t) => [t.board, t.jobs])),
    recent: recent.map((j): JobspyJobRow => ({ ...j, firstSeenAt: j.firstSeenAt.toISOString() })),
  };
}

/** One job as the service returns it (JobSpy's JobPost fields; emails are stripped by the service). */
type ServiceJob = {
  site?: string | null;
  job_url?: string | null;
  job_url_direct?: string | null;
  title?: string | null;
  company?: string | null;
  company_url_direct?: string | null;
  location?: string | null;
  is_remote?: boolean | null;
  job_type?: string | null;
  date_posted?: string | null;
  interval?: string | null;
  min_amount?: number | null;
  max_amount?: number | null;
  currency?: string | null;
  description?: string | null;
};

const httpUrl = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v) ? v.slice(0, 2000) : null);
const str = (v: unknown, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isoDate = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

function toJobRow(job: ServiceJob, runId: string): typeof jobs.$inferInsert | null {
  const board = job.site as JobspyBoard;
  const jobUrl = httpUrl(job.job_url);
  const title = str(job.title);
  if (!JOBSPY_BOARDS.includes(board) || !jobUrl || !title) return null;
  return {
    board,
    jobUrl,
    jobUrlDirect: httpUrl(job.job_url_direct),
    title,
    company: str(job.company, 300),
    companyUrl: httpUrl(job.company_url_direct),
    location: str(job.location, 300),
    isRemote: typeof job.is_remote === "boolean" ? job.is_remote : null,
    jobType: str(job.job_type, 100),
    datePosted: isoDate(job.date_posted),
    salaryMin: num(job.min_amount),
    salaryMax: num(job.max_amount),
    salaryInterval: str(job.interval, 20),
    currency: str(job.currency, 10),
    description: str(job.description, MAX_DESCRIPTION),
    firstRunId: runId,
  };
}

async function callService(input: z.output<typeof jobspyRunSchema>) {
  const response = await fetch(`${serviceUrl()}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey()}` },
    body: JSON.stringify({
      boards: input.boards,
      search_term: input.searchTerm,
      location: input.location,
      results_wanted: input.resultsPerBoard,
      hours_old: input.hoursOld,
    }),
    signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as { jobs?: ServiceJob[]; errors?: Record<string, string>; error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `The JobSpy service answered ${response.status}.`);
  return { jobs: Array.isArray(body?.jobs) ? body.jobs : [], errors: body?.errors ?? {} };
}

export async function runJobspy(auth: AuthContext, input: z.output<typeof jobspyRunSchema>): Promise<JobspyStatus> {
  if (!configured()) {
    throw new AppError("VALIDATION_FAILED", "JobSpy import isn't set up: add JOBSPY_SERVICE_URL and JOBSPY_SERVICE_KEY to the server's environment.");
  }

  // Claim the slot: one run per cooldown across all workspaces, even if two people press Run at once.
  const run = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('jobspy_import'))`);
    const [last] = await tx.select({ startedAt: runs.startedAt }).from(runs).orderBy(desc(runs.startedAt)).limit(1);
    const waitMs = last ? last.startedAt.getTime() + COOLDOWN_MS - Date.now() : 0;
    if (waitMs > 0) {
      const minutes = Math.ceil(waitMs / 60_000);
      throw new AppError("RATE_LIMITED", `JobSpy import can run again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, undefined, {
        retryAfter: Math.ceil(waitMs / 1000),
      });
    }
    const [created] = await tx
      .insert(runs)
      .values({ requestedBy: auth.userId, searchTerm: input.searchTerm, location: input.location, boards: input.boards, resultsPerBoard: input.resultsPerBoard })
      .returning({ id: runs.id });
    return created;
  });

  let found = 0;
  let created = 0;
  let errors: Record<string, string> = {};
  try {
    const result = await callService(input);
    errors = result.errors;
    // One row per job URL: the same post can come back twice in one search.
    const rows = [...new Map(result.jobs.map((j) => toJobRow(j, run.id)).filter((r) => r !== null).map((r) => [r.jobUrl, r])).values()];
    found = rows.length;
    if (rows.length) {
      const saved = await db
        .insert(jobs)
        .values(rows)
        .onConflictDoUpdate({ target: jobs.jobUrl, set: { lastSeenAt: sql`now()` } })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      created = saved.filter((s) => s.inserted).length;
    }
  } catch (error) {
    errors = { ...errors, service: error instanceof Error ? error.message.slice(0, 500) : "The JobSpy service failed." };
  }

  const failedBoards = input.boards.filter((b) => errors[b]).length;
  const status = errors.service || failedBoards === input.boards.length ? "failed" : failedBoards ? "partial" : "success";
  await db.update(runs).set({ finishedAt: new Date(), status, found, created, errors }).where(eq(runs.id, run.id));
  return jobspyStatus(auth.workspaceId);
}
