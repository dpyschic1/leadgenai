import "server-only";
import { createHash } from "node:crypto";
import { BOARD_TOKEN_PATTERN, type JobBoardProvider } from "@/lib/domain/job-boards";
import { decodeEntities, htmlToText } from "@/server/jobs/html-to-text";
import type { HealthStatus, SourceAdapter } from "./index";
import { FetchBlockedError, hostResolves, politeGet, siteOf } from "./http";

/**
 * The company's own public website: find it when only the name is known, then read a handful of
 * pages (about, team, contact, careers, news) politely. Only facts extracted from them are stored.
 */

export type SitePage = { url: string; kind: PageKind; text: string; contentHash: string };
export type SiteRead = {
  domain: string;
  pages: SitePage[];
  emails: string[];
  phones: string[];
  jobBoard: ReturnType<typeof jobBoardFromHtml>;
};

/** Existing guessed domains fetched per company, and how long each may take. */
const MAX_WEBSITE_GUESSES = 3;
const GUESS_TIMEOUT_MS = 6_000;

/** Characters of text kept per page (enough for an about/team page; keeps AI prompts small). */
const MAX_PAGE_TEXT = 4000;

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

async function fetchHtml(url: string, timeoutMs?: number): Promise<{ url: string; html: string } | null> {
  try {
    const page = await politeGet(url, { timeoutMs });
    if (page.status >= 400 || !/html/i.test(page.contentType)) return null;
    return { url: page.url, html: page.body };
  } catch (error) {
    if (!(error instanceof FetchBlockedError)) console.warn(`[sources] website fetch failed for ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** Finds the company's website from its name: the first candidate whose home page names it. */
export async function findWebsite(company: { name: string; companyNumber: string | null; city: string | null }): Promise<{ domain: string; confidence: number } | null> {
  // Most guesses don't exist: a parallel DNS check rules them out at once, then only real sites
  // are fetched, a few at most, with a short timeout.
  const candidates = candidateDomains(company.name);
  const exists = await Promise.all(candidates.map(hostResolves));
  for (const domain of candidates.filter((_, i) => exists[i]).slice(0, MAX_WEBSITE_GUESSES)) {
    const page = await fetchHtml(`https://${domain}/`, GUESS_TIMEOUT_MS);
    if (!page) continue;
    const confidence = websiteMatchConfidence(htmlToText(page.html), company);
    if (confidence >= 70) return { domain: siteOf(new URL(page.url).hostname), confidence };
  }
  return null;
}

/** Reads the home page and up to five more pages of the site. Null when the site can't be read. */
export async function readWebsite(domain: string): Promise<SiteRead | null> {
  const home = await fetchHtml(`https://${domain}/`);
  if (!home) return null;
  const site = siteOf(new URL(home.url).hostname);

  const pages: { url: string; kind: PageKind; html: string }[] = [{ url: home.url, kind: "home", html: home.html }];
  for (const target of pickPages(extractLinks(home.html, home.url), site)) {
    const page = await fetchHtml(target.url);
    if (page) pages.push({ url: page.url, kind: target.kind, html: page.html });
  }

  const allHtml = pages.map((p) => p.html).join("\n");
  return {
    domain: site,
    pages: pages.map((p) => {
      const text = htmlToText(p.html.replace(/<(nav|footer|header)\b[\s\S]*?<\/\1>/gi, " ")).slice(0, MAX_PAGE_TEXT);
      return { url: p.url, kind: p.kind, text, contentHash: hash(text) };
    }),
    // Footers carry the contact details, so they're read from the full HTML.
    emails: emailsFrom(allHtml, site),
    phones: phonesFrom(pages.find((p) => p.kind === "contact")?.html ?? allHtml),
    jobBoard: jobBoardFromHtml(allHtml),
  };
}

export const companyWebsite: SourceAdapter = {
  slug: "company_website",
  isConfigured: () => true,
  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, message: "Reads public pages; no account needed." };
  },
};

// --- Pure helpers (unit-tested): which addresses to try, which pages to read, what they publish --

export type PageKind = "home" | "about" | "team" | "contact" | "careers" | "news";

const NAME_NOISE = /\b(ltd|limited|llp|plc|lp|cic|uk|group|holdings|the|and|company|co)\b/g;

/** Plain lowercase words of a company name, without legal suffixes. */
export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(NAME_NOISE, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Domains a UK company would plausibly use, most likely first ("Brightsmile Dental Ltd" → brightsmiledental.co.uk, …). */
export function candidateDomains(name: string): string[] {
  const words = nameWords(name);
  if (words.length === 0) return [];
  const stems = [
    ...new Set(
      [
        words.join(""),
        words.join("-"),
        words.length > 2 ? words.slice(0, 2).join("") : null,
        // Brands often use just the first word (Monzo Bank → monzo.com); the page must still name the company.
        words.length > 1 && words[0].length >= 4 ? words[0] : null,
      ].filter(Boolean),
    ),
  ] as string[];
  return stems
    .filter((stem) => stem.length >= 3 && stem.length <= 50)
    .flatMap((stem) => [`${stem}.co.uk`, `${stem}.com`, `${stem}.uk`])
    .slice(0, 9);
}

/**
 * How sure we are that a website belongs to the company. UK companies must show their registered
 * number on their website, so finding it is near-certain. The name alone is weak (many businesses
 * share a phrase like "More Smiles"), so it only counts together with the company's town.
 */
export function websiteMatchConfidence(pageText: string, company: { name: string; companyNumber: string | null; city?: string | null }): number {
  const text = pageText.toLowerCase().replace(/\s+/g, " ");
  if (company.companyNumber) {
    const number = company.companyNumber.toLowerCase();
    const spaced = number.replace(/^(\w{2})(\w{3})(\w{3})$/, "$1 $2 $3");
    if (new RegExp(`\\b(${number}|${spaced})\\b`).test(text)) return 95;
  }
  const words = nameWords(company.name);
  if (words.length === 0) return 0;
  if (!text.includes(words.join(" "))) return 0;
  return company.city && text.includes(company.city.toLowerCase()) ? 70 : 40;
}

/** Same-site links on a page, absolute, without fragments. */
export function extractLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const base = new URL(baseUrl);
  const links: { url: string; text: string }[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decodeEntities(match[1]), base);
      url.hash = "";
      if (!/^https?:$/.test(url.protocol)) continue;
      links.push({ url: url.toString(), text: decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() });
    } catch {
      // Not a URL; skip.
    }
  }
  return links;
}

const KIND_PATTERNS: [Exclude<PageKind, "home">, RegExp][] = [
  ["team", /\b(team|our[- ]people|meet[- ]the|staff|leadership|who[- ]we[- ]are)\b/],
  ["about", /\b(about)\b/],
  ["contact", /\b(contact)\b/],
  ["careers", /\b(careers?|jobs|vacanc(y|ies)|join[- ]us|work[- ]with[- ]us|recruitment)\b/],
  ["news", /\b(news|blog|insights|press|updates|articles)\b/],
];

/** The pages worth reading after the home page: one per kind, same site, in a fixed order. */
export function pickPages(links: { url: string; text: string }[], site: string): { url: string; kind: PageKind }[] {
  const chosen = new Map<PageKind, string>();
  for (const link of links) {
    const url = new URL(link.url);
    if (url.hostname.replace(/^www\./, "") !== site) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|docx?|xlsx?)$/i.test(url.pathname)) continue;
    const haystack = `${url.pathname} ${link.text}`.toLowerCase();
    for (const [kind, pattern] of KIND_PATTERNS) {
      if (!chosen.has(kind) && pattern.test(haystack)) {
        chosen.set(kind, url.toString());
        break;
      }
    }
  }
  return KIND_PATTERNS.flatMap(([kind]) => (chosen.has(kind) ? [{ kind, url: chosen.get(kind)! }] : []));
}

const BOARD_LINKS: [JobBoardProvider, RegExp][] = [
  ["greenhouse", /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_.-]+)/i],
  ["lever", /jobs\.(?:eu\.)?lever\.co\/([A-Za-z0-9_.-]+)/i],
  ["ashby", /jobs\.ashbyhq\.com\/([A-Za-z0-9_.-]+)/i],
];

/** A Greenhouse, Lever or Ashby board the site links to or embeds. */
export function jobBoardFromHtml(html: string): { provider: JobBoardProvider; boardToken: string } | null {
  for (const [provider, pattern] of BOARD_LINKS) {
    const token = pattern.exec(html)?.[1];
    if (token && BOARD_TOKEN_PATTERN.test(token) && !/^(embed|api|v\d)$/i.test(token)) return { provider, boardToken: token };
  }
  return null;
}

/** Business email addresses the site publishes, on its own domain first. */
export function emailsFrom(html: string, site: string): string[] {
  const found = new Set<string>();
  for (const match of decodeEntities(html).matchAll(/(?:mailto:)?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const email = match[1].toLowerCase();
    if (/\.(png|jpe?g|gif|svg|webp)$/.test(email) || /example\.|sentry|wixpress|@2x/.test(email)) continue;
    found.add(email);
  }
  const own = [...found].filter((e) => e.endsWith(`@${site}`) || e.endsWith(`.${site}`));
  return (own.length > 0 ? own : [...found]).slice(0, 3);
}

/** UK phone numbers from tel: links, or written out on the page. */
export function phonesFrom(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) found.add(decodeEntities(match[1]).replace(/[^\d+]/g, ""));
  if (found.size === 0) {
    for (const match of decodeEntities(html.replace(/<[^>]+>/g, " ")).matchAll(/(?:\+44\s?\(?0?\)?|\b0)(?:\d[\s-]?){9,10}\b/g)) {
      found.add(match[0].replace(/[^\d+]/g, ""));
    }
  }
  return [...found].filter((p) => /^(\+44|0)\d{9,10}$/.test(p)).slice(0, 2);
}
