import { STATUS_LABELS, type OpportunityStatus } from "@/lib/domain/opportunities";
import { cn } from "@/lib/utils";

const TONE: Record<OpportunityStatus, string> = {
  new: "bg-signal-tint text-[var(--signal-deep)] border-primary/20",
  qualified: "bg-sky-50 text-sky-800 border-sky-200",
  saved: "bg-secondary text-foreground border-border",
  contacted: "bg-indigo-50 text-indigo-800 border-indigo-200",
  replied: "bg-indigo-50 text-indigo-800 border-indigo-200",
  meeting: "bg-violet-50 text-violet-800 border-violet-200",
  proposal: "bg-violet-50 text-violet-800 border-violet-200",
  won: "bg-emerald-50 text-emerald-800 border-emerald-200",
  lost: "bg-secondary text-muted-foreground border-border",
  dismissed: "bg-secondary text-muted-foreground border-border",
};

export function StatusBadge({ status, className }: { status: OpportunityStatus; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium", TONE[status], className)}>
      {STATUS_LABELS[status]}
    </span>
  );
}
