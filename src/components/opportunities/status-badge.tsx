import type { StageRef } from "@/lib/domain/pipeline";
import { cn } from "@/lib/utils";

const TONE = {
  intake: "bg-signal-tint text-[var(--signal-deep)] border-primary/20",
  open: "bg-indigo-50 text-indigo-800 border-indigo-200",
  won: "bg-emerald-50 text-emerald-800 border-emerald-200",
  lost: "bg-secondary text-muted-foreground border-border",
  archived: "bg-secondary text-muted-foreground border-border",
} as const;

/**
 * A stage as a pill. Won and Lost are told apart by kind, so they look right however the workspace names
 * them. `intake` marks the first open stage, where new discoveries land.
 */
export function StatusBadge({ stage, archived = false, intake = false, className }: { stage: StageRef; archived?: boolean; intake?: boolean; className?: string }) {
  const tone = archived ? TONE.archived : stage.kind === "open" ? (intake ? TONE.intake : TONE.open) : TONE[stage.kind];
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium", tone, className)}>
      {archived ? "Archived" : stage.name}
    </span>
  );
}
