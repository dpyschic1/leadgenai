import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { readIntent } from "@/server/engine/intent";
import { decodeEntities, htmlToText } from "@/server/jobs/html-to-text";
import { categorizeJob } from "@/server/jobs/job-categories";
import { isBlockedUrl } from "../fetch";
import { domainOf } from "../normalize";
import type { CollectedItemInput, CollectContext, CollectResult, Collector } from "../types";
import { countryOf, factsOf, isJobHost, isJobTitle } from "./html-jobs";

/**
 * Hacker News through the public HN Search API (Algolia, no key). Three targets:
 * - `who-is-hiring`: the monthly "Ask HN: Who is hiring?" thread, where startups post their open
 *   roles as "Company | Role | Place | …". Each company's post (a top-level comment) is a job.
 * - `seeking-freelancer`: the monthly "Freelancer? Seeking freelancer?" thread. Each post that opens
 *   with SEEKING FREELANCER is a buyer looking for help (a post, not a job).
 * - `ask-hn-requests`: Ask HN posts whose own title asks for an agency or a developer (the LeadGen
 *   Engine's intent rules, `readIntent`).
 * A thread is read whole in one request (its comment tree); the month's newest thread replaces the
 * last one, so last month's posts close.
 */

const API = "https://hn.algolia.com/api/v1";
export const HN_TARGETS = ["who-is-hiring", "seeking-freelancer", "ask-hn-requests"] as const;

type HnStory = { objectID: string; title?: string | null; story_text?: string | null; url?: string | null; author?: string | null; created_at_i?: number; num_comments?: number | null };
type HnComment = { id: number; author?: string | null; text?: string | null; created_at_i?: number; children?: HnComment[] };

const itemUrl = (id: string | number) => `https://news.ycombinator.com/item?id=${id}`;
/** A comment's text, one paragraph per line. */
const plain = (html: string | null | undefined) => htmlToText(decodeEntities((html ?? "").replace(/<p>/gi, "\n")));

/** The newest story whose title fits, the busiest when two are posted the same month. Pure. */
export function newestThread(stories: HnStory[], title: RegExp): HnStory | null {
  const fitting = stories.filter((s) => s.title && title.test(s.title));
  const month = (s: HnStory) => (s.title ?? "").match(/\(([A-Za-z]+ \d{4})\)/)?.[1] ?? "";
  const newest = fitting.sort((a, b) => (b.created_at_i ?? 0) - (a.created_at_i ?? 0))[0];
  if (!newest) return null;
  return fitting.filter((s) => month(s) === month(newest)).sort((a, b) => (b.num_comments ?? 0) - (a.num_comments ?? 0))[0];
}

/** Roles named in a whole word list: "Software Engineers", "Multiple positions (…)". */
const ROLES = /\b(engineers|developers|designers|scientists|researchers|managers|roles|positions|openings)\b/i;

/**
 * Hosts a hiring post links to that are never the company's own website: code, video, forms,
 * documents, link shorteners, scheduling (and every platform collection never fetches).
 */
const NOT_COMPANY_HOSTS =
  /(^|\.)(ycombinator\.com|grnh\.se|oraclecloud\.com|taleo\.net|successfactors\.(com|eu)|devitjobs\.com|welcometothejungle\.com|otta\.com|builtin\.com|himalayas\.app|remoteok\.com|weworkremotely\.com|vercel\.app|netlify\.app|herokuapp\.com|github\.io|pages\.dev|webflow\.io|github\.com|gitlab\.com|youtube\.com|youtu\.be|vimeo\.com|forms\.gle|notion\.site|notion\.so|medium\.com|substack\.com|calendly\.com|cal\.com|typeform\.com|airtable\.com|tally\.so|lu\.ma|bit\.ly|tinyurl\.com|docs\.google\.com|drive\.google\.com|dropbox\.com|loom\.com)$/i;

/** A post's links that can be the company's own website (not a job board, HN or another platform). */
function companySite(links: string[]): string | null {
  for (const url of links) {
    try {
      const host = new URL(url).hostname;
      if (!NOT_COMPANY_HOSTS.test(host) && !isJobHost(host) && !isBlockedUrl(url)) return url;
    } catch {
      // Not a URL.
    }
  }
  return null;
}

/** A header part that is a web address ("https://acme.com", "acme.com/jobs"). */
const WEBSITE_PART = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;

/** A header part that is a place ("Cologne, Germany", "REMOTE (US)"), not a company or a role. */
const isPlacePart = (part: string) => /^(remote|onsite|on-site|hybrid)\b/i.test(part) || (countryOf(part) !== null && !isJobTitle(part));

/**
 * A "Who is hiring?" post as a job: its first line is "Company | Role | Place | …" by the thread's
 * rules. The company is the first part, the job the first part that names a role, the facts the
 * rest; the company's website is the first link that isn't a job board or HN. Posts without the
 * header, or without a role in it, are left out. Pure.
 */
export function hiringPost(comment: HnComment, threadId: string): CollectedItemInput | null {
  if (!comment.text || !comment.id) return null;
  const text = plain(comment.text);
  const header = text.split("\n")[0]?.trim() ?? "";
  if (!header.includes("|")) return null;
  const parts = header.split("|").map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const isRole = (p: string) => p.length <= 120 && (isJobTitle(p) || ROLES.test(p));
  // The company is the first part, unless the header opens with a place ("Cologne, Germany | UMH | …").
  const companyAt = parts.findIndex((p) => !isPlacePart(p) && !isRole(p));
  const company = parts[companyAt]?.replace(/\s*\(.*\)$/, "").trim();
  const roleAt = parts.findIndex((p, i) => i > companyAt && isRole(p));
  if (companyAt === -1 || companyAt > 1 || !company || company.length > 80 || roleAt === -1) return null;
  const title = parts[roleAt].replace(/\s*\(\d+\s+openings?\)$/i, "");
  const rest = parts.filter((p, i) => i !== companyAt && i !== roleAt && !WEBSITE_PART.test(p));
  const { location, remote, data } = factsOf(rest);
  const links = [...comment.text.matchAll(/href="([^"]+)"/g)].map((m) => decodeEntities(m[1]));
  // A website the header states ("https://acme.com", "acme.com") comes first: the company wrote it there.
  const stated = parts.filter((p) => WEBSITE_PART.test(p)).map((p) => (/^https?:/i.test(p) ? p : `https://${p}`));
  const website = companySite([...stated, ...links]);
  const apply = links.find((url) => {
    try {
      return isJobHost(new URL(url).hostname);
    } catch {
      return false;
    }
  });
  return {
    externalId: String(comment.id),
    kind: "job",
    url: itemUrl(comment.id),
    extraction: "api",
    fetchedUrl: null,
    title,
    text,
    companyName: company,
    companyDomain: website ? domainOf(website) : null,
    location,
    country: countryOf(location),
    remote,
    postedAt: comment.created_at_i ? new Date(comment.created_at_i * 1000) : null,
    validThrough: null,
    data: { ...data, thread: threadId, author: comment.author ?? null, header: header.slice(0, 300), ...(apply ? { applyUrl: apply } : {}) },
  };
}

/** A "SEEKING FREELANCER" post as a buyer's request: its first line is its title. Pure. */
export function freelancerRequest(comment: HnComment, threadId: string): CollectedItemInput | null {
  if (!comment.text || !comment.id) return null;
  const text = plain(comment.text);
  if (!/^\s*seeking freelancer/i.test(text)) return null;
  const title = (text.split("\n")[0] ?? "").trim().slice(0, 200);
  const { location, remote } = factsOf(title.split("|").map((p) => p.trim()).slice(1));
  return {
    externalId: String(comment.id),
    kind: "post",
    url: itemUrl(comment.id),
    extraction: "api",
    fetchedUrl: null,
    title,
    text,
    companyName: null,
    companyDomain: null,
    location,
    country: countryOf(location),
    remote,
    postedAt: comment.created_at_i ? new Date(comment.created_at_i * 1000) : null,
    validThrough: null,
    // The title is only "SEEKING FREELANCER | Remote": the work is named in the opening lines.
    categories: categorizeJob({ title: text.split("\n").slice(0, 3).join(" ").slice(0, 300), department: null }),
    data: { thread: threadId, author: comment.author ?? null, intent: "high" },
  };
}

/** An Ask HN post whose own title asks to hire someone for a piece of work, as a request. Pure. */
export function askRequest(story: HnStory): CollectedItemInput | null {
  const title = story.title?.trim();
  if (!title || !story.objectID || story.url || !/^ask hn/i.test(title)) return null;
  const intent = readIntent(title);
  if (!intent) return null;
  return {
    externalId: story.objectID,
    kind: "post",
    url: itemUrl(story.objectID),
    extraction: "api",
    fetchedUrl: null,
    title: title.slice(0, 200),
    text: story.story_text ? plain(story.story_text) : null,
    companyName: null,
    companyDomain: null,
    location: null,
    country: null,
    remote: null,
    postedAt: story.created_at_i ? new Date(story.created_at_i * 1000) : null,
    validThrough: null,
    data: { author: story.author ?? null, intent: intent.level, intentReason: intent.reason },
  };
}

/** Phrases that open a request to hire (as in the LeadGen Engine's Hacker News provider). */
const REQUEST_PHRASES = ["looking for an agency", "looking for a developer", "need a developer", "need an agency", "looking for a dev shop", "recommend an agency"];
/** How far back the Ask HN search looks; posts older than this are also past the freshness limit. */
const ASK_WINDOW_DAYS = 60;

async function collect({ target, fetcher, now }: CollectContext): Promise<CollectResult> {
  const json = async <T>(url: string, timeoutMs?: number): Promise<T> => {
    const page = await fetcher.get(url, { timeoutMs });
    if (page.status >= 400) throw new Error(`HN Search answered ${page.status}`);
    return JSON.parse(page.body) as T;
  };

  if (target.targetKey === "ask-hn-requests") {
    const since = Math.floor(now.getTime() / 1000) - ASK_WINDOW_DAYS * 86_400;
    const items = new Map<string, CollectedItemInput>();
    for (const phrase of REQUEST_PHRASES) {
      const { hits } = await json<{ hits: HnStory[] }>(
        `${API}/search_by_date?${new URLSearchParams({ query: phrase, tags: "ask_hn", numericFilters: `created_at_i>${since}`, hitsPerPage: "50" })}`,
      );
      for (const hit of hits) {
        const item = askRequest(hit);
        if (item) items.set(item.externalId, item);
      }
    }
    // Searches, not a listing: a post not found again is not closed by it.
    return { items: [...items.values()], cursor: {}, complete: false };
  }

  const hiring = target.targetKey === "who-is-hiring";
  const query = hiring ? "Ask HN: Who is hiring?" : "Freelancer? Seeking freelancer?";
  const { hits } = await json<{ hits: HnStory[] }>(`${API}/search_by_date?${new URLSearchParams({ query, tags: "story", hitsPerPage: "20" })}`);
  const thread = newestThread(hits, hiring ? /^Ask HN: Who is hiring\? \(/i : /^Ask HN: Freelancer\? Seeking freelancer\? \(/i);
  if (!thread) return { items: [], cursor: target.cursor, complete: false, note: "No thread found" };
  // The whole thread in one answer (about 0.5 MB): it gets longer than a page to arrive.
  const tree = await json<{ children?: HnComment[] }>(`${API}/items/${thread.objectID}`, 20_000);
  // A SEEKING FREELANCER post in the hiring thread is a buyer's request, not a company's job.
  const read = (c: HnComment) => freelancerRequest(c, thread.objectID) ?? (hiring ? hiringPost(c, thread.objectID) : null);
  const items = (tree.children ?? []).map(read).filter((i): i is CollectedItemInput => i !== null);
  return { items, cursor: { thread: thread.objectID, title: thread.title }, complete: true, note: `${thread.title}: ${tree.children?.length ?? 0} posts` };
}

/** The three targets (idempotent). */
async function seed(): Promise<number> {
  let added = 0;
  for (const key of HN_TARGETS) {
    const rows = await db.execute<{ id: string }>(sql`
      insert into collection_targets (source_slug, target_key, interval_minutes)
      values ('hacker_news', ${key}, ${12 * 60}) on conflict (source_slug, target_key) do nothing returning id`);
    added += rows.length;
  }
  return added;
}

export const hackerNews: Collector = {
  slug: "hacker_news",
  access: "api",
  defaultIntervalMinutes: 12 * 60,
  collect,
  seed,
};
