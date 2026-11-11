import "server-only";
import { fetchJson } from "../http";
import { readIntent } from "../intent";
import { matchedTerms } from "../match";
import type { DiscoveredItem, DiscoveryProvider } from "../types";

/**
 * Google results through SerpAPI (paid; set SERPAPI_API_KEY). This is how Intent Discovery reaches
 * public posts on Reddit, Quora, Indie Hackers, LinkedIn and X: those sites have no open API and block
 * or forbid direct scraping, but a licensed search API returns what Google already indexes. Each query
 * costs one search credit, so a run uses at most QUERIES_PER_RUN.
 */

const QUERIES_PER_RUN = 4;
/** Phrases that state a request to hire, in the words people actually use. */
const REQUEST = '("looking for an agency" OR "need a developer" OR "looking for a freelancer" OR "looking for a dev shop" OR "recommend an agency")';
const SITES = "(site:reddit.com OR site:quora.com OR site:indiehackers.com OR site:linkedin.com/posts OR site:x.com)";

export type SerpResult = { title?: string; link?: string; snippet?: string; date?: string };

const PLATFORMS: [RegExp, string][] = [
  [/(^|\.)reddit\.com$/, "Reddit"],
  [/(^|\.)quora\.com$/, "Quora"],
  [/(^|\.)indiehackers\.com$/, "Indie Hackers"],
  [/(^|\.)linkedin\.com$/, "LinkedIn"],
  [/(^|\.)(x|twitter)\.com$/, "X"],
  [/(^|\.)facebook\.com$/, "Facebook"],
];

export function platformOf(link: string): string | null {
  try {
    const host = new URL(link).hostname.toLowerCase();
    return PLATFORMS.find(([re]) => re.test(host))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** "3 days ago" / "Nov 3, 2026" from a search result; null when absent. */
function resultDate(date: string | undefined, now: Date): Date | null {
  if (!date) return null;
  const ago = date.match(/(\d+)\s*(hour|day|week|month)s?\s+ago/i);
  if (ago) {
    const unit = { hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000 }[ago[2].toLowerCase() as "hour" | "day" | "week" | "month"];
    return new Date(now.getTime() - Number(ago[1]) * unit);
  }
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * One search result -> an Intent opportunity, or null. The buyer is an unidentified person (spec outcome B):
 * a search snippet does not say who posted, so identity stays unknown rather than guessed.
 */
export function parseSerpResult(r: SerpResult, serviceTerms: string[], now: Date): DiscoveredItem | null {
  if (!r.link || !r.title) return null;
  const platform = platformOf(r.link);
  if (!platform) return null;
  const text = `${r.title}\n${r.snippet ?? ""}`;
  const intent = readIntent(text);
  if (!intent) return null;
  if (matchedTerms(serviceTerms, text).length === 0) return null;

  return {
    capability: "intent",
    category: "intent",
    sourceSlug: "serpapi",
    platform,
    externalId: r.link.slice(0, 300),
    url: r.link,
    title: r.title.slice(0, 200),
    text: (r.snippet ?? "").slice(0, 1000),
    postedAt: resultDate(r.date, now),
    buyerName: null,
    buyerProfileUrl: null,
    companyName: null,
    companyDomain: null,
    country: null,
    city: null,
    industry: null,
    remote: null,
    clientType: null,
    budget: null,
    funding: null,
    intentHint: intent.level,
    verification: "unverified", // a search snippet, not the post itself
    metadata: { intentReason: intent.reason, via: "Google (SerpAPI)" },
  };
}

export const serpApi: DiscoveryProvider = {
  slug: "serpapi",
  name: "Google search (SerpAPI)",
  capability: "intent",
  configured: () => Boolean(process.env.SERPAPI_API_KEY),
  setupHint: "Set SERPAPI_API_KEY to search Reddit, Quora, Indie Hackers, LinkedIn and X through Google.",
  async discover({ serviceTerms, now, signal }) {
    const key = process.env.SERPAPI_API_KEY;
    if (!key) return [];
    const found = new Map<string, DiscoveredItem>();
    for (const term of serviceTerms.slice(0, QUERIES_PER_RUN)) {
      const params = new URLSearchParams({ engine: "google", q: `${SITES} ${REQUEST} ${term}`, num: "20", tbs: "qdr:m", api_key: key });
      const data = await fetchJson<{ organic_results?: SerpResult[]; error?: string }>(`https://serpapi.com/search.json?${params}`, { signal });
      if (data.error) throw new Error(`SerpAPI: ${data.error}`);
      for (const result of data.organic_results ?? []) {
        const item = parseSerpResult(result, serviceTerms, now);
        if (item) found.set(item.externalId, item);
      }
    }
    return [...found.values()];
  },
};
