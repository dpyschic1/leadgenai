"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PhoneIcon, SearchIcon, TargetIcon } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Pagination, usePage } from "@/components/layout/pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { activeFilterCount } from "@/hooks/use-filter-options";
import { useOpportunities } from "@/hooks/use-opportunities";
import type { StatusGroup } from "@/lib/domain/opportunities";
import { cn } from "@/lib/utils";
import { EMPTY_FILTERS, type OpportunityFilters } from "@/lib/validation/opportunities";
import { ActiveFilters } from "./active-filters";
import { AiSearch } from "./ai-search";
import { ExportButton } from "./export-button";
import { FilterPanel } from "./filter-panel";
import { OpportunityCard } from "./opportunity-card";

const TABS: { group: StatusGroup; label: string }[] = [
  { group: "open", label: "Open" },
  { group: "inProgress", label: "In progress" },
  { group: "won", label: "Won" },
  { group: "closed", label: "Closed" },
];

const EMPTY_TAB: Record<StatusGroup, string> = {
  open: "No open opportunities. Record signals on your companies and they'll appear here, ranked.",
  inProgress: "Nothing in progress yet. Move an opportunity to Contacted once you reach out.",
  won: "No wins yet. Mark an opportunity as Won when it closes.",
  closed: "Nothing lost or dismissed.",
};

export function OpportunitiesView() {
  const [group, setGroup] = useState<StatusGroup>("open");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<OpportunityFilters>(EMPTY_FILTERS);
  const q = useDebouncedValue(search.trim());
  // The company box types freely; everything else changes in one step.
  const active = useMemo(() => ({ ...filters, q }), [filters, q]);
  // Another tab, search or filter starts again from page 1.
  const [page, setPage] = usePage(JSON.stringify([group, active]));
  const { data, isPending, isFetching } = useOpportunities(group, active, page);

  const filtering = q !== "" || activeFilterCount(filters) > 0;
  const hasAny = data && Object.values(data.counts).some((count) => count > 0);
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSearch("");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Opportunities"
        description="Companies showing a reason to buy what you sell, ranked by priority. The score ranks who to look at first; it doesn't predict a sale."
        action={
          (hasAny || filtering) && <ExportButton request={{ group, filters: active }} disabled={!data?.items.length} />
        }
      />

      {data && !hasAny && !filtering ? (
        <EmptyOpportunities />
      ) : (
        <>
          <AiSearch
            onApply={({ filters: found }) => {
              setFilters(found);
              setSearch(found.q);
            }}
          />

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            {/* On narrow screens the tabs scroll inside their own bar instead of widening the page. */}
            <div
              role="tablist"
              aria-label="Status"
              className="flex max-w-full overflow-x-auto rounded-lg border bg-card p-1 lg:inline-flex lg:self-start"
            >
              {TABS.map((tab) => {
                const selected = tab.group === group;
                return (
                  <button
                    key={tab.group}
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setGroup(tab.group)}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      selected ? "bg-signal-tint font-medium text-[var(--signal-deep)]" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tab.label}
                    <span className={cn("rounded-full px-1.5 text-xs tabular-nums", selected ? "bg-background" : "bg-secondary")}>
                      {data?.counts[tab.group] ?? "·"}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2">
              <div className="relative w-full lg:w-64">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search companies"
                  aria-label="Search opportunities"
                  className="h-9 bg-card pl-9"
                />
              </div>
              {/* The one filter a caller reaches for most: only leads someone can be contacted at. */}
              <Button
                variant="outline"
                aria-pressed={filters.contact === "any"}
                onClick={() => setFilters({ ...filters, contact: filters.contact === "any" ? null : "any" })}
                className={cn("h-9 shrink-0 bg-card", filters.contact === "any" && "border-primary/40 bg-signal-tint text-[var(--signal-deep)]")}
              >
                <PhoneIcon />
                Has contact
              </Button>
              <FilterPanel filters={filters} onChange={setFilters} />
            </div>
          </div>

          <ActiveFilters filters={filters} onChange={setFilters} />

          {isPending && !data ? (
            <FeedSkeleton />
          ) : data && data.items.length > 0 ? (
            <>
              <ul className={cn("space-y-3 transition-opacity", isFetching && "opacity-60")} aria-label="Opportunities">
                {data.items.map((opportunity, index) => (
                  <OpportunityCard
                    key={opportunity.id}
                    opportunity={opportunity}
                    // Ranks run on across pages: page 2 starts at #26.
                    rank={group === "open" ? (data.page - 1) * data.pageSize + index + 1 : null}
                  />
                ))}
              </ul>
              <Pagination page={data.page} pageSize={data.pageSize} total={data.total} noun="opportunities" onChange={setPage} />
            </>
          ) : (
            <div className="rounded-xl border border-dashed bg-card px-6 py-12 text-center text-sm text-muted-foreground">
              {filtering ? (
                <>
                  <p>No {TABS.find((tab) => tab.group === group)?.label.toLowerCase()} opportunities match these filters.</p>
                  <Button variant="outline" size="sm" className="mt-4" onClick={clearFilters}>
                    Clear search and filters
                  </Button>
                </>
              ) : (
                <p>{EMPTY_TAB[group]}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FeedSkeleton() {
  return (
    <ul className="space-y-3" aria-label="Loading opportunities">
      {[0, 1, 2].map((row) => (
        <li key={row} className="flex gap-5 rounded-xl border bg-card p-5">
          <Skeleton className="size-14 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-full" />
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-5 w-28 rounded-full" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyOpportunities() {
  return (
    <section className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-signal-tint text-primary">
        <TargetIcon className="size-5" />
      </span>
      <h2 className="mt-4 font-semibold">No opportunities yet</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        An opportunity appears as soon as a company has a buying signal. It&apos;s scored against your services and ICP,
        and re-scored whenever anything changes.
      </p>
      <Button asChild className="mt-5">
        <Link href="/companies">Go to companies</Link>
      </Button>
    </section>
  );
}
