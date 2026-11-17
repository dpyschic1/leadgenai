/**
 * Web Scraping & Discovery Engine: a shared collection layer, independent of the Company Discovery
 * Engine and the LeadGen Engine. Collectors gather public items once, for every workspace, into
 * global tables (`collected_items`); the engines read from it later. The database enums are built
 * from these lists, so schema and code share one definition.
 */

/** What a collected item is. */
export const COLLECTED_ITEM_KINDS = ["job", "post", "search_result", "tender"] as const;
export type CollectedItemKind = (typeof COLLECTED_ITEM_KINDS)[number];

/** How an item was read from its page or feed: the evidence of how it was extracted. */
export const EXTRACTION_METHODS = ["json_ld", "api", "feed", "html", "rendered"] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/** How a collector reaches its source. `rendered` (a headless browser) is not run on the web server. */
export const COLLECTOR_ACCESS = ["api", "feed", "html", "rendered"] as const;
export type CollectorAccess = (typeof COLLECTOR_ACCESS)[number];

/**
 * Collector slugs, each a row in `sources` (seeded by migration; only `approved` ones run). Kept
 * apart from `SOURCE_SLUGS` so they never show in a workspace's Data sources settings.
 */
export const COLLECTOR_SLUGS = ["career_pages"] as const;
export type CollectorSlug = (typeof COLLECTOR_SLUGS)[number];

/** Shortest and longest time between two collections of one target. */
export const MIN_COLLECT_INTERVAL_MINUTES = 6 * 60;
export const MAX_COLLECT_INTERVAL_MINUTES = 7 * 24 * 60;
/** For a target with nothing to collect (no careers page, or jobs already covered elsewhere). */
export const IDLE_COLLECT_INTERVAL_MINUTES = 30 * 24 * 60;
