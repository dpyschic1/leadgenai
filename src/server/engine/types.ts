import type { Capability, FreelanceConfig, OpportunityCategory, Targeting, VerificationStatus } from "@/lib/domain/engine";
import type { IntentLevel } from "@/lib/domain/signals";

/**
 * What every discovery provider returns, whatever its source (spec §7 "Normalize"). Fields a
 * source doesn't state stay null: nothing is guessed, and `verification` says how well it is backed.
 */
export type DiscoveredItem = {
  capability: Capability;
  category: OpportunityCategory;
  sourceSlug: string;
  /** Human-readable platform, e.g. "Hacker News". */
  platform: string;
  /** The source's own ID: the deduplication key. */
  externalId: string;
  url: string | null;
  title: string;
  /** The captured post / description text, used for matching, intent and the evidence snippet. */
  text: string;
  postedAt: Date | null;
  buyerName: string | null;
  buyerProfileUrl: string | null;
  companyName: string | null;
  companyDomain: string | null;
  country: string | null;
  city: string | null;
  /** Industry slug (see the industries reference table) when the source states one. */
  industry: string | null;
  /** True / false when the source says; null when unknown. */
  remote: boolean | null;
  clientType: "company" | "individual" | null;
  budget: { min: number | null; max: number | null; currency: string | null; usd: number | null } | null;
  funding: { amountUsd: number | null; stage: string | null; date: string | null; investors: string[] } | null;
  /** The provider's own reading of buying intent when it has one (a [Hiring] tag, an SEEKING post); null = read the text. */
  intentHint: IntentLevel | null;
  verification: VerificationStatus;
  metadata: Record<string, unknown>;
};

/** A provider is one source of items for one capability; new sources are added without touching the engine. */
export type DiscoveryContext = {
  targeting: Targeting;
  /** Names + descriptions of the services being matched, used to build search queries. */
  serviceTerms: string[];
  config: Record<string, unknown>;
  now: Date;
  signal?: AbortSignal;
};

export type DiscoveryProvider = {
  slug: string;
  name: string;
  capability: Capability;
  /** False when the provider needs a credential that is not set; the runner then skips it with a note instead of failing. */
  configured?: () => boolean;
  /** What a user must do to enable it, shown when it is skipped. */
  setupHint?: string;
  discover(context: DiscoveryContext): Promise<DiscoveredItem[]>;
};

export type ScoreFactorKey = "serviceFit" | "intent" | "icpFit" | "budget" | "timing" | "evidence";

export type EngineScore = {
  total: number;
  factors: Record<ScoreFactorKey, number>;
  weights: Record<ScoreFactorKey, number>;
  intentLevel: IntentLevel;
  matchedTerms: string[];
};

export type { FreelanceConfig };
