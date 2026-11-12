"use client";

import type { ReactNode } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import { ChipSelect } from "@/components/forms/chip-select";
import { MultiCombobox } from "@/components/forms/multi-combobox";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { activeFilterCount, useFilterOptions, type ListFilterKey } from "@/hooks/use-filter-options";
import { CONTACT_REACH, CONTACT_REACH_LABELS, type ContactReach } from "@/lib/domain/opportunities";
import { EMPTY_FILTERS, type OpportunityFilters } from "@/lib/validation/opportunities";

export const MIN_SCORE_CHOICES = [50, 60, 70, 80, 90] as const;
export const WITHIN_DAYS_CHOICES = [7, 30, 90, 180] as const;
const ANY = "any";

/** Every structured filter in one panel. Changes apply straight away. */
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
      <PopoverContent align="end" className="max-h-[min(36rem,80vh)] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto p-0">
        <div className="space-y-5 p-5">
          <div className="grid gap-5 sm:grid-cols-2">
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
            <Group label="Opportunity type">
              <MultiCombobox
                options={options.types}
                value={filters.types}
                onChange={setList("types")}
                placeholder="Any type"
                searchPlaceholder="Search types"
                emptyText="No type found."
              />
            </Group>
            <Group label="Industry">
              <MultiCombobox
                options={options.industries}
                value={filters.industries}
                onChange={setList("industries")}
                placeholder="Any industry"
                searchPlaceholder="Search industries"
                emptyText="No industry found."
              />
            </Group>
            <Group label="Source">
              <MultiCombobox
                options={options.sources}
                value={filters.sources}
                onChange={setList("sources")}
                placeholder="Any source"
                searchPlaceholder="Search sources"
                emptyText="No source found."
              />
            </Group>
            <Group label="Buying intent">
              <ChipSelect options={options.intents} value={filters.intents} onChange={setList("intents")} />
            </Group>
            <Group label="Country (headquarters or stated)">
              <MultiCombobox
                options={options.countries}
                value={filters.countries}
                onChange={setList("countries")}
                placeholder="Any country"
                searchPlaceholder="Search countries"
                emptyText="No country found."
              />
            </Group>
            <div className="grid grid-cols-2 gap-3">
              <Group label="Score">
                <NumberChoice
                  label="Minimum score"
                  value={filters.minScore}
                  choices={MIN_SCORE_CHOICES}
                  anyLabel="Any"
                  format={(n) => `${n}+`}
                  onChange={(minScore) => onChange({ ...filters, minScore })}
                />
              </Group>
              <Group label="Latest signal">
                <NumberChoice
                  label="Latest signal within"
                  value={filters.withinDays}
                  choices={WITHIN_DAYS_CHOICES}
                  anyLabel="Any time"
                  format={(n) => `Last ${n} days`}
                  onChange={(withinDays) => onChange({ ...filters, withinDays })}
                />
              </Group>
            </div>
          </div>

          <Group label="Contact">
            <Select value={filters.contact ?? ANY} onValueChange={(next) => onChange({ ...filters, contact: next === ANY ? null : (next as ContactReach) })}>
              <SelectTrigger aria-label="How the lead can be reached" className="h-10! w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any</SelectItem>
                {CONTACT_REACH.map((reach) => (
                  <SelectItem key={reach} value={reach}>
                    {CONTACT_REACH_LABELS[reach]}
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
          <Group label="Signal">
            <ChipSelect options={options.signals} value={filters.signals} onChange={setList("signals")} />
          </Group>
          <Group label="Urgency">
            <ChipSelect options={options.urgency} value={filters.urgency} onChange={setList("urgency")} />
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

function NumberChoice({
  label,
  value,
  choices,
  anyLabel,
  format,
  onChange,
}: {
  label: string;
  value: number | null;
  choices: readonly number[];
  anyLabel: string;
  format: (value: number) => string;
  onChange: (value: number | null) => void;
}) {
  return (
    <Select value={value === null ? ANY : String(value)} onValueChange={(next) => onChange(next === ANY ? null : Number(next))}>
      <SelectTrigger aria-label={label} className="h-10! w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{anyLabel}</SelectItem>
        {/* A value the AI chose that isn't a preset still shows correctly. */}
        {[...new Set([...choices, ...(value === null ? [] : [value])])]
          .sort((a, b) => a - b)
          .map((choice) => (
            <SelectItem key={choice} value={String(choice)}>
              {format(choice)}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
