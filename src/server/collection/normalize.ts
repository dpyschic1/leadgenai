import "server-only";
import { createHash } from "node:crypto";
import { COUNTRY_CODES } from "@/lib/countries";
import { countriesNamedIn } from "@/server/sources/board-directory";
import { registrableDomain } from "@/server/sources/http";
import { categorizeJob } from "@/server/jobs/job-categories";
import { jobDigest, repostKey } from "@/server/jobs/job-signal";
import type { CollectedItemInput } from "./types";

/**
 * Turns what a collector found into what is stored: canonical URL, a digest of the text, the
 * service categories, and the two hashes that drive change detection and deduplication. Pure.
 */

export type NormalizedItem = Omit<CollectedItemInput, "text"> & {
  canonicalUrl: string;
  body: string | null;
  categories: string[];
  contentHash: string;
  dedupeKey: string;
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** Query parameters that only say where a click came from, never which page it is. */
const TRACKING_PARAM = /^(utm_[a-z_]+|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|yclid|dclid|ref|referrer|trk|trackingid)$/i;

/**
 * The same page from any link to it: https, lowercase host without `www.`, no fragment, no tracking
 * parameters, the rest sorted, no trailing slash. Unparseable input is returned trimmed. Pure.
 */
export function canonicalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim();
  }
  parsed.protocol = "https:";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  parsed.hash = "";
  parsed.port = "";
  const params = [...parsed.searchParams.entries()].filter(([key]) => !TRACKING_PARAM.test(key)).sort(([a], [b]) => a.localeCompare(b));
  parsed.search = new URLSearchParams(params).toString();
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

/** A company's website domain from a URL or bare host ("https://careers.acme.com/x" → "acme.com"); null when it isn't one. Pure. */
export function domainOf(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`).hostname;
    return host.includes(".") ? registrableDomain(host) : null;
  } catch {
    return null;
  }
}

/**
 * The countries a text names (`countriesNamedIn`), current ISO codes only: the shared helper also
 * returns obsolete ones whose names overlap ("Germany" → DE and DD, East Germany), which would make
 * every German place ambiguous. Pure.
 */
export function countriesIn(text: string): string[] {
  const named = countriesNamedIn(text).filter((code) => (COUNTRY_CODES as readonly string[]).includes(code));
  // "REMOTE (US)", "US only": the capitalised abbreviation, never the word "us".
  if (!named.includes("US") && /(^|[^A-Za-z])(US|USA|U\.S\.)([^A-Za-z]|$)/.test(text)) named.push("US");
  return named;
}

/** An ISO code from a country as sources write it ("US", "USA", "United States"); null when unclear. Pure. */
export function countryCodeOf(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper === "UK") return "GB";
  if (upper === "USA") return "US";
  if (/^[A-Z]{2}$/.test(upper)) return (COUNTRY_CODES as readonly string[]).includes(upper) ? upper : null;
  const named = countriesIn(text);
  return named.length === 1 ? named[0] : null;
}

/** "2026-11-03", "2026-11-03T10:00:00Z" → a Date; null for anything else (or an impossible date). Pure. */
export function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The stored form of an item. A job's text is kept in full (as `jobDigest` trims it) only when its
 * title fits a service category; otherwise just the links and emails it names. Categories are the
 * ones the source states, else the title rules' for a job or a post. Pure.
 */
export function normalizeItem(item: CollectedItemInput): NormalizedItem {
  const { text, categories: stated, ...rest } = item;
  const title = item.title.replace(/\s+/g, " ").trim().slice(0, 300);
  const categories = stated ?? (item.kind === "job" || item.kind === "post" ? categorizeJob({ title, department: null }) : []);
  const body = item.kind === "job" ? jobDigest(text, { relevant: categories.length > 0 }) : (text?.trim().slice(0, 3000) ?? null) || null;
  const canonical = canonicalUrl(item.url);
  const companyDomain = item.companyDomain ? domainOf(item.companyDomain) : null;
  const location = item.location?.replace(/\s+/g, " ").trim() || null;
  const normalized = { ...rest, title, body, location, companyDomain, canonicalUrl: canonical, categories };
  return { ...normalized, contentHash: contentHash(normalized), dedupeKey: dedupeKey(normalized) };
}

/** Hash of every stored field that can change: a new hash on a later visit means the item changed. Pure. */
export function contentHash(item: Omit<NormalizedItem, "contentHash" | "dedupeKey">): string {
  return hash(
    JSON.stringify([
      item.title,
      item.body,
      item.url,
      item.companyName,
      item.companyDomain,
      item.location,
      item.country,
      item.remote,
      item.postedAt?.toISOString() ?? null,
      item.validThrough?.toISOString() ?? null,
      item.data,
    ]),
  );
}

/**
 * The same item wherever it is listed: a job is its company's domain + title + place (case and
 * spacing ignored, as `repostKey` reads a repost); anything else, or a job with no known company,
 * is its canonical URL. Pure.
 */
export function dedupeKey(item: Pick<NormalizedItem, "kind" | "companyDomain" | "title" | "location" | "canonicalUrl">): string {
  if (item.kind === "job" && item.companyDomain) return hash(`job|${item.companyDomain}|${repostKey({ title: item.title, location: item.location })}`);
  return hash(`url|${item.canonicalUrl}`);
}
