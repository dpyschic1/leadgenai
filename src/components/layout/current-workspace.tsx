"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { sentenceCase } from "@/lib/format";

/** The workspace the session is signed into. Becomes a switcher once users have several. */
export function CurrentWorkspace() {
  const { data: me } = useCurrentUser();

  if (!me) {
    return (
      <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5" aria-label="Loading workspace">
        <Skeleton className="size-8 rounded-md" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-signal-tint text-sm font-semibold text-[var(--signal-deep)]">
        {me.workspace.name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{me.workspace.name}</p>
        <p className="text-xs text-muted-foreground">{sentenceCase(`${me.workspace.plan} plan`)}</p>
      </div>
    </div>
  );
}
