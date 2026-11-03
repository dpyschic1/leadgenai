import { z } from "zod";
import { COUNTRY_CODES } from "@/lib/countries";
import { OPPORTUNITY_STATUSES, STATUS_GROUPS, type StatusGroup } from "@/lib/domain/opportunities";
import { paginationFields } from "./pagination";

/** Shared by the opportunity pages, the AI search and the route handlers. */

const slug = z.string().min(1).max(64);

/** A list from a URL ("a,b") or from code (["a", "b"]), deduplicated. Missing means no filter. */
const list = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (value) =>
      typeof value === "string"
        ? value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : (value ?? []),
    z
      .array(item)
      .max(50)
      .transform((values) => [...new Set(values)]),
  );

/** A whole number from a URL ("70") or from code (70); missing or empty means no filter. */
const optionalInt = (min: number, max: number) =>
  z.preprocess(
    (value) => (value === undefined || value === null || value === "" ? null : typeof value === "string" ? Number(value) : value),
    z.number().int().min(min).max(max).nullable(),
  );

/** Urgency levels worth filtering by; "unknown" isn't something anyone searches for. */
export const FILTER_URGENCY_LEVELS = ["high", "medium", "low"] as const;

/**
 * Feed filters (PRD §22: "filtered by company, signal, date, score, and opportunity type").
 * Every filter narrows the feed; empty ones are ignored.
 */
export const opportunityFiltersSchema = z.object({
  /** Company name or domain contains this text. */
  q: z.string().trim().max(200).default(""),
  /** Opportunity type slugs. */
  types: list(slug),
  /** Matched service ids. */
  services: list(z.uuid()),
  /** Signal category slugs: has at least one supporting signal in one of them. */
  signals: list(slug),
  urgency: list(z.enum(FILTER_URGENCY_LEVELS)),
  /** Company industry slugs. */
  industries: list(slug),
  /** Company headquarters country codes. */
  countries: list(z.enum(COUNTRY_CODES)),
  /** Opportunity score at least this (unscored ones are left out). */
  minScore: optionalInt(0, 100),
  /** Latest supporting signal within this many days. */
  withinDays: optionalInt(1, 365),
});

export type OpportunityFilters = z.output<typeof opportunityFiltersSchema>;

export const EMPTY_FILTERS: OpportunityFilters = {
  q: "",
  types: [],
  services: [],
  signals: [],
  urgency: [],
  industries: [],
  countries: [],
  minScore: null,
  withinDays: null,
};

const groupField = { group: z.enum(Object.keys(STATUS_GROUPS) as [StatusGroup, ...StatusGroup[]]).default("open") };

/** One page of the feed. */
export const opportunityListQuerySchema = opportunityFiltersSchema.extend({ ...groupField, ...paginationFields });

/** CSV export: one saved list (any status), or the whole feed as filtered on screen (every page). */
export const opportunityExportQuerySchema = opportunityFiltersSchema.extend({
  ...groupField,
  listId: z.uuid("Unknown list").optional(),
});

/** A plain-language request for the AI search, e.g. "funded UK startups needing an app". */
export const interpretSearchSchema = z.object({
  query: z
    .string()
    .trim()
    .min(3, "Describe what you're looking for")
    .max(300, "Keep it under 300 characters"),
});

export const updateOpportunitySchema = z
  .object({
    status: z.enum(OPPORTUNITY_STATUSES).optional(),
    notes: z
      .string()
      .nullable()
      .transform((value) => value?.trim() || null)
      .refine((value) => value === null || value.length <= 5000, "Keep notes under 5,000 characters")
      .optional(),
  })
  .refine((value) => value.status !== undefined || value.notes !== undefined, "Nothing to update");

export type OpportunityListQuery = z.output<typeof opportunityListQuerySchema>;
export type OpportunityExportQuery = z.output<typeof opportunityExportQuerySchema>;
export type InterpretSearchInput = z.infer<typeof interpretSearchSchema>;
export type UpdateOpportunityInput = z.input<typeof updateOpportunitySchema>;
export type UpdateOpportunityValues = z.output<typeof updateOpportunitySchema>;
