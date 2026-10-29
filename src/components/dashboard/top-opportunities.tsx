"use client";

import Link from "next/link";
import { ArrowRightIcon, RadarIcon } from "lucide-react";
import { ScoreRing } from "@/components/opportunities/score-ring";
import { StatusBadge } from "@/components/opportunities/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpportunities } from "@/hooks/use-opportunities";
import { useLookupNames } from "@/hooks/use-reference-data";

const SHOWN = 5;

/** The highest-priority open opportunities, so the dashboard answers "who first?". */
export function TopOpportunities() {
  const { data } = useOpportunities("open");
  const names = useLookupNames();
  const top = data?.items.slice(0, SHOWN);

  if (data && data.items.length === 0) return <EmptyTopOpportunities />;

  return (
    <section aria-labelledby="top-heading" className="rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 id="top-heading" className="font-semibold">
            Top opportunities
          </h2>
          <p className="text-sm text-muted-foreground">Who to look at first, by priority score.</p>
        </div>
        <Link href="/opportunities" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline underline-offset-4">
          View all
          {data && ` ${data.counts.open}`}
          <ArrowRightIcon className="size-3.5" />
        </Link>
      </div>
      {!top ? (
        <div className="space-y-4 p-5" aria-label="Loading opportunities">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-4">
              <Skeleton className="size-11 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <ul className="divide-y">
          {top.map((opportunity) => (
            <li key={opportunity.id}>
              <Link href={`/opportunities/${opportunity.id}`} className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-accent/60">
                <ScoreRing score={opportunity.score} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {opportunity.company.name}
                    <span className="font-normal text-muted-foreground">, {names.opportunityType(opportunity.type)}</span>
                  </p>
                  {opportunity.problem && <p className="truncate text-sm text-muted-foreground">{opportunity.problem}</p>}
                </div>
                <StatusBadge status={opportunity.status} className="hidden sm:inline-flex" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyTopOpportunities() {
  return (
    <section className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-12 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-signal-tint text-primary">
        <RadarIcon className="size-5" />
      </span>
      <h2 className="mt-4 font-semibold">No opportunities yet</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        Record a signal on a company and it becomes a scored opportunity here, matched to your best-fitting service.
      </p>
    </section>
  );
}
