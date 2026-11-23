"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  BanknoteIcon,
  BriefcaseBusinessIcon,
  CalendarIcon,
  CheckIcon,
  FileTextIcon,
  MailIcon,
  MessageSquareIcon,
  MinusIcon,
  NewspaperIcon,
  PhoneIcon,
  RadioTowerIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { UrgencyBadge } from "@/components/signals/signal-badges";
import { useLookupNames } from "@/hooks/use-reference-data";
import type { OpportunitySummary } from "@/lib/api/types";
import { OSM_COPYRIGHT_URL } from "@/lib/domain/sources";
import { opportunityName } from "@/lib/opportunity-display";
import { cn } from "@/lib/utils";
import { CategoryBadge, EngineChips, VerificationBadge } from "./engine-parts";
import { FeedbackVotes } from "./feedback-votes";
import { LeadBadge, StatusBadge } from "./status-badge";

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** A rounded tick box (visual only; the button around it carries the state). `partly` shows a dash. */
export function TickBox({ checked, partly = false }: { checked: boolean; partly?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors",
        checked || partly ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40 bg-card",
      )}
    >
      {checked ? <CheckIcon className="size-3.5" strokeWidth={3} /> : partly && <MinusIcon className="size-3.5" strokeWidth={3} />}
    </span>
  );
}

/** Each kind of opportunity: what to call it and its icon. */
export const KIND: Record<OpportunitySummary["kind"], { label: string; icon: LucideIcon; tone: string }> = {
  hiring: { label: "Hiring", icon: UsersRoundIcon, tone: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300" },
  request: { label: "Asking for help", icon: MessageSquareIcon, tone: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300" },
  project: { label: "Freelance project", icon: FileTextIcon, tone: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" },
  funding: { label: "Recently funded", icon: BanknoteIcon, tone: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" },
  event: { label: "Company news", icon: NewspaperIcon, tone: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300" },
  problem: { label: "Problem found", icon: TriangleAlertIcon, tone: "bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300" },
  other: { label: "Signal", icon: RadioTowerIcon, tone: "bg-secondary text-muted-foreground" },
};

/** The kind of opportunity as an icon tile, in place of a score: what it is at a glance. */
export function KindTile({ kind, size = "md" }: { kind: OpportunitySummary["kind"]; size?: "md" | "lg" }) {
  const { label, icon: Icon, tone } = KIND[kind];
  return (
    <span title={label} className={cn("grid shrink-0 place-items-center rounded-xl", tone, size === "lg" ? "size-16" : "size-11")}>
      <Icon className={size === "lg" ? "size-7" : "size-5"} />
    </span>
  );
}

/**
 * One opportunity in a feed. The whole card opens it (a stretched link), so `action`, e.g. a
 * remove button, can sit on top without nesting interactive elements.
 */
export function OpportunityCard({
  opportunity,
  rank = null,
  action,
  selection,
}: {
  opportunity: OpportunitySummary;
  rank?: number | null;
  action?: ReactNode;
  /** Selecting for bulk actions: a click anywhere on the card ticks it instead of opening it. */
  selection?: { selected: boolean; onToggle: () => void };
}) {
  const names = useLookupNames();
  const latest = opportunity.latestSignalOn
    ? dateFormat.format(new Date(`${opportunity.latestSignalOn}T12:00:00`))
    : opportunity.engine?.discoveredAt
      ? dateFormat.format(new Date(opportunity.engine.discoveredAt))
      : null;
  const { phone: companyPhone, email: companyEmail } = opportunity.companyContact;

  return (
    <li
      className={cn(
        "group relative flex gap-4 rounded-xl border bg-card p-4 transition-[box-shadow,border-color,background-color] hover:shadow-[0_8px_24px_-12px_rgba(27,36,51,0.18)] has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-ring/50 has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/50 sm:gap-5 sm:p-5",
        selection?.selected && "border-primary/50 bg-signal-tint/40",
      )}
    >
      {/* While selecting, this covers the card's link: a click ticks rather than opens. */}
      {selection && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selection.selected}
          aria-label={`Select ${opportunityName(opportunity)}`}
          onClick={selection.onToggle}
          className="absolute inset-0 z-[5] cursor-pointer rounded-xl outline-none"
        />
      )}
      {/* What it is, not a number: the AI's score shows once it's a lead. */}
      <div className="flex flex-col items-center gap-1">
        <KindTile kind={opportunity.kind} />
        {rank !== null && <span className="text-xs tabular-nums text-muted-foreground">#{rank}</span>}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <Link
              href={`/opportunities/${opportunity.id}`}
              className="block truncate font-semibold outline-none group-hover:text-primary after:absolute after:inset-0 after:rounded-xl"
            >
              {opportunityName(opportunity)}
            </Link>
            {opportunity.engine ? (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <CategoryBadge category={opportunity.engine.category} />
                <VerificationBadge status={opportunity.engine.verification} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground/80">{KIND[opportunity.kind].label}</span>
                {opportunity.openRoles.total > 0 && ` · ${opportunity.openRoles.total} open ${opportunity.openRoles.total === 1 ? "role" : "roles"}`}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <LeadBadge lead={opportunity.lead} />
            <StatusBadge stage={opportunity.stage} archived={opportunity.archived} />
            {action && <div className="relative z-10">{action}</div>}
            {selection && (
              <span className="ml-1">
                <TickBox checked={selection.selected} />
              </span>
            )}
          </div>
        </div>

        {opportunity.problem && <p className="mt-2 line-clamp-2 text-sm leading-relaxed">{opportunity.problem}</p>}
        {/* What they're after: the roles they're hiring for and the kinds of work it points to. */}
        {(opportunity.openRoles.titles.length > 0 || opportunity.needs.length > 0) && (
          <div className="mt-2 space-y-1.5 text-sm">
            {opportunity.openRoles.titles.length > 0 && (
              <p className="line-clamp-1 text-muted-foreground">
                <span className="font-medium text-foreground">Roles: </span>
                {opportunity.openRoles.titles.join(" · ")}
                {opportunity.openRoles.total > opportunity.openRoles.titles.length && (
                  <span className="text-primary"> +{opportunity.openRoles.total - opportunity.openRoles.titles.length} more</span>
                )}
              </p>
            )}
            {opportunity.needs.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">Needs:</span>
                {opportunity.needs.slice(0, 4).map((slug) => (
                  <span key={slug} className="rounded-full border bg-secondary px-2 py-0.5 text-xs">
                    {names.category(slug)}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {/* The AI's (or team's) verdict, with the line from the evidence that shows the need. */}
        {opportunity.lead.reason && (
          <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Why: </span>
            {opportunity.lead.reason}
            {opportunity.lead.quote && <span className="italic"> “{opportunity.lead.quote}”</span>}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {opportunity.service && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/15 bg-signal-tint px-2 py-0.5 font-medium text-[var(--signal-deep)]">
              <BriefcaseBusinessIcon className="size-3" />
              {opportunity.service.name}
            </span>
          )}
          {opportunity.urgency !== "unknown" && <UrgencyBadge level={opportunity.urgency} />}
          {opportunity.contact && (
            <span className="inline-flex items-center gap-1">
              <UserRoundIcon className="size-3.5" />
              {opportunity.contact.name}
              {opportunity.contact.title && `, ${opportunity.contact.title}`}
            </span>
          )}
          {/* The company's own line: a way to reach them even before a person is known. Sits above the card's link. */}
          {(companyPhone || companyEmail) && (
            <a
              href={companyPhone ? `tel:${companyPhone.replace(/[^\d+]/g, "")}` : `mailto:${companyEmail}`}
              className="relative z-10 inline-flex items-center gap-1 hover:text-foreground hover:underline underline-offset-4"
            >
              {companyPhone ? <PhoneIcon className="size-3.5" /> : <MailIcon className="size-3.5" />}
              {companyPhone ?? companyEmail}
            </a>
          )}
          {/* ODbL: a contact from OpenStreetMap carries its credit wherever it is shown. */}
          {(companyPhone || companyEmail) && opportunity.companyContact.fromOpenStreetMap && (
            <a
              href={OSM_COPYRIGHT_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="Published on OpenStreetMap, not verified by us"
              className="relative z-10 -ml-2.5 hover:text-foreground hover:underline underline-offset-4"
            >
              © OpenStreetMap
            </a>
          )}
          {opportunity.engine ? (
            <EngineChips engine={opportunity.engine} />
          ) : (
            <span className="inline-flex items-center gap-1">
              <RadioTowerIcon className="size-3.5" />
              {opportunity.signalCount} {opportunity.signalCount === 1 ? "signal" : "signals"}
            </span>
          )}
          {latest && (
            <span className="inline-flex items-center gap-1">
              <CalendarIcon className="size-3.5" />
              {opportunity.engine ? "Found" : "Latest"} {latest}
            </span>
          )}
          <FeedbackVotes votes={opportunity.feedbackVotes} />
        </div>
      </div>
    </li>
  );
}
