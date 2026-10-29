"use client";

import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCompanySignals } from "@/hooks/use-signals";
import type { CompanyPerson, Signal } from "@/lib/api/types";
import { EmptySignals, SignalTimeline, SignalTimelineSkeleton } from "./signal-timeline";

/** The company page's signals panel: newest event first. */
export function CompanySignals({
  companyId,
  people,
  canEdit,
  onRecord,
  onEdit,
}: {
  companyId: string;
  people: CompanyPerson[];
  canEdit: boolean;
  onRecord: () => void;
  onEdit: (signal: Signal) => void;
}) {
  const { data: signals } = useCompanySignals(companyId);

  return (
    <section aria-labelledby="signals-heading" className="rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 id="signals-heading" className="font-semibold">
            Signals
          </h2>
          <p className="text-sm text-muted-foreground">
            {!signals
              ? "Loading…"
              : signals.length === 0
                ? "Why this company might buy, with the evidence"
                : `${signals.length} ${signals.length === 1 ? "signal" : "signals"}, newest first`}
          </p>
        </div>
        {canEdit && signals && signals.length > 0 && (
          <Button variant="outline" onClick={onRecord}>
            <SparklesIcon />
            Record signal
          </Button>
        )}
      </div>
      {!signals ? (
        <SignalTimelineSkeleton />
      ) : signals.length > 0 ? (
        <SignalTimeline signals={signals} people={people} canEdit={canEdit} onEdit={onEdit} />
      ) : (
        <EmptySignals canEdit={canEdit} onRecord={onRecord} />
      )}
    </section>
  );
}
