import { cn } from "@/lib/utils";

/**
 * Static example of an opportunity record (PRD Appendix A), shown beside the auth forms so
 * the first screen explains the product: a scored opportunity and the evidence behind it.
 */

type Evidence = "observed" | "inferred";

const SCORES = [
  { label: "Intent", value: 94 },
  { label: "ICP fit", value: 91 },
  { label: "Identity", value: 98 },
  { label: "Service fit", value: 93 },
] as const;

const SIGNALS: { when: string; text: string; evidence: Evidence }[] = [
  { when: "2 days ago", text: "Posted a request for a website redesign", evidence: "observed" },
  { when: "3 weeks ago", text: "Opened a third office, in Leeds", evidence: "observed" },
  { when: "5 weeks ago", text: "Started hiring a marketing manager", evidence: "observed" },
  { when: "Analysis", text: "Current site can't take bookings per location", evidence: "inferred" },
];

function EvidenceMark({ kind }: { kind: Evidence }) {
  return (
    <span
      className={cn(
        "relative z-10 mt-1 size-2.5 shrink-0 rounded-full",
        kind === "observed" ? "bg-primary" : "border-[1.5px] border-dashed border-primary bg-white",
      )}
    />
  );
}

/** Notification pinned to the card's corner: the moment a new signal lands. */
function SignalToast() {
  return (
    <div className="absolute -right-14 -bottom-9 z-10 flex items-center gap-3 rounded-lg border bg-card py-2.5 pr-4 pl-3 text-card-foreground shadow-[0_12px_28px_-10px_rgba(4,40,31,0.5)]">
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
      </span>
      <div className="text-xs leading-tight">
        <p className="font-medium">New signal</p>
        <p className="text-muted-foreground">Redesign request, 2 days ago</p>
      </div>
    </div>
  );
}

/** The example card, labelled for screen readers since the caption is visual context only. */
export function OpportunityPreview() {
  return (
    <figure className="relative w-full max-w-md" aria-label="Example opportunity">
      <SignalToast />
      <div className="rounded-xl border bg-card text-card-foreground shadow-[0_2px_4px_rgba(4,40,31,0.12),0_28px_56px_-18px_rgba(4,40,31,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b p-5">
          <div className="min-w-0">
            <span className="inline-flex rounded-full bg-signal-tint px-2 py-0.5 text-xs font-medium text-[var(--signal-deep)]">
              Website redesign
            </span>
            <p className="mt-2 text-lg font-semibold">ABC Accounting Ltd</p>
            <p className="text-sm text-muted-foreground">Sarah Williams, Managing Director</p>
          </div>
          <div className="text-right">
            <p className="text-4xl leading-none font-semibold tabular-nums text-primary">92</p>
            <p className="mt-1 text-xs text-muted-foreground">Opportunity score</p>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-b p-5">
          {SCORES.map((score, index) => (
            <div key={score.label}>
              <div className="flex items-baseline justify-between text-xs">
                <dt className="text-muted-foreground">{score.label}</dt>
                <dd className="font-medium tabular-nums">{score.value}</dd>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="score-bar h-full rounded-full bg-primary"
                  style={{ width: `${score.value}%`, animationDelay: `${index * 90}ms` }}
                />
              </div>
            </div>
          ))}
        </dl>

        <div className="p-5">
          <p className="text-sm font-medium">Why now</p>
          <ol className="relative mt-3 space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[4.5px] before:w-px before:bg-border">
            {SIGNALS.map((signal) => (
              <li key={signal.text} className="flex gap-3">
                <EvidenceMark kind={signal.evidence} />
                <div className="min-w-0 text-sm">
                  <p className={cn(signal.evidence === "inferred" && "text-muted-foreground italic")}>
                    {signal.text}
                  </p>
                  <p className="text-xs text-muted-foreground">{signal.when}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex gap-4 border-t pt-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-primary" /> Observed in a source
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full border-[1.5px] border-dashed border-primary" /> AI inference
            </span>
          </div>
        </div>
      </div>
    </figure>
  );
}
