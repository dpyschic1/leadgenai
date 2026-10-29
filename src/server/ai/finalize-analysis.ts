import type { ReferenceData, SignalAnalysis } from "@/lib/api/types";
import { todayIso } from "@/lib/validation/signals";

/** The model's reply as constrained by the output schema, before our own checks. */
export type RawAnalysis = Omit<SignalAnalysis, "excerpt" | "occurredOn" | "model"> & {
  excerpt: string;
  occurredOn: string | null;
};

const MAX_SUMMARY = 500;
const MAX_EXCERPT = 600;
const MAX_CATEGORIES = 4;

/**
 * Typography-insensitive form, so a quote still matches when the model swaps in curly quotes,
 * a different dash (e.g. a non-breaking hyphen), an ellipsis character or other spacing.
 */
function comparable(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * True when the quote appears in the source. An elided quote ("first part ... second part") is
 * accepted only if every part appears in the source, in that order.
 */
function isFaithfulQuote(quote: string, sourceText: string): boolean {
  const source = comparable(sourceText);
  const parts = comparable(quote)
    .split("...")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;

  let from = 0;
  for (const part of parts) {
    const at = source.indexOf(part, from);
    if (at === -1) return false;
    from = at + part.length;
  }
  return true;
}

/**
 * Enforces what the schema can't: ranges, lengths, known slugs, a real date, and — most
 * importantly — that the quoted evidence actually appears in the source. A quote the model
 * invented is dropped, and an "observed" label without a verified quote becomes "inferred".
 * Pure, so it is unit-tested without calling the model.
 */
export function finalizeAnalysis(
  raw: RawAnalysis,
  sourceText: string,
  ref: Pick<ReferenceData, "serviceCategories">,
  today = todayIso(),
): Omit<SignalAnalysis, "model"> {
  const quote = raw.excerpt.trim().slice(0, MAX_EXCERPT);
  const quoteFound = quote.length > 0 && isFaithfulQuote(quote, sourceText);
  const knownCategories = new Set(ref.serviceCategories.map((c) => c.slug));
  const occurredOn =
    raw.occurredOn && /^\d{4}-\d{2}-\d{2}$/.test(raw.occurredOn) && !Number.isNaN(Date.parse(raw.occurredOn)) && raw.occurredOn <= today
      ? raw.occurredOn
      : null;

  return {
    isSignal: raw.isSignal,
    signalType: raw.signalType,
    intentLevel: raw.intentLevel,
    urgency: raw.urgency,
    serviceCategories: [...new Set(raw.serviceCategories)].filter((slug) => knownCategories.has(slug)).slice(0, MAX_CATEGORIES),
    summary: raw.summary.trim().slice(0, MAX_SUMMARY),
    excerpt: quoteFound ? quote : null,
    evidenceLabel: raw.evidenceLabel === "observed" && !quoteFound ? "inferred" : raw.evidenceLabel,
    confidence: Math.round(Math.min(100, Math.max(0, raw.confidence))),
    occurredOn,
  };
}
