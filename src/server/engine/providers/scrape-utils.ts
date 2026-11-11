import { decodeEntities } from "@/server/jobs/html-to-text";

/** Helpers shared by the page scrapers (PeoplePerHour, Guru). Pure, so they are unit-tested. */

export const textOf = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** "3 hours ago", "53 mins ago", "a day ago", "2 days ago" -> a Date; null when it does not read as one. */
export function agoToDate(text: string, now: Date): Date | null {
  const m = text.toLowerCase().match(/\b(an?|\d+)\s*(sec|second|min|minute|hr|hour|day|week|month)s?\.?\s+ago\b/);
  if (!m) return null;
  const n = m[1].startsWith("a") ? 1 : Number(m[1]);
  const unit = m[2];
  const ms = unit.startsWith("sec") ? 1000 : unit.startsWith("min") ? 60_000 : unit === "hr" || unit === "hour" ? 3_600_000 : unit === "day" ? 86_400_000 : unit === "week" ? 7 * 86_400_000 : 30 * 86_400_000;
  return new Date(now.getTime() - n * ms);
}

/** Approximate rates to USD for the currencies marketplaces display. Budgets converted this way are flagged approximate. */
const USD_PER: Record<string, number> = { USD: 1, GBP: 1.27, EUR: 1.08, CAD: 0.73, AUD: 0.65 };
const SYMBOL: Record<string, string> = { "$": "USD", "£": "GBP", "€": "EUR" };

/** "$1,200", "£350", "€90" -> amount, currency and an approximate USD figure. Null for anything else. */
export function parseMoney(text: string): { amount: number; currency: string; usd: number; approximate: boolean } | null {
  const m = text.match(/([$£€])\s?(\d[\d,]*(?:\.\d+)?)/);
  if (!m) return null;
  const currency = SYMBOL[m[1]];
  const amount = Number(m[2].replace(/,/g, ""));
  if (!currency || !Number.isFinite(amount)) return null;
  return { amount, currency, usd: Math.round(amount * USD_PER[currency]), approximate: currency !== "USD" };
}

/** "$500-$1k", "$1,200 - $3k" -> low/high in the displayed currency (a `k` suffix means thousands). */
export function parseMoneyRange(text: string): { min: number; max: number; currency: string; usd: number; approximate: boolean } | null {
  const m = text.match(/([$£€])\s?(\d[\d,]*(?:\.\d+)?)\s?(k?)\s*[-–]\s*[$£€]?\s?(\d[\d,]*(?:\.\d+)?)\s?(k?)/i);
  if (!m) return null;
  const currency = SYMBOL[m[1]];
  const num = (n: string, k: string) => Number(n.replace(/,/g, "")) * (k ? 1000 : 1);
  const max = num(m[4], m[5]);
  // "$500-$1k": the first figure has no suffix of its own but the range is in the same unit as its top only when it says so.
  const min = num(m[2], m[3]);
  if (!currency || !Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  return { min, max, currency, usd: Math.round(max * USD_PER[currency]), approximate: currency !== "USD" };
}

const COUNTRY_BY_NAME: Record<string, string> = {
  "united states": "US", usa: "US", "united kingdom": "GB", uk: "GB", canada: "CA", ireland: "IE", germany: "DE", netherlands: "NL", australia: "AU",
  india: "IN", france: "FR", spain: "ES", italy: "IT", israel: "IL", singapore: "SG", "united arab emirates": "AE", pakistan: "PK", philippines: "PH",
};
export const countryFromName = (name: string | null) => (name ? COUNTRY_BY_NAME[name.trim().toLowerCase()] ?? null : null);
