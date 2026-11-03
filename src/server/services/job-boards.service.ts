import "server-only";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { auditLogs, companies, companyJobBoards, jobPostings } from "@/db/schema";
import type { JobBoardProvider } from "@/lib/domain/job-boards";
import { MAX_SOURCE_TEXT } from "@/lib/validation/signals";
import { triageJobs, TRIAGE_BATCH_SIZE } from "@/server/ai/job-triage";
import { analyzeSignal } from "@/server/ai/signal-analysis";
import type { Actor } from "@/server/auth/actor";
import { AppError } from "@/server/http/errors";
import { rateLimit } from "@/server/http/rate-limit";
import { MAX_JOBS_PER_BOARD } from "@/server/jobs/fetch-jobs";
import { BOARD_FRESH_MS, boardJobsFor, jobInCountries, type CachedJob } from "@/server/sources/board-directory";
import {
  jobSignalValues,
  jobSourceText,
  MAX_JOB_TEXT,
  rejectionReason,
  roleKey,
  SIGNAL_DELETED_REASON,
} from "@/server/jobs/job-signal";
import { getReferenceData } from "./reference-data.service";
import { loadServices } from "./services.service";
import { insertDetectedSignal } from "./signals.service";

/**
 * A company's job board, found automatically on its website: download the open jobs, screen them
 * with AI against the workspace's services, and record the relevant ones as signals with the job
 * link as evidence.
 *
 * AI runs in two stages to stay inside the free quota: a cheap title check for every new job,
 * then a full signal analysis only for the relevant ones, a few per run. Whatever is left waits
 * for the next run (a few minutes later). The caller re-scores the company afterwards.
 */

/** Why a job was skipped without the AI: it is outside every country the workspace sells to. */
export const OUTSIDE_REGIONS = "Outside the countries your services target";

/** What one sync of a board did. */
export type JobFetchResult = {
  /** Jobs open on the board now. */
  open: number;
  /** Jobs seen for the first time. */
  added: number;
  /** Jobs that are no longer listed. */
  closed: number;
  signalsCreated: number;
  skipped: number;
  /** Open jobs still waiting for the AI (picked up by the next run). */
  pending: number;
  /** Why the AI stopped before finishing, e.g. its quota ran out. */
  stoppedReason: string | null;
};

/*
 * Per-fetch AI budget. The free Groq plan allows ~8,000 tokens a minute: about two title checks
 * plus two or three full analyses. More waits for the next fetch (one a minute per company).
 */
/** New jobs screened per fetch (two title-check calls). */
const MAX_TRIAGE_PER_FETCH = TRIAGE_BATCH_SIZE * 2;
/** Roles given the full analysis per fetch. */
const MAX_ANALYSES_PER_FETCH = 3;
/** Stop starting AI calls after this long, so the request finishes inside the hosting time limit. */
const AI_TIME_BUDGET_MS = 30_000;
/** Rows per upsert statement. */
const UPSERT_CHUNK = 100;

type JobRow = typeof jobPostings.$inferSelect;
type BoardRow = typeof companyJobBoards.$inferSelect;

/**
 * Connects a board the system found (careers-page link or name match), unless one is already set:
 * a board chosen by a person is never replaced. Returns true when it connected one.
 */
export async function connectDetectedBoard(
  actor: Actor,
  companyId: string,
  board: { provider: JobBoardProvider; boardToken: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(companyJobBoards)
      .values({ companyId, workspaceId: actor.workspaceId, provider: board.provider, boardToken: board.boardToken, autoDetected: true })
      .onConflictDoNothing()
      .returning({ companyId: companyJobBoards.companyId });
    if (inserted.length === 0) return false;
    await audit(tx, actor, "job_board.detected", companyId, { provider: board.provider, boardToken: board.boardToken });
    return true;
  });
}

/**
 * Refreshes the company's jobs and records the relevant ones as signals (background ingestion,
 * `actor.userId` null). The caller re-scores the company afterwards.
 */
export async function syncCompanyJobs(
  auth: Actor,
  companyId: string,
  { freshWithinMs = BOARD_FRESH_MS }: { freshWithinMs?: number } = {},
): Promise<JobFetchResult> {
  const company = await loadCompany(auth, companyId);
  const [board] = await db.select().from(companyJobBoards).where(boardOf(auth, companyId)).limit(1);
  if (!board) throw new AppError("NOT_FOUND", "Connect a job board first.");
  const services = await loadServices(auth.workspaceId);
  if (services.length === 0) {
    throw new AppError("VALIDATION_FAILED", "Add your services first (Services & ICP), so the AI knows which jobs matter to you.");
  }

  // From the shared cache: a board several workspaces watch is downloaded once.
  let fetched: CachedJob[];
  try {
    fetched = await boardJobsFor(board.provider, board.boardToken, freshWithinMs);
  } catch (error) {
    const message = error instanceof AppError ? error.message : "The job board couldn't be reached.";
    await db.update(companyJobBoards).set({ lastError: message, lastFetchedAt: new Date() }).where(boardOf(auth, companyId));
    throw error;
  }

  const { added, closed } = await storeJobs(auth, companyId, board, fetched);

  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > AI_TIME_BUDGET_MS;
  const ref = await getReferenceData();
  let stoppedReason: string | null = null;
  let skipped = 0;
  let signalsCreated = 0;

  /** Runs one AI step; returns false (and records why) when the AI can't continue this fetch. */
  const aiStep = async (step: () => Promise<void>): Promise<boolean> => {
    if (outOfTime()) {
      stoppedReason = "Stopped to stay within the time limit; the rest continues on the next run.";
      return false;
    }
    try {
      await rateLimit("aiWorkspace", auth.workspaceId);
      await step();
      return true;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const reasons: Partial<Record<AppError["code"], string>> = {
        AI_BUSY: "The free AI checks only a few jobs a minute. Fetch again in a minute to continue.",
        RATE_LIMITED: "Your workspace's daily AI limit is used up. The remaining jobs will be checked on a later fetch.",
        AI_FAILED: "The AI couldn't check some jobs. Fetch again to retry them.",
        AI_UNAVAILABLE: error.message,
      };
      const reason = reasons[error.code];
      if (!reason) throw error;
      stoppedReason = reason;
      return false;
    }
  };

  // Jobs outside the countries the workspace sells to are skipped without asking the AI.
  const countries = [...new Set(services.flatMap((s) => s.targetCountries))];
  const pendingNow = await openJobs(auth, companyId, eq(jobPostings.triage, "pending"), MAX_JOBS_PER_BOARD);
  const outside = pendingNow.filter((job) => !jobInCountries(job.location, countries)).map((job) => job.id);
  if (outside.length > 0) {
    skipped += outside.length;
    await db.update(jobPostings).set({ triage: "skipped", triageReason: OUTSIDE_REGIONS }).where(inArray(jobPostings.id, outside));
  }

  // Stage 1: title check for jobs the AI hasn't seen yet.
  const untriaged = await openJobs(auth, companyId, eq(jobPostings.triage, "pending"), MAX_TRIAGE_PER_FETCH);
  for (let start = 0; start < untriaged.length; start += TRIAGE_BATCH_SIZE) {
    const batch = untriaged.slice(start, start + TRIAGE_BATCH_SIZE);
    const ok = await aiStep(async () => {
      const verdicts = await triageJobs(batch, services, ref);
      await db.transaction(async (tx) => {
        for (const [index, verdict] of verdicts.entries()) {
          if (!verdict) continue;
          if (!verdict.relevant) skipped++;
          await tx
            .update(jobPostings)
            .set({ triage: verdict.relevant ? "relevant" : "skipped", triageReason: verdict.reason })
            .where(eq(jobPostings.id, batch[index].id));
        }
      });
    });
    if (!ok) break;
  }

  // Stage 2: one full analysis per role (the same role posted for several places counts once).
  // A role already decided earlier (recorded, or its signal deleted by the team) needs no AI.
  if (!stoppedReason) {
    const groups = await relevantRoles(auth, companyId);
    const industryName = ref.industries.find((i) => i.slug === company.industry)?.name ?? null;
    let analysed = 0;

    for (const group of groups) {
      if (group.decided) {
        await db
          .update(jobPostings)
          .set(group.decided.signalId ? { signalId: group.decided.signalId } : { triage: "skipped", triageReason: group.decided.reason })
          .where(inArray(jobPostings.id, group.jobs.map((j) => j.id)));
        if (!group.decided.signalId) skipped += group.jobs.length;
        continue;
      }
      if (analysed >= MAX_ANALYSES_PER_FETCH) continue;
      analysed++;

      const [lead] = group.jobs;
      const ok = await aiStep(async () => {
        const openings = group.jobs.map((j) => j.location ?? j.title);
        const text = jobSourceText(lead, { openings, maxDescription: MAX_JOB_TEXT });
        const analysis = await analyzeSignal({ companyId, text, sourceUrl: lead.url }, { ...company, industry: industryName }, ref);
        const values = jobSignalValues(analysis, lead);
        const ids = group.jobs.map((j) => j.id);
        await db.transaction(async (tx) => {
          if (!values) {
            skipped += ids.length;
            await tx.update(jobPostings).set({ triage: "skipped", triageReason: rejectionReason(analysis) }).where(inArray(jobPostings.id, ids));
            return;
          }
          const signal = await insertDetectedSignal(tx, auth, companyId, values);
          if (signal.created) signalsCreated++;
          await tx.update(jobPostings).set({ signalId: signal.id }).where(inArray(jobPostings.id, ids));
        });
      });
      if (!ok) break;
    }
  }

  await db.transaction(async (tx) => {
    await tx.update(companyJobBoards).set({ lastFetchedAt: new Date(), lastError: null }).where(boardOf(auth, companyId));
    await audit(tx, auth, "job_board.fetched", companyId, { open: fetched.length, added, closed, signalsCreated });
  });

  const [{ pending }] = await db
    .select({ pending: count() })
    .from(jobPostings)
    .where(
      and(
        eq(jobPostings.companyId, companyId),
        eq(jobPostings.workspaceId, auth.workspaceId),
        isNull(jobPostings.closedAt),
        isNull(jobPostings.signalId),
        inArray(jobPostings.triage, ["pending", "relevant"]),
      ),
    );

  return { open: fetched.length, added, closed, signalsCreated, skipped, pending, stoppedReason };
}

/**
 * Saves the board's current jobs: new ones are added, known ones refreshed, and jobs no longer on
 * the board are marked closed. One transaction, so `now()` is the same instant throughout.
 */
async function storeJobs(auth: Actor, companyId: string, board: BoardRow, jobs: CachedJob[]) {
  return db.transaction(async (tx) => {
    let added = 0;
    for (let start = 0; start < jobs.length; start += UPSERT_CHUNK) {
      const rows = jobs.slice(start, start + UPSERT_CHUNK).map((job) => ({
        workspaceId: auth.workspaceId,
        companyId,
        provider: board.provider,
        externalId: job.externalId,
        title: job.title.slice(0, 300),
        department: job.department?.slice(0, 200) ?? null,
        location: job.location?.slice(0, 300) ?? null,
        url: job.url,
        description: job.description?.slice(0, MAX_SOURCE_TEXT) ?? null,
        postedAt: job.postedAt,
        boardJobId: job.boardJobId,
      }));
      const result = await tx
        .insert(jobPostings)
        .values(rows)
        .onConflictDoUpdate({
          target: [jobPostings.companyId, jobPostings.provider, jobPostings.externalId],
          set: {
            title: sql`excluded.title`,
            department: sql`excluded.department`,
            location: sql`excluded.location`,
            url: sql`excluded.url`,
            description: sql`excluded.description`,
            postedAt: sql`excluded.posted_at`,
            boardJobId: sql`excluded.board_job_id`,
            lastSeenAt: sql`now()`,
            closedAt: null,
          },
        })
        // xmax is 0 only for a freshly inserted row, so this tells new jobs from refreshed ones.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      added += result.filter((r) => r.inserted).length;
    }

    const closedRows = await tx
      .update(jobPostings)
      .set({ closedAt: sql`now()` })
      .where(
        and(
          eq(jobPostings.companyId, companyId),
          eq(jobPostings.workspaceId, auth.workspaceId),
          isNull(jobPostings.closedAt),
          lt(jobPostings.lastSeenAt, sql`now()`),
        ),
      )
      .returning({ id: jobPostings.id });
    return { added, closed: closedRows.length };
  });
}

type RoleGroup = {
  /** Open relevant jobs without a signal, newest first; the first one leads the analysis. */
  jobs: JobRow[];
  /** What an earlier job with this role ended as, if anything: its signal, or why it was dropped. */
  decided: { signalId: string | null; reason: string } | null;
};

/** Relevant jobs still waiting for the full analysis, grouped by role, newest role first. */
async function relevantRoles(auth: Actor, companyId: string): Promise<RoleGroup[]> {
  const waiting = await openJobs(auth, companyId, and(eq(jobPostings.triage, "relevant"), isNull(jobPostings.signalId)), MAX_JOBS_PER_BOARD);
  if (waiting.length === 0) return [];

  // Earlier outcomes for the same roles: a recorded signal, or one the team deleted.
  const earlier = await db
    .select({ title: jobPostings.title, signalId: jobPostings.signalId, triageReason: jobPostings.triageReason })
    .from(jobPostings)
    .where(
      and(
        eq(jobPostings.companyId, companyId),
        eq(jobPostings.workspaceId, auth.workspaceId),
        or(isNotNull(jobPostings.signalId), eq(jobPostings.triageReason, SIGNAL_DELETED_REASON)),
      ),
    );
  const decidedByRole = new Map<string, RoleGroup["decided"]>();
  for (const row of earlier) {
    const key = roleKey(row.title);
    if (row.signalId) decidedByRole.set(key, { signalId: row.signalId, reason: "" });
    else if (!decidedByRole.has(key)) decidedByRole.set(key, { signalId: null, reason: SIGNAL_DELETED_REASON });
  }

  const groups = new Map<string, RoleGroup>();
  for (const job of waiting) {
    const key = roleKey(job.title);
    const group = groups.get(key) ?? { jobs: [], decided: decidedByRole.get(key) ?? null };
    group.jobs.push(job);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Open jobs matching `where`, newest first. */
function openJobs(auth: Actor, companyId: string, where: ReturnType<typeof and>, limit: number): Promise<JobRow[]> {
  return db
    .select()
    .from(jobPostings)
    .where(and(eq(jobPostings.companyId, companyId), eq(jobPostings.workspaceId, auth.workspaceId), isNull(jobPostings.closedAt), where))
    .orderBy(desc(sql`coalesce(${jobPostings.postedAt}, ${jobPostings.firstSeenAt})`), asc(jobPostings.id))
    .limit(limit);
}

async function loadCompany(auth: Actor, companyId: string) {
  const [company] = await db
    .select({ name: companies.canonicalName, domain: companies.domain, industry: companies.industry })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!company) throw new AppError("NOT_FOUND", "Company not found.");
  return company;
}

const boardOf = (auth: Actor, companyId: string) =>
  and(eq(companyJobBoards.companyId, companyId), eq(companyJobBoards.workspaceId, auth.workspaceId));

async function audit(
  tx: Tx,
  auth: Actor,
  action: string,
  companyId: string,
  metadata: Record<string, unknown>,
) {
  await tx.insert(auditLogs).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    action,
    entityType: "company",
    entityId: companyId,
    metadata,
  });
}
