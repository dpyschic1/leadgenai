import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { CollectorSlug } from "@/lib/domain/collection";
import { decodeEntities, htmlToText } from "@/server/jobs/html-to-text";
import { CollectionBudgetError } from "../fetch";
import { isStaleJob } from "@/server/jobs/job-signal";
import { countriesIn, parseDate } from "../normalize";
import type { CollectedItemInput, CollectContext, CollectResult, Collector } from "../types";

/**
 * Job boards hosted by ATSs the Company Discovery Engine doesn't read, where startups (our best
 * source of jobs) post: Gem and Rippling. One target per board (its token, e.g. "ultra"), for the
 * company whose careers page linked to it (`params.company`, its domain). Phase 0 review:
 * - Gem: the public Job Board API Gem documents for its customers' boards
 *   (`api.gem.com/job_board/v0/{board}/job_posts/`), with each post's text.
 * - Rippling: the public board pages (`ats.rippling.com/{board}/jobs`), which carry their jobs as
 *   page data; each job's own page adds its description. Read politely, robots.txt allows them.
 * Not collected: Dover (its pages load jobs from `/api/`, which its robots.txt disallows).
 */

export type HostedBoard = { sourceSlug: CollectorSlug; token: string };

const TOKEN = /^[A-Za-z0-9][\w.-]{0,80}$/;

/** The hosted board a job link points to ("https://jobs.gem.com/ultra/…" → gem_board "ultra"); null for any other. Pure. */
export function hostedBoardOf(url: string): HostedBoard | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const first = decodeURIComponent(parsed.pathname.split("/")[1] ?? "");
  if (!TOKEN.test(first)) return null;
  if (host === "jobs.gem.com") return { sourceSlug: "gem_board", token: first };
  if (host === "ats.rippling.com") return { sourceSlug: "rippling_board", token: first };
  return null;
}

const countryOf = (location: string | null) => {
  const named = location ? countriesIn(location) : [];
  return named.length === 1 ? named[0] : null;
};
const company = (params: Record<string, unknown>) => (typeof params.company === "string" ? params.company : null);

// --- Gem -------------------------------------------------------------------------------------------

type GemPost = {
  id?: string;
  title?: string;
  absolute_url?: string;
  content?: string | null;
  content_plain?: string | null;
  first_published_at?: string | null;
  created_at?: string | null;
  location?: { name?: string | null } | null;
  location_type?: string | null;
  employment_type?: string | null;
  departments?: { name?: string | null }[] | null;
};

/**
 * A Gem board's posts (the Job Board API's answer) as items. Posts first published more than 60 days
 * ago are left out, as for every job we keep (`isStaleJob`). Pure.
 */
export function gemJobs(posts: unknown, domain: string | null, now = new Date()): CollectedItemInput[] {
  if (!Array.isArray(posts)) throw new Error("Gem answered something other than a list of posts");
  return (posts as GemPost[]).flatMap((post) => {
    if (!post.id || !post.title?.trim() || !post.absolute_url) return [];
    const postedAt = parseDate(post.first_published_at) ?? parseDate(post.created_at);
    if (isStaleJob(postedAt, now)) return [];
    const location = post.location?.name?.trim() || null;
    const text = post.content_plain?.trim() || (post.content ? htmlToText(post.content) : null);
    return [
      {
        externalId: post.id,
        kind: "job" as const,
        url: post.absolute_url,
        extraction: "api" as const,
        fetchedUrl: null,
        title: post.title.trim(),
        text,
        companyName: null,
        companyDomain: domain,
        location,
        country: countryOf(location),
        remote: post.location_type === "remote" ? true : post.location_type ? false : null,
        postedAt,
        validThrough: null,
        data: {
          ...(post.employment_type ? { employmentType: [post.employment_type.toUpperCase()] } : {}),
          ...(post.location_type ? { workplace: post.location_type } : {}),
          ...(post.departments?.length ? { departments: post.departments.map((d) => d.name).filter(Boolean) } : {}),
        },
      },
    ];
  });
}

async function collectGem({ target, fetcher, now }: CollectContext): Promise<CollectResult> {
  const page = await fetcher.get(`https://api.gem.com/job_board/v0/${encodeURIComponent(target.targetKey)}/job_posts/`);
  if (page.status === 404) return { items: [], cursor: target.cursor, complete: true, note: "Board not found" };
  if (page.status >= 400) throw new Error(`Gem answered ${page.status}`);
  return { items: gemJobs(JSON.parse(page.body), company(target.params), now), cursor: target.cursor, complete: true };
}

// --- Rippling --------------------------------------------------------------------------------------

type RipplingListJob = {
  id?: string;
  name?: string;
  url?: string;
  department?: { name?: string | null } | null;
  locations?: { city?: string | null; state?: string | null; stateCode?: string | null; countryCode?: string | null; workplaceType?: string | null }[] | null;
};

/** The page data a Rippling (Next.js) page is rendered from. */
function nextData(html: string): Record<string, unknown> {
  const json = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!json) throw new Error("Rippling page has no page data");
  return JSON.parse(json) as Record<string, unknown>;
}

/** A Rippling board page's jobs and how many pages the board has. Pure. */
export function ripplingList(html: string): { jobs: RipplingListJob[]; totalPages: number } {
  const queries = ((nextData(html).props as { pageProps?: { dehydratedState?: { queries?: { queryKey?: unknown[]; state?: { data?: unknown } }[] } } })?.pageProps
    ?.dehydratedState?.queries ?? []) as { queryKey?: unknown[]; state?: { data?: { items?: RipplingListJob[]; totalPages?: number } } }[];
  const posts = queries.find((q) => Array.isArray(q.queryKey) && q.queryKey.includes("job-posts"));
  if (!posts?.state?.data) throw new Error("Rippling page has no job list");
  return { jobs: posts.state.data.items ?? [], totalPages: posts.state.data.totalPages ?? 1 };
}

/** One job's own page: its description, when it was created, its contract. Pure. */
export function ripplingJob(html: string): { text: string | null; createdOn: string | null; employmentType: string | null } {
  const post = (nextData(html).props as { pageProps?: { apiData?: { jobPost?: Record<string, unknown> } } })?.pageProps?.apiData?.jobPost;
  if (!post) return { text: null, createdOn: null, employmentType: null };
  const description = post.description && typeof post.description === "object" ? (post.description as Record<string, unknown>) : {};
  // The role first, then the company blurb that every post repeats.
  const parts = [description.role, ...Object.entries(description).filter(([k]) => k !== "role" && k !== "company").map(([, v]) => v), description.company];
  const text = parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => htmlToText(decodeEntities(p))).join("\n") || null;
  const employment = post.employmentType as { id?: string } | undefined;
  return { text, createdOn: typeof post.createdOn === "string" ? post.createdOn : null, employmentType: employment?.id ?? null };
}

/** "Verona, Veneto, IT" / "Austin, TX, US": city, region (US state code) and country of each place. */
function ripplingLocation(job: RipplingListJob): { location: string | null; country: string | null; remote: boolean | null } {
  const places = (job.locations ?? []).map((l) => [l.city, l.countryCode === "US" ? l.stateCode : l.state, l.countryCode].filter(Boolean).join(", ")).filter(Boolean);
  const countries = [...new Set((job.locations ?? []).map((l) => l.countryCode).filter((c): c is string => !!c && /^[A-Z]{2}$/.test(c)))];
  const types = (job.locations ?? []).map((l) => l.workplaceType).filter(Boolean);
  return {
    location: places.join("; ") || null,
    country: countries.length === 1 ? countries[0] : null,
    remote: types.length ? types.every((t) => t === "REMOTE") : null,
  };
}

/** Pages of a board read per run (20 jobs each). */
const RIPPLING_MAX_PAGES = 5;

/**
 * A Rippling board: every job on its pages, then the own pages of jobs not yet described (the
 * description and date never change for a post, so each is read once; the date is kept in the
 * cursor, the text by the store).
 */
async function collectRippling({ target, fetcher, now }: CollectContext): Promise<CollectResult> {
  const base = `https://ats.rippling.com/${encodeURIComponent(target.targetKey)}/jobs`;
  const known = (target.cursor.posted && typeof target.cursor.posted === "object" ? target.cursor.posted : {}) as Record<string, string | null>;
  const jobs: RipplingListJob[] = [];
  let complete = true;
  const first = await fetcher.get(base);
  if (first.status === 404) return { items: [], cursor: {}, complete: true, note: "Board not found" };
  if (first.status >= 400) throw new Error(`Rippling answered ${first.status}`);
  const { jobs: firstJobs, totalPages } = ripplingList(first.body);
  jobs.push(...firstJobs);
  for (let page = 1; page < Math.min(totalPages, RIPPLING_MAX_PAGES); page++) {
    const next = await fetcher.get(`${base}?page=${page}`);
    if (next.status >= 400) throw new Error(`Rippling answered ${next.status} on page ${page + 1}`);
    jobs.push(...ripplingList(next.body).jobs);
  }
  if (totalPages > RIPPLING_MAX_PAGES) complete = false;

  const posted: Record<string, string | null> = {};
  const details = new Map<string, ReturnType<typeof ripplingJob>>();
  for (const job of jobs) {
    if (!job.id) continue;
    if (job.id in known) {
      posted[job.id] = known[job.id];
      continue;
    }
    if (!job.url || !fetcher.canFetch()) continue;
    try {
      const page = await fetcher.get(job.url);
      if (page.status < 400) {
        const detail = ripplingJob(page.body);
        details.set(job.id, detail);
        posted[job.id] = detail.createdOn;
      }
    } catch (error) {
      if (error instanceof CollectionBudgetError) break;
      // One job page failing leaves that job without its description this time.
    }
  }

  const domain = company(target.params);
  const items = jobs.flatMap((job): CollectedItemInput[] => {
    if (!job.id || !job.name?.trim() || !job.url) return [];
    // Posted more than 60 days ago: left out, as for every job we keep. Undated until its page is read.
    if (isStaleJob(parseDate(posted[job.id] ?? null), now)) return [];
    const detail = details.get(job.id);
    const { location, country, remote } = ripplingLocation(job);
    return [
      {
        externalId: job.id,
        kind: "job",
        url: job.url,
        extraction: "api",
        fetchedUrl: detail ? null : `https://ats.rippling.com/${target.targetKey}/jobs`,
        title: job.name.trim(),
        text: detail?.text ?? null,
        companyName: null,
        companyDomain: domain,
        location,
        country,
        remote,
        postedAt: parseDate(posted[job.id] ?? null),
        validThrough: null,
        data: {
          ...(job.department?.name ? { departments: [job.department.name] } : {}),
          ...(detail?.employmentType ? { employmentType: [detail.employmentType] } : {}),
        },
      },
    ];
  });
  return { items, cursor: { posted }, complete };
}

// --- Targets ---------------------------------------------------------------------------------------

/**
 * Boards already seen in collected data (job links on careers pages, careers pages hosted on a
 * board), each with the company that linked to it. Idempotent; returns how many were added.
 */
async function seedFrom(sourceSlug: CollectorSlug, host: string): Promise<number> {
  const rows = await db.execute<{ company: string; url: string }>(sql`
    select company_domain as company, data->>'applyUrl' as url from collected_items
    where data->>'applyUrl' like ${`https://${host}/%`} and company_domain is not null
    union
    select target_key, cursor->>'offsiteCareers' from collection_targets where cursor->>'offsiteCareers' like ${`https://${host}/%`}`);
  let added = 0;
  for (const row of rows) {
    const board = hostedBoardOf(row.url);
    if (!board || board.sourceSlug !== sourceSlug) continue;
    const inserted = await db.execute<{ id: string }>(sql`
      insert into collection_targets (source_slug, target_key, interval_minutes, params)
      values (${sourceSlug}, ${board.token}, ${DEFAULT_INTERVAL_MINUTES}, ${JSON.stringify({ company: row.company, foundOn: row.url })}::jsonb)
      on conflict (source_slug, target_key) do nothing returning id`);
    added += inserted.length;
  }
  return added;
}

/** A board is read daily at first; the interval then adapts to how often it changes. */
const DEFAULT_INTERVAL_MINUTES = 24 * 60;

export const gemBoards: Collector = {
  slug: "gem_board",
  access: "api",
  defaultIntervalMinutes: DEFAULT_INTERVAL_MINUTES,
  collect: collectGem,
  seed: () => seedFrom("gem_board", "jobs.gem.com"),
};

export const ripplingBoards: Collector = {
  slug: "rippling_board",
  access: "html",
  defaultIntervalMinutes: DEFAULT_INTERVAL_MINUTES,
  collect: collectRippling,
  seed: () => seedFrom("rippling_board", "ats.rippling.com"),
};
