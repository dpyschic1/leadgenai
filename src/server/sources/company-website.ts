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

/** What a site states about itself in schema.org data (JSON-LD), the most reliable part of a page. */
export type StructuredFacts = {
  telephone: string | null;
  email: string | null;
  employees: number | null;
  people: { name: string; title: string | null }[];
};

/** Raw facts for the deterministic website checks (see `websiteFindings`). */
export type SiteChecks = {
  homeUrl: string;
  /** False when the site only answered over plain HTTP. */
  secure: boolean;
  /** The page's own `generator` meta tag, e.g. "WordPress 5.8.3". */
  generator: string | null;
  /** The first page showing an online-booking link or widget, with what was found. */
  booking: { url: string; evidence: string } | null;
  pagesChecked: string[];
};

export type SiteRead = {
  domain: string;
  pages: SitePage[];
  emails: string[];
  phones: string[];
  jobBoard: ReturnType<typeof jobBoardFromHtml>;
  structured: StructuredFacts;
  checks: SiteChecks;
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

/** Contact, about and legal pages read per candidate site when its home page alone doesn't settle it. */
const MAX_EVIDENCE_PAGES = 3;

/**
 * Finds the company's website from its name. Each existing candidate domain is read: parked and
 * for-sale domains are skipped; a site whose home page names the company is checked further on its
 * contact, about and legal pages, where UK companies show their number and registered address.
 * Accepted only with that evidence (see `websiteMatchConfidence`).
 */
export async function findWebsite(company: {
  name: string;
  companyNumber: string | null;
  city: string | null;
  postcode?: string | null;
}): Promise<{ domain: string; confidence: number } | null> {
  // Most guesses don't exist: a parallel DNS check rules them out at once, then only real sites
  // are fetched, a few at most, with a short timeout.
  const candidates = candidateDomains(company.name);
  const exists = await Promise.all(candidates.map(hostResolves));
  let checked = 0;
  for (const domain of candidates.filter((_, i) => exists[i])) {
    if (checked >= MAX_WEBSITE_GUESSES) break;
    const page = await fetchHtml(`https://${domain}/`, GUESS_TIMEOUT_MS);
    if (!page || isParkedPage(page.html)) continue;
    checked++;
    const site = siteOf(new URL(page.url).hostname);
    let text = htmlToText(page.html);
    let confidence = websiteMatchConfidence(text, company);
    // It names the company but doesn't prove it yet: look where the proof usually is.
    if (confidence > 0 && confidence < 85) {
      const links = extractLinks(page.html, page.url).filter((l) => new URL(l.url).hostname.replace(/^www\./, "") === site);
      const evidence = [
        ...pickPages(links, site).filter((p) => p.kind === "contact" || p.kind === "about").map((p) => p.url),
        ...links.filter((l) => LEGAL_PAGE.test(`${new URL(l.url).pathname} ${l.text}`.toLowerCase())).map((l) => l.url),
      ];
      for (const url of [...new Set(evidence)].slice(0, MAX_EVIDENCE_PAGES)) {
        const more = await fetchHtml(url, GUESS_TIMEOUT_MS);
        if (more) text += ` ${htmlToText(more.html)}`;
      }
      confidence = websiteMatchConfidence(text, company);
    }
    if (confidence >= 70) return { domain: site, confidence };
  }
  return null;
}

/** Reads the home page and up to five more pages of the site. Null when the site can't be read. */
export async function readWebsite(domain: string): Promise<SiteRead | null> {
  // HTTPS first; a site that only answers over plain HTTP is itself worth knowing.
  let home = await fetchHtml(`https://${domain}/`);
  let secure = true;
  if (!home) {
    home = await fetchHtml(`http://${domain}/`);
    if (!home) return null;
    secure = home.url.startsWith("https:");
  }
  const site = siteOf(new URL(home.url).hostname);

  const links = extractLinks(home.html, home.url);
  let targets = pickPages(links, site);
  // The menu may not link the team or about page; the sitemap usually lists them.
  if (targets.length < 3) {
    const sitemap = await fetchText(`${new URL(home.url).origin}/sitemap.xml`);
    if (sitemap) targets = pickPages([...links, ...sitemapLinks(sitemap)], site);
  }

  const pages: { url: string; kind: PageKind; html: string }[] = [{ url: home.url, kind: "home", html: home.html }];
  for (const target of targets) {
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
    structured: structuredFacts(pages.flatMap((p) => parseJsonLd(p.html))),
    checks: {
      homeUrl: home.url,
      secure,
      generator: generatorOf(home.html),
      booking: pages.flatMap((p) => {
        const evidence = bookingEvidence(p.html);
        return evidence ? [{ url: p.url, evidence }] : [];
      })[0] ?? null,
      pagesChecked: pages.map((p) => p.url),
    },
  };
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const page = await politeGet(url);
    return page.status < 400 ? page.body : null;
  } catch {
    return null;
  }
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
 * How sure we are that a website belongs to the company, from the text of the pages read. UK
 * companies must show their registered number on their website, so finding it is near-certain.
 * The name alone is weak (many businesses share a phrase: "Largo Law" is also a Fife holiday park),
 * so it counts only with the registered-office postcode (strong) or the town (enough). A site that
 * shows a different company number is someone else's.
 */
export function websiteMatchConfidence(
  pageText: string,
  company: { name: string; companyNumber: string | null; city?: string | null; postcode?: string | null },
): number {
  const text = pageText.toLowerCase().replace(/\s+/g, " ");
  if (company.companyNumber) {
    const number = company.companyNumber.toLowerCase();
    const spaced = number.replace(/^(\w{2})(\w{3})(\w{3})$/, "$1 $2 $3");
    if (new RegExp(`\\b(${number}|${spaced})\\b`).test(text)) return 95;
    // "Company number 12345678" naming another company.
    if (/\bcompany (?:no\.?|number|registration(?: number)?|reg\.? no\.?)\s*:?\s*(?:sc|ni|oc)?\d{6,8}\b/.test(text)) return 0;
  }
  const words = nameWords(company.name);
  if (words.length === 0) return 0;
  if (!text.includes(words.join(" "))) return 0;
  const postcode = company.postcode?.replace(/\s+/g, "").toLowerCase();
  if (postcode && postcode.length >= 5 && text.replace(/\s+/g, "").includes(postcode)) return 85;
  return company.city && text.includes(company.city.toLowerCase()) ? 70 : 40;
}

/**
 * A parked, for-sale or placeholder domain: no business lives there, so it is skipped without
 * reading further. Pure.
 */
export function isParkedPage(html: string): boolean {
  if (/window\.location\.href\s*=\s*["']\/lander|\b(sedoparking|parkingcrew|bodis\.com|above\.com\/|dan\.com|afternic|hugedomains|undeveloped\.com)\b/i.test(html)) return true;
  const text = htmlToText(html).toLowerCase();
  return /\b(this domain (?:name )?(?:is|may be) for sale|buy this domain|domain (?:is )?for sale|domain has (?:just )?been registered|parked (?:free|domain|page)|is parked\b|future home of|website coming soon|under construction)\b/.test(text) && text.length < 3000;
}

/** Pages where a UK business shows its registration details: legal notices, privacy, terms. */
const LEGAL_PAGE = /\b(privacy|terms|legal|imprint|cookies?|disclaimer|company[- ]information)\b/;

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
  // apply.workable.com/{account}/ (not /j/{job}, which names no account), or a legacy {account}.workable.com.
  ["workable", /apply\.workable\.com\/(?!j\/|api\/)([a-z0-9][a-z0-9-]*)/i],
  ["workable", /\/\/(?!(?:www|apply|jobs|help|resources|developers|blog|careers)\.)([a-z0-9][a-z0-9-]*)\.workable\.com/i],
];

/** A Greenhouse, Lever, Ashby or Workable board the site links to or embeds. */
export function jobBoardFromHtml(html: string): { provider: JobBoardProvider; boardToken: string } | null {
  for (const [provider, pattern] of BOARD_LINKS) {
    const token = pattern.exec(html)?.[1];
    if (token && BOARD_TOKEN_PATTERN.test(token) && !/^(embed|api|v\d)$/i.test(token)) {
      // Workable account names are lowercase; the others keep the case the site used.
      return { provider, boardToken: provider === "workable" ? token.toLowerCase() : token };
    }
  }
  return null;
}

/** Business email addresses the site publishes: the company's own, shared inboxes (info@) first. */
export function emailsFrom(html: string, site: string): string[] {
  const found = new Set<string>();
  for (const match of decodeEntities(html).matchAll(/(?:mailto:)?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)) found.add(match[1].toLowerCase());
  return usableEmails([...found], site).slice(0, 3);
}

/** Template and tooling addresses that sites carry by mistake (changeme@client-domain.co.uk, sentry, image names). */
export const PLACEHOLDER_EMAIL =
  /\.(png|jpe?g|gif|svg|webp)$|@2x|example\.|sentry|wixpress|changeme|client-?domain|your-?(domain|company|email|name)|^(name|email|user|test|someone|username|noreply|no-reply|donotreply)@|@(domain|email|company)\.(com|co\.uk)$/;
/** Shared inboxes: the right way into a company, and what the company itself publishes for contact. */
const ROLE_INBOX = /^(info|enquir|inquir|hello|contact|reception|office|admin|team|bookings?|appointments?|general|mail|sales|support|practice|surgery|clinic)/;
/** Mail services a small practice may use for its own address; anyone else's (a web designer's) uses one too. */
const NHS_MAIL = /@nhs\.net$/;
/** Words too common in practice names to tie an address to one business. */
const GENERIC_WORDS = new Set(["info", "mail", "dental", "dentist", "dentists", "medical", "health", "healthcare", "clinic", "care", "practice", "surgery", "group", "services", "centre", "center", "online", "the", "and", "london", "limited"]);

const wordsOf = (text: string) => text.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));

/**
 * The addresses that really belong to the business at `site`, shared inboxes first. Placeholders
 * are dropped. An address on another domain (gmail, nhs.net) is kept only when the site has none
 * of its own and the address names the business (kensingtondentists@gmail.com on
 * kensington-dentist.com, not the web designer's by.blossom@yahoo.com); nhs.net addresses are
 * NHS-issued, so they're kept too. Pure.
 */
export function usableEmails(emails: string[], site: string): string[] {
  const real = [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) && !PLACEHOLDER_EMAIL.test(e));
  const own = real.filter((e) => e.endsWith(`@${site}`) || e.endsWith(`.${site}`));
  const siteWords = wordsOf(site.split(".")[0]);
  const label = site.split(".")[0];
  const namesBusiness = (email: string) => {
    const local = email.split("@")[0];
    return siteWords.some((w) => local.includes(w)) || wordsOf(local).some((w) => label.includes(w));
  };
  const kept = own.length > 0 ? own : real.filter((e) => NHS_MAIL.test(e) || namesBusiness(e));
  return kept.sort((a, b) => Number(ROLE_INBOX.test(b)) - Number(ROLE_INBOX.test(a)));
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

/** Page URLs listed in a sitemap.xml, as links with no text (the path decides the page kind). */
export function sitemapLinks(xml: string): { url: string; text: string }[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].slice(0, 500).map((m) => ({ url: decodeEntities(m[1]), text: "" }));
}

// --- Structured data (schema.org JSON-LD) ---------------------------------------------------------

/** Every JSON-LD object on a page, flattening `@graph` lists. Malformed blocks are skipped. Pure. */
export function parseJsonLd(html: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      objects.push(object);
      if (object["@graph"]) add(object["@graph"]);
    }
  };
  for (const match of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      add(JSON.parse(match[1].trim()));
    } catch {
      // Not valid JSON; skip it.
    }
  }
  return objects;
}

const typesOf = (object: Record<string, unknown>) => [object["@type"]].flat().map(String);
const ORGANISATION = /Organization|LocalBusiness|Dentist|MedicalBusiness|MedicalClinic|LegalService|Attorney|AccountingService|ProfessionalService|Corporation/;

/** The organisation's phone, email, size and named people from its JSON-LD. Pure. */
export function structuredFacts(objects: Record<string, unknown>[]): StructuredFacts {
  const facts: StructuredFacts = { telephone: null, email: null, employees: null, people: [] };
  const people = new Map<string, { name: string; title: string | null }>();
  const addPerson = (value: unknown) => {
    for (const item of [value].flat()) {
      if (!item || typeof item !== "object") continue;
      const person = item as Record<string, unknown>;
      const name = typeof person.name === "string" ? person.name.trim().replace(/\s+/g, " ") : null;
      if (!name || name.split(" ").length < 2 || name.length > 80) continue;
      const title = typeof person.jobTitle === "string" ? person.jobTitle.trim().slice(0, 120) || null : null;
      people.set(name.toLowerCase(), { name, title });
    }
  };
  for (const object of objects) {
    const types = typesOf(object);
    if (types.some((t) => ORGANISATION.test(t))) {
      if (!facts.telephone && typeof object.telephone === "string") facts.telephone = object.telephone.trim();
      if (!facts.email && typeof object.email === "string") facts.email = object.email.replace(/^mailto:/i, "").trim().toLowerCase();
      const employees = object.numberOfEmployees as { value?: unknown; maxValue?: unknown } | number | undefined;
      const count = typeof employees === "number" ? employees : Number(employees?.value ?? employees?.maxValue);
      if (!facts.employees && Number.isInteger(count) && count > 0 && count < 1_000_000) facts.employees = count;
      addPerson(object.founder);
      addPerson(object.employee);
    }
    if (types.includes("Person")) addPerson(object);
  }
  facts.people = [...people.values()].slice(0, 12);
  return facts;
}

// --- Deterministic website checks -----------------------------------------------------------------

/** The page's `<meta name="generator">`, e.g. "WordPress 5.8.3". */
export function generatorOf(html: string): string | null {
  const tag = html.match(/<meta[^>]+name\s*=\s*["']generator["'][^>]*>/i)?.[0];
  const content = tag?.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
  return content ? decodeEntities(content).trim().slice(0, 120) : null;
}

/** Online booking links and widgets: booking systems by name, or plain "book online" links. */
const BOOKING_PATTERNS: [RegExp, string][] = [
  [/(dentally\.co|portal\.dentally|pearl-?dental|exact-booking)/i, "dental booking system"],
  [/(calendly\.com|setmore\.com|simplybook\.(me|it)|acuityscheduling\.com|bookingbug|fresha\.com|cliniko\.com|jane\.app|doctolib|zocdoc|resdiary|opentable|squareup\.com\/appointments|booksy\.com)/i, "booking widget"],
  [/<a[^>]*>[^<]*\b(book (an? )?(appointment|consultation|online|now)|online booking|make an appointment|request an appointment)\b[^<]*<\/a>/i, "booking link"],
];

/** What on a page shows it takes bookings online, or null. Pure. */
export function bookingEvidence(html: string): string | null {
  for (const [pattern, label] of BOOKING_PATTERNS) {
    const match = html.match(pattern);
    if (match) return `${label}: ${decodeEntities(match[0].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 120)}`;
  }
  return null;
}

/** Industries where customers expect to book online, so its absence is a possible problem. */
const BOOKING_INDUSTRIES = new Set(["dental", "healthcare", "hospitality"]);

/** Web technology past its supported life: generator pattern, whether that version is old, what to call it. */
const OUTDATED: [RegExp, (m: RegExpMatchArray) => boolean, string][] = [
  [/WordPress (\d+)\.(\d+)/i, (m) => Number(m[1]) < 6, "an old WordPress version"],
  [/Joomla!? ?(\d+)/i, (m) => Number(m[1]) < 4, "an old Joomla version"],
  [/Drupal (\d+)/i, (m) => Number(m[1]) <= 7, "Drupal 7 or older, which no longer gets security updates"],
];

export type WebsiteFinding = {
  signalType: "outdated_website" | "insecure_website" | "no_online_booking";
  summary: string;
  /** What was seen, word for word where there is something to quote. */
  excerpt: string | null;
  url: string;
  confidence: number;
  evidenceLabel: "observed" | "derived";
  /** The services that could fix it; a finding counts only for workspaces that sell one. */
  categories: string[];
};

/**
 * Possible website problems, found by fixed rules before any AI: no HTTPS, an out-of-support CMS,
 * no online booking where customers expect it. They suggest a need, not an intent to buy. Pure.
 */
export function websiteFindings(company: string, checks: SiteChecks, industry: string | null): WebsiteFinding[] {
  const findings: WebsiteFinding[] = [];
  if (!checks.secure) {
    findings.push({
      signalType: "insecure_website",
      summary: `Possible problem: ${company}'s website only loads over plain HTTP, without a secure (HTTPS) connection.`,
      excerpt: null,
      url: checks.homeUrl,
      confidence: 90,
      evidenceLabel: "observed",
      categories: ["web_development", "cybersecurity", "it_managed_services"],
    });
  }
  for (const [pattern, isOld, label] of OUTDATED) {
    const match = checks.generator?.match(pattern);
    if (match && isOld(match)) {
      findings.push({
        signalType: "outdated_website",
        summary: `Possible problem: ${company}'s website runs on ${label}.`,
        excerpt: `<meta name="generator" content="${checks.generator}">`,
        url: checks.homeUrl,
        confidence: 85,
        evidenceLabel: "observed",
        categories: ["web_development", "ui_ux_design"],
      });
      break;
    }
  }
  if (industry && BOOKING_INDUSTRIES.has(industry) && !checks.booking) {
    findings.push({
      signalType: "no_online_booking",
      summary: `Possible problem: no online booking found on ${company}'s website (${checks.pagesChecked.length} pages checked).`,
      excerpt: null,
      url: checks.homeUrl,
      // Absence can't be quoted, and a booking page may exist beyond the pages read.
      confidence: 60,
      evidenceLabel: "derived",
      categories: ["web_development", "conversion_optimization", "crm_implementation"],
    });
  }
  return findings;
}
