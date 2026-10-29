import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Initials tile standing in for a company logo. */
export function CompanyAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-lg border bg-canvas text-xs font-semibold text-foreground/80",
        className,
      )}
    >
      {initials(name) || "?"}
    </span>
  );
}
