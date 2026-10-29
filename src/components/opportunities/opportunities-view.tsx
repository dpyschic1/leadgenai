"use client";

import { useState } from "react";
import Link from "next/link";
import { BriefcaseBusinessIcon, CalendarIcon, RadioTowerIcon, SearchIcon, TargetIcon, UserRoundIcon } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { UrgencyBadge } from "@/components/signals/signal-badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useOpportunities } from "@/hooks/use-opportunities";
import { useLookupNames } from "@/hooks/use-reference-data";
import type { OpportunitySummary } from "@/lib/api/types";
import type { StatusGroup } from "@/lib/domain/opportunities";
import { cn } from "@/lib/utils";
import { ScoreRing } from "./score-ring";
import { StatusBadge } from "./status-badge";

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

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

export function OpportunitiesView() {
  const [group, setGroup] = useState<StatusGroup>("open");
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim());
  const { data, isPending, isFetching } = useOpportunities(group, query);

  const hasAny = data && Object.values(data.counts).some((count) => count > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Opportunities"
        description="Companies showing a reason to buy what you sell, ranked by priority. The score ranks who to look at first; it doesn't predict a sale."
      />

      {data && !hasAny && !query ? (
        <EmptyOpportunities />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div role="tablist" aria-label="Status" className="inline-flex rounded-lg border bg-card p-1">
              {TABS.map((tab) => {
                const selected = tab.group === group;
                return (
                  <button
                    key={tab.group}
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setGroup(tab.group)}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
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
            <div className="relative w-full sm:max-w-xs">
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
          </div>

          {isPending && !data ? (
            <FeedSkeleton />
          ) : data && data.items.length > 0 ? (
            <ul className={cn("space-y-3 transition-opacity", isFetching && "opacity-60")} aria-label="Opportunities">
              {data.items.map((opportunity, index) => (
                <OpportunityCard key={opportunity.id} opportunity={opportunity} rank={group === "open" ? index + 1 : null} />
              ))}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed bg-card px-6 py-12 text-center text-sm text-muted-foreground">
              {query ? `No opportunities match “${query}”.` : EMPTY_TAB[group]}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function OpportunityCard({ opportunity, rank }: { opportunity: OpportunitySummary; rank: number | null }) {
  const names = useLookupNames();
  const latest = opportunity.latestSignalOn && dateFormat.format(new Date(`${opportunity.latestSignalOn}T12:00:00`));

  return (
    <li>
      <Link
        href={`/opportunities/${opportunity.id}`}
        className="group flex gap-4 rounded-xl border bg-card p-4 transition-shadow hover:shadow-[0_8px_24px_-12px_rgba(27,36,51,0.18)] sm:gap-5 sm:p-5"
      >
        <div className="flex flex-col items-center gap-1">
          <ScoreRing score={opportunity.score} />
          {rank !== null && <span className="text-xs tabular-nums text-muted-foreground">#{rank}</span>}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <p className="truncate font-semibold group-hover:text-primary">{opportunity.company.name}</p>
              <p className="text-sm text-muted-foreground">{names.opportunityType(opportunity.type)}</p>
            </div>
            <StatusBadge status={opportunity.status} />
          </div>

          {opportunity.problem && <p className="mt-2 line-clamp-2 text-sm leading-relaxed">{opportunity.problem}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            {opportunity.service && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/15 bg-signal-tint px-2 py-0.5 font-medium text-[var(--signal-deep)]">
                <BriefcaseBusinessIcon className="size-3" />
                {opportunity.service.name}
              </span>
            )}
            {opportunity.urgency !== "unknown" && <UrgencyBadge level={opportunity.urgency} />}
            {opportunity.contact && (
              <span className="inline-flex items-center gap-1">
                <UserRoundIcon className="size-3.5" />
                {opportunity.contact.name}
                {opportunity.contact.title && `, ${opportunity.contact.title}`}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <RadioTowerIcon className="size-3.5" />
              {opportunity.signalCount} {opportunity.signalCount === 1 ? "signal" : "signals"}
            </span>
            {latest && (
              <span className="inline-flex items-center gap-1">
                <CalendarIcon className="size-3.5" />
                Latest {latest}
              </span>
            )}
          </div>
        </div>
      </Link>
    </li>
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
