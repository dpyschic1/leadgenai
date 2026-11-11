/**
 * LeadGen Engine (Opportunities Engine spec §2): one master switch, three independent discovery
 * capabilities, each with its own schedule, targeting override and filters. The database enum is
 * built from CAPABILITIES, so schema, API validation and UI share one definition.
 */
import { z } from "zod";

export const CAPABILITIES = ["intent", "funded", "freelance"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  intent: "Intent Discovery",
  funded: "Funded Companies",
  freelance: "Freelance Projects",
};

export const CAPABILITY_DESCRIPTIONS: Record<Capability, string> = {
  intent: "People and companies publicly asking for services you provide.",
  funded: "Companies with a disclosed funding round that may need your services.",
  freelance: "Freelance projects that match your services and have a real budget.",
};

/** The opportunity category each capability produces (spec §11). */
export const OPPORTUNITY_CATEGORIES = ["intent", "funded_company", "freelance_project"] as const;
export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];
export const CAPABILITY_CATEGORY: Record<Capability, OpportunityCategory> = {
  intent: "intent",
  funded: "funded_company",
  freelance: "freelance_project",
};
export const CATEGORY_LABELS: Record<OpportunityCategory, string> = {
  intent: "Intent",
  funded_company: "Funded company",
  freelance_project: "Freelance project",
};

/** Opportunities from the original company-signal flow have no category; the feed filters them as "signal". */
export const FILTER_CATEGORIES = ["signal", ...OPPORTUNITY_CATEGORIES] as const;
export type FilterCategory = (typeof FILTER_CATEGORIES)[number];
export const FILTER_CATEGORY_LABELS: Record<FilterCategory, string> = { signal: "Company signals", ...CATEGORY_LABELS };

/** The factors of an engine opportunity's score (spec section 10), in display order. */
export const ENGINE_FACTOR_LABELS: Record<string, string> = {
  serviceFit: "Service fit",
  intent: "Buying intent",
  icpFit: "ICP fit",
  budget: "Budget / funding",
  timing: "Timing",
  evidence: "Evidence quality",
};

/** Where an engine opportunity was found, by provider slug. */
export const ENGINE_SOURCE_LABELS: Record<string, string> = {
  hacker_news: "Hacker News",
  serpapi: "Google search",
  reddit: "Reddit",
  yc_directory: "Y Combinator",
  sec_form_d: "SEC EDGAR (Form D)",
  freelancer: "Freelancer.com",
  peopleperhour: "PeoplePerHour",
  guru: "Guru",
};

export const VERIFICATION_LABELS: Record<VerificationStatus, string> = { verified: "Verified", unverified: "Unverified", unavailable: "Unavailable" };

/** Evidence verification (spec §8). */
export const VERIFICATION_STATUSES = ["verified", "unverified", "unavailable"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Outcome of the last run of a capability (spec §6, proposed controls). */
export const RUN_STATUSES = ["success", "partial", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Shortest and longest discovery interval a user may choose; sources enforce their own limits too. */
export const MIN_FREQUENCY_MINUTES = 15;
export const MAX_FREQUENCY_MINUTES = 7 * 24 * 60;

/** Examples from the spec (§6), used as starting values only. */
export const DEFAULT_FREQUENCY_MINUTES: Record<Capability, number> = {
  intent: 6 * 60,
  funded: 24 * 60,
  freelance: 60,
};

// ---------------------------------------------------------------------------
// Targeting: workspace defaults, with per-capability overrides that REPLACE (never add to)
// the inherited value for that dimension (spec §2).
// ---------------------------------------------------------------------------

export const TARGETING_DIMENSIONS = ["countries", "industries", "serviceIds"] as const;
export type TargetingDimension = (typeof TARGETING_DIMENSIONS)[number];

export type Targeting = Record<TargetingDimension, string[]>;
/** `null` for a dimension means "inherit the workspace value". An empty array is a real override. */
export type TargetingOverride = Record<TargetingDimension, string[] | null>;

export const NO_OVERRIDE: TargetingOverride = { countries: null, industries: null, serviceIds: null };

export function resolveTargeting(workspace: Targeting, override: TargetingOverride): Targeting {
  const pick = (dimension: TargetingDimension) => override[dimension] ?? workspace[dimension];
  return { countries: pick("countries"), industries: pick("industries"), serviceIds: pick("serviceIds") };
}

// ---------------------------------------------------------------------------
// Capability-specific configuration (stored as JSONB, always read through these schemas).
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const FRESHNESS_DAYS = [1, 7, 30, 90] as const;
export const CLIENT_TYPES = ["company", "individual"] as const;
export const WORK_MODES = ["any", "remote", "onsite"] as const;

export const intentConfigSchema = z.object({
  /** Which discovery providers to use, by slug (see PROVIDERS). Empty means all enabled ones. */
  providers: z.array(z.string()).default([]),
});

export const fundedConfigSchema = z
  .object({
    /** Inclusive funding-date window; null means open-ended. No minimum amount or stage (spec §4). */
    fundedFrom: isoDate.nullable().default(null),
    fundedTo: isoDate.nullable().default(null),
  })
  .refine((c) => !c.fundedFrom || !c.fundedTo || c.fundedFrom <= c.fundedTo, {
    message: "Start date must be on or before end date",
    path: ["fundedTo"],
  });

export const freelanceConfigSchema = z.object({
  /** Default $5,000 USD; no upper limit (spec §5). */
  minBudgetUsd: z.number().int().min(0).default(5000),
  /**
   * Projects without a disclosed budget are never treated as meeting the minimum. `include`
   * keeps them, flagged "budget unavailable"; `exclude` drops them.
   */
  undisclosedBudget: z.enum(["include", "exclude"]).default("include"),
  postedWithinDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(30),
  clientTypes: z.array(z.enum(CLIENT_TYPES)).min(1).default([...CLIENT_TYPES]),
  workMode: z.enum(WORK_MODES).default("any"),
  cities: z.array(z.string().trim().min(1)).default([]),
  regions: z.array(z.string().trim().min(1)).default([]),
  providers: z.array(z.string()).default([]),
});

export const CAPABILITY_CONFIG_SCHEMAS = {
  intent: intentConfigSchema,
  funded: fundedConfigSchema,
  freelance: freelanceConfigSchema,
} as const;

export type IntentConfig = z.infer<typeof intentConfigSchema>;
export type FundedConfig = z.infer<typeof fundedConfigSchema>;
export type FreelanceConfig = z.infer<typeof freelanceConfigSchema>;
export type CapabilityConfig = IntentConfig | FundedConfig | FreelanceConfig;

/** Parses stored config, falling back to defaults when a row is malformed or empty. */
export function parseCapabilityConfig(capability: Capability, raw: unknown): CapabilityConfig {
  const schema = CAPABILITY_CONFIG_SCHEMAS[capability];
  const parsed = schema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : schema.parse({});
}

// ---------------------------------------------------------------------------
// The engine's own reading of an item (intent, matched words). An opportunity's score is the
// workspace scoring profile's (src/server/engine/our-score.ts), the same as company opportunities.
// ---------------------------------------------------------------------------

export const ENGINE_WEIGHT_KEYS = ["serviceFit", "intent", "icpFit", "budget", "timing", "evidence"] as const;
export type EngineWeightKey = (typeof ENGINE_WEIGHT_KEYS)[number];
export type EngineWeights = Record<EngineWeightKey, number>;

/** Fixed weights for the engine's own reading of an item; not a setting. */
export const DEFAULT_ENGINE_WEIGHTS: EngineWeights = { serviceFit: 25, intent: 25, icpFit: 20, budget: 15, timing: 10, evidence: 5 };


// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** When a capability should next run, given when it last ran (spec §6). */
export function nextRunAt(lastRunAt: Date | null, frequencyMinutes: number, now = new Date()): Date {
  if (!lastRunAt) return now;
  const due = new Date(lastRunAt.getTime() + frequencyMinutes * 60_000);
  return due < now ? now : due;
}

export function isDue(
  c: { enabled: boolean; lastRunAt: Date | null; frequencyMinutes: number },
  masterEnabled: boolean,
  now = new Date(),
): boolean {
  return masterEnabled && c.enabled && nextRunAt(c.lastRunAt, c.frequencyMinutes, now) <= now;
}
