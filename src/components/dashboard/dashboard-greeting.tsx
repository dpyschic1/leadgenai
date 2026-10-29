"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** The brand's signal arcs, drawn large and faint as the banner's backdrop. */
function SignalArcs() {
  return (
    <svg
      viewBox="0 0 320 200"
      fill="none"
      aria-hidden="true"
      className="pointer-events-none absolute right-0 bottom-0 h-full w-auto max-w-[55%] text-primary"
    >
      {[60, 110, 160, 210, 260].map((radius, index) => (
        <path
          key={radius}
          d={`M ${320 - radius} 200 A ${radius} ${radius} 0 0 1 320 ${200 - radius}`}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity={0.32 - index * 0.055}
        />
      ))}
      <circle cx="320" cy="200" r="22" fill="currentColor" opacity="0.12" />
    </svg>
  );
}

export function DashboardGreeting() {
  const { data: me } = useCurrentUser();

  return (
    <section className="relative overflow-hidden rounded-2xl border bg-card px-6 py-7 sm:px-8 sm:py-9">
      <SignalArcs />
      {me ? (
        <div className="relative max-w-xl">
          <h1 className="text-3xl font-semibold sm:text-[2.125rem] sm:leading-tight">
            {greeting(new Date().getHours())}
            {me.user.name ? `, ${me.user.name.split(" ")[0]}` : ""}
          </h1>
          <p className="mt-2 text-muted-foreground">
            Here&apos;s what changed for {me.workspace.name} since your last visit.
          </p>
        </div>
      ) : (
        <div className="relative max-w-xl space-y-3" aria-label="Loading">
          <Skeleton className="h-9 w-80 max-w-full" />
          <Skeleton className="h-5 w-96 max-w-full" />
        </div>
      )}
    </section>
  );
}
