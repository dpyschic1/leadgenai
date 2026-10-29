import { WEIGHT_TONES } from "@/components/scoring/score-weights-editor";
import type { OpportunityFactor } from "@/lib/api/types";
import { SCORE_FACTORS, type ScoreFactor } from "@/lib/validation/scoring";

/**
 * Every score decomposed into its factors (PRD: "scores are explainable from stored factors"):
 * each factor's own score, its weight, the points it contributes, and why.
 */
export function ScoreBreakdown({ factors, total }: { factors: Record<ScoreFactor, OpportunityFactor>; total: number }) {
  return (
    <div className="space-y-5">
      {/* Contribution of each factor to the total, as one stacked bar. */}
      <div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`Score ${total} out of 100 by factor`}>
          {SCORE_FACTORS.map(({ key }) => (
            <span key={key} style={{ width: `${factors[key].contribution}%`, background: WEIGHT_TONES[key] }} />
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Each factor&apos;s score times its weight adds up to the total of {total}.</p>
      </div>

      <ul className="divide-y rounded-xl border">
        {SCORE_FACTORS.map(({ key, label }) => {
          const factor = factors[key];
          return (
            <li key={key} className="space-y-2 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span className="size-2.5 rounded-sm" style={{ background: WEIGHT_TONES[key] }} aria-hidden="true" />
                  {label}
                </p>
                <p className="text-sm tabular-nums">
                  <span className="font-semibold">{factor.score}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    × {factor.weight}% = {factor.contribution} pts
                  </span>
                </p>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full" style={{ width: `${factor.score}%`, background: WEIGHT_TONES[key] }} />
              </div>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {factor.reasons.map((reason) => (
                  <li key={reason} className="flex gap-2">
                    <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                    <span className={reason.startsWith("-") ? "text-red-700" : undefined}>{reason}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
