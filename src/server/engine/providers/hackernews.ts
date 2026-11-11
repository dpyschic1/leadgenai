import "server-only";
import { htmlToText } from "@/server/jobs/html-to-text";
import { fetchJson } from "../http";
import { readIntent } from "../intent";
import { matchedTerms } from "../match";
import type { DiscoveredItem, DiscoveryProvider } from "../types";

/**
 * Hacker News through the official Algolia search API (free, no key). Posts and comments are kept
 * only when the text reads as a buying signal AND mentions one of the workspace's services.
 */

export type HnHit = {
  objectID: string;
  author?: string;
  created_at_i?: number;
  title?: string | null;
  story_title?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  url?: string | null;
};

/** How far back each run looks. Rediscovery of the same post only enriches it. */
const WINDOW_DAYS = 30;

/** Phrases that surface requests to hire, combined with the workspace's own service terms. */
const REQUEST_PHRASES = ["looking for an agency", "looking for a developer", "need a developer", "seeking freelancer", "need an agency", "looking for a dev shop"];

/**
 * Where requests to hire actually appear on HN:
 *  - comments in the monthly "Freelancer? Seeking freelancer?" thread that open with "SEEKING FREELANCER";
 *  - Ask HN posts whose own title states the request.
 * A phrase buried in an ordinary discussion comment is conversation, not a buying signal, and the
 * other recurring threads ("Who is hiring" = staff jobs, "Who wants to be hired" = freelancers
 * advertising) are the opposite of a buyer.
 */
const FREELANCER_THREAD = /seeking freelancer/i;

export function parseHnHit(hit: HnHit, serviceTerms: string[]): DiscoveredItem | null {
  const isComment = hit.comment_text != null;
  if (isComment) {
    if (!FREELANCER_THREAD.test(hit.story_title ?? "")) return null;
    if (!/^\s*seeking freelancer/i.test(htmlToText(hit.comment_text ?? ""))) return null;
  } else if (hit.url || !/^ask hn/i.test(hit.title ?? "")) {
    return null; // a link post is an article; only Ask HN self posts can be a request
  }
  const body = htmlToText(hit.comment_text ?? hit.story_text ?? "");
  // A comment is titled by its own first line: the thread title ("Seeking freelancer?") says nothing about this commenter.
  const title = (isComment ? (body.split("\n")[0] ?? "") : (hit.title ?? "")).trim();
  const text = body || title;
  if (!text || !hit.objectID) return null;

  // For a post, only its title counts: a phrase deep in the body is not the request.
  const intent = readIntent(isComment ? `${title}\n${text}` : title);
  if (!intent) return null;
  if (matchedTerms(serviceTerms, `${title}\n${text}`).length === 0) return null;

  return {
    capability: "intent",
    category: "intent",
    sourceSlug: "hacker_news",
    platform: "Hacker News",
    externalId: hit.objectID,
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    title: title.slice(0, 200),
    text: text.slice(0, 2000),
    postedAt: hit.created_at_i ? new Date(hit.created_at_i * 1000) : null,
    buyerName: hit.author ?? null,
    buyerProfileUrl: hit.author ? `https://news.ycombinator.com/user?id=${encodeURIComponent(hit.author)}` : null,
    companyName: null,
    companyDomain: null,
    country: null, // HN does not state one; never guessed
    city: null,
    industry: null,
    remote: null,
    clientType: null,
    budget: null,
    funding: null,
    intentHint: intent.level,
    verification: "unverified", // the post is real, who/what is behind it is not confirmed
    metadata: { intentReason: intent.reason, intentLevel: intent.level },
  };
}

export const hackerNews: DiscoveryProvider = {
  slug: "hacker_news",
  name: "Hacker News",
  capability: "intent",
  async discover({ serviceTerms, now, signal }) {
    const since = Math.floor(now.getTime() / 1000) - WINDOW_DAYS * 86_400;
    const topTerms = serviceTerms.slice(0, 3);
    const queries = [...REQUEST_PHRASES, ...topTerms.map((t) => `looking for ${t}`)];
    const found = new Map<string, DiscoveredItem>();
    const failures: string[] = [];
    for (const query of queries) {
      const url =
        "https://hn.algolia.com/api/v1/search_by_date?" +
        new URLSearchParams({ query, tags: "(story,comment)", numericFilters: `created_at_i>${since}`, hitsPerPage: "40" });
      try {
        const data = await fetchJson<{ hits?: HnHit[] }>(url, { signal });
        for (const hit of data.hits ?? []) {
          const item = parseHnHit(hit, serviceTerms);
          if (item) found.set(item.externalId, item);
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    // One slow query must not lose the rest; only every query failing is a provider failure.
    if (failures.length === queries.length) throw new Error(failures[0]);
    return [...found.values()];
  },
};
