"use client";

import type { ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Whole-number input whose value is `number | null` (empty = null) rather than a string. */
export function NumberInput({
  value,
  onChange,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type"> & {
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <Input
      {...props}
      type="number"
      inputMode="numeric"
      min={1}
      className={cn("h-10", className)}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.valueAsNumber)}
    />
  );
}
