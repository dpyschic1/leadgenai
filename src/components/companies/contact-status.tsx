"use client";

import type { ReactNode } from "react";
import { BadgeCheckIcon, BanIcon, CircleHelpIcon, CircleIcon, ShieldCheckIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ContactCheck } from "@/lib/api/types";
import {
  IDENTITY_DESCRIPTIONS,
  IDENTITY_LABELS,
  isSuggestable,
  VERIFICATION_LABELS,
  type ContactVerification,
  type IdentityLevel,
} from "@/lib/domain/people";
import { cn } from "@/lib/utils";

/**
 * How sure we are about a person, and whether their email/phone works (PRD §22: identity
 * confidence and contact verification state are displayed). Explanations open on hover or focus.
 */

const IDENTITY_STYLE: Record<IdentityLevel, { icon: LucideIcon; className: string }> = {
  confirmed: { icon: ShieldCheckIcon, className: "border-primary/20 bg-signal-tint text-[var(--signal-deep)]" },
  likely: { icon: CircleIcon, className: "border-border bg-secondary text-muted-foreground" },
  unsure: { icon: CircleHelpIcon, className: "border-amber-300/60 bg-amber-50 text-amber-800" },
  do_not_contact: { icon: BanIcon, className: "border-destructive/20 bg-destructive/5 text-destructive" },
};

/** A compact icon next to a person's name; the level and what it means are in the tooltip. */
export function IdentityBadge({ level, confidence }: { level: IdentityLevel; confidence: number | null }) {
  const { icon: Icon, className } = IDENTITY_STYLE[level];
  return (
    <Explained
      label={`Identity: ${IDENTITY_LABELS[level]}`}
      explanation={
        <>
          <span className="font-medium">{IDENTITY_LABELS[level]}</span>
          {confidence !== null && <span className="text-muted-foreground">Identity confidence {confidence}%</span>}
          <span>{IDENTITY_DESCRIPTIONS[level]}</span>
          {!isSuggestable(level) && level !== "do_not_contact" && (
            <span className="text-muted-foreground">Not suggested as an opportunity&apos;s contact.</span>
          )}
        </>
      }
    >
      <span className={cn("grid size-5 place-items-center rounded-full border", className)}>
        <Icon className="size-3" />
      </span>
    </Explained>
  );
}

const VERIFICATION_STYLE: Record<ContactVerification, { icon: LucideIcon; className: string }> = {
  valid: { icon: BadgeCheckIcon, className: "text-primary" },
  invalid: { icon: BanIcon, className: "text-destructive" },
  accept_all: { icon: TriangleAlertIcon, className: "text-amber-700" },
  webmail: { icon: TriangleAlertIcon, className: "text-amber-700" },
  disposable: { icon: BanIcon, className: "text-destructive" },
  unknown: { icon: CircleHelpIcon, className: "text-muted-foreground" },
};

const checkedFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** One line for an email/phone's state, e.g. "Verified · 2 Nov 2026" or "Not checked". */
export function verificationText(check: ContactCheck): string {
  const label = VERIFICATION_LABELS[check.state];
  return check.checkedAt ? `${label} · ${checkedFormat.format(new Date(check.checkedAt))}` : label;
}

/** A small icon for an email/phone's state, explained on hover. `inline` also writes the label. */
export function VerificationMark({ kind, check, inline }: { kind: "Email" | "Phone"; check: ContactCheck; inline?: boolean }) {
  const { icon: Icon, className } = VERIFICATION_STYLE[check.state];
  const text = `${kind}: ${verificationText(check)}`;
  return (
    <Explained label={text} explanation={<span>{text}</span>}>
      <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", className)}>
        <Icon className="size-3.5" />
        {inline && VERIFICATION_LABELS[check.state]}
      </span>
    </Explained>
  );
}

function Explained({ label, explanation, children }: { label: string; explanation: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so keyboard users can read the explanation too. */}
        <span tabIndex={0} aria-label={label} className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex-col items-start gap-0.5">
        {explanation}
      </TooltipContent>
    </Tooltip>
  );
}
