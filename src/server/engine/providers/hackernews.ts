import "server-only";
import { decodeEntities, htmlToText } from "@/server/jobs/html-to-text";
import { categorizeJob } from "@/server/jobs/job-categories";
import { isJobHost } from "@/server/collection/collectors/html-jobs";
import { registrableDomain } from "@/server/sources/http";
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

/**
 * A company's post in HN's monthly "Who is hiring?" thread, kept only when it's a B2B opportunity
 * (`B2B` in the rules the feed uses): open to contract, freelance or part-time work; hiring 3 or more
 * technical roles; or hiring a founding role. The post is written by the company (often a founder)
 * and usually gives its website and an email to write to: both are kept as its contacts. Nothing is
 * guessed: no website or email means none. Pure.
 */
/** Open to outside help: contractors, freelancers, part-time or consulting work. A fixed-term employment contract isn't. */
const CONTRACT_WORK =
  /\b(contractors?|freelance(rs?)?|part[- ]time|consultants?|contract[- ](to[- ]hire|roles?|positions?|basis|work|engineers?|developers?|opportunit(y|ies))|(on|via) (a )?contract)\b/i;
const FOUNDING_ROLE = /\bfounding\b/i;
const MIN_ROLES = 3;
/** Links in a post that aren't the company's website. */
const NOT_A_WEBSITE = /(grnh\.se|lnkd\.in|ycombinator\.com|linkedin\.com|github\.com|twitter\.com|x\.com\/|notion\.site|docs\.google\.com|forms\.gle|calendly\.com|typeform\.com|tally\.so|airtable\.com|bit\.ly)/i;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};
/** A job title names a job ("Senior Backend Engineer", "Product Designer"); a sentence or a skill ("TypeScript") doesn't. */
const ROLE_NOUN = /\b(engineers?|developers?|designers?|scientists?|architects?|devops|sre|programmers?|cto|researchers?|analysts?)\b/i;

/**
 * The roles a post lists, as job titles: the header's parts after the company ("Acme | Senior Backend
 * Engineer, ML Engineer | Remote") split at commas, slashes and "and", plus short list lines of the
 * post ("- Staff Data Scientist"). Never a sentence, a place, a salary or a skill. Pure.
 */
export function postRoles(text: string): string[] {
  const lines = text.split("\n").map((l) => l.trim());
  const headerParts = (lines[0] ?? "").split("|").slice(1);
  const listLines = lines.slice(1).filter((l) => /^([-*•·]|\d+[.)])\s+/.test(l) || (l.length <= 60 && !/[.!?:;]$/.test(l)));
  const candidates = [...headerParts, ...listLines]
    .flatMap((part) => part.split(/\s*(?:,|\/|&|\band\b|;)\s*/i))
    // Bullets, emphasis, "(US)" and an unclosed "(US" left by a split are not part of the title.
    .map((r) => r.replace(/^([-*•·]|\d+[.)])\s+/, "").replace(/[*_]/g, "").replace(/\s*\(.*?\)\s*/g, " ").replace(/\s*\([^)]*$/, "").trim())
    .filter(
      (r) =>
        r.length >= 4 &&
        r.length <= 60 &&
        r.split(/\s+/).length <= 7 &&
        ROLE_NOUN.test(r) &&
        !/[$€£\d:]|https?|www\.|\b(remote|onsite|on-site|hybrid|visa|full[- ]time|salary|equity)\b/i.test(r) &&
        !/[.!?]$/.test(r) &&
        // A web-address slug ("founding-engineer"), a file name ("devops.md"), a lone lowercase word
        // ("devops": a tag, not a title), or the start of a sentence ("Strong understanding of…").
        !/^[a-z0-9]+(-[a-z0-9]+)+$/i.test(r) &&
        !/\.[a-z]{1,4}$/i.test(r) &&
        !/^[a-z]+$/.test(r) &&
        !/^(strong|experience|understanding|knowledge|you|we|our|ideal|looking|ability|familiar|proven)\b/i.test(r),
    );
  const seen = new Set<string>();
  return candidates.filter((r) => {
    // The same title written twice ("DevOps Engineer", "Devops engineers") is one role.
    const key = r.toLowerCase().replace(/[^a-z]/g, "").replace(/s$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return categorizeJob({ title: r, department: null }).length > 0;
  });
}

export function parseHiringPost(hit: HnHit, thread: string): DiscoveredItem | null {
  if (!hit.comment_text || !hit.objectID) return null;
  const text = htmlToText(hit.comment_text);
  const header = (text.split("\n")[0] ?? "").trim();
  const parts = header.split("|").map((p) => p.trim()).filter(Boolean);
  const named = parts[0]?.replace(/\s*\(.*?\)\s*$/, "").trim();
  if (!named || named.length > 80 || parts.length < 2) return null; // not a company post ("Is this still open?")

  // Technical roles: each listed job title a job-title rule recognises.
  const roles = postRoles(text);
  const categories = [...new Set(roles.flatMap((r) => categorizeJob({ title: r, department: null })))];
  if (categories.length === 0) return null;
  const contract = CONTRACT_WORK.test(text);
  const founding = FOUNDING_ROLE.test(text);
  const reasons = [contract && "open to contract or freelance work", founding && "hiring a founding role", roles.length >= MIN_ROLES && `hiring ${roles.length} technical roles`].filter(
    (r): r is string => typeof r === "string",
  );
  if (reasons.length === 0) return null; // one or two ordinary roles: a job opening, not B2B

  const links = [...hit.comment_text.matchAll(/href="([^"]+)"/g)].map((m) => decodeEntities(m[1]));
  // The company's own site: not HN, a job board or ATS, a form, a code host or a social profile.
  const link = links.find((u) => /^https?:\/\//i.test(u) && !NOT_A_WEBSITE.test(u) && !isJobHost(hostOf(u)));
  // The site itself (app.opentrain.ai/api/out/… is opentrain.ai), not a tracking or careers-page link.
  const domain = link ? registrableDomain(hostOf(link)) || null : null;
  const website = domain ? `https://${domain}` : null;
  // HN hides addresses from bots as "jobs [at] acme [dot] com": read them back.
  const plain = text.replace(/\s*[[(]\s*at\s*[\])]\s*/gi, "@").replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".");
  const emails = [...new Set([...plain.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map((m) => m[0].toLowerCase().replace(/\.$/, "")))].slice(0, 3);
  // A post that opens with "SEEKING FREELANCER" (or similar) instead of its name: named by its site or address.
  const company = /^(seeking|hiring|looking)\b/i.test(named) ? (domain ?? emails[0]?.split("@")[1] ?? named) : named;

  return {
    capability: "intent",
    category: "intent",
    sourceSlug: "hacker_news",
    platform: "Hacker News",
    externalId: hit.objectID,
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    title: `${company} is hiring: ${roles.slice(0, 4).join(", ")}${roles.length > 4 ? ` and ${roles.length - 4} more` : ""}`.slice(0, 200),
    text: text.slice(0, 2000),
    postedAt: hit.created_at_i ? new Date(hit.created_at_i * 1000) : null,
    buyerName: company,
    buyerProfileUrl: website,
    companyName: company,
    companyDomain: domain,
    country: null, // a post's place is free text; never guessed
    city: null,
    industry: null,
    remote: /\bremote\b/i.test(header) ? true : null,
    clientType: "company",
    budget: null,
    funding: null,
    intentHint: contract ? "high" : "medium",
    verification: "unverified",
    metadata: {
      hiring: true,
      jobCategories: categories,
      roles,
      b2bReasons: reasons,
      thread,
      ...(emails.length ? { emails } : {}),
      ...(website ? { website } : {}),
    },
  };
}

/** The latest monthly "Ask HN: Who is hiring?" thread (posted by HN's own account), if it's recent. */
async function latestHiringThread(now: Date, signal?: AbortSignal): Promise<{ id: string; title: string } | null> {
  const data = await fetchJson<{ hits?: { objectID: string; title?: string; created_at_i?: number }[] }>(
    "https://hn.algolia.com/api/v1/search_by_date?" + new URLSearchParams({ tags: "story,author_whoishiring", query: "who is hiring", hitsPerPage: "5" }),
    { signal },
  );
  const thread = (data.hits ?? []).find((h) => /who is hiring\?/i.test(h.title ?? ""));
  if (!thread || !thread.created_at_i || now.getTime() / 1000 - thread.created_at_i > HIRING_THREAD_MAX_AGE_DAYS * 86_400) return null;
  return { id: thread.objectID, title: thread.title ?? "Who is hiring?" };
}
const HIRING_THREAD_MAX_AGE_DAYS = 45;

/** Every top-level post in a thread (the company posts, not the replies to them). */
async function threadPosts(threadId: string, signal?: AbortSignal): Promise<HnHit[]> {
  const data = await fetchJson<{ hits?: (HnHit & { parent_id?: number })[] }>(
    "https://hn.algolia.com/api/v1/search?" + new URLSearchParams({ tags: `comment,story_${threadId}`, hitsPerPage: "1000" }),
    { signal },
  );
  return (data.hits ?? []).filter((h) => String(h.parent_id) === threadId);
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
    // This month's "Who is hiring?": the company posts that are B2B (contract work, 3+ roles, founding roles).
    try {
      const thread = await latestHiringThread(now, signal);
      if (thread) {
        for (const post of await threadPosts(thread.id, signal)) {
          const item = parseHiringPost(post, thread.title);
          if (item) found.set(item.externalId, item);
        }
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
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
    if (failures.length === queries.length + 1) throw new Error(failures[0]);
    return [...found.values()];
  },
};
