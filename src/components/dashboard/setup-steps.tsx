import { cn } from "@/lib/utils";

/** The path from an empty workspace to a first scored opportunity. Steps become links as features ship. */
const STEPS = [
  {
    title: "Describe what you sell",
    description: "Add your services and who you sell to. Every score is measured against this.",
  },
  {
    title: "Add a company you're watching",
    description: "Enter the company and the people you would talk to there.",
  },
  {
    title: "Record a signal",
    description: "Paste a job post, request or news item. AI pulls out the problem, intent and urgency.",
  },
  {
    title: "Review your first opportunity",
    description: "See its score, the evidence behind it and a suggested next step.",
  },
] as const;

export function SetupSteps({ currentStep = 0 }: { currentStep?: number }) {
  return (
    <section aria-labelledby="setup-heading" className="rounded-xl border bg-card">
      <div className="flex items-baseline justify-between border-b px-5 py-4">
        <h2 id="setup-heading" className="font-semibold">
          Get set up
        </h2>
        <p className="text-sm tabular-nums text-muted-foreground">
          {currentStep} of {STEPS.length} done
        </p>
      </div>
      <ol className="divide-y">
        {STEPS.map((step, index) => {
          const isCurrent = index === currentStep;
          return (
            <li key={step.title} className="flex gap-4 px-5 py-4">
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums",
                  isCurrent ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
                )}
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className={cn("text-sm font-medium", !isCurrent && "text-muted-foreground")}>{step.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{step.description}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
