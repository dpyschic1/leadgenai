import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { isJobHost } from "./collectors/html-jobs";
import { isBlockedUrl } from "./fetch";

/**
 * Careers-page targets from Common Crawl's URL index: `.com` websites whose careers page
 * (`/careers`, `/jobs`, `/join-us`…) the crawl fetched in English. Only the web addresses are
 * used: each site is then read live, politely, by `career_pages` (robots.txt, one request a second),
 * starting at the careers page the crawl found. Read offline (`scripts/collect-common-crawl.ts`,
 * DuckDB on the index's Parquet files, a few files at a time; each costs about 80 MB) and seeded in
 * controlled batches whose first runs are spread over time. Nothing of the crawl is stored but each
 * chosen domain as a target, with the crawl and careers page it came from (`params.commonCrawl`).
 *
 * Common Crawl's terms neither allow nor forbid commercial use outright (they recommend legal
 * advice) and forbid invading privacy or infringing others' rights: no page content is taken.
 */

export const COMMON_CRAWL_INDEX = "https://index.commoncrawl.org/collinfo.json";
export const COMMON_CRAWL_DATA = "https://data.commoncrawl.org";

/** Careers-page paths the index is searched for (with or without a trailing slash). */
const CAREERS_PATHS = ["careers", "jobs", "join-us", "join", "work-with-us", "careers/open-positions", "company/careers", "about/careers"];

/** One site as the extraction query writes it (one JSON object per line). */
export type CrawlSite = { domain: string; careers_url: string };

/**
 * The index files to read, by number ("150-152,80" → the 150th, 151st, 152nd and 80th of the
 * crawl's `subset=warc` files, from its `cc-index-table.paths` list). Pure.
 */
export function indexFiles(pathsList: string, picks: string): string[] {
  const files = pathsList.split("\n").map((l) => l.trim()).filter((l) => l.includes("/subset=warc/") && l.endsWith(".parquet"));
  const numbers = new Set<number>();
  for (const part of picks.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [from, to = from] = part.split("-").map(Number);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) throw new Error(`"${part}" is not a file number or range`);
    for (let n = from; n <= to; n++) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b).map((n) => {
    if (!files[n]) throw new Error(`The crawl has ${files.length} index files; there is no file ${n}`);
    return `${COMMON_CRAWL_DATA}/${files[n]}`;
  });
}

/**
 * The DuckDB query that reads careers pages from these index files: `.com` sites (row groups of
 * other domains are skipped by their statistics, so a file of other domains costs only its footer),
 * fetched with status 200 as HTML in English, on the site's own host, at a careers path without a
 * query. One row per domain. Writes one JSON object per line.
 */
export function crawlSitesSql(files: string[], outJson: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const paths = CAREERS_PATHS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return `SET enable_progress_bar = false;
COPY (
  SELECT url_host_registered_domain AS domain, min(url) AS careers_url
  FROM read_parquet([${files.map(quote).join(", ")}])
  WHERE url_host_tld = 'com' AND fetch_status = 200 AND content_mime_detected = 'text/html'
    AND (url_host_name = url_host_registered_domain OR url_host_name = 'www.' || url_host_registered_domain)
    AND regexp_matches(url_path, '^/(${paths})/?$') AND url_query IS NULL
    AND content_languages LIKE 'eng%'
  GROUP BY 1
) TO ${quote(outJson)} (FORMAT json);`;
}

/** A domain whose name says it is a job site, not an employer ("interislandjob.com", "techcareers.com"). */
const JOB_SITE_NAME = /(jobs?|careers?|hiring|recruit|staffing|vacanc)/i;

/** Sites in a template family: at least this many sharing the start of their name… */
const FAMILY_SIZE = 10;
const FAMILY_PREFIX = 7;
const FAMILY_SUFFIX = 5;
/** …nearly all at the same careers path (real companies that share a name's start, "integra…", vary). */
const FAMILY_SAME_PATH = 0.85;

export type SeedSite = { domain: string; careersUrl: string };
export type CrawlSeedStats = { sites: number; alreadyTargets: number; jobSites: number; templateFamilies: number; candidates: number };

/**
 * The sites worth seeding: a usable `.com` domain on its own careers page, not a platform we never
 * collect from, not a job board or job site, not one of a family of template microsites (insurance
 * agents' sites, all "/jobs": "myagentnora.com", "insurewithashley.com"…), and not already a target.
 * Families are found among the sites given, so give a whole extraction at once. Pure.
 */
export function crawlCandidates(rows: CrawlSite[], existing: Set<string>): { candidates: SeedSite[]; stats: CrawlSeedStats } {
  const sites = new Map<string, SeedSite>();
  for (const row of rows) {
    const domain = row.domain?.toLowerCase();
    if (!domain || !/^[a-z0-9-]+\.com$/.test(domain) || sites.has(domain)) continue;
    let host: string;
    try {
      host = new URL(row.careers_url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host !== domain && host !== `www.${domain}`) continue;
    sites.set(domain, { domain, careersUrl: row.careers_url });
  }
  // The exact path: a template writes it one way ("/jobs"); companies vary ("/careers", "/careers/").
  const pathOf = (url: string) => new URL(url).pathname;
  // A family shares the start of its names ("myagent…") or their end ("…sfagent", "…insurance").
  const families = new Map<string, SeedSite[]>();
  for (const site of sites.values()) {
    const name = site.domain.slice(0, -".com".length);
    for (const key of [`^${name.slice(0, FAMILY_PREFIX)}`, `${name.slice(-FAMILY_SUFFIX)}$`]) families.set(key, [...(families.get(key) ?? []), site]);
  }
  const templated = new Set<string>();
  for (const members of families.values()) {
    if (members.length < FAMILY_SIZE) continue;
    const counts = new Map<string, number>();
    for (const m of members) counts.set(pathOf(m.careersUrl), (counts.get(pathOf(m.careersUrl)) ?? 0) + 1);
    if (Math.max(...counts.values()) / members.length >= FAMILY_SAME_PATH) for (const m of members) templated.add(m.domain);
  }
  const stats: CrawlSeedStats = { sites: sites.size, alreadyTargets: 0, jobSites: 0, templateFamilies: templated.size, candidates: 0 };
  const candidates: SeedSite[] = [];
  for (const site of sites.values()) {
    if (templated.has(site.domain)) continue;
    if (existing.has(site.domain)) stats.alreadyTargets++;
    else if (JOB_SITE_NAME.test(site.domain.split(".")[0]) || isJobHost(site.domain) || isBlockedUrl(`https://${site.domain}/`)) stats.jobSites++;
    else candidates.push(site);
  }
  stats.candidates = candidates.length;
  return { candidates, stats };
}

/**
 * A batch of `limit` candidates spread over the whole extraction (the index is sorted by host, so
 * its first rows are one corner of the alphabet): ordered by a hash of the domain. Deterministic.
 * Pure.
 */
export function pickCrawlBatch(candidates: SeedSite[], limit: number): SeedSite[] {
  const key = (d: string) => createHash("sha1").update(d).digest("hex");
  return [...candidates].sort((a, b) => key(a.domain).localeCompare(key(b.domain))).slice(0, limit);
}

/**
 * Adds a batch as careers-page targets that start at the careers page the crawl found (a page that
 * is gone sends the collector back to the home page). First runs are spread evenly over
 * `spreadHours`; they go behind YC's companies and Overture's tier 1 (priority -1). A domain that
 * became a target meanwhile is left as it is. Returns how many were added.
 */
export async function insertCrawlSeeds(batch: SeedSite[], { crawl, spreadHours }: { crawl: string; spreadHours: number }): Promise<number> {
  let added = 0;
  const step = batch.length > 1 ? (spreadHours * 3_600_000) / batch.length : 0;
  const start = Date.now();
  for (const [i, site] of batch.entries()) {
    const rows = await db.execute<{ id: string }>(sql`
      insert into collection_targets (source_slug, target_key, interval_minutes, priority, next_run_at, params, cursor)
      values ('career_pages', ${site.domain}, ${24 * 60}, -1, ${new Date(start + i * step).toISOString()}::timestamptz,
        ${JSON.stringify({ seed: "common_crawl", commonCrawl: { crawl, careersUrl: site.careersUrl } })}::jsonb,
        ${JSON.stringify({ careersUrl: site.careersUrl })}::jsonb)
      on conflict (source_slug, target_key) do nothing
      returning id`);
    added += rows.length;
  }
  return added;
}

/** The newest crawl's id ("CC-MAIN-2026-43"). */
export async function latestCrawl(): Promise<string> {
  const response = await fetch(COMMON_CRAWL_INDEX, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Common Crawl's crawl list answered ${response.status}`);
  const [newest] = (await response.json()) as { id: string }[];
  if (!/^CC-MAIN-\d{4}-\d{2}$/.test(newest?.id ?? "")) throw new Error("Common Crawl's crawl list has no crawl id");
  return newest.id;
}
