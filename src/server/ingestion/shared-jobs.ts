import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { boardJobCategories, boardJobs, companyJobBoards, jobAnalyses, jobPostings, signals } from "@/db/schema";
import type { SignalAnalysis } from "@/lib/api/types";
import type { JobBoardProvider } from "@/lib/domain/job-boards";
import { analyzeSignal } from "@/server/ai/signal-analysis";
import { systemActor, type Actor } from "@/server/auth/actor";
import { AppError } from "@/server/http/errors";
import { categorizeJob, ruleJobSignal } from "@/server/jobs/job-categories";
import { jobSignalValues, jobSourceText, MAX_JOB_TEXT, rejectionReason, roleKey } from "@/server/jobs/job-signal";
import { JOB_BOARD_ADAPTERS } from "@/server/jobs/providers";
import { rescoreAfterCompanyChange } from "@/server/scoring/rescore";
import { getReferenceData } from "@/server/services/reference-data.service";
import { loadServices } from "@/server/services/services.service";
import { insertDetectedSignal, replaceDetectedSignal } from "@/server/services/signals.service";
import { cleanBoardName, jobInCountries } from "@/server/sources/board-directory";
import { toYcCompany, ycCompanyForBoard } from "@/server/sources/yc";
import { sourceRunnable } from "./queue";
import { resolveCompany } from "./resolve";

/**
 * Shared job intelligence: discover once, analyse once, match many times.
 *
 * 1. **Categorise** (shared, free): every job in the shared cache (`board_jobs`) gets the service
 *    categories its title points to (`categorizeJob`), stored in `board_job_categories`.
 * 2. **Match** (per workspace, no AI, seconds): open jobs in the workspace's service categories and
 *    target countries become its companies, jobs and signals straight away (`matchWorkspaceJobs`,
 *    run by `evaluate_boards`). A job already analysed gets the AI's signal; any other gets a
 *    rule-based signal with stated facts only (`ruleJobSignal`).
 * 3. **Analyse** (shared, AI, background): jobs behind rule-based signals are read in full by the AI
 *    once (`job_analyses`), newest first, and every workspace's signal from that job is upgraded,
 *    or removed when the AI finds no buying signal (`analyzeSharedJobs`).
 */

/** Jobs categorised per tick (pure regexes, a few milliseconds each). */
const CATEGORIZE_BATCH = 2000;
/** Rows per insert statement. */
const INSERT_CHUNK = 500;
/** Matching only looks at jobs posted (or first seen) within this many days. */
const MATCH_MAX_AGE_DAYS = 90;
/** Candidate jobs read per matching run, newest first, before the country check. */
const MATCH_CANDIDATES = 5000;
/** Companies matched per run; more follow a minute later. */
export const MATCH_BOARDS_PER_RUN = 40;
/** New signals per company per run: its strongest few roles, not one per posting. */
const MAX_ROLES_PER_COMPANY = 3;
/** The model name stored when the AI could not read a job, so it isn't retried forever. */
const FAILED_MODEL = "failed";

// --- 1. Categorise ---------------------------------------------------------------------------

/** Sorts the newest uncategorised shared jobs into service categories. Returns how many it did. */
export async function categorizeBoardJobs(limit = CATEGORIZE_BATCH): Promise<number> {
  const jobs = await db
    .select({ id: boardJobs.id, title: boardJobs.title, department: boardJobs.department })
    .from(boardJobs)
    .where(isNull(boardJobs.categorizedAt))
    .orderBy(sql`${boardJobs.firstSeenAt} desc`)
    .limit(limit);
  if (jobs.length === 0) return 0;
  const rows = jobs.flatMap((job) => categorizeJob(job).map((categorySlug) => ({ boardJobId: job.id, categorySlug, method: "rule" })));
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(boardJobCategories).values(rows.slice(i, i + INSERT_CHUNK)).onConflictDoNothing();
    }
    await tx
      .update(boardJobs)
      .set({ categorizedAt: sql`now()` })
      .where(inArray(boardJobs.id, jobs.map((j) => j.id)));
  });
  return jobs.length;
}

/** The service categories of these shared jobs (AI ones once analysed, else the rule ones). */
export async function jobCategories(boardJobIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (boardJobIds.length === 0) return result;
  const rows = await db
    .select({ boardJobId: boardJobCategories.boardJobId, categorySlug: boardJobCategories.categorySlug })
    .from(boardJobCategories)
    .where(inArray(boardJobCategories.boardJobId, boardJobIds));
  for (const row of rows) result.set(row.boardJobId, [...(result.get(row.boardJobId) ?? []), row.categorySlug]);
  // Jobs not categorised yet (just downloaded): their title tells now.
  const missing = boardJobIds.filter((id) => !result.has(id));
  if (missing.length > 0) {
    const jobs = await db
      .select({ id: boardJobs.id, title: boardJobs.title, department: boardJobs.department, categorizedAt: boardJobs.categorizedAt })
      .from(boardJobs)
      .where(inArray(boardJobs.id, missing));
    for (const job of jobs) if (!job.categorizedAt) result.set(job.id, categorizeJob(job));
  }
  return result;
}

/** The shared analyses of these jobs, with the AI's own categories (failed readings left out). */
export async function sharedAnalyses(boardJobIds: string[]): Promise<Map<string, SignalAnalysis>> {
  const result = new Map<string, SignalAnalysis>();
  if (boardJobIds.length === 0) return result;
  const [rows, categories] = await Promise.all([
    db.select().from(jobAnalyses).where(inArray(jobAnalyses.boardJobId, boardJobIds)),
    jobCategories(boardJobIds),
  ]);
  for (const row of rows) {
    if (row.model === FAILED_MODEL) continue;
    result.set(row.boardJobId, {
      isSignal: row.isSignal,
      signalType: row.signalType,
      intentLevel: row.intentLevel,
      urgency: row.urgency,
      serviceCategories: categories.get(row.boardJobId) ?? [],
      summary: row.summary,
      excerpt: row.excerpt,
      evidenceLabel: row.evidenceLabel,
      confidence: row.confidence,
      occurredOn: row.occurredOn,
      model: row.model,
    });
  }
  return result;
}

// --- 2. Match ---------------------------------------------------------------------------------

type Candidate = {
  id: string;
  provider: JobBoardProvider;
  board_token: string;
  external_id: string;
  title: string;
  department: string | null;
  location: string | null;
  url: string;
  description: string | null;
  posted_at: Date | null;
  first_seen_at: Date;
  board_name: string | null;
  stated_website: string | null;
  categories: string[];
  /** The AI has read this job and found a buying signal. */
  ai_confirmed: boolean;
  /** The board is a known Y Combinator company's own. */
  yc: boolean;
};

type RankedJob = Pick<Candidate, "title" | "categories" | "posted_at" | "first_seen_at" | "ai_confirmed" | "yc">;

const DAY_MS = 86_400_000;

/**
 * How strong a matched company is as a lead, from its matching jobs: several distinct roles (a
 * real need, not one post) count most, then a buying signal the AI confirmed, a known company (a YC
 * company's own board: verified website and location), how fresh the newest post is, and how many
 * of the workspace's services it touches. Pure.
 */
export function boardScore(jobs: RankedJob[], sold: string[], now = new Date()): number {
  const roles = new Set(jobs.map((j) => roleKey(j.title))).size;
  const newest = Math.max(...jobs.map((j) => new Date(j.posted_at ?? j.first_seen_at).getTime()));
  const ageDays = (now.getTime() - newest) / DAY_MS;
  const services = new Set(jobs.flatMap((j) => j.categories.filter((c) => sold.includes(c)))).size;
  return (
    Math.min(roles, 5) * 3 +
    (jobs.some((j) => j.ai_confirmed) ? 6 : 0) +
    (jobs[0]?.yc ? 4 : 0) +
    (ageDays <= 7 ? 4 : ageDays <= 30 ? 2 : 0) +
    Math.min(services, 3)
  );
}

/** Matched companies (each a board's jobs), strongest first; the newest post breaks ties. Pure. */
export function rankBoards<T extends RankedJob>(boards: T[][], sold: string[], now = new Date()): T[][] {
  const newest = (jobs: T[]) => Math.max(...jobs.map((j) => new Date(j.posted_at ?? j.first_seen_at).getTime()));
  return boards
    .map((jobs) => ({ jobs, score: boardScore(jobs, sold, now), newest: newest(jobs) }))
    .sort((a, b) => b.score - a.score || b.newest - a.newest)
    .map((b) => b.jobs);
}

type JobFacts = {
  title: string;
  department: string | null;
  location: string | null;
  url: string;
  description: string | null;
  postedAt: Date | null;
  firstSeenAt: Date;
};

const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|personio\.(de|com)|breezy\.hr)$/i;

/** The site a board's job links point to when it isn't the board itself (Greenhouse lets companies host jobs on their own careers page). */
function candidateWebsite(jobs: { url: string }[]): string | null {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    try {
      const host = new URL(job.url).hostname.toLowerCase().replace(/^www\./, "");
      if (!ATS_HOSTS.test(host)) counts.set(host, (counts.get(host) ?? 0) + 1);
    } catch {
      // Not a URL.
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const titleFromToken = (token: string) => token.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export type MatchResult = {
  /** Companies new to the workspace (their website and contacts are looked up next). */
  newCompanies: string[];
  /** Every company that got jobs this run (re-scored). */
  companies: string[];
  signalsCreated: number;
  /** More matching companies are waiting for the next run. */
  more: boolean;
};

/**
 * Matches the shared jobs to this workspace's services, with no AI: open jobs in its services'
 * categories and target countries, not yet in the workspace, grouped by company (board), newest
 * first. Each company is created (provisional, under the board's own name) or found, its board
 * connected, its matching jobs stored as relevant, and its strongest roles recorded as signals.
 */
export async function matchWorkspaceJobs(
  actor: Actor,
  { boards: only }: { boards?: { provider: JobBoardProvider; boardToken: string }[] } = {},
): Promise<MatchResult> {
  const result: MatchResult = { newCompanies: [], companies: [], signalsCreated: 0, more: false };
  const services = await loadServices(actor.workspaceId);
  const categories = [...new Set(services.flatMap((s) => s.categories))];
  if (categories.length === 0) return result;
  const countries = [...new Set(services.flatMap((s) => s.targetCountries))];

  const candidates = await db.execute<Candidate>(sql`
    select j.id, j.provider, j.board_token, j.external_id, j.title, j.department, j.location, j.url, j.description,
      j.posted_at, j.first_seen_at, d.board_name, d.stated_website, array_agg(c.category_slug) as categories,
      coalesce(bool_or(a.is_signal and a.model <> ${FAILED_MODEL}), false) as ai_confirmed,
      exists (select 1 from yc_companies y where y.board_provider = j.provider and y.board_token = j.board_token) as yc
    from board_jobs j
    join job_board_directory d on d.provider = j.provider and d.board_token = j.board_token and d.validation_status = 'valid'
    join board_job_categories c on c.board_job_id = j.id and c.category_slug in (${sql.join(categories.map((c) => sql`${c}`), sql`, `)})
    left join job_analyses a on a.board_job_id = j.id
    where j.closed_at is null
      and coalesce(j.posted_at, j.first_seen_at) > now() - make_interval(days => ${MATCH_MAX_AGE_DAYS})
      and (a.board_job_id is null or a.is_signal or a.model = ${FAILED_MODEL})
      and not exists (select 1 from job_postings p where p.workspace_id = ${actor.workspaceId} and p.board_job_id = j.id)
      ${only ? sql`and (j.provider, j.board_token) in (${sql.join(only.map((b) => sql`(${b.provider}::job_board_provider, ${b.boardToken})`), sql`, `)})` : sql``}
    group by j.id, d.board_name, d.stated_website
    order by coalesce(j.posted_at, j.first_seen_at) desc
    limit ${MATCH_CANDIDATES}`);

  // Group by board, keeping only jobs in the workspace's countries; strongest companies first.
  const boards = new Map<string, Candidate[]>();
  for (const job of candidates) {
    if (!jobInCountries(job.location, countries)) continue;
    const key = `${job.provider}:${job.board_token}`;
    boards.set(key, [...(boards.get(key) ?? []), job]);
  }
  result.more = boards.size > MATCH_BOARDS_PER_RUN;

  const ref = await getReferenceData();
  for (const jobs of rankBoards([...boards.values()], categories).slice(0, MATCH_BOARDS_PER_RUN)) {
    const { companyId, created, companyName } = await companyForBoard(actor, jobs);
    if (created) result.newCompanies.push(companyId);
    result.companies.push(companyId);
    result.signalsCreated += await recordMatchedJobs(actor, companyId, companyName, jobs, categories, ref.serviceCategories);
  }
  return result;
}

/** The workspace's company for a board: the one already following it, else found or created. */
async function companyForBoard(actor: Actor, jobs: Candidate[]): Promise<{ companyId: string; created: boolean; companyName: string }> {
  const [{ provider, board_token: token, board_name, stated_website }] = jobs;
  const [connected] = await db
    .select({ companyId: companyJobBoards.companyId, name: sql<string>`(select canonical_name from companies where id = ${companyJobBoards.companyId})` })
    .from(companyJobBoards)
    .where(and(eq(companyJobBoards.workspaceId, actor.workspaceId), eq(companyJobBoards.provider, provider), eq(companyJobBoards.boardToken, token)))
    .limit(1);
  if (connected) return { companyId: connected.companyId, created: false, companyName: connected.name };

  // A YC company's own board: the company comes with its name, website and location from YC.
  const yc = (await sourceRunnable(actor.workspaceId, "yc_directory")) ? await ycCompanyForBoard(provider, token) : null;
  if (yc) {
    return db.transaction(async (tx) => {
      const resolved = await resolveCompany(tx, actor, toYcCompany(yc));
      await tx
        .insert(companyJobBoards)
        .values({ companyId: resolved.companyId, workspaceId: actor.workspaceId, provider, boardToken: token, autoDetected: true })
        .onConflictDoNothing();
      return { companyId: resolved.companyId, created: resolved.created, companyName: yc.name };
    });
  }

  // The board's own name for the company ("TPG Careers Page" → "TPG"); the board address otherwise.
  const boardName = cleanBoardName(board_name);
  const name = boardName ?? titleFromToken(token);
  return db.transaction(async (tx) => {
    const resolved = await resolveCompany(tx, actor, {
      name,
      domain: null,
      industry: null,
      hq: null,
      identifiers: [],
      identity: "provisional",
      foundedOn: null,
      record: {
        sourceSlug: "board_directory",
        externalId: `board:${provider}:${token}`,
        url: JOB_BOARD_ADAPTERS[provider].boardUrl(token),
        recordType: "job_board",
        publishedAt: null,
        data: {
          provider,
          boardToken: token,
          relevant: true,
          nameFrom: boardName ? "board" : "board_address",
          candidateWebsite: stated_website ?? candidateWebsite(jobs),
        },
      },
    });
    await tx
      .insert(companyJobBoards)
      .values({ companyId: resolved.companyId, workspaceId: actor.workspaceId, provider, boardToken: token, autoDetected: true })
      .onConflictDoNothing();
    return { companyId: resolved.companyId, created: resolved.created, companyName: name };
  });
}

/**
 * Stores a company's matched jobs as relevant and records its strongest roles as signals: the
 * shared AI analysis when the job has one, else a rule-based signal. Returns the signals created.
 */
async function recordMatchedJobs(
  actor: Actor,
  companyId: string,
  companyName: string,
  jobs: Candidate[],
  sold: string[],
  categoryNames: { slug: string; name: string }[],
): Promise<number> {
  const names = new Map(categoryNames.map((c) => [c.slug, c.name]));
  const analyses = await sharedAnalyses(jobs.map((j) => j.id));
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(jobPostings)
      .values(
        jobs.map((job) => ({
          workspaceId: actor.workspaceId,
          companyId,
          provider: job.provider,
          externalId: job.external_id,
          title: job.title,
          department: job.department,
          location: job.location,
          url: job.url,
          description: job.description,
          // Raw SQL rows carry timestamps as strings.
          postedAt: job.posted_at ? new Date(job.posted_at) : null,
          boardJobId: job.id,
          triage: "relevant" as const,
          triageReason: matchReason(job.categories, sold, names),
        })),
      )
      .onConflictDoNothing()
      .returning({ id: jobPostings.id, boardJobId: jobPostings.boardJobId, title: jobPostings.title });

    // One signal per role (the same role posted for several places counts once), newest first.
    const byRole = new Map<string, Candidate[]>();
    for (const job of jobs) byRole.set(roleKey(job.title), [...(byRole.get(roleKey(job.title)) ?? []), job]);
    let created = 0;
    for (const roleJobs of [...byRole.values()].slice(0, MAX_ROLES_PER_COMPANY)) {
      const [lead] = roleJobs;
      const facts = toFacts(lead);
      const analysis = analyses.get(lead.id);
      const values = analysis
        ? jobSignalValues(analysis, facts)
        : ruleJobSignal(companyName, facts, roleJobs.length, lead.categories.filter((c) => sold.includes(c)));
      if (!values) continue;
      const signal = await insertDetectedSignal(tx, actor, companyId, values);
      if (signal.created) created++;
      const ids = inserted.filter((p) => roleJobs.some((j) => j.id === p.boardJobId)).map((p) => p.id);
      if (ids.length > 0) await tx.update(jobPostings).set({ signalId: signal.id }).where(inArray(jobPostings.id, ids));
    }
    return created;
  });
}

const toFacts = (job: Candidate): JobFacts => ({
  title: job.title,
  department: job.department,
  location: job.location,
  url: job.url,
  description: job.description,
  postedAt: job.posted_at ? new Date(job.posted_at) : null,
  firstSeenAt: new Date(job.first_seen_at),
});

/** "Matches your AI / machine learning service" (the job's categories this workspace sells). */
export function matchReason(jobCategoriesFound: string[], sold: string[], names: Map<string, string>): string {
  const shared = jobCategoriesFound.filter((c) => sold.includes(c)).map((c) => names.get(c) ?? c);
  return shared.length > 0 ? `Matches your ${shared.slice(0, 2).join(" and ")} services`.slice(0, 160) : "No match with your services";
}

// --- 3. Analyse -------------------------------------------------------------------------------

type Pending = { board_job_id: string; company_name: string; company_domain: string | null };

/**
 * Reads, with the AI, the shared jobs behind rule-based signals (newest signal first), stores each
 * reading once, and upgrades every workspace's signal from that job. Stops when the AI is busy or
 * the deadline passes. Returns how many jobs it read.
 */
export async function analyzeSharedJobs({
  deadline,
  limit = 10,
  boardJobIds,
}: {
  deadline: number;
  limit?: number;
  /** Only these jobs (e.g. one company's). */
  boardJobIds?: string[];
}): Promise<number> {
  if (boardJobIds?.length === 0) return 0;
  const pending = await db.execute<Pending>(sql`
    select * from (
      select distinct on (p.board_job_id) p.board_job_id, c.canonical_name as company_name, c.domain as company_domain, s.created_at
      from signals s
      join job_postings p on p.signal_id = s.id and p.board_job_id is not null
      join companies c on c.id = s.company_id
      where s.source = 'provider'
        and not exists (select 1 from job_analyses a where a.board_job_id = p.board_job_id)
        ${boardJobIds ? sql`and p.board_job_id in (${sql.join(boardJobIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
      order by p.board_job_id, s.created_at desc
    ) newest
    order by created_at desc
    limit ${limit}`);
  if (pending.length === 0) return 0;
  const ref = await getReferenceData();
  let read = 0;
  for (const job of pending) {
    if (Date.now() > deadline) break;
    const [row] = await db.select().from(boardJobs).where(eq(boardJobs.id, job.board_job_id));
    if (!row) continue;
    let analysis: SignalAnalysis;
    try {
      const text = jobSourceText(row, { maxDescription: MAX_JOB_TEXT });
      analysis = await analyzeSignal(
        { companyId: "00000000-0000-0000-0000-000000000000", text, sourceUrl: row.url },
        { name: job.company_name, domain: job.company_domain, industry: null },
        ref,
      );
    } catch (error) {
      if (error instanceof AppError && (error.code === "AI_BUSY" || error.code === "AI_UNAVAILABLE")) break;
      if (!(error instanceof AppError)) throw error;
      // The AI couldn't read this one: keep its rule-based signals and don't try it again.
      await db.insert(jobAnalyses).values(failedAnalysis(row.id)).onConflictDoNothing();
      continue;
    }
    await saveAnalysis(row.id, analysis);
    await applyAnalysis(row, analysis);
    read++;
  }
  return read;
}

const failedAnalysis = (boardJobId: string) => ({
  boardJobId,
  isSignal: false,
  intentLevel: "unknown" as const,
  urgency: "unknown" as const,
  summary: "The AI could not read this job.",
  evidenceLabel: "unknown" as const,
  confidence: 0,
  model: FAILED_MODEL,
});

async function saveAnalysis(boardJobId: string, analysis: SignalAnalysis): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(jobAnalyses)
      .values({
        boardJobId,
        isSignal: analysis.isSignal,
        signalType: analysis.isSignal ? analysis.signalType : null,
        intentLevel: analysis.intentLevel,
        urgency: analysis.urgency,
        summary: analysis.summary.slice(0, 500),
        excerpt: analysis.excerpt,
        evidenceLabel: analysis.evidenceLabel,
        confidence: analysis.confidence,
        occurredOn: analysis.occurredOn,
        model: analysis.model,
      })
      .onConflictDoNothing();
    // The AI's categories, read from the whole post, replace the title rules'.
    if (analysis.isSignal && analysis.serviceCategories.length > 0) {
      await tx.delete(boardJobCategories).where(eq(boardJobCategories.boardJobId, boardJobId));
      await tx
        .insert(boardJobCategories)
        .values(analysis.serviceCategories.map((categorySlug) => ({ boardJobId, categorySlug, method: "ai" })))
        .onConflictDoNothing();
    }
  });
}

/**
 * Upgrades every workspace's rule-based signal from this job with the AI's reading, or removes it
 * (and marks its jobs skipped, with why) when the AI finds no buying signal; then re-scores.
 */
async function applyAnalysis(job: typeof boardJobs.$inferSelect, analysis: SignalAnalysis): Promise<void> {
  const linked = await db
    .selectDistinct({ signalId: signals.id, workspaceId: signals.workspaceId, companyId: signals.companyId })
    .from(jobPostings)
    .innerJoin(signals, eq(signals.id, jobPostings.signalId))
    .where(and(eq(jobPostings.boardJobId, job.id), eq(signals.source, "provider")));
  const values = jobSignalValues(analysis, job);
  for (const link of linked) {
    const actor = systemActor(link.workspaceId);
    await db.transaction(async (tx) => {
      if (values) return replaceDetectedSignal(tx, actor, link.signalId, values);
      await tx
        .update(jobPostings)
        .set({ signalId: null, triage: "skipped", triageReason: rejectionReason(analysis) })
        .where(and(eq(jobPostings.signalId, link.signalId), eq(jobPostings.workspaceId, link.workspaceId)));
      await tx.delete(signals).where(and(eq(signals.id, link.signalId), eq(signals.workspaceId, link.workspaceId)));
    });
    await rescoreAfterCompanyChange(link.workspaceId, link.companyId);
  }
}
