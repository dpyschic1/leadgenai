import "server-only";
import { isIP } from "node:net";
import { FetchBlockedError, OffSiteRedirectError, politeGet, registrableDomain, type FetchedPage } from "@/server/sources/http";

/**
 * HTTP for collectors: the existing polite fetch (`politeGet`: robots.txt, one request a second per
 * site, public addresses only, size cap, identified user agent) plus the collection policy:
 * - sites whose terms forbid automated collection are refused outright, whatever a collector asks
 *   (Phase 0 review: LinkedIn, Indeed, Google Search and similar);
 * - each run has a request budget and a deadline, so one target cannot hold a call too long.
 * Pages are always fetched with robots.txt checked and redirects kept on the same site.
 */

/** Hosts never fetched by any collector (their registrable domain and every subdomain). */
const BLOCKED_HOSTS =
  /(^|\.)(linkedin\.com|lnkd\.in|indeed\.[a-z.]+|glassdoor\.[a-z.]+|ziprecruiter\.com|monster\.com|wellfound\.com|angel\.co|google\.[a-z.]+|googleusercontent\.com|bing\.com|duckduckgo\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|reddit\.com|upwork\.com)$/i;

/** Whether collection may never fetch this URL's host. Pure. */
export function isBlockedUrl(url: string): boolean {
  try {
    return BLOCKED_HOSTS.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

/** The run's request budget or time is used up; the collector stops and returns what it has. */
export class CollectionBudgetError extends Error {}

export type Fetcher = {
  /** GETs a page (robots.txt checked, same-site redirects only). Throws FetchBlockedError or CollectionBudgetError. */
  get(url: string): Promise<FetchedPage>;
  /** Whether another request fits in the run's budget and time. */
  canFetch(): boolean;
  readonly requests: number;
};

/** Reserve for the last request to finish (the polite fetch times out after 10 s). */
const LAST_REQUEST_MS = 10_000;

export function createFetcher({ maxRequests, deadline }: { maxRequests: number; deadline: number }): Fetcher {
  let requests = 0;
  const canFetch = () => requests < maxRequests && Date.now() + LAST_REQUEST_MS < deadline;
  return {
    get requests() {
      return requests;
    },
    canFetch,
    async get(url) {
      if (isBlockedUrl(url)) throw new FetchBlockedError(`Collection never fetches ${safeHost(url)}`);
      if (!canFetch()) throw new CollectionBudgetError("Request budget or time used up");
      requests++;
      return politeGet(url);
    },
  };
}

// --- Websites that moved to another domain ------------------------------------------------------

/** One recorded redirect to another domain: the URL asked for, where it ended, every hop between. */
export type DomainMove = { from: string; to: string; hops: string[]; domain: string };

/** Hosts a domain redirects to when it is parked or for sale: never the company's new website. */
const PARKING_HOSTS = /(^|\.)(sedo\.com|sedoparking\.com|hugedomains\.com|dan\.com|afternic\.com|godaddy\.com|parkingcrew\.net|bodis\.com|above\.com|undeveloped\.com|namecheap\.com|domainmarket\.com|squadhelp\.com|atom\.com|porkbun\.com)$/i;

/**
 * Whether a redirect from `fromDomain` to `to` is a company website moving to a new domain, and
 * which. Refused: anything not http(s), IP addresses, local or single-label hosts, platforms whose
 * terms forbid collection, parked domains, the same site, and a domain already passed through this
 * run (a loop). Only a check of the URL: the new site's own fetch then applies the network checks
 * (public addresses only, robots.txt). Pure.
 */
export function moveDestination(fromDomain: string, to: string, visited: string[]): { domain: string } | { refused: string } {
  let url: URL;
  try {
    url = new URL(to);
  } catch {
    return { refused: "not a valid URL" };
  }
  if (!/^https?:$/.test(url.protocol)) return { refused: `unsupported protocol ${url.protocol}` };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) return { refused: "an IP address, not a website" };
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return { refused: `${host} is not a public website` };
  if (isBlockedUrl(url.toString())) return { refused: `${host} is a platform we never collect from` };
  if (PARKING_HOSTS.test(host)) return { refused: `${host} parks domains; the website is gone` };
  const domain = registrableDomain(host);
  if (domain === fromDomain) return { refused: "the same website" };
  if (visited.includes(domain)) return { refused: `redirect loop back to ${domain}` };
  return { domain };
}

/** Most domain moves followed in one run (old → new → newer). */
const MAX_DOMAIN_MOVES = 2;

/**
 * GETs a company's home page, following moves to other domains the way `moveDestination` allows.
 * Returns the page, the domain it is on now and the moves on the way (empty when it didn't move).
 * A refused or looping move throws FetchBlockedError with the reason.
 */
export async function fetchHome(domain: string, fetcher: Fetcher): Promise<{ page: FetchedPage; domain: string; moves: DomainMove[] }> {
  const moves: DomainMove[] = [];
  const visited = [domain];
  let current = domain;
  for (;;) {
    try {
      return { page: await fetcher.get(`https://${current}/`), domain: current, moves };
    } catch (error) {
      if (!(error instanceof OffSiteRedirectError)) throw error;
      const destination = moveDestination(current, error.to, visited);
      if ("refused" in destination) throw new FetchBlockedError(`Redirected to ${safeHost(error.to)}, not followed: ${destination.refused}`);
      if (moves.length >= MAX_DOMAIN_MOVES) throw new FetchBlockedError(`More than ${MAX_DOMAIN_MOVES} domain moves`);
      moves.push({ from: error.hops[0] ?? `https://${current}/`, to: error.to, hops: error.hops, domain: destination.domain });
      visited.push(destination.domain);
      current = destination.domain;
    }
  }
}

const safeHost = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "an invalid URL";
  }
};
