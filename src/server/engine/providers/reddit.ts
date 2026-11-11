import "server-only";
import { decodeEntities, htmlToText } from "@/server/jobs/html-to-text";
import { fetchText } from "../http";
import { isEmployment, readIntent } from "../intent";
import { matchedTerms } from "../match";
import type { DiscoveredItem, DiscoveryProvider } from "../types";

/**
 * Reddit through its public Atom feeds. Reddit's JSON and API hosts answer 403 to unauthenticated
 * clients, but `.rss` works. If the feeds get rate-limited, switch to the official OAuth API with
 * a free app key (same parser output).
 */

export type AtomEntry = { id: string; title: string; link: string; author: string | null; updated: string | null; content: string };

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? null;

/** Minimal Atom reader for Reddit's well-formed feeds. */
export function parseAtom(xml: string): AtomEntry[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: decodeEntities(tag(e, "id") ?? "").trim(),
    title: decodeEntities(tag(e, "title") ?? "").trim(),
    link: e.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? "",
    author: decodeEntities(tag(tag(e, "author") ?? "", "name") ?? "").trim() || null,
    updated: tag(e, "updated")?.trim() ?? null,
    content: tag(e, "content") ?? "",
  }));
}

/** Subreddits where people ask for agencies and developers. */
const SUBREDDITS = ["forhire", "startups", "SaaS", "Entrepreneur", "smallbusiness", "webdev", "SideProject"];

export function parseRedditEntry(entry: AtomEntry, serviceTerms: string[]): DiscoveredItem | null {
  if (!entry.id || !entry.link) return null;
  const text = htmlToText(decodeEntities(entry.content)).replace(/\s*submitted by[\s\S]*$/i, "").trim();
  const full = `${entry.title}\n${text}`;
  // r/forhire's own convention: [Hiring] is a buyer, [For Hire] is someone offering services.
  const hiring = /^\[hiring\]/i.test(entry.title);
  const intent = hiring ? { level: "high" as const, reason: "Posted as [Hiring] on r/forhire." } : readIntent(full);
  if (!intent) return null;
  if (hiring && isEmployment(full)) return null; // a job ad, not a project for an outside provider
  // r/forhire posts tagged [For Hire] are people offering services, not buyers.
  if (/^\[for hire\]/i.test(entry.title)) return null;
  if (matchedTerms(serviceTerms, full).length === 0) return null;

  const user = entry.author?.replace(/^\/?u\//, "") ?? null;
  return {
    capability: "intent",
    category: "intent",
    sourceSlug: "reddit",
    platform: "Reddit",
    externalId: entry.id.replace(/^.*\//, ""),
    url: entry.link,
    title: entry.title.slice(0, 200),
    text: text.slice(0, 2000),
    postedAt: entry.updated ? new Date(entry.updated) : null,
    buyerName: user,
    buyerProfileUrl: user ? `https://www.reddit.com/user/${encodeURIComponent(user)}` : null,
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
    verification: "unverified",
    metadata: { intentReason: intent.reason, intentLevel: intent.level },
  };
}

export const reddit: DiscoveryProvider = {
  slug: "reddit",
  name: "Reddit",
  capability: "intent",
  async discover({ serviceTerms, signal }) {
    const urls = [
      ...SUBREDDITS.map((s) => `https://www.reddit.com/r/${s}/new.rss?limit=50`),
      ...serviceTerms.slice(0, 3).map((t) => `https://www.reddit.com/search.rss?${new URLSearchParams({ q: `looking for ${t}`, sort: "new", t: "month", limit: "50" })}`),
    ];
    const found = new Map<string, DiscoveredItem>();
    const failures: string[] = [];
    for (const url of urls) {
      try {
        for (const entry of parseAtom(await fetchText(url, { signal }))) {
          const item = parseRedditEntry(entry, serviceTerms);
          if (item) found.set(item.externalId, item);
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      // Reddit throttles bursts; stay well under it.
      await new Promise((r) => setTimeout(r, 1200));
    }
    // One failing feed must not hide the others; only an all-feeds failure is a provider failure.
    if (failures.length === urls.length) throw new Error(failures[0]);
    return [...found.values()];
  },
};
