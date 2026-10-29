import type { EvidenceLabel, IntentLevel, UrgencyLevel } from "@/lib/domain/signals";
import { EVIDENCE_LABEL_NAMES, INTENT_LABELS, URGENCY_LABELS } from "@/lib/domain/signals";
import { cn } from "@/lib/utils";

/** Teal intensity rises with intent; amber/grey for weaker levels. Shared with the timeline marker. */
export const INTENT_TONE: Record<IntentLevel, string> = {
  explicit: "bg-[var(--signal-deep)] text-white border-transparent",
  high: "bg-primary text-primary-foreground border-transparent",
  medium: "bg-amber-50 text-amber-800 border-amber-200",
  low: "bg-secondary text-muted-foreground border-transparent",
  unknown: "bg-background text-muted-foreground border-border",
};

const URGENCY_TONE: Record<UrgencyLevel, string> = {
  high: "bg-red-50 text-red-700 border-red-200",
  medium: "bg-amber-50 text-amber-800 border-amber-200",
  low: "bg-secondary text-muted-foreground border-transparent",
  unknown: "bg-background text-muted-foreground border-border",
};

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", className)}>
      {children}
    </span>
  );
}

export function IntentBadge({ level }: { level: IntentLevel }) {
  return <Pill className={INTENT_TONE[level]}>{INTENT_LABELS[level]} intent</Pill>;
}

export function UrgencyBadge({ level }: { level: UrgencyLevel }) {
  return <Pill className={URGENCY_TONE[level]}>{URGENCY_LABELS[level]} urgency</Pill>;
}

/** Solid dot = seen in a source; dashed ring = interpretation. Same marks as the sign-in preview. */
export function EvidenceMark({ label, className }: { label: EvidenceLabel; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        label === "observed" || label === "derived"
          ? "bg-primary"
          : "border-[1.5px] border-dashed border-primary bg-background",
        className,
      )}
    />
  );
}

export function EvidenceTag({ label }: { label: EvidenceLabel }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <EvidenceMark label={label} />
      {EVIDENCE_LABEL_NAMES[label]}
    </span>
  );
}
