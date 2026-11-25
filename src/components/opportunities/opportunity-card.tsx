"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  BanknoteIcon,
  CalendarIcon,
  CheckIcon,
  CircleCheckIcon,
  FileTextIcon,
  MailIcon,
  MessageSquareIcon,
  MinusIcon,
  NewspaperIcon,
  PhoneIcon,
  RadioTowerIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { UrgencyBadge } from "@/components/signals/signal-badges";
import { useLookupNames } from "@/hooks/use-reference-data";
import { useServices } from "@/hooks/use-services";
import type { OpportunitySummary } from "@/lib/api/types";
import { OSM_COPYRIGHT_URL } from "@/lib/domain/sources";
import { opportunityName } from "@/lib/opportunity-display";
import { cn } from "@/lib/utils";
import { EngineChips, VerificationBadge } from "./engine-parts";
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

/** Each kind of opportunity: what they're doing in plain words, and its icon. One accent for all: the theme's signal green. */
export const KIND: Record<OpportunitySummary["kind"], { label: string; icon: LucideIcon }> = {
  hiring: { label: "Hiring", icon: UsersRoundIcon },
  request: { label: "Asking for help", icon: MessageSquareIcon },
  project: { label: "Freelance project", icon: FileTextIcon },
  funding: { label: "Just raised funding", icon: BanknoteIcon },
  event: { label: "Company news", icon: NewspaperIcon },
  problem: { label: "Problem on their site", icon: TriangleAlertIcon },
  other: { label: "Signal", icon: RadioTowerIcon },
};

/** The buyer tag on a card. */
const STAGE_TAG: Record<OpportunitySummary["companyStage"], string> = { startup: "B2B", established: "Job opening", individual: "Individual" };

/** What they're doing, in plain words: "Hiring 6 roles", "Just raised funding". */
export function KindLabel({ opportunity, className }: { opportunity: Pick<OpportunitySummary, "kind" | "openRoles">; className?: string }) {
  const { label, icon: Icon } = KIND[opportunity.kind];
  const roles = opportunity.openRoles.total;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm text-muted-foreground", className)}>
      <Icon className="size-4 text-primary" />
      {opportunity.kind === "hiring" && roles > 0 ? `Hiring ${roles} ${roles === 1 ? "role" : "roles"}` : label}
    </span>
  );
}

/** The company's initials, as a quiet stand-in for a logo. */
function Monogram({ name }: { name: string }) {
  const initials = name
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
  return (
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full border bg-canvas text-xs font-semibold text-foreground/70">
      {initials || "?"}
    </span>
  );
}

/**
 * One opportunity in a feed: the company (largest), what they need in one line and the roles,
 * the service it matches, then contact and date. The whole card opens it (a stretched link), so
 * `action`, e.g. a remove button, can sit on top without nesting interactive elements.
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
  const { data: services } = useServices();
  // The categories the matched service covers, to show which of their needs you meet.
  const offered = new Set(services?.items.find((s) => s.id === opportunity.service?.id)?.categories ?? []);
  const latest = opportunity.latestSignalOn
    ? dateFormat.format(new Date(`${opportunity.latestSignalOn}T12:00:00`))
    : opportunity.engine?.discoveredAt
      ? dateFormat.format(new Date(opportunity.engine.discoveredAt))
      : null;
  const { phone: companyPhone, email: companyEmail } = opportunity.companyContact;
  const name = opportunityName(opportunity);
  const { lead } = opportunity;
  // What they need in one line: the AI's reading, else what happened, else the post's own title.
  const headline = lead.reason ?? opportunity.problem ?? opportunity.engine?.title ?? null;
  const roles = opportunity.openRoles;

  return (
    <li
      className={cn(
        "group relative rounded-2xl border bg-card px-5 pb-4 pt-5 transition-[border-color,box-shadow,background-color] hover:border-foreground/20 hover:shadow-[0_10px_30px_-18px_rgba(27,36,51,0.35)] has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-ring/50 has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/50 sm:px-6",
        selection?.selected && "border-primary/50 bg-signal-tint/40",
      )}
    >
      {/* While selecting, this covers the card's link: a click ticks rather than opens. */}
      {selection && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selection.selected}
          aria-label={`Select ${name}`}
          onClick={selection.onToggle}
          className="absolute inset-0 z-[5] cursor-pointer rounded-2xl outline-none"
        />
      )}

      {/* 1. Who: the company, what they're doing, and where it stands. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <Monogram name={name} />
          <div className="min-w-0">
            <Link
              href={`/opportunities/${opportunity.id}`}
              className="block truncate text-lg leading-snug font-semibold tracking-tight outline-none group-hover:text-primary after:absolute after:inset-0 after:rounded-2xl"
            >
              {name}
            </Link>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <KindLabel opportunity={opportunity} />
              {/* What kind of buyer, at a glance: a startup likely to buy from an agency, or a company posting job openings. */}
              <span
                className={cn(
                  "rounded-md border px-1.5 py-px text-xs",
                  opportunity.companyStage === "startup" ? "border-primary/30 bg-signal-tint text-[var(--signal-deep)]" : "text-muted-foreground",
                )}
              >
                {STAGE_TAG[opportunity.companyStage]}
              </span>
              {opportunity.engine && <VerificationBadge status={opportunity.engine.verification} />}
              {rank !== null && <span className="text-xs tabular-nums text-muted-foreground">#{rank}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <LeadBadge lead={lead} showScore={false} />
          <StatusBadge stage={opportunity.stage} archived={opportunity.archived} />
          {action && <div className="relative z-10">{action}</div>}
          {selection && (
            <span className="ml-1">
              <TickBox checked={selection.selected} />
            </span>
          )}
        </div>
      </div>

      {/* 2. What they need: one headline (the AI's reading when it has one, else what happened), the roles under it. */}
      {headline && (
        <p className="mt-3.5 line-clamp-2 max-w-[75ch] text-[15px] leading-relaxed text-pretty text-foreground/90">
          {lead.reason && <SparklesIcon className="mr-1.5 inline size-4 -translate-y-px text-primary" aria-label="AI's reading" />}
          {headline}
        </p>
      )}
      {roles.titles.length > 0 && (
        <p className="mt-1 line-clamp-1 max-w-[75ch] text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground/70">Roles: </span>
          {roles.titles.join(" · ")}
          {roles.total > roles.titles.length && ` +${roles.total - roles.titles.length} more`}
        </p>
      )}

      {/* 3. Yours: the service it's a match for. */}
      <div className="mt-3">
        {opportunity.service ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-signal-tint px-2.5 py-0.5 text-xs font-medium text-[var(--signal-deep)]">
            <CircleCheckIcon className="size-3.5 text-primary" />
            Matches {opportunity.service.name}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No service matched yet</span>
        )}
      </div>

      {/* 4. Footer: their needs (yours ticked), contact, date. */}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-xs text-muted-foreground">
        {/* What they need; the needs your matched service covers are ticked in green: why it matched. */}
        {opportunity.needs.slice(0, 4).map((slug) => {
          const covered = offered.has(slug);
          return (
            <span
              key={slug}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium",
                covered ? "bg-signal-tint text-[var(--signal-deep)]" : "bg-secondary text-foreground/70",
              )}
            >
              {covered && <CheckIcon className="size-3" strokeWidth={3} />}
              {names.category(slug)}
            </span>
          );
        })}
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
        {opportunity.engine && <EngineChips engine={opportunity.engine} />}
        <span className="ml-auto inline-flex items-center gap-3">
          <FeedbackVotes votes={opportunity.feedbackVotes} />
          {latest && (
            <span className="inline-flex items-center gap-1">
              <CalendarIcon className="size-3.5" />
              {latest}
            </span>
          )}
        </span>
      </div>
    </li>
  );
}
