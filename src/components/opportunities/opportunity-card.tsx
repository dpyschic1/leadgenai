"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { BriefcaseBusinessIcon, CalendarIcon, MailIcon, PhoneIcon, RadioTowerIcon, UserRoundIcon } from "lucide-react";
import { UrgencyBadge } from "@/components/signals/signal-badges";
import { useLookupNames } from "@/hooks/use-reference-data";
import type { OpportunitySummary } from "@/lib/api/types";
import { OSM_COPYRIGHT_URL } from "@/lib/domain/sources";
import { opportunityName } from "@/lib/opportunity-display";
import { CategoryBadge, EngineChips, VerificationBadge } from "./engine-parts";
import { FeedbackVotes } from "./feedback-votes";
import { ScoreRing } from "./score-ring";
import { StatusBadge } from "./status-badge";

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/**
 * One opportunity in a feed. The whole card opens it (a stretched link), so `action`, e.g. a
 * remove button, can sit on top without nesting interactive elements.
 */
export function OpportunityCard({
  opportunity,
  rank = null,
  action,
}: {
  opportunity: OpportunitySummary;
  rank?: number | null;
  action?: ReactNode;
}) {
  const names = useLookupNames();
  const latest = opportunity.latestSignalOn
    ? dateFormat.format(new Date(`${opportunity.latestSignalOn}T12:00:00`))
    : opportunity.engine?.discoveredAt
      ? dateFormat.format(new Date(opportunity.engine.discoveredAt))
      : null;
  const { phone: companyPhone, email: companyEmail } = opportunity.companyContact;

  return (
    <li className="group relative flex gap-4 rounded-xl border bg-card p-4 transition-shadow hover:shadow-[0_8px_24px_-12px_rgba(27,36,51,0.18)] has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-ring/50 sm:gap-5 sm:p-5">
      <div className="flex flex-col items-center gap-1">
        <ScoreRing score={opportunity.score} />
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
              <p className="text-sm text-muted-foreground">{names.opportunityType(opportunity.type)}</p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <StatusBadge stage={opportunity.stage} archived={opportunity.archived} />
            {action && <div className="relative z-10">{action}</div>}
          </div>
        </div>

        {opportunity.problem && <p className="mt-2 line-clamp-2 text-sm leading-relaxed">{opportunity.problem}</p>}

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
