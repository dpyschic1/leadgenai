"use client";

import { COUNTRY_CODES, countryName } from "@/lib/countries";
import { ENGINE_SOURCE_LABELS } from "@/lib/domain/engine";
import { INTENT_LABELS, URGENCY_LABELS } from "@/lib/domain/signals";
import { FILTER_URGENCY_LEVELS, type OpportunityFilters } from "@/lib/validation/opportunities";
import { useReferenceData } from "./use-reference-data";
import { useServices } from "./use-services";

/** Feed filters that hold a list of values. */
export type ListFilterKey = "types" | "services" | "signals" | "urgency" | "industries" | "countries" | "sources" | "intents";

/** One choice for a filter; matches the option shape the select components take. */
type Option = { value: string; label: string };

const COUNTRY_OPTIONS: Option[] = COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code) })).sort((a, b) =>
  a.label.localeCompare(b.label),
);
const SOURCE_OPTIONS: Option[] = Object.entries(ENGINE_SOURCE_LABELS).map(([value, label]) => ({ value, label }));
const INTENT_OPTIONS: Option[] = (['explicit', 'high', 'medium', 'low'] as const).map((level) => ({ value: level, label: INTENT_LABELS[level] }));
const URGENCY_OPTIONS: Option[] = FILTER_URGENCY_LEVELS.map((level) => ({ value: level, label: URGENCY_LABELS[level] }));

/** The choices for each feed filter, from the reference data and the workspace's own services. */
export function useFilterOptions(): Record<ListFilterKey, Option[]> {
  const { data: ref } = useReferenceData();
  const { data: services } = useServices();
  const options = (rows: { slug: string; name: string }[] | undefined) =>
    rows?.map((row) => ({ value: row.slug, label: row.name })) ?? [];

  return {
    types: options(ref?.opportunityTypes),
    services: services?.items.map((service) => ({ value: service.id, label: service.name })) ?? [],
    // Negative signals lower a score; nobody searches for them.
    signals: options(ref?.signalCategories.filter((category) => category.slug !== "negative")),
    urgency: URGENCY_OPTIONS,
    industries: options(ref?.industries),
    countries: COUNTRY_OPTIONS,
    sources: SOURCE_OPTIONS,
    intents: INTENT_OPTIONS,
  };
}

/** How many filters are narrowing the feed, not counting the company search box. */
export function activeFilterCount(filters: OpportunityFilters): number {
  const lists: ListFilterKey[] = ["types", "services", "signals", "urgency", "industries", "countries", "sources", "intents"];
  return (
    lists.filter((key) => filters[key].length > 0).length +
    (filters.minScore === null ? 0 : 1) +
    (filters.withinDays === null ? 0 : 1) +
    (filters.contact === null ? 0 : 1)
  );
}
