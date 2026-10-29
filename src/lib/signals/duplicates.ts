/**
 * Duplicate detection for signals, shared by the form (live warning) and the API (enforcement),
 * so both always agree.
 *
 * Rule: a signal duplicates another of the same company when it has the same signal type and the
 * same source: the same link (after normalisation) or the same evidence quote. One source with a
 * different type is allowed, since a single article can report two real signals.
 */

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|mc_cid|mc_eid|ref|trk|trackingId)$/i;

/** "https://www.Example.com/post/?utm_source=x#top" -> "example.com/post". Null if not a URL. */
export function normalizeSourceUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const params = [...parsed.searchParams]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${host}${path}${query}`;
}

/** Spacing-, case- and quote-style-insensitive form of an evidence quote. */
function normalizeQuote(quote: string | null | undefined): string | null {
  const text = quote
    ?.replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return text || null;
}

export type DedupeCandidate = {
  signalType: string;
  sourceUrl: string | null;
  excerpt: string | null;
};

export type DedupeExisting = DedupeCandidate & { id: string };

/** The existing signal `candidate` would duplicate, if any. `excludeId` skips the signal being edited. */
export function findDuplicateSignal<T extends DedupeExisting>(
  existing: T[],
  candidate: DedupeCandidate,
  excludeId?: string,
): T | null {
  if (!candidate.signalType) return null;
  const url = normalizeSourceUrl(candidate.sourceUrl);
  const quote = normalizeQuote(candidate.excerpt);
  if (!url && !quote) return null;

  return (
    existing.find(
      (signal) =>
        signal.id !== excludeId &&
        signal.signalType === candidate.signalType &&
        ((url !== null && normalizeSourceUrl(signal.sourceUrl) === url) ||
          (quote !== null && normalizeQuote(signal.excerpt) === quote)),
    ) ?? null
  );
}
