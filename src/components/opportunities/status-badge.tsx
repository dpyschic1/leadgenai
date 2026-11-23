import { FlameIcon, Loader2Icon, SunIcon, XIcon } from "lucide-react";
import type { OpportunitySummary } from "@/lib/api/types";
import type { StageRef } from "@/lib/domain/pipeline";
import { cn } from "@/lib/utils";

const LEAD_BADGE = {
  hot: { label: "HOT", icon: FlameIcon, tone: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900" },
  warm: { label: "WARM", icon: SunIcon, tone: "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900" },
  not_fit: { label: "Not a fit", icon: XIcon, tone: "bg-secondary text-muted-foreground border-border" },
  checking: { label: "AI checking", icon: Loader2Icon, tone: "bg-secondary text-muted-foreground border-border" },
} as const;

/**
 * Whether an opportunity is a lead: HOT or WARM with the AI's fit (or the team's call), "Not a fit",
 * or "AI checking" while it waits to be read. Nothing for opportunities too weak to be checked.
 */
export function LeadBadge({ lead, className, showScore = true }: { lead: OpportunitySummary["lead"]; className?: string; showScore?: boolean }) {
  if (lead.status === "unchecked") return null;
  const { label, icon: Icon, tone } = LEAD_BADGE[lead.status];
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold tabular-nums", tone, className)}
      title={lead.reason ?? (lead.status === "checking" ? "The AI will read this opportunity's evidence soon" : undefined)}
    >
      <Icon className="size-3" />
      {label}
      {showScore && lead.score !== null && lead.status !== "not_fit" && ` ${lead.score}`}
    </span>
  );
}

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
