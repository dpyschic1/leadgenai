import type { Targeting } from "@/lib/domain/engine";

const STOP = new Set([
  "and", "the", "for", "with", "your", "our", "you", "from", "that", "this", "services", "service", "solutions", "development", "support",
  "who", "what", "when", "where", "how", "are", "can", "will", "help", "helps", "professional", "professionals", "business", "businesses", "company",
  "companies", "team", "teams", "custom", "new", "high", "quality", "best", "their", "they", "them", "more", "most", "any", "all", "get", "make",
  "dedicated", "modern", "full", "stack", "senior", "junior", "expert", "experts", "premium", "affordable",
]);

/** Two-letter terms that are real service names; other short words are noise. */
const SHORT_TERMS = new Set(["ai", "ml", "ui", "ux", "qa"]);

/** Lower-case word stems worth matching on: "Website redesign & SEO" -> ["website", "redesign", "seo"]. */
export function termsOf(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => (w.length >= 3 || SHORT_TERMS.has(w)) && !STOP.has(w)))];
}

/** Plural only: "developers" = "developer", but "developing" and "redesigned" are different words, not the same service. */
const stem = (w: string) => w.replace(/(es|s)$/, "");

/** Service terms that appear in the item text (by stem), so a match can always be explained. */
export function matchedTerms(serviceTerms: string[], text: string): string[] {
  const haystack = new Set(termsOf(text).map(stem));
  return serviceTerms.filter((t) => haystack.has(stem(t)));
}

/** An empty list on a dimension means "any" (the same rule Services & ICP uses). */
export function matchesCountry(targeting: Targeting, country: string | null): boolean {
  return targeting.countries.length === 0 || (country !== null && targeting.countries.includes(country));
}
