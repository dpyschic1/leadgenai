"use client";

import Link from "next/link";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompanies } from "@/hooks/use-companies";
import { useServices } from "@/hooks/use-services";
import { cn } from "@/lib/utils";

/**
 * The path from an empty workspace to a first scored opportunity. A step gets an `href` once its
 * feature ships; steps complete in order, so progress is the count of finished steps.
 */
const STEPS: { title: string; description: string; href?: string }[] = [
  {
    title: "Describe what you sell",
    description: "Add your services and who you sell to. Every score is measured against this.",
    href: "/services",
  },
  {
    title: "Add a company you're watching",
    description: "Enter the company and the people you would talk to there.",
    href: "/companies",
  },
  {
    title: "Record a signal",
    description: "Paste a job post, request or news item. AI pulls out the problem, intent and urgency.",
  },
  {
    title: "Review your first opportunity",
    description: "See its score, the evidence behind it and a suggested next step.",
  },
];

export function SetupSteps() {
  const services = useServices();
  const companies = useCompanies();
  const isPending = services.isPending || companies.isPending;
  // Steps complete in order, so progress is the run of finished steps from the start.
  const finished = [Boolean(services.data?.length), Boolean(companies.data?.length)];
  const firstUnfinished = finished.indexOf(false);
  const completed = firstUnfinished === -1 ? finished.length : firstUnfinished;

  return (
    <section aria-labelledby="setup-heading" className="rounded-xl border bg-card">
      <div className="flex items-baseline justify-between border-b px-5 py-4">
        <h2 id="setup-heading" className="font-semibold">
          Get set up
        </h2>
        {isPending ? (
          <Skeleton className="h-4 w-20" />
        ) : (
          <p className="text-sm tabular-nums text-muted-foreground">
            {completed} of {STEPS.length} done
          </p>
        )}
      </div>
      <ol className="divide-y">
        {STEPS.map((step, index) => {
          const isDone = !isPending && index < completed;
          const isCurrent = !isPending && index === completed;
          const body = (
            <>
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums",
                  isCurrent && "border-primary bg-primary text-primary-foreground",
                  isDone && "border-primary/30 bg-signal-tint text-primary",
                  !isCurrent && !isDone && "text-muted-foreground",
                )}
              >
                {isDone ? <CheckIcon className="size-3.5" /> : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    !isCurrent && "text-muted-foreground",
                    isDone && "line-through decoration-muted-foreground/50",
                  )}
                >
                  {step.title}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">{step.description}</p>
              </div>
              {step.href && <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />}
            </>
          );
          return (
            <li key={step.title}>
              {step.href ? (
                <Link href={step.href} className="flex gap-4 px-5 py-4 transition-colors hover:bg-accent/60">
                  {body}
                </Link>
              ) : (
                <div className="flex gap-4 px-5 py-4">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
