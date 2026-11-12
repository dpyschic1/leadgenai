"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ListChecksIcon,
  PhoneIcon,
  SearchIcon,
  SparklesIcon,
  TargetIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Pagination, usePage } from "@/components/layout/pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { activeFilterCount } from "@/hooks/use-filter-options";
import { useLists } from "@/hooks/use-lists";
import { useBulkOpportunities, useOpportunities } from "@/hooks/use-opportunities";
import { usePermission } from "@/hooks/use-permission";
import { usePipeline } from "@/hooks/use-pipeline";
import { EDITOR_ROLES } from "@/lib/permissions";
import { FILTER_CATEGORIES, FILTER_CATEGORY_LABELS, type FilterCategory } from "@/lib/domain/engine";
import type { StatusGroup } from "@/lib/domain/opportunities";
import { cn } from "@/lib/utils";
import {
  EMPTY_FILTERS,
  OPPORTUNITY_SORT_LABELS,
  OPPORTUNITY_SORTS,
  type BulkOpportunitiesValues,
  type OpportunityFilters,
  type OpportunitySort,
} from "@/lib/validation/opportunities";
import { ActiveFilters } from "./active-filters";
import { AiSearch } from "./ai-search";
import { ExportButton } from "./export-button";
import { FilterPanel } from "./filter-panel";
import { OpportunityCard, TickBox } from "./opportunity-card";

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

/** "New this week": found in the last 7 days. */
const NEW_DAYS = 7;

export function OpportunitiesView() {
  const [group, setGroup] = useState<StatusGroup>("open");
  const [sort, setSort] = useState<OpportunitySort>("best");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Tick boxes appear on the cards only while selecting, so the feed stays clean the rest of the time.
  const [selecting, setSelecting] = useState(false);
  const canEdit = usePermission(EDITOR_ROLES);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<OpportunityFilters>(EMPTY_FILTERS);
  const q = useDebouncedValue(search.trim());
  // The company box types freely; everything else changes in one step.
  const active = useMemo(() => ({ ...filters, q }), [filters, q]);
  // Another tab, search or filter starts again from page 1.
  const [page, setPage] = usePage(JSON.stringify([group, active, sort]));
  const { data, isPending, isFetching } = useOpportunities(group, active, page, sort);
  // Only what's on screen can be acted on: a selection never reaches rows the user can't see.
  const visibleSelected = data ? data.items.filter((o) => selected.has(o.id)).map((o) => o.id) : [];
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOnPage = data !== undefined && data.items.length > 0 && visibleSelected.length === data.items.length;
  const toggleAll = () => {
    setSelecting(true);
    setSelected(allOnPage ? new Set() : new Set(data?.items.map((o) => o.id)));
  };
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const isNew = filters.foundWithinDays === NEW_DAYS;

  const filtering = q !== "" || activeFilterCount(filters) > 0;
  const hasAny = data && Object.values(data.counts).some((count) => count > 0);
  const clearFilters = () => {
    setFilters({ ...EMPTY_FILTERS, categories: filters.categories });
    setSearch("");
  };
  // One category at a time, or all of them (an empty list).
  const category: FilterCategory | "all" = filters.categories.length === 1 ? filters.categories[0] : "all";
  const setCategory = (next: FilterCategory | "all") => setFilters({ ...filters, categories: next === "all" ? [] : [next] });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Opportunities"
        description="Companies, buyers and projects showing a reason to buy what you sell, ranked by priority. The score ranks who to look at first; it doesn't predict a sale."
        action={
          (hasAny || filtering) && <ExportButton request={{ group, filters: active, sort }} disabled={!data?.items.length} />
        }
      />

      {/* Only a workspace with no opportunities at all gets the setup screen; an empty category tab
          (e.g. Intent before any post is found) keeps the tabs so another can be picked. */}
      {data && !hasAny && !filtering && category === "all" ? (
        <EmptyOpportunities />
      ) : (
        <>
          <AiSearch
            onApply={({ filters: found }) => {
              setFilters(found);
              setSearch(found.q);
            }}
          />

          <div role="tablist" aria-label="Category" className="flex max-w-full gap-2 overflow-x-auto">
            {(["all", ...FILTER_CATEGORIES] as const).map((c) => (
              <button
                key={c}
                role="tab"
                aria-selected={c === category}
                onClick={() => setCategory(c)}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  c === category ? "border-primary/40 bg-signal-tint font-medium text-[var(--signal-deep)]" : "bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {c === "all" ? "All" : FILTER_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>

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
            <div className="flex flex-wrap gap-2">
              <div className="relative w-full lg:w-56">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search companies, buyers, titles"
                  aria-label="Search opportunities"
                  className="h-9 bg-card pl-9"
                />
              </div>
              {/* The first check of the day: what was found this week. */}
              <Button
                variant="outline"
                aria-pressed={isNew}
                onClick={() => setFilters({ ...filters, foundWithinDays: isNew ? null : NEW_DAYS })}
                className={cn("h-9 shrink-0 bg-card", isNew && "border-primary/40 bg-signal-tint text-[var(--signal-deep)]")}
              >
                <SparklesIcon />
                New this week
                <span className={cn("rounded-full px-1.5 text-xs tabular-nums", isNew ? "bg-background" : "bg-secondary")}>{data?.newThisWeek ?? "·"}</span>
              </Button>
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
              <Select value={sort} onValueChange={(next) => setSort(next as OpportunitySort)}>
                <SelectTrigger aria-label="Sort by" className="h-9! w-44 shrink-0 bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {OPPORTUNITY_SORTS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {OPPORTUNITY_SORT_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {canEdit && (
                <Button
                  variant="outline"
                  aria-pressed={selecting}
                  disabled={!data?.items.length}
                  onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
                  className={cn("h-9 shrink-0 bg-card", selecting && "border-primary/40 bg-signal-tint text-[var(--signal-deep)]")}
                >
                  <ListChecksIcon />
                  Select
                </Button>
              )}
            </div>
          </div>

          <ActiveFilters filters={filters} onChange={setFilters} />

          {canEdit && selecting && data && data.items.length > 0 && (
            <BulkBar
              ids={visibleSelected}
              allOnPage={allOnPage}
              onToggleAll={toggleAll}
              archived={group === "closed"}
              onDone={stopSelecting}
            />
          )}

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
                    selection={canEdit && selecting ? { selected: selected.has(opportunity.id), onToggle: () => toggle(opportunity.id) } : undefined}
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
              ) : category !== "all" ? (
                <>
                  <p>No {TABS.find((tab) => tab.group === group)?.label.toLowerCase()} {FILTER_CATEGORY_LABELS[category].toLowerCase()} opportunities yet.</p>
                  <Button variant="outline" size="sm" className="mt-4" onClick={() => setCategory("all")}>
                    Show all opportunities
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

/**
 * Shown while selecting (the toolbar's "Select" button): tick all on the page, then one action for
 * the selection: move to a stage, add to a list, or archive (restore on the Closed tab). Sticks to
 * the top while scrolling.
 */
function BulkBar({
  ids,
  allOnPage,
  onToggleAll,
  archived,
  onDone,
}: {
  ids: string[];
  allOnPage: boolean;
  onToggleAll: () => void;
  archived: boolean;
  onDone: () => void;
}) {
  const { data: stages } = usePipeline();
  const { data: lists } = useLists();
  const bulk = useBulkOpportunities();
  const run = (action: Omit<BulkOpportunitiesValues, "ids">, done: (changed: number) => string) =>
    bulk.mutate(
      { ids, ...action },
      {
        onSuccess: ({ changed }) => {
          toast.success(done(changed));
          onDone();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  const plural = (n: number) => `${n} ${n === 1 ? "opportunity" : "opportunities"}`;
  const count = ids.length;

  return (
    <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2 text-sm shadow-[0_8px_24px_-12px_rgba(27,36,51,0.25)]">
      <button
        type="button"
        role="checkbox"
        aria-checked={allOnPage ? true : count > 0 ? "mixed" : false}
        onClick={onToggleAll}
        className="inline-flex items-center gap-2 rounded-md px-1 py-0.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <TickBox checked={allOnPage} partly={count > 0} />
        {count > 0 ? <span className="font-medium">{count} selected</span> : <span className="text-muted-foreground">Select all on this page</span>}
      </button>
      {count === 0 && <span className="text-xs text-muted-foreground">or click the cards you want</span>}
      {count > 0 && (
        <>
          <Select
            value=""
            disabled={bulk.isPending}
            onValueChange={(stageId) => {
              const stage = stages?.find((s) => s.id === stageId);
              run({ stageId }, (n) => `Moved ${plural(n)} to ${stage?.name ?? "the stage"}.`);
            }}
          >
            <SelectTrigger aria-label="Move selected to a stage" className="h-8! w-40">
              <SelectValue placeholder="Move to stage…" />
            </SelectTrigger>
            <SelectContent>
              {stages?.map((stage) => (
                <SelectItem key={stage.id} value={stage.id}>
                  {stage.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value=""
            disabled={bulk.isPending || !lists?.length}
            onValueChange={(listId) => {
              const list = lists?.find((l) => l.id === listId);
              run({ listId }, (n) => (n === 0 ? `Already in ${list?.name ?? "the list"}.` : `Added ${plural(n)} to ${list?.name ?? "the list"}.`));
            }}
          >
            <SelectTrigger aria-label="Add selected to a list" className="h-8! w-40">
              <SelectValue placeholder={lists?.length ? "Add to list…" : "No lists yet"} />
            </SelectTrigger>
            <SelectContent>
              {lists?.map((list) => (
                <SelectItem key={list.id} value={list.id}>
                  {list.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={bulk.isPending}
            onClick={() => run({ archived: !archived }, (n) => `${archived ? "Restored" : "Archived"} ${plural(n)}.`)}
          >
            {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
            {archived ? "Restore" : "Archive"}
          </Button>
        </>
      )}
      <Button variant="ghost" size="sm" className="ml-auto h-8" onClick={onDone}>
        <XIcon />
        Done
      </Button>
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
        Opportunities are found automatically for what you sell: hiring signals, buying requests and more, each scored
        against your services and ICP and re-scored whenever anything changes.
      </p>
      <Button asChild className="mt-5">
        <Link href="/services">Set up your services</Link>
      </Button>
    </section>
  );
}
