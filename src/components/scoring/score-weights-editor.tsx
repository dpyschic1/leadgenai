"use client";

import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { SCORE_FACTORS, totalWeight, type ScoreFactor, type ScoreWeights } from "@/lib/validation/scoring";

/** Shades of the signal colour, strongest for the first (most important by default) factor. */
export const WEIGHT_TONES: Record<ScoreFactor, string> = {
  intent: "var(--signal)",
  icpFit: "color-mix(in oklab, var(--signal) 70%, white)",
  recency: "color-mix(in oklab, var(--signal) 48%, white)",
  identity: "color-mix(in oklab, var(--signal) 32%, white)",
  serviceFit: "color-mix(in oklab, var(--signal) 20%, white)",
};

/** Edits the five score weights; the stacked bar and total show the balance as you go. */
export function ScoreWeightsEditor({
  value,
  onChange,
  disabled,
}: {
  value: ScoreWeights;
  onChange: (value: ScoreWeights) => void;
  disabled?: boolean;
}) {
  const total = totalWeight(value);
  const balanced = total === 100;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label="Weight balance">
          {SCORE_FACTORS.map(({ key }) => (
            <span
              key={key}
              className="transition-[width] duration-200"
              style={{ width: `${(value[key] / Math.max(total, 100)) * 100}%`, background: WEIGHT_TONES[key] }}
            />
          ))}
        </div>
        <p
          role="status"
          className={cn("mt-2 text-sm tabular-nums", balanced ? "text-muted-foreground" : "font-medium text-destructive")}
        >
          {balanced
            ? "Total 100%."
            : total > 100
              ? `Total ${total}%. Remove ${total - 100}% to reach 100%.`
              : `Total ${total}%. Add ${100 - total}% to reach 100%.`}
        </p>
      </div>

      <ul className="divide-y rounded-xl border">
        {SCORE_FACTORS.map(({ key, label, hint }) => {
          const sliderId = `weight-${key}`;
          return (
            <li key={key} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center sm:gap-6">
              <div className="flex gap-3">
                <span className="mt-1.5 size-2.5 shrink-0 rounded-sm" style={{ background: WEIGHT_TONES[key] }} />
                <div>
                  <p id={`${sliderId}-label`} className="text-sm font-medium">
                    {label}
                  </p>
                  <p className="text-sm text-muted-foreground">{hint}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Slider
                  disabled={disabled}
                  min={0}
                  max={100}
                  step={5}
                  value={[value[key]]}
                  onValueChange={([next]) => onChange({ ...value, [key]: next })}
                  aria-labelledby={`${sliderId}-label`}
                />
                <span className="w-10 text-right text-sm font-medium tabular-nums">{value[key]}%</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
