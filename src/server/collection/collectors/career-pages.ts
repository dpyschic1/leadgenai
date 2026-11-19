import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { IDLE_COLLECT_INTERVAL_MINUTES, MAX_COLLECT_INTERVAL_MINUTES } from "@/lib/domain/collection";
import { decodeEntities, htmlToText } from "@/server/jobs/html-to-text";
import { isStaleJob, repostKey } from "@/server/jobs/job-signal";
import { extractLinks, jobBoardFromHtml, parseJsonLd, sitemapLinks } from "@/server/sources/company-website";
import { boardFromUrl } from "@/server/sources/board-directory";
import { OffSiteRedirectError, registrableDomain } from "@/server/sources/http";
import { CollectionBudgetError, fetchHome, isBlockedUrl, type Fetcher } from "../fetch";
import { hostedBoardOf } from "./hosted-boards";
import { currentJob, isJobHost, jobCardsFrom, jobPageFrom, listingBody } from "./html-jobs";
import { canonicalUrl, countryCodeOf, domainOf, parseDate } from "../normalize";
import type { CollectedItemInput, CollectContext, CollectResult, Collector } from "../types";

/**
 * Jobs on a company's own careers pages: the original of most jobs that LinkedIn and Indeed show.
 * One target per company domain.
 *
 * 1. Find the careers page (home page links, else the sitemap), once; it is kept in the cursor.
 * 2. Read it and up to two more listing pages, then the job pages it links to (capped per run).
 * 3. Each schema.org JobPosting (the markup employers publish for Google for Jobs) becomes an item;
 *    expired and stale jobs are left out. Without markup, jobs are read from the HTML
 *    (`html-jobs.ts`): the job links on the listing, with each job's own page for its description.
 * A company whose careers page links to a job board the Company Discovery Engine already reads
 * (Greenhouse, Lever, Ashby…) is skipped, so nothing is collected twice. A page that only a browser
 * can render is flagged in the cursor (`needsRender`), not rendered.
 */

/** A careers page's path. Not `/join`: on startup sites that is usually a waitlist or sign-up. */
const CAREERS_PATH = /\/(careers?|jobs|join-us|work-with-us|open-positions|openings|vacancies|positions)(\/|$)/i;
/**
 * Link text that names the careers page itself, as the whole (short) text: "Careers", "Join us",
 * "We're hiring", "Work at Acme". Not "How to work with us" (a page for customers) or any text that
 * only mentions jobs.
 */
const CAREERS_TEXT = /^(careers?|jobs|join (us|our team|the team)|open (positions|roles)|current openings|we('|’)re hiring!?|hiring|vacancies|work (at|for) [\w .&'-]{2,30})$/i;
/** A link that is a file, an application form or a feed, never a job page. */
const NOT_A_JOB_PAGE = /(\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xml)$)|\/(apply|login|signin|feed|rss)(\/|$)/i;

/** A careers page is read daily at first; the interval then adapts to how often it changes. */
const DEFAULT_INTERVAL_MINUTES = 24 * 60;
/** Listing pages read per run (the careers page and its "next" pages). */
const MAX_LISTING_PAGES = 3;
/** Job pages read per run; a bigger careers site is read over several runs (the run is then not complete). */
const MAX_JOB_PAGES = 25;

const sameSite = (url: string, domain: string) => {
  try {
    return registrableDomain(new URL(url).hostname) === domain;
  } catch {
    return false;
  }
};

/** The company's careers page among a page's (or sitemap's) links: same site, shortest path first. Pure. */
export function careersUrlFrom(links: { url: string; text: string }[], domain: string): string | null {
  const candidates = links
    .filter((l) => sameSite(l.url, domain) && !NOT_A_JOB_PAGE.test(new URL(l.url).pathname))
    .map((l) => ({ url: l.url, path: new URL(l.url).pathname, text: l.text }))
    .filter((l) => CAREERS_PATH.test(l.path) || CAREERS_TEXT.test(l.text.trim()));
  // A path that says careers beats link text that does; then the shortest (the index, not one job).
  candidates.sort((a, b) => Number(CAREERS_PATH.test(b.path)) - Number(CAREERS_PATH.test(a.path)) || a.path.length - b.path.length);
  return candidates[0]?.url ?? null;
}

/** "Next" listing pages linked from a careers page: the same path with a page number. Pure. */
export function listingPageLinks(html: string, pageUrl: string, careersUrl: string): string[] {
  const careers = new URL(careersUrl);
  const base = careers.pathname.replace(/\/+$/, "");
  return [
    ...new Set(
      extractLinks(html, pageUrl)
        .map((l) => new URL(l.url))
        .filter((u) => u.hostname === careers.hostname)
        .filter((u) => /[?&](page|p|pg)=\d+/.test(u.search) || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/page/\\d+/?$`).test(u.pathname))
        .map((u) => u.toString()),
    ),
  ].filter((u) => canonicalUrl(u) !== canonicalUrl(pageUrl));
}

/** Job pages a careers listing links to: same site, below the careers path or under a jobs path. Pure. */
export function jobPageLinks(html: string, pageUrl: string, careersUrl: string, domain: string): string[] {
  const base = new URL(careersUrl).pathname.replace(/\/+$/, "");
  const seen = new Set<string>([canonicalUrl(careersUrl), canonicalUrl(pageUrl)]);
  const links: string[] = [];
  for (const link of extractLinks(html, pageUrl)) {
    if (!sameSite(link.url, domain)) continue;
    const url = new URL(link.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (NOT_A_JOB_PAGE.test(path) || /[?&](page|p|pg)=\d+/.test(url.search)) continue;
    const below = base.length > 1 && path.startsWith(`${base}/`) && !/\/page\/\d+$/.test(path);
    const jobPath = /\/(jobs?|careers?|positions?|openings?|vacanc(y|ies)|roles?)\/[^/]+/i.test(path);
    if (!below && !jobPath) continue;
    const key = canonicalUrl(url.toString());
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(url.toString());
  }
  return links;
}

/** A page whose content only appears once scripts run: little text and an app root element. Pure. */
export function looksClientRendered(html: string): boolean {
  const text = htmlToText(listingBody(html));
  if (/\b(javascript is required|requires javascript|enable javascript|turn on javascript)\b/i.test(text)) return true;
  return text.length < 400 && /<div[^>]+id\s*=\s*["'](root|app|__next|__nuxt|svelte|main-app)["']/i.test(html);
}

// --- JobPosting markup -----------------------------------------------------------------------------

type Json = Record<string, unknown>;
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null);
const objects = (value: unknown): Json[] => [value].flat().filter((v): v is Json => !!v && typeof v === "object" && !Array.isArray(v));
const isType = (object: Json, type: string) => [object["@type"]].flat().some((t) => t === type);

function placeOf(location: Json): { text: string | null; country: string | null } {
  const address = location.address;
  if (typeof address === "string") return { text: address.trim() || null, country: countryCodeOf(address.split(",").at(-1)) };
  const a = objects(address)[0] ?? {};
  const countryValue = typeof a.addressCountry === "object" ? str((a.addressCountry as Json)?.name) : str(a.addressCountry);
  const parts = [str(a.addressLocality), str(a.addressRegion), countryValue].filter(Boolean);
  return { text: parts.length > 0 ? parts.join(", ") : str(location.name), country: countryCodeOf(countryValue) };
}

/**
 * The organisation's own website among `url` / `sameAs` (a LinkedIn profile or its page on a job
 * site, "ycombinator.com/companies/…", is not it).
 */
function organisationDomain(org: Json): string | null {
  for (const value of [org.url, org.sameAs].flat()) {
    const url = str(value);
    if (url && /^https?:\/\//i.test(url) && !isBlockedUrl(url) && !isJobHost(new URL(url).hostname)) return domainOf(url);
  }
  return null;
}

/**
 * Every current JobPosting on a page as an item. Expired jobs (`validThrough` passed) and stale ones
 * (posted more than 60 days ago) are left out. The company is the posting's own organisation when it
 * names its website, else the site's. Pure.
 */
export function jobPostingsFrom(html: string, pageUrl: string, domain: string, now: Date): CollectedItemInput[] {
  const items: CollectedItemInput[] = [];
  for (const posting of parseJsonLd(html).filter((o) => isType(o, "JobPosting"))) {
    const title = str(posting.title) ?? str(posting.name);
    if (!title) continue;
    const validThrough = parseDate(posting.validThrough);
    const postedAt = parseDate(posting.datePosted);
    if ((validThrough && validThrough < now) || isStaleJob(postedAt, now)) continue;

    let url = pageUrl;
    try {
      if (str(posting.url)) url = new URL(str(posting.url)!, pageUrl).toString();
    } catch {
      // A malformed url: the page it is on is the job's page.
    }
    const org = objects(posting.hiringOrganization)[0] ?? {};
    const places = objects(posting.jobLocation).map(placeOf);
    const remote = [posting.jobLocationType].flat().some((t) => t === "TELECOMMUTE") || null;
    const required = objects(posting.applicantLocationRequirements).map((r) => str(r.name)).filter((n): n is string => !!n);
    const countries = [...new Set([...places.map((p) => p.country), ...required.map(countryCodeOf)].filter((c): c is string => !!c))];
    const location = places.map((p) => p.text).filter(Boolean).join("; ") || (remote ? ["Remote", ...required].join(", ") : null);
    const identifier = str(posting.identifier) ?? str(objects(posting.identifier)[0]?.value);
    const text = str(posting.description) ? htmlToText(decodeEntities(str(posting.description)!)) : null;
    const salary = objects(posting.baseSalary)[0];
    const salaryValue = salary ? (objects(salary.value)[0] ?? {}) : {};

    items.push({
      // The posting's own id, else its URL; jobs listed without either on one page are told apart by title and place.
      externalId: identifier
        ? `${domain}:${identifier}`
        : str(posting.url)
          ? canonicalUrl(url)
          : `${canonicalUrl(pageUrl)}#${repostKey({ title, location })}`,
      kind: "job",
      url,
      extraction: "json_ld",
      fetchedUrl: canonicalUrl(url) === canonicalUrl(pageUrl) ? null : pageUrl,
      title,
      text,
      companyName: str(org.name),
      companyDomain: organisationDomain(org) ?? domain,
      location,
      country: countries.length === 1 ? countries[0] : null,
      remote,
      postedAt,
      validThrough,
      data: {
        ...(str(posting.employmentType) || Array.isArray(posting.employmentType) ? { employmentType: [posting.employmentType].flat().filter((t) => typeof t === "string") } : {}),
        ...(salary
          ? {
              salary: {
                currency: str(salary.currency),
                min: Number(salaryValue.minValue ?? salaryValue.value) || null,
                max: Number(salaryValue.maxValue ?? salaryValue.value) || null,
                unit: str(salaryValue.unitText),
              },
            }
          : {}),
        ...(identifier ? { identifier } : {}),
      },
    });
  }
  return items;
}

// --- The collector ---------------------------------------------------------------------------------

/** Nothing to collect here for a long while; earlier items of the target are closed. */
const idle = (cursor: Json, note: string): CollectResult => ({ items: [], cursor, complete: true, intervalMinutes: IDLE_COLLECT_INTERVAL_MINUTES, note });

type FoundCareers = { careersUrl: string | null; jobBoard: string | null; moved?: NonNullable<CollectResult["movedTo"]>; boardLinks?: string[] };

/**
 * Hands the jobs on Gem and Rippling boards to their own collectors: each board this company links
 * to becomes a target of that collector (with this company), and is listed in the cursor.
 */
function withBoards(result: CollectResult, links: Iterable<string>, domain: string): CollectResult {
  const boards = new Map<string, NonNullable<CollectResult["discovered"]>[number]>();
  for (const url of links) {
    const board = hostedBoardOf(url);
    const key = board && `${board.sourceSlug}:${board.token}`;
    if (board && key && !boards.has(key)) boards.set(key, { sourceSlug: board.sourceSlug, targetKey: board.token, params: { company: domain, foundOn: url } });
  }
  if (boards.size === 0) return result;
  return {
    ...result,
    cursor: { ...result.cursor, hostedBoards: [...boards.keys()] },
    discovered: [...boards.values()],
    handedOver: [...links].filter((url) => hostedBoardOf(url)),
  };
}

/** Most redirects kept in a target's history. */
const MAX_REDIRECT_HISTORY = 10;

/**
 * The website moved to another domain (checked and reachable): nothing is collected under the old
 * domain, and its earlier jobs close; the runner collects the new domain as its own target. The old
 * target keeps the original URL and the redirect history.
 */
function moved(cursor: Json, move: NonNullable<CollectResult["movedTo"]>, now: Date): CollectResult {
  const history = Array.isArray(cursor.redirects) ? cursor.redirects : [];
  const redirects = [...history, ...move.moves.map((m) => ({ ...m, at: now.toISOString() }))].slice(-MAX_REDIRECT_HISTORY);
  const rest = { ...cursor };
  delete rest.careersUrl;
  return { items: [], cursor: { ...rest, movedTo: move.domain, redirects }, complete: true, intervalMinutes: IDLE_COLLECT_INTERVAL_MINUTES, note: `Website moved to ${move.domain}`, movedTo: move };
}

async function findCareersPage(domain: string, fetcher: Fetcher): Promise<FoundCareers> {
  const { page: home, domain: current, moves } = await fetchHome(domain, fetcher);
  if (home.status >= 400) throw new Error(`Home page answered ${home.status}`);
  if (moves.length > 0) return { careersUrl: null, jobBoard: null, moved: { domain: current, moves } };
  const board = jobBoardFromHtml(home.body);
  if (board) return { careersUrl: null, jobBoard: `${board.provider}:${board.boardToken}` };
  const homeLinks = extractLinks(home.body, home.url);
  const fromHome = careersUrlFrom(homeLinks, domain);
  // Without a careers page of its own, the home page may link straight to its job board.
  const boardLinks = homeLinks.map((l) => l.url).filter((u) => hostedBoardOf(u));
  if (fromHome || !fetcher.canFetch()) return { careersUrl: fromHome, jobBoard: null, boardLinks };
  try {
    const sitemap = await fetcher.get(`${new URL(home.url).origin}/sitemap.xml`);
    return { careersUrl: sitemap.status < 400 ? careersUrlFrom(sitemapLinks(sitemap.body), domain) : null, jobBoard: null, boardLinks };
  } catch (error) {
    if (error instanceof CollectionBudgetError) throw error;
    return { careersUrl: null, jobBoard: null, boardLinks }; // no sitemap, or robots.txt disallows it
  }
}

async function collect({ target, now, fetcher }: CollectContext): Promise<CollectResult> {
  const domain = target.targetKey;
  const cursor: Json = { ...target.cursor };
  delete cursor.needsRender;
  const items: CollectedItemInput[] = [];
  /** Jobs read from the listing's HTML, by external id, until their own pages are read. */
  const cards = new Map<string, CollectedItemInput>();
  let complete = true;

  try {
    let careersUrl = str(cursor.careersUrl);
    if (!careersUrl) {
      const found = await findCareersPage(domain, fetcher);
      if (found.moved) return moved(cursor, found.moved, now);
      if (found.jobBoard) return idle({ ...cursor, jobBoard: found.jobBoard }, "Jobs are on a job board the Company Discovery Engine reads");
      if (!found.careersUrl) {
        const onBoard = found.boardLinks?.length ? "Jobs are on a Gem or Rippling board, collected there" : "No careers page found";
        return withBoards(idle(cursor, onBoard), found.boardLinks ?? [], domain);
      }
      careersUrl = found.careersUrl;
      cursor.careersUrl = careersUrl;
    }

    let listing;
    try {
      listing = await fetcher.get(careersUrl);
    } catch (error) {
      if (!(error instanceof OffSiteRedirectError)) throw error;
      // The careers page now redirects to another site: a job board we already read, the whole
      // website having moved, or careers hosted elsewhere (kept for later collectors, not followed).
      const board = boardFromUrl(error.to);
      if (board) return idle({ ...cursor, jobBoard: `${board.provider}:${board.boardToken}` }, "Jobs are on a job board the Company Discovery Engine reads");
      if (hostedBoardOf(error.to)) return withBoards(idle(cursor, "Jobs are on a Gem or Rippling board, collected there"), [error.to], domain);
      delete cursor.careersUrl;
      const found = await findCareersPage(domain, fetcher);
      if (found.moved) return moved(cursor, found.moved, now);
      return idle({ ...cursor, offsiteCareers: error.to }, `Careers page redirects to ${new URL(error.to).hostname}`);
    }
    if (listing.status === 404 || listing.status === 410) {
      // The careers page moved: look for it again next time; its jobs have gone with it.
      delete cursor.careersUrl;
      return { items: [], cursor, complete: true, note: `Careers page answered ${listing.status}` };
    }
    if (listing.status >= 400) throw new Error(`Careers page answered ${listing.status}`);
    const board = jobBoardFromHtml(listing.body);
    if (board) return idle({ ...cursor, jobBoard: `${board.provider}:${board.boardToken}` }, "Jobs are on a job board the Company Discovery Engine reads");

    const pages = [listing];
    for (const next of listingPageLinks(listing.body, listing.url, careersUrl).slice(0, MAX_LISTING_PAGES - 1)) {
      if (!fetcher.canFetch()) break;
      const page = await fetcher.get(next).catch(() => null);
      if (page && page.status < 400) pages.push(page);
    }
    for (const page of pages) items.push(...jobPostingsFrom(page.body, page.url, domain, now));
    // No markup on the listing: the jobs it links to, read from its HTML (see html-jobs.ts).
    if (items.length === 0) for (const page of pages) for (const card of jobCardsFrom(page.body, page.url, domain)) cards.set(card.externalId, card);
    // Jobs on a Gem or Rippling board are collected from the board itself (full list, text, dates).
    const boardLinks = new Set<string>();
    for (const [key, card] of cards) {
      if (!hostedBoardOf(card.url)) continue;
      boardLinks.add(card.url);
      cards.delete(key);
    }

    const read = new Set(items.map((i) => canonicalUrl(i.url)));
    // Cards that link to the job's own page on this site: that page is read for the description.
    // (Never a job on a board elsewhere or a ?job_id= view of the listing: those carry an applyUrl.)
    const linked = [...cards.values()].filter((c) => !c.data.applyUrl && c.fetchedUrl !== null && sameSite(c.url, domain)).map((c) => c.url);
    const jobPages = [...new Set([...pages.flatMap((p) => jobPageLinks(p.body, p.url, careersUrl!, domain)), ...linked])].filter((u) => !read.has(canonicalUrl(u)));
    if (jobPages.length > MAX_JOB_PAGES) complete = false;
    for (const url of jobPages.slice(0, MAX_JOB_PAGES)) {
      if (!fetcher.canFetch()) {
        complete = false;
        break;
      }
      try {
        const page = await fetcher.get(url);
        // A job page that is gone is a closed job; any other error leaves the run incomplete.
        if (page.status >= 400) {
          if (page.status !== 404 && page.status !== 410) complete = false;
          continue;
        }
        const marked = jobPostingsFrom(page.body, page.url, domain, now);
        // A card for its own page is keyed by that page's canonical URL (its external id).
        const key = canonicalUrl(url);
        if (marked.length > 0) {
          // The job's own page has markup: that is the job, not its card on the listing.
          items.push(...marked);
          cards.delete(key);
          continue;
        }
        const own = jobPageFrom(page.body, page.url, domain);
        const card = cards.get(key);
        if (own && card) {
          cards.set(key, { ...card, text: own.text, location: card.location ?? own.location, country: card.country ?? own.country, remote: card.remote ?? own.remote, data: { ...own.data, ...card.data } });
        } else if (own) {
          cards.set(key, own);
        }
      } catch (error) {
        if (error instanceof CollectionBudgetError) throw error;
        complete = false;
      }
    }

    // The careers link went straight to one job's page.
    if (items.length === 0 && cards.size === 0 && /\/[^/]+\/[^/]+/.test(new URL(listing.url).pathname)) {
      const own = jobPageFrom(listing.body, listing.url, domain);
      if (own) cards.set(own.externalId, own);
    }
    items.push(...cards.values());
    cards.clear();
    // Posts marked filled, builders' copies, and dates written on undated pages (see currentJob).
    items.splice(0, items.length, ...items.flatMap((item) => currentJob(item, now) ?? []));

    if (items.length === 0 && boardLinks.size > 0) return withBoards(idle(cursor, "Jobs are on a Gem or Rippling board, collected there"), boardLinks, domain);
    if (items.length === 0 && looksClientRendered(listing.body)) {
      // Phase 4 renders these in a browser; until then nothing is closed on their account.
      return { items, cursor: { ...cursor, needsRender: true }, complete: false, intervalMinutes: IDLE_COLLECT_INTERVAL_MINUTES, note: "Careers page needs a browser to render" };
    }
    return withBoards(
      {
        items,
        cursor: { ...cursor, jobs: items.length },
        complete,
        ...(items.length === 0 ? { intervalMinutes: MAX_COLLECT_INTERVAL_MINUTES, note: "No jobs found on the careers pages" } : {}),
      },
      boardLinks,
      domain,
    );
  } catch (error) {
    if (!(error instanceof CollectionBudgetError)) throw error;
    return { items: [...items, ...cards.values()].flatMap((item) => currentJob(item, now) ?? []), cursor, complete: false, note: "Stopped at the run's request budget or time" };
  }
}

/**
 * Targets from companies already known platform-wide (read only): active US Y Combinator companies
 * (hiring ones first) and every website the Company Discovery Engine has read.
 */
async function seed(): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into collection_targets (source_slug, target_key, interval_minutes, priority)
    select 'career_pages', domain, ${DEFAULT_INTERVAL_MINUTES}, max(priority) from (
      select y.domain, case when y.is_hiring then 1 else 0 end as priority
      from yc_companies y where y.country = 'US' and y.status = 'Active' and y.domain is not null
      union all
      select s.domain, 0 from site_reads s
    ) d
    where domain ~ '^[a-z0-9.-]+\\.[a-z]{2,}$'
    group by domain
    on conflict (source_slug, target_key) do nothing
    returning id`);
  return rows.length;
}


export const careerPages: Collector = {
  slug: "career_pages",
  access: "html",
  defaultIntervalMinutes: DEFAULT_INTERVAL_MINUTES,
  collect,
  seed,
};
