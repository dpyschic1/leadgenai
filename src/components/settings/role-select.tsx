"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ASSIGNABLE_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type AssignableRole } from "@/lib/domain/members";
import { cn } from "@/lib/utils";

/** Picks a role someone can be given, explaining what each role can do. */
export function RoleSelect({
  id,
  value,
  onChange,
  invalid,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: AssignableRole;
  onChange: (role: AssignableRole) => void;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as AssignableRole)} disabled={disabled}>
      <SelectTrigger id={id} aria-invalid={invalid} aria-label={ariaLabel} className={cn("h-10! w-full", className)}>
        <SelectValue>{ROLE_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent className="max-w-80">
        {ASSIGNABLE_ROLES.map((role) => (
          <SelectItem key={role} value={role} className="py-2">
            <div>
              <p className="font-medium">{ROLE_LABELS[role]}</p>
              <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
