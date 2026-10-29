/** How the opportunity score is built (PRD §12), so users can trust the ranking. */
const WEIGHTS = [
  { label: "Intent", weight: 40, tone: "var(--signal)" },
  { label: "ICP fit", weight: 25, tone: "color-mix(in oklab, var(--signal) 70%, white)" },
  { label: "Recency", weight: 15, tone: "color-mix(in oklab, var(--signal) 48%, white)" },
  { label: "Identity", weight: 10, tone: "color-mix(in oklab, var(--signal) 32%, white)" },
  { label: "Service fit", weight: 10, tone: "color-mix(in oklab, var(--signal) 20%, white)" },
] as const;

export function ScoreExplainer() {
  return (
    <section aria-labelledby="score-heading" className="rounded-xl border bg-card p-5">
      <h2 id="score-heading" className="font-semibold">
        How opportunities are ranked
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A priority score from 0 to 100. It tells you who to look at first, not who will buy.
      </p>

      <div className="mt-5 flex h-2.5 overflow-hidden rounded-full" role="img" aria-label="Score weights">
        {WEIGHTS.map((item) => (
          <span key={item.label} style={{ width: `${item.weight}%`, background: item.tone }} />
        ))}
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        {WEIGHTS.map((item) => (
          <div key={item.label} className="flex items-center gap-2.5">
            <span className="size-2.5 rounded-sm" style={{ background: item.tone }} />
            <dt className="flex-1">{item.label}</dt>
            <dd className="tabular-nums text-muted-foreground">{item.weight}%</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
