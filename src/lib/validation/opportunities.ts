import { z } from "zod";
import { COUNTRY_CODES } from "@/lib/countries";
import { FILTER_CATEGORIES } from "@/lib/domain/engine";
import { CONTACT_REACH, LEAD_TABS, ROLE_FAMILIES, STATUS_GROUP_KEYS, type StatusGroup } from "@/lib/domain/opportunities";
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
  /** Category: company signals, intent, funded company, freelance project. */
  categories: list(z.enum(FILTER_CATEGORIES)),
  /** Where an engine opportunity was found (provider slugs). */
  sources: list(slug),
  /** Buying intent level of an engine opportunity. */
  intents: list(z.enum(["explicit", "high", "medium", "low"])),
  /** Opportunity score at least this (unscored ones are left out). */
  minScore: optionalInt(0, 100),
  /** Latest supporting signal within this many days. */
  withinDays: optionalInt(1, 365),
  /** Hiring for / needs: service category slugs the opportunity's evidence points to (e.g. ui_ux_design). */
  needs: list(slug),
  /** Found (added to the list) within this many days: "new this week" is 7. */
  foundWithinDays: optionalInt(1, 365),
  /** How the lead can be reached (see `CONTACT_REACH`); missing means any. */
  contact: z.preprocess((value) => (value === "" || value === undefined ? null : value), z.enum(CONTACT_REACH).nullable()).default(null),
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
  categories: [],
  sources: [],
  intents: [],
  minScore: null,
  withinDays: null,
  needs: [],
  foundWithinDays: null,
  contact: null,
};

/** How the feed is ordered: best match (score) by default, or newest found, latest activity, most open roles. */
export const OPPORTUNITY_SORTS = ["best", "newest", "latest", "roles"] as const;
export type OpportunitySort = (typeof OPPORTUNITY_SORTS)[number];
export const OPPORTUNITY_SORT_LABELS: Record<OpportunitySort, string> = {
  best: "Best match",
  newest: "Newest found",
  latest: "Latest activity",
  roles: "Most open roles",
};

const groupField = { group: z.enum(STATUS_GROUP_KEYS as readonly [StatusGroup, ...StatusGroup[]]).default("open") };
const sortField = { sort: z.enum(OPPORTUNITY_SORTS).default("best") };

/** One page of the feed. */
export const opportunityListQuerySchema = opportunityFiltersSchema.extend({ ...groupField, ...sortField, ...paginationFields });

/** CSV export: one saved list (any status), or the whole feed as filtered and sorted on screen (every page). */
export const opportunityExportQuerySchema = opportunityFiltersSchema.extend({
  ...groupField,
  ...sortField,
  listId: z.uuid("Unknown list").optional(),
});

/** Bulk actions on selected opportunities: exactly one of move to a stage, archive/restore, or add to a list. */
export const MAX_BULK = 100;
export const bulkOpportunitiesSchema = z
  .object({
    ids: z.array(z.uuid()).min(1, "Select at least one opportunity").max(MAX_BULK, `Select at most ${MAX_BULK} at a time`),
    stageId: z.uuid().optional(),
    archived: z.boolean().optional(),
    listId: z.uuid().optional(),
  })
  .refine((v) => [v.stageId, v.archived, v.listId].filter((x) => x !== undefined).length === 1, "Choose one action");

export type BulkOpportunitiesValues = z.infer<typeof bulkOpportunitiesSchema>;

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
    /** Move it to a pipeline stage of this workspace. */
    stageId: z.uuid().optional(),
    /** Archive it (hide from the working tabs, keep it) or bring it back. */
    archived: z.boolean().optional(),
    notes: z
      .string()
      .nullable()
      .transform((value) => value?.trim() || null)
      .refine((value) => value === null || value.length <= 5000, "Keep notes under 5,000 characters")
      .optional(),
  })
  .refine((value) => value.stageId !== undefined || value.archived !== undefined || value.notes !== undefined, "Nothing to update");

export type OpportunityListQuery = z.output<typeof opportunityListQuerySchema>;
export type OpportunityExportQuery = z.output<typeof opportunityExportQuerySchema>;
export type InterpretSearchInput = z.infer<typeof interpretSearchSchema>;
export type UpdateOpportunityInput = z.input<typeof updateOpportunitySchema>;
export type UpdateOpportunityValues = z.output<typeof updateOpportunitySchema>;

/** Which leads the Leads page shows: a contact tab, a role type, a search. */
export const leadFilterFields = {
  q: z.string().trim().max(200).default(""),
  tab: z.enum(LEAD_TABS).default("all"),
  role: z.enum(ROLE_FAMILIES).optional(),
};

/** One page of the Leads page. */
export const leadListQuerySchema = z.object({ ...leadFilterFields, ...paginationFields });
export type LeadListQuery = z.output<typeof leadListQuerySchema>;

/** Every lead the Leads page's filters match, for copying their emails and phones at once. */
export const leadContactsQuerySchema = z.object(leadFilterFields);
export type LeadContactsQuery = z.output<typeof leadContactsQuerySchema>;
