import { RadarIcon } from "lucide-react";

export function EmptyOpportunities() {
  return (
    <section
      aria-labelledby="new-opportunities-heading"
      className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-12 text-center"
    >
      <span className="grid size-11 place-items-center rounded-full bg-signal-tint text-primary">
        <RadarIcon className="size-5" />
      </span>
      <h2 id="new-opportunities-heading" className="mt-4 font-semibold">
        No opportunities yet
      </h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        New, high-intent and workforce-gap opportunities will appear here as soon as you record your
        first signals.
      </p>
    </section>
  );
}
