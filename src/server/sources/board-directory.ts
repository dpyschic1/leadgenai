import "server-only";
import { and, asc, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { boardJobs, directoryCrawls, jobBoardDirectory } from "@/db/schema";
import { BOARD_TOKEN_PATTERN, JOB_BOARD_PROVIDERS, type JobBoardProvider } from "@/lib/domain/job-boards";
import { MAX_SOURCE_TEXT } from "@/lib/validation/signals";
import { AppError } from "@/server/http/errors";
import { fetchBoardJobs } from "@/server/jobs/fetch-jobs";
import { JOB_BOARD_ADAPTERS } from "@/server/jobs/providers";
import { decodeEntities } from "@/server/jobs/html-to-text";
import type { NormalizedJob } from "@/server/jobs/types";
import { politeGet } from "./http";
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
/** Closed jobs are kept this long (to tell long-open roles from new ones), then deleted. */
const CLOSED_RETENTION_DAYS = 90;

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
  const unique = [...new Map(candidates.map((c) => [`${c.provider}:${c.boardToken}`, c])).values()];
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
export async function refreshBoard(provider: JobBoardProvider, token: string): Promise<"valid" | "invalid" | "error"> {
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
    return invalid ? "invalid" : "error";
  }

  const profile = await boardProfile(provider, token);
  await db.transaction(async (tx) => {
    for (let start = 0; start < jobs.length; start += 100) {
      const rows = jobs.slice(start, start + 100).map((job) => ({
        provider,
        boardToken: token,
        externalId: job.externalId,
        title: job.title.slice(0, 300),
        department: trimText(job.department, 200),
        location: trimText(job.location, 300),
        url: job.url,
        description: trimText(job.description, MAX_SOURCE_TEXT),
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
            description: sql`excluded.description`,
            postedAt: sql`excluded.posted_at`,
            lastSeenAt: sql`now()`,
            closedAt: null,
          },
        });
    }
    // Jobs gone from the board are closed; long-closed ones are deleted.
    await tx
      .update(boardJobs)
      .set({ closedAt: sql`now()` })
      .where(and(eq(boardJobs.provider, provider), eq(boardJobs.boardToken, token), isNull(boardJobs.closedAt), lt(boardJobs.lastSeenAt, sql`now()`)));
    await tx
      .delete(boardJobs)
      .where(and(eq(boardJobs.provider, provider), eq(boardJobs.boardToken, token), lt(boardJobs.closedAt, sql`now() - make_interval(days => ${CLOSED_RETENTION_DAYS})`)));
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

export type CachedJob = NormalizedJob & { boardJobId: string };

/**
 * A board's open jobs from the shared cache, downloading them first when the cache is older than
 * `freshWithinMs`. Throws the provider's error when a download is needed and fails.
 */
export async function boardJobsFor(provider: JobBoardProvider, token: string, freshWithinMs = BOARD_FRESH_MS): Promise<CachedJob[]> {
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
const ONLY_ELSEWHERE = /\b(remote)\b.*\b(us|usa|canada|americas|apac|india|latam)\b/i;

/**
 * Whether a job's location fits the workspace's target countries (ISO codes; empty = anywhere).
 * Named countries and their main cities count; a remote role open worldwide counts too, but not
 * one restricted to another region. Pure.
 */
export function jobInCountries(location: string | null, countries: string[]): boolean {
  if (countries.length === 0) return true;
  const text = ` ${(location ?? "").toLowerCase().replace(/[^a-z.]+/g, " ")} `;
  const hit = countries.some((code) => {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code)?.toLowerCase();
    return [...(COUNTRY_HINTS[code] ?? []), ...(name ? [name] : [])].some((hint) => text.includes(` ${hint} `));
  });
  if (hit) return true;
  return ANYWHERE.test(location ?? "") && !ONLY_ELSEWHERE.test(location ?? "");
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

