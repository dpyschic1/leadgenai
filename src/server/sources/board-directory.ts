import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { boardJobs, directoryCrawls, jobBoardDirectory } from "@/db/schema";
import { BOARD_TOKEN_PATTERN, JOB_BOARD_PROVIDERS, type JobBoardProvider } from "@/lib/domain/job-boards";
import { AppError } from "@/server/http/errors";
import { fetchBoardJobs } from "@/server/jobs/fetch-jobs";
import { categorizeJob } from "@/server/jobs/job-categories";
import { CLOSED_JOB_RETENTION_DAYS, isStaleJob, jobDigest, MAX_JOB_AGE_DAYS, repostKey } from "@/server/jobs/job-signal";
import { JOB_BOARD_ADAPTERS } from "@/server/jobs/providers";
import { decodeEntities } from "@/server/jobs/html-to-text";
import type { NormalizedJob } from "@/server/jobs/types";
import { politeGet, registrableDomain } from "./http";
import type { HealthStatus, SourceAdapter } from "./index";

/**
 * Job-board discovery, shared by every workspace (a board's existence and its public jobs are
 * public facts; nothing workspace-specific is stored here):
 *
 * 1. **Collect** candidate boards from the Common Crawl index of archived URLs (plus boards found on
 *    company websites or entered by hand). A candidate is not a company: it is `unverified`.
 * 2. **Validate** each against the provider's own public job-board API. Only a board the provider
 *    confirms becomes `valid`; a missing one is `invalid`.
 * 3. **Cache** a valid board's open jobs once in `board_jobs`, deduplicated by provider + board +
 *    the provider's job id, so workspaces never fetch the same board separately.
 *
 * Each workspace then evaluates the cached jobs against its own ICP and services (ingestion's
 * `evaluate_boards`). Coverage is broad, not complete: only boards the archive has crawled appear.
 *
 * Data use: the providers publish these endpoints as public, and their docs are silent on third
 * parties storing them. We keep only what evaluation and evidence need, honour Ashby's "not
 * listed" flag (in the adapter), link to the original posting, and prune closed jobs.
 */

const INDEX = "https://index.commoncrawl.org";
/** Archive index queries are slow and sometimes time out (504); keep each one bounded. */
const INDEX_TIMEOUT_MS = 25_000;
/** Index pages read per collection step. */
const PAGES_PER_STEP = 1;
/** A host whose last index query failed is tried again after this long. */
const RETRY_FAILED_HOST_MS = 30 * 60 * 1000;
/** How long a board's cached jobs stay fresh before the next download. */
export const BOARD_FRESH_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** The hosts each provider serves public boards on, as archived URLs show them. */
const BOARD_HOSTS: Record<JobBoardProvider, string[]> = {
  greenhouse: ["boards.greenhouse.io", "job-boards.greenhouse.io"],
  lever: ["jobs.lever.co"],
  ashby: ["jobs.ashbyhq.com"],
  // Older boards live on {slug}.workable.com, which redirects here.
  workable: ["apply.workable.com"],
  smartrecruiters: ["jobs.smartrecruiters.com", "careers.smartrecruiters.com"],
  // Boards on their own subdomain: the archive is asked for every subdomain of these.
  personio: ["*.jobs.personio.de", "*.jobs.personio.com"],
  breezy: ["*.breezy.hr"],
};

/** Providers whose boards are subdomains ({slug}.breezy.hr), and the provider's own subdomains to ignore. */
const SUBDOMAIN_BOARDS: { provider: JobBoardProvider; suffix: string; own: RegExp }[] = [
  { provider: "personio", suffix: ".jobs.personio.de", own: /^(www|api|app)$/ },
  { provider: "personio", suffix: ".jobs.personio.com", own: /^(www|api|app)$/ },
  { provider: "breezy", suffix: ".breezy.hr", own: /^(www|app|api|help|developer|developers|marketing|blog|status|assets|cdn|support|careers)$/ },
];

/** Path segments that are pages of the provider, not company boards. */
const NOT_A_BOARD = /^(embed|api|v\d+|jobs|job|careers|search|static|assets|favicon\.ico|robots\.txt|sitemap.*|login|apply|_next|images?|j|oops)$/i;
/** Workable's own subdomains, as opposed to a company's legacy {slug}.workable.com board. */
const WORKABLE_OWN_HOSTS = /^(www|apply|jobs|help|resources|developers|api|blog|careers|status)\.workable\.com$/;

/**
 * The provider and board name in an archived job-board URL, or null when the URL isn't a company
 * board (provider pages, numeric junk, malformed names). Pure.
 */
export function boardFromUrl(url: string): { provider: JobBoardProvider; boardToken: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  // A legacy Workable board: the account is the subdomain.
  const legacyWorkable = host.endsWith(".workable.com") && !WORKABLE_OWN_HOSTS.test(host) ? host.slice(0, -".workable.com".length) : null;
  if (legacyWorkable) return !legacyWorkable.includes(".") && BOARD_TOKEN_PATTERN.test(legacyWorkable) ? { provider: "workable", boardToken: legacyWorkable } : null;
  for (const { provider, suffix, own } of SUBDOMAIN_BOARDS) {
    if (!host.endsWith(suffix)) continue;
    const slug = host.slice(0, -suffix.length);
    return slug && !slug.includes(".") && !own.test(slug) && BOARD_TOKEN_PATTERN.test(slug) ? { provider, boardToken: slug } : null;
  }
  const provider = JOB_BOARD_PROVIDERS.find((p) => BOARD_HOSTS[p].includes(host));
  if (!provider) return null;
  // Greenhouse also embeds boards as /embed/job_board?for=<token>.
  const token = (parsed.pathname === "/embed/job_board" ? parsed.searchParams.get("for") : decodeURIComponent(parsed.pathname.split("/")[1] ?? ""))?.trim();
  if (!token || NOT_A_BOARD.test(token) || /^\d+$/.test(token) || !BOARD_TOKEN_PATTERN.test(token)) return null;
  return { provider, boardToken: token.toLowerCase() };
}

// --- Board names ----------------------------------------------------------------------------------

const GENERIC_TITLE = /^(jobs?|careers?|job board|open positions|home)$/i;

/** A company name from a board page title ("Jobs at Acme", "Acme - Careers", "Acme | Lever"), or null. Pure. */
export function nameFromBoardTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const cleaned = decodeEntities(title)
    .replace(/\s+/g, " ")
    .replace(/^(jobs|careers|open roles|open positions)\s+(at|with)\s+/i, "")
    .split(/\s+[|–—-]\s+/)
    .map((part) => part.trim())
    .filter((part) => part && !GENERIC_TITLE.test(part) && !/^(lever|ashby|greenhouse|workable|powered by .*)$/i.test(part))[0];
  return cleanBoardName(cleaned);
}

/** "TPG Careers Page", "Acme Jobs", "Careers at Acme" → the company's own name ("TPG", "Acme"). Pure. */
export function cleanBoardName(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = decodeEntities(name)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(jobs|careers|open roles|open positions|work)\s+(at|with)\s+/i, "")
    .replace(/[\s,:–—-]*\b(careers?|jobs?|job board|job openings|open roles|open positions)(\s+(page|site|portal|board))?$/i, "")
    .trim();
  return cleaned.length >= 2 && cleaned.length <= 120 && !GENERIC_TITLE.test(cleaned) ? cleaned : null;
}

/**
 * The board's own name for the company, and the company website the provider states, if any.
 * Greenhouse's API gives the name; Workable's account record gives the name and website; Lever
 * and Ashby put the name in the page title.
 */
async function boardProfile(provider: JobBoardProvider, token: string): Promise<{ name: string | null; website: string | null }> {
  const none = { name: null, website: null };
  try {
    if (provider === "greenhouse") {
      const page = await politeGet(`https://boards-api.greenhouse.io/v1/boards/${token}`, { sameSite: false, timeoutMs: 10_000 });
      return page.status === 200 ? { name: cleanBoardName((JSON.parse(page.body) as { name?: string }).name), website: null } : none;
    }
    if (provider === "smartrecruiters" || provider === "breezy") {
      // The company's name comes with each job.
      const page = await politeGet(JOB_BOARD_ADAPTERS[provider].probeEndpoint(token), { sameSite: false, timeoutMs: 10_000 });
      if (page.status !== 200) return none;
      const body = JSON.parse(page.body) as { content?: { company?: { name?: string } }[] } | { company?: { name?: string } }[];
      const first = Array.isArray(body) ? body[0] : body.content?.[0];
      return { name: cleanBoardName(first?.company?.name), website: null };
    }
    if (provider === "personio") return none;
    if (provider === "workable") {
      const page = await politeGet(JOB_BOARD_ADAPTERS.workable.probeEndpoint(token), { sameSite: false, timeoutMs: 10_000 });
      return page.status === 200 ? workableProfile(JSON.parse(page.body)) : none;
    }
    const page = await politeGet(JOB_BOARD_ADAPTERS[provider].boardUrl(token), { timeoutMs: 10_000 });
    return page.status === 200 ? { name: nameFromBoardTitle(page.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]), website: null } : none;
  } catch {
    return none;
  }
}

/** Name and website from a Workable account record (`/api/v1/accounts/{slug}`). Pure. */
export function workableProfile(body: unknown): { name: string | null; website: string | null } {
  const account = (body ?? {}) as { name?: unknown; url?: unknown };
  let website: string | null = null;
  if (typeof account.url === "string") {
    try {
      const host = new URL(/^https?:\/\//i.test(account.url) ? account.url : `https://${account.url}`).hostname.toLowerCase().replace(/^www\./, "");
      // Its own site, not Workable's or a social profile.
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && !/(^|\.)(workable\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com)$/.test(host)) website = host;
    } catch {
      // Not a URL.
    }
  }
  return { name: cleanBoardName(typeof account.name === "string" ? account.name : null), website };
}

// --- Directory ------------------------------------------------------------------------------------

/** Adds candidate boards (unverified); a board already known is left as it is. */
export async function addCandidates(candidates: { provider: JobBoardProvider; boardToken: string; discoveryUrl: string | null }[]): Promise<number> {
  if (candidates.length === 0) return 0;
  const unique = [
    ...new Map(candidates.map((c) => ({ ...c, boardToken: canonicalToken(c.boardToken) })).map((c) => [`${c.provider}:${c.boardToken}`, c])).values(),
  ];
  const rows = await db
    .insert(jobBoardDirectory)
    .values(unique.map((c) => ({ provider: c.provider, boardToken: c.boardToken, discoveryUrl: c.discoveryUrl })))
    .onConflictDoNothing()
    .returning({ token: jobBoardDirectory.boardToken });
  return rows.length;
}

const trimText = (value: string | null, max: number) => (value ? value.slice(0, max) : null);

/**
 * Validates a board against its provider and caches its open jobs. A board the provider doesn't
 * know (404) is marked invalid; an outage is an error, retried later with backoff. Returns the
 * board's status after the check.
 */
export async function refreshBoard(provider: JobBoardProvider, boardToken: string): Promise<"valid" | "invalid" | "error"> {
  const token = canonicalToken(boardToken);
  const key = and(eq(jobBoardDirectory.provider, provider), eq(jobBoardDirectory.boardToken, token));
  await db.insert(jobBoardDirectory).values({ provider, boardToken: token }).onConflictDoNothing();

  let jobs: NormalizedJob[];
  try {
    jobs = await fetchBoardJobs(provider, token);
  } catch (error) {
    const invalid = error instanceof AppError && (error.code === "NOT_FOUND" || error.code === "VALIDATION_FAILED");
    const [row] = await db.select({ attempts: jobBoardDirectory.attempts }).from(jobBoardDirectory).where(key);
    const attempts = (row?.attempts ?? 0) + 1;
    await db
      .update(jobBoardDirectory)
      .set({
        validationStatus: invalid ? "invalid" : "error",
        lastVerifiedAt: new Date(),
        lastError: error instanceof Error ? error.message.slice(0, 300) : "Unavailable",
        attempts,
        // A board that doesn't exist is rechecked rarely; an outage soon, backing off.
        nextCheckAt: new Date(Date.now() + (invalid ? 60 * DAY_MS : Math.min(2 ** attempts, 48) * 60 * 60 * 1000)),
      })
      .where(key);
    // A board that no longer exists has no open jobs.
    if (invalid) await db.transaction((tx) => closeAndPrune(tx, provider, token));
    return invalid ? "invalid" : "error";
  }

  const profile = await boardProfile(provider, token);
  await db.transaction(async (tx) => {
    const stored = await tx
      .select({ externalId: boardJobs.externalId, title: boardJobs.title, location: boardJobs.location })
      .from(boardJobs)
      .where(and(eq(boardJobs.provider, provider), eq(boardJobs.boardToken, token)));
    const fresh = freshUniqueJobs(jobs, stored);
    for (let start = 0; start < fresh.length; start += 100) {
      const rows = fresh.slice(start, start + 100).map((job) => ({
        provider,
        boardToken: token,
        externalId: job.externalId,
        title: job.title.slice(0, 300),
        department: trimText(job.department, 200),
        location: trimText(job.location, 300),
        url: job.url,
        description: jobDigest(job.description, { relevant: categorizeJob(job).length > 0 }),
        postedAt: job.postedAt,
      }));
      await tx
        .insert(boardJobs)
        .values(rows)
        .onConflictDoUpdate({
          target: [boardJobs.provider, boardJobs.boardToken, boardJobs.externalId],
          set: {
            title: sql`excluded.title`,
            department: sql`excluded.department`,
            location: sql`excluded.location`,
            url: sql`excluded.url`,
            // Rewritten only when it changed: an unchanged text keeps its stored copy (no new one per refresh).
            description: sql`case when ${boardJobs.description} is distinct from excluded.description then excluded.description else ${boardJobs.description} end`,
            postedAt: sql`excluded.posted_at`,
            lastSeenAt: sql`now()`,
            closedAt: null,
          },
        });
    }
    // Jobs gone from the board (or now too old, or a repost) are closed; old ones are deleted.
    await closeAndPrune(tx, provider, token);
    await tx
      .update(jobBoardDirectory)
      .set({
        validationStatus: "valid",
        boardName: profile.name,
        statedWebsite: profile.website,
        lastVerifiedAt: sql`now()`,
        lastFetchedAt: sql`now()`,
        lastError: null,
        attempts: 0,
        nextCheckAt: new Date(Date.now() + DAY_MS),
      })
      .where(key);
  });
  return "valid";
}

/**
 * Board names are compared without case: archived links spell the same board "FINNY" and "finny",
 * and providers answer either. Stored lowercase so one board is never two.
 */
export const canonicalToken = (token: string) => token.trim().toLowerCase();

/**
 * The jobs worth keeping from a board's download: fresh ones (`isStaleJob`), each listed once. A job
 * listed several times with the same title and place (`repostKey`) is kept as the copy already
 * stored, else the newest, so a refresh never swaps it for a "new" job. Pure.
 */
export function freshUniqueJobs<T extends Pick<NormalizedJob, "externalId" | "title" | "location" | "postedAt">>(
  jobs: T[],
  stored: { externalId: string; title: string; location: string | null }[] = [],
  now = new Date(),
): T[] {
  const storedIds = new Set(stored.map((s) => s.externalId));
  const best = new Map<string, T>();
  for (const job of jobs) {
    if (isStaleJob(job.postedAt, now)) continue;
    const key = repostKey(job);
    const current = best.get(key);
    const better =
      !current ||
      (storedIds.has(job.externalId) && !storedIds.has(current.externalId)) ||
      (storedIds.has(job.externalId) === storedIds.has(current.externalId) && (job.postedAt?.getTime() ?? 0) > (current.postedAt?.getTime() ?? 0));
    if (better) best.set(key, job);
  }
  return [...best.values()];
}

/**
 * A board's housekeeping after a download: jobs no longer listed are closed; closed jobs past
 * `CLOSED_JOB_RETENTION_DAYS` and jobs posted more than `MAX_JOB_AGE_DAYS` ago are deleted; an
 * undated job seen that long ago keeps its row (so it isn't taken for a new job) but not its text.
 */
async function closeAndPrune(tx: Tx, provider: JobBoardProvider, token: string): Promise<void> {
  const board = and(eq(boardJobs.provider, provider), eq(boardJobs.boardToken, token));
  await tx.update(boardJobs).set({ closedAt: sql`now()` }).where(and(board, isNull(boardJobs.closedAt), lt(boardJobs.lastSeenAt, sql`now()`)));
  await tx
    .delete(boardJobs)
    .where(
      and(
        board,
        or(
          lt(boardJobs.closedAt, sql`now() - make_interval(days => ${CLOSED_JOB_RETENTION_DAYS})`),
          lt(boardJobs.postedAt, sql`now() - make_interval(days => ${MAX_JOB_AGE_DAYS})`),
        ),
      ),
    );
  await tx
    .update(boardJobs)
    .set({ description: null })
    .where(and(board, isNull(boardJobs.postedAt), isNotNull(boardJobs.description), lt(boardJobs.firstSeenAt, sql`now() - make_interval(days => ${MAX_JOB_AGE_DAYS})`)));
}

export type CachedJob = NormalizedJob & { boardJobId: string };

/**
 * A board's open jobs from the shared cache, downloading them first when the cache is older than
 * `freshWithinMs`. Throws the provider's error when a download is needed and fails.
 */
export async function boardJobsFor(provider: JobBoardProvider, boardToken: string, freshWithinMs = BOARD_FRESH_MS): Promise<CachedJob[]> {
  const token = canonicalToken(boardToken);
  const [board] = await db
    .select({ lastFetchedAt: jobBoardDirectory.lastFetchedAt, status: jobBoardDirectory.validationStatus, lastError: jobBoardDirectory.lastError })
    .from(jobBoardDirectory)
    .where(and(eq(jobBoardDirectory.provider, provider), eq(jobBoardDirectory.boardToken, token)));
  const fresh = board?.status === "valid" && board.lastFetchedAt && Date.now() - board.lastFetchedAt.getTime() < freshWithinMs;
  if (!fresh) {
    const status = await refreshBoard(provider, token);
    if (status !== "valid") {
      const [after] = await db.select({ lastError: jobBoardDirectory.lastError }).from(jobBoardDirectory).where(and(eq(jobBoardDirectory.provider, provider), eq(jobBoardDirectory.boardToken, token)));
      throw new AppError(status === "invalid" ? "NOT_FOUND" : "JOB_BOARD_FAILED", after?.lastError ?? "The job board couldn't be reached.");
    }
  }
  const rows = await db
    .select()
    .from(boardJobs)
    .where(and(eq(boardJobs.provider, provider), eq(boardJobs.boardToken, token), isNull(boardJobs.closedAt)))
    .orderBy(desc(sql`coalesce(${boardJobs.postedAt}, ${boardJobs.firstSeenAt})`));
  return rows.map((r) => ({
    boardJobId: r.id,
    externalId: r.externalId,
    title: r.title,
    department: r.department,
    location: r.location,
    url: r.url,
    description: r.description,
    postedAt: r.postedAt,
  }));
}

/** Validates (and caches) the boards that are due, newest candidates first. Returns how many were checked. */
export async function validateDueBoards({ limit, deadline }: { limit: number; deadline: number }): Promise<number> {
  const due = await db
    .select({ provider: jobBoardDirectory.provider, token: jobBoardDirectory.boardToken })
    .from(jobBoardDirectory)
    .where(and(inArray(jobBoardDirectory.validationStatus, ["unverified", "valid", "error"]), lte(jobBoardDirectory.nextCheckAt, sql`now()`)))
    .orderBy(asc(jobBoardDirectory.nextCheckAt))
    .limit(limit);
  let checked = 0;
  for (const board of due) {
    if (Date.now() > deadline) break;
    await refreshBoard(board.provider, board.token);
    checked++;
  }
  return checked;
}

// --- Common Crawl ---------------------------------------------------------------------------------

let latestCrawl: { id: string; at: number } | null = null;

async function getJson(url: string): Promise<unknown> {
  const page = await politeGet(url, { sameSite: false, timeoutMs: INDEX_TIMEOUT_MS, maxBytes: 30 * 1024 * 1024 });
  if (page.status >= 400) throw new Error(`The archive index answered ${page.status}.`);
  return JSON.parse(page.body);
}

/** The newest crawl's id, e.g. "CC-MAIN-2026-43" (cached for a day). */
async function currentCrawl(): Promise<string> {
  if (latestCrawl && Date.now() - latestCrawl.at < DAY_MS) return latestCrawl.id;
  const list = (await getJson(`${INDEX}/collinfo.json`)) as { id: string }[];
  if (!list[0]?.id) throw new Error("The archive index lists no crawls.");
  latestCrawl = { id: list[0].id, at: Date.now() };
  return list[0].id;
}

/** Board candidates in one page of archive index lines (one JSON object per line). Pure. */
export function boardsFromIndexPage(text: string): { provider: JobBoardProvider; boardToken: string; discoveryUrl: string }[] {
  const found = new Map<string, { provider: JobBoardProvider; boardToken: string; discoveryUrl: string }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const url = (JSON.parse(line) as { url?: string }).url;
      const board = url ? boardFromUrl(url) : null;
      if (board && !found.has(`${board.provider}:${board.boardToken}`)) found.set(`${board.provider}:${board.boardToken}`, { ...board, discoveryUrl: url! });
    } catch {
      // A partial line from a cut-off response; skip it.
    }
  }
  return [...found.values()];
}

/**
 * Reads the next page(s) of the archive index for one provider host and adds the boards found.
 * Progress is stored per crawl and host, so a slow or failed query resumes where it stopped.
 * Returns how many new candidates were added.
 */
export async function collectFromArchive(): Promise<number> {
  const crawl = await currentCrawl();
  const targets = JOB_BOARD_PROVIDERS.flatMap((provider) => BOARD_HOSTS[provider].map((host) => ({ provider, host, crawlId: `${crawl}|${host}` })));
  const progress = await db.select().from(directoryCrawls).where(inArray(directoryCrawls.crawlId, targets.map((t) => t.crawlId)));
  // A host that failed recently waits its turn, so one overloaded query can't block the others;
  // otherwise the host least advanced in this crawl goes next.
  const recentlyFailed = (t: { state?: (typeof progress)[number] }) =>
    Boolean(t.state?.lastError && Date.now() - t.state.updatedAt.getTime() < RETRY_FAILED_HOST_MS);
  const next = targets
    .map((t) => ({ ...t, state: progress.find((p) => p.crawlId === t.crawlId && p.provider === t.provider) }))
    .filter((t) => !t.state?.finishedAt)
    .sort((a, b) => Number(recentlyFailed(a)) - Number(recentlyFailed(b)) || (a.state?.nextPage ?? 0) - (b.state?.nextPage ?? 0))[0];
  if (!next) return 0;

  // "*.breezy.hr" asks for every subdomain; a plain host for every path under it.
  const pattern = next.host.startsWith("*.") ? next.host : `${next.host}/*`;
  const query = `${INDEX}/${crawl}-index?url=${encodeURIComponent(pattern)}&output=json&fl=url`;
  let added = 0;
  let page = next.state?.nextPage ?? 0;
  try {
    // Pages are read directly: the page-count query is the one that times out most. An empty page
    // (or "no captures") is the end of this host's results in this crawl.
    let finished = false;
    for (let i = 0; i < PAGES_PER_STEP && !finished; i++) {
      const response = await politeGet(`${query}&page=${page}`, { sameSite: false, timeoutMs: INDEX_TIMEOUT_MS, maxBytes: 30 * 1024 * 1024 });
      if (response.status === 404 || (response.status === 400 && /no captures|out of range/i.test(response.body))) {
        finished = true;
        break;
      }
      if (response.status >= 400) throw new Error(`The archive index answered ${response.status}.`);
      const boards = boardsFromIndexPage(response.body);
      if (!response.body.trim()) finished = true;
      added += await addCandidates(boards);
      page++;
    }
    await db
      .insert(directoryCrawls)
      .values({ provider: next.provider, crawlId: next.crawlId, nextPage: page, finishedAt: finished ? new Date() : null, lastError: null })
      .onConflictDoUpdate({
        target: [directoryCrawls.provider, directoryCrawls.crawlId],
        set: { nextPage: page, finishedAt: finished ? new Date() : null, lastError: null },
      });
  } catch (error) {
    // The index is often slow: remember the error and try the same page next time.
    const lastError = error instanceof Error ? error.message.slice(0, 300) : "Unavailable";
    await db
      .insert(directoryCrawls)
      .values({ provider: next.provider, crawlId: next.crawlId, nextPage: page, lastError })
      .onConflictDoUpdate({ target: [directoryCrawls.provider, directoryCrawls.crawlId], set: { lastError } });
  }
  return added;
}

// --- Regions --------------------------------------------------------------------------------------

const COUNTRY_HINTS: Record<string, string[]> = {
  GB: ["united kingdom", "uk", "u.k.", "great britain", "britain", "england", "scotland", "wales", "northern ireland", "london", "manchester", "birmingham", "leeds", "glasgow", "edinburgh", "bristol", "liverpool", "cambridge", "oxford", "belfast", "cardiff", "sheffield", "newcastle", "nottingham", "brighton", "reading", "milton keynes"],
  IE: ["ireland", "dublin", "cork", "galway"],
  US: ["united states", "usa", "u.s.", "us", "new york", "san francisco", "los angeles", "seattle", "austin", "boston", "chicago", "denver", "atlanta", "miami"],
};
const ANYWHERE = /\b(remote|anywhere|worldwide|global)\b/i;
/** "San Jose, CA", "Austin, TX 78701": a US state code after a comma. */
const US_STATE_CODE = /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;
const US_STATE_NAMES = ["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming"];
const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
/** A country's names as a location may write them: its hints and its English name. */
const countryNames = (code: string): string[] => {
  const name = REGION_NAMES.of(code)?.toLowerCase();
  return [...(COUNTRY_HINTS[code] ?? []), ...(name && name !== code.toLowerCase() ? [name] : [])];
};
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Every country code the runtime knows a name for ("AA".."ZZ"), for spotting another country. */
const ALL_COUNTRIES = [...LETTERS].flatMap((a) => [...LETTERS].map((b) => a + b)).filter((code) => REGION_NAMES.of(code) !== code);
/** Regions a remote role can be limited to. */
const REGIONS = ["europe", "eu", "emea", "apac", "asia", "latam", "latin america", "americas", "africa", "middle east", "oceania", "nordics", "dach", "benelux"];

/** One listed place ("San Jose, CA", "Mountain View, California") that is in the US by its state. */
function usPlace(place: string): boolean {
  const text = ` ${place.toLowerCase().replace(/[^a-z.]+/g, " ")} `;
  const names = (hint: string) => text.includes(` ${hint} `);
  if (!US_STATE_CODE.test(place) && !US_STATE_NAMES.some(names)) return false;
  // Other countries by their names only: a town that shares a name ("Reading, PA") is no country.
  return !ALL_COUNTRIES.some((code) => code !== "US" && [REGION_NAMES.of(code)!.toLowerCase(), ...(COUNTRY_ALIASES[code] ?? [])].some(names));
}

/**
 * The countries a text names by their English name or a common short name ("India Only",
 * "in the Philippines", "UK-based"), as ISO codes. City names are not used: a town that shares a
 * name with one abroad ("Reading", "Cambridge") names no country. Pure.
 */
export function countriesNamedIn(text: string): string[] {
  const words = ` ${text.toLowerCase().replace(/[^a-z.]+/g, " ")} `;
  const named = ALL_COUNTRIES.filter(
    (code) => !AMBIGUOUS_COUNTRIES.has(code) && [REGION_NAMES.of(code)!.toLowerCase(), ...(COUNTRY_ALIASES[code] ?? [])].some((name) => words.includes(` ${name} `)),
  );
  // A US state ("Austin, TX", "Texas") is the US.
  if (!named.includes("US") && (US_STATE_CODE.test(text) || US_STATE_NAMES.some((state) => words.includes(` ${state} `)))) named.push("US");
  return named;
}

/** Country names that are also common words, first names or US places: never read as a country. */
const AMBIGUOUS_COUNTRIES = new Set(["GE", "JE", "JO", "TD", "TR"]);

/** Short names a place may give a country by. */
const COUNTRY_ALIASES: Record<string, string[]> = {
  GB: ["uk", "u.k.", "england", "scotland", "wales"],
  AE: ["uae"],
  US: ["usa", "u.s.", "u.s.a.", "united states"],
};

/**
 * Whether a job's location fits the workspace's target countries (ISO codes; empty = anywhere).
 * Named countries and their main cities count. A remote role counts only when its location names no
 * other country or region: "Remote" and "Remote (Global)" do, "India; Remote" or "remote in the EU"
 * don't. Pure.
 */
export function jobInCountries(location: string | null, countries: string[]): boolean {
  if (countries.length === 0) return true;
  const text = ` ${(location ?? "").toLowerCase().replace(/[^a-z.]+/g, " ")} `;
  const names = (hint: string) => text.includes(` ${hint} `);
  if (countries.some((code) => countryNames(code).some(names))) return true;
  // US places are usually written "City, ST" or with the state's name, not the country's: per place
  // listed, and only when that place names no other country ("Barcelona, CT, Spain" is Catalonia).
  if (countries.includes("US") && (location ?? "").split(/[;|/]| or /).some(usPlace)) return true;
  if (!ANYWHERE.test(location ?? "")) return false;
  const elsewhere = ALL_COUNTRIES.filter((code) => !countries.includes(code)).some((code) => countryNames(code).some(names)) || REGIONS.some(names);
  return !elsewhere;
}

// Hosts job posts link to that are never the employer's own site.
const THIRD_PARTY_HOSTS =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|personio\.(de|com)|breezy\.hr|linkedin\.com|glassdoor\.[a-z.]+|indeed\.[a-z.]+|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|google\.com|goo\.gl|bit\.ly|apple\.com|microsoft\.com|gov(\.[a-z]{2})?|europa\.eu|wikipedia\.org|github\.com|medium\.com|gmail\.com|outlook\.com|hotmail\.com|yahoo\.com|icloud\.com|workday\.com|myworkdayjobs\.com|icims\.com|taleo\.net|jobvite\.com|bamboohr\.com|recruitee\.com|teamtailor\.com|onetrust\.com)$/i;
/** "careers.toasttab.com" -> "toasttab.com"; "jobs.acme.co.uk" -> "acme.co.uk". Pure. */
export const siteOf = registrableDomain;

/**
 * The sites a company's own job posts link to or give email addresses at (its careers page, its
 * accommodation or recruiting inbox), with how many posts mention each, most mentioned first. Job
 * boards, social networks, government and webmail are left out. Pure.
 */
export function sitesInJobPosts(descriptions: (string | null)[]): { site: string; posts: number }[] {
  const counts = new Map<string, number>();
  for (const text of descriptions) {
    if (!text) continue;
    const hosts = new Set<string>();
    for (const [, host] of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(host);
    for (const [, host] of text.matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(host);
    const sites = new Set([...hosts].map((h) => h.toLowerCase().replace(/\.$/, "")).filter((h) => !THIRD_PARTY_HOSTS.test(h)).map(siteOf));
    for (const site of sites) counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return [...counts.entries()].map(([site, posts]) => ({ site, posts })).sort((a, b) => b.posts - a.posts);
}

// The inbox applicants are asked to send their CV to; never accessibility, privacy, legal or
// benefits addresses, which are for candidates' own requests and not for anyone selling.
const HIRING_INBOX = /^(careers?|jobs?|recruit(ing|ment|er|ers)?|talent([._-]?acquisition)?|hiring|hr|people|apply|applications?|resumes?|cv|vacanc(y|ies)|join(us)?|work(withus)?)([._-]?[a-z]{2,3})?$/;
const NOT_FOR_SALES = /accommodat|disabilit|accessib|privacy|gdpr|dpo|legal|ethic|complian|benefit|payroll|security|abuse|fraud|eeo|noreply|no-reply|donotreply/;

/** Hiring inboxes at the company's own site found in its job posts (e.g. careers@acme.com). Pure. */
export function hiringEmails(descriptions: (string | null)[], site: string): string[] {
  const found = new Set<string>();
  for (const text of descriptions) {
    for (const [email] of (text ?? "").matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
      const [local, host] = email.toLowerCase().split("@");
      if (siteOf(host) === site && HIRING_INBOX.test(local) && !NOT_FOR_SALES.test(local)) found.add(email.toLowerCase());
    }
  }
  return [...found];
}

export const boardDirectory: SourceAdapter = {
  slug: "board_directory",
  isConfigured: () => true,
  async healthCheck(): Promise<HealthStatus> {
    try {
      await currentCrawl();
      return { ok: true, message: "Common Crawl index reachable." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Unavailable." };
    }
  },
};

