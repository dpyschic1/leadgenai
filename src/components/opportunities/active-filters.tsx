"use client";

import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { activeFilterCount, useFilterOptions, type ListFilterKey } from "@/hooks/use-filter-options";
import { EMPTY_FILTERS, type OpportunityFilters } from "@/lib/validation/opportunities";

const LIST_LABELS: Record<ListFilterKey, string> = {
  types: "Type",
  services: "Service",
  signals: "Signal",
  urgency: "Urgency",
  industries: "Industry",
  countries: "Country",
};

type Chip = { key: string; label: string; remove: (filters: OpportunityFilters) => OpportunityFilters };

/** The filters in force, as chips that each remove one value: the AI search's choices stay inspectable. */
export function ActiveFilters({
  filters,
  onChange,
}: {
  filters: OpportunityFilters;
  onChange: (filters: OpportunityFilters) => void;
}) {
  const options = useFilterOptions();
  if (activeFilterCount(filters) === 0) return null;

  const chips: Chip[] = (Object.keys(LIST_LABELS) as ListFilterKey[]).flatMap((key) => {
    const labelOf = new Map(options[key].map((option) => [option.value, option.label]));
    return filters[key].map((value) => ({
      key: `${key}:${value}`,
      label: `${LIST_LABELS[key]}: ${labelOf.get(value) ?? value}`,
      remove: (current: OpportunityFilters) => ({ ...current, [key]: current[key].filter((v) => v !== value) }),
    }));
  });
  if (filters.minScore !== null) {
    chips.push({ key: "minScore", label: `Score ${filters.minScore}+`, remove: (f) => ({ ...f, minScore: null }) });
  }
  if (filters.withinDays !== null) {
    chips.push({
      key: "withinDays",
      label: filters.withinDays === 1 ? "Signal today" : `Signal in last ${filters.withinDays} days`,
      remove: (f) => ({ ...f, withinDays: null }),
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ul className="flex flex-wrap gap-2" aria-label="Active filters">
        {chips.map((chip) => (
          <li
            key={chip.key}
            className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-signal-tint py-0.5 pr-1 pl-3 text-xs font-medium text-[var(--signal-deep)]"
          >
            {chip.label}
            <button
              type="button"
              onClick={() => onChange(chip.remove(filters))}
              className="grid size-5 place-items-center rounded-full hover:bg-background"
              aria-label={`Remove filter ${chip.label}`}
            >
              <XIcon className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onChange({ ...EMPTY_FILTERS, q: filters.q })}>
        Clear all
      </Button>
    </div>
  );
}
