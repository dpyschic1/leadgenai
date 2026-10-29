"use client";

import Link from "next/link";
import { WEIGHT_TONES } from "@/components/scoring/score-weights-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { useScoringProfile } from "@/hooks/use-scoring-profile";
import { SCORE_FACTORS } from "@/lib/validation/scoring";

/** How this workspace's opportunity score is built (PRD §12), so users can trust the ranking. */
export function ScoreExplainer() {
  const { data } = useScoringProfile();

  return (
    <section aria-labelledby="score-heading" className="rounded-xl border bg-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="score-heading" className="font-semibold">
          How opportunities are ranked
        </h2>
        <Link href="/settings" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Adjust
        </Link>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        A priority score from 0 to 100. It tells you who to look at first, not who will buy.
      </p>

      {data ? (
        <>
          <div className="mt-5 flex h-2.5 overflow-hidden rounded-full" role="img" aria-label="Score weights">
            {SCORE_FACTORS.map(({ key }) => (
              <span key={key} style={{ width: `${data.weights[key]}%`, background: WEIGHT_TONES[key] }} />
            ))}
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            {SCORE_FACTORS.map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2.5">
                <span className="size-2.5 rounded-sm" style={{ background: WEIGHT_TONES[key] }} />
                <dt className="flex-1">{label}</dt>
                <dd className="tabular-nums text-muted-foreground">{data.weights[key]}%</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <div className="mt-5 space-y-3" aria-label="Loading weights">
          <Skeleton className="h-2.5 w-full rounded-full" />
          {SCORE_FACTORS.map(({ key }) => (
            <Skeleton key={key} className="h-4 w-full" />
          ))}
        </div>
      )}
    </section>
  );
}
