"use client";

import { cn } from "@/lib/utils";

/** Single choice among a few ordered options (e.g. intent level), shown as a button strip. */
export function SegmentedControl<T extends string>({
  id,
  options,
  value,
  onChange,
  label,
}: {
  id?: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div id={id} role="radiogroup" aria-label={label} className="inline-flex w-full rounded-lg border bg-canvas p-1">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex-1 rounded-md px-2.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              selected ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
