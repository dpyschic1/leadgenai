"use client";

import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type Option = { value: string; label: string };

/** Multi-select shown as toggle chips. Best for short lists that people scan rather than search. */
export function ChipSelect({
  id,
  options,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id?: string;
  options: Option[];
  value: string[];
  onChange: (value: string[]) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const selected = new Set(value);
  const toggle = (option: string) =>
    onChange(selected.has(option) ? value.filter((v) => v !== option) : [...value, option]);

  return (
    <div
      id={id}
      role="group"
      aria-describedby={describedBy}
      className="flex flex-wrap gap-2"
    >
      {options.map((option) => {
        const isOn = selected.has(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isOn}
            onClick={() => toggle(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              isOn
                ? "border-primary bg-signal-tint font-medium text-[var(--signal-deep)]"
                : "bg-background text-foreground hover:border-foreground/25 hover:bg-accent",
              invalid && !isOn && "border-destructive/50",
            )}
          >
            {isOn && <CheckIcon className="size-3.5" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
