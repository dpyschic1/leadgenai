import type { CollectedItemKind, CollectorAccess, CollectorSlug, ExtractionMethod } from "@/lib/domain/collection";
import type { DomainMove, Fetcher } from "./fetch";

/**
 * The contract every collector implements. A collector only reads its source and returns items in
 * this shape; the runner stores, deduplicates, categorizes and logs them. Adding a source means
 * writing one collector and listing it in `collectors/index.ts`; the engine does not change.
 */

/** One item as a collector found it. Fields the source doesn't state stay null: nothing is guessed. */
export type CollectedItemInput = {
  /** The source's own id for the item (stable across visits). */
  externalId: string;
  kind: CollectedItemKind;
  url: string;
  extraction: ExtractionMethod;
  /** The page the item was read from, when that is not `url`. */
  fetchedUrl: string | null;
  title: string;
  /** Plain text (not HTML); the store keeps a digest of it. */
  text: string | null;
  companyName: string | null;
  /** The company's own website domain (registrable, e.g. "acme.com"). */
  companyDomain: string | null;
  location: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  remote: boolean | null;
  postedAt: Date | null;
  validThrough: Date | null;
  data: Record<string, unknown>;
};

export type CollectTarget = {
  id: string;
  sourceSlug: string;
  targetKey: string;
  params: Record<string, unknown>;
  cursor: Record<string, unknown>;
  intervalMinutes: number;
};

export type CollectContext = {
  target: CollectTarget;
  now: Date;
  /** Time (ms since epoch) after which the collector must stop and return what it has. */
  deadline: number;
  fetcher: Fetcher;
};

export type CollectResult = {
  items: CollectedItemInput[];
  /** The collector's progress, saved on the target for its next run. */
  cursor: Record<string, unknown>;
  /** True when the whole target was read: an item of this target not seen again has closed. */
  complete: boolean;
  /** Overrides the adaptive interval, e.g. a long one when there is nothing to collect. */
  intervalMinutes?: number;
  /** Why the run collected what it did, kept in the run log. */
  note?: string;
  /**
   * The target (a website) moved to another domain, checked and reachable: the runner keeps this
   * target with its redirect history, switches it off, and collects the new domain as its own target.
   */
  movedTo?: { domain: string; moves: DomainMove[] };
};

export type Collector = {
  slug: CollectorSlug;
  access: CollectorAccess;
  defaultIntervalMinutes: number;
  collect(context: CollectContext): Promise<CollectResult>;
  /** Adds the targets this collector should read (idempotent). Returns how many were new. */
  seed?(): Promise<number>;
};
