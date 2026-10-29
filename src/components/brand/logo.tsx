import { cn } from "@/lib/utils";

/** Brand mark: a source point with signal arcs radiating from it. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn("size-6", className)}>
      <rect width="24" height="24" rx="6" fill="var(--signal)" />
      <circle cx="7.5" cy="16.5" r="1.9" fill="white" />
      <path d="M7.5 11.25a5.25 5.25 0 0 1 5.25 5.25" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7.5 6.75a9.75 9.75 0 0 1 9.75 9.75" stroke="white" strokeWidth="1.8" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight", className)}>
      <LogoMark />
      LeadGenAI
    </span>
  );
}
