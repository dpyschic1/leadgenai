"use client";

import type { ReactNode } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import { ChipSelect } from "@/components/forms/chip-select";
import { MultiCombobox } from "@/components/forms/multi-combobox";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { activeFilterCount, useFilterOptions, type ListFilterKey } from "@/hooks/use-filter-options";
import { LEAD_STATUS_LABELS, LEAD_STATUSES, type LeadStatus } from "@/lib/domain/opportunities";
import { EMPTY_FILTERS, type OpportunityFilters } from "@/lib/validation/opportunities";

export const HIDDEN_FILTER_LABEL = "Show only likely competitors";
const ANY = "any";

/**
 * The filters that decide which opportunities to work on, and only those: is it a lead, which of
 * your services it's for, what they're hiring for, and where. (Other filters the AI search may set
 * still apply, and show as removable chips.) Changes apply straight away.
 */
export function FilterPanel({
  filters,
  onChange,
}: {
  filters: OpportunityFilters;
  onChange: (filters: OpportunityFilters) => void;
}) {
  const options = useFilterOptions();
  const count = activeFilterCount(filters);
  const setList = (key: ListFilterKey) => (value: string[]) => onChange({ ...filters, [key]: value });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 bg-card">
          <SlidersHorizontalIcon />
          Filters
          {count > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-xs tabular-nums text-primary-foreground">{count}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[min(36rem,80vh)] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto p-0">
        <div className="space-y-5 p-5">
          {/* An opportunity is everything found; the AI's check makes it a lead. */}
          <Group label="Lead status">
            <Select value={filters.leadStatus ?? ANY} onValueChange={(next) => onChange({ ...filters, leadStatus: next === ANY ? null : (next as LeadStatus) })}>
              <SelectTrigger aria-label="Lead status" className="h-10! w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any</SelectItem>
                {LEAD_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {LEAD_STATUS_LABELS[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Group>

          {options.services.length > 0 && (
            <Group label="Matches your service">
              <ChipSelect options={options.services} value={filters.services} onChange={setList("services")} />
            </Group>
          )}

          <Group label="Hiring for">
            <MultiCombobox
              options={options.needs}
              value={filters.needs}
              onChange={setList("needs")}
              placeholder="Any work"
              searchPlaceholder="Search: design, AI, mobile…"
              emptyText="No kind of work found."
            />
          </Group>

          <Group label="Country">
            <MultiCombobox
              options={options.countries}
              value={filters.countries}
              onChange={setList("countries")}
              placeholder="Any country"
              searchPlaceholder="Search countries"
              emptyText="No country found."
            />
          </Group>
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
          <p className="text-xs text-muted-foreground">Every filter you pick narrows the list.</p>
          <Button
            variant="ghost"
            size="sm"
            disabled={count === 0}
            onClick={() => onChange({ ...EMPTY_FILTERS, q: filters.q, categories: filters.categories })}
          >
            Clear filters
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      {children}
    </fieldset>
  );
}
