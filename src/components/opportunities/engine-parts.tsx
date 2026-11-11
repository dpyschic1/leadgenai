"use client";

import Link from "next/link";
import { BadgeCheckIcon, CircleHelpIcon, ExternalLinkIcon, GlobeIcon, HistoryIcon, MapPinIcon, RadarIcon, TagIcon, WalletIcon } from "lucide-react";
import { IntentBadge } from "@/components/signals/signal-badges";
import type { EngineOpportunity, OpportunityDetail } from "@/lib/api/types";
import { countryName } from "@/lib/countries";
import { CATEGORY_LABELS, VERIFICATION_LABELS, type VerificationStatus } from "@/lib/domain/engine";
import { INTENT_LABELS, type IntentLevel } from "@/lib/domain/signals";
import { cn } from "@/lib/utils";

/** Pieces shared by the feed card and the detail page for opportunities the LeadGen Engine discovered. */

export function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${+(n / 1000).toFixed(1)}k`;
  return `$${n}`;
}

export function CategoryBadge({ category }: { category: EngineOpportunity["category"] }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/15 bg-signal-tint px-2 py-0.5 text-xs font-medium text-[var(--signal-deep)]">
      <TagIcon className="size-3" />
      {CATEGORY_LABELS[category]}
    </span>
  );
}

const VERIFICATION_STYLE: Record<VerificationStatus, string> = {
  verified: "border-emerald-200 bg-emerald-50 text-emerald-800",
  unverified: "border-amber-200 bg-amber-50 text-amber-800",
  unavailable: "border-border bg-secondary text-muted-foreground",
};

export function VerificationBadge({ status }: { status: VerificationStatus }) {
  const Icon = status === "verified" ? BadgeCheckIcon : CircleHelpIcon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", VERIFICATION_STYLE[status])}>
      <Icon className="size-3" />
      {VERIFICATION_LABELS[status]}
    </span>
  );
}

/** The money line: a stated budget, a funding round, or an honest "no budget stated". */
export function moneyLine(engine: EngineOpportunity): string | null {
  if (engine.category === "funded_company") {
    if (!engine.fundingAmountUsd) return engine.fundingStage ? `${engine.fundingStage} (amount not disclosed)` : "Funding round";
    return `Raised ${[formatUsd(engine.fundingAmountUsd), engine.fundingStage].filter(Boolean).join(" · ")}`;
  }
  if (engine.category === "freelance_project") {
    if (engine.budgetUsd === null) return "No budget stated";
    // The stated range is in the source's own currency; only the USD figure is comparable, so never print
    // a foreign amount with a "$".
    if (engine.budgetCurrency && engine.budgetCurrency !== "USD") return `Budget about ${formatUsd(engine.budgetUsd)} (converted from ${engine.budgetCurrency})`;
    const range = engine.budgetMin !== null && engine.budgetMax !== null && engine.budgetMin !== engine.budgetMax;
    return `Budget ${range ? `${formatUsd(engine.budgetMin!)}–${formatUsd(engine.budgetMax!)}` : formatUsd(engine.budgetUsd)}`;
  }
  return null;
}

/** Facts shown on the card: where, how much, which country, how strong the intent. */
export function EngineChips({ engine }: { engine: EngineOpportunity }) {
  const money = moneyLine(engine);
  return (
    <>
      {engine.platform && (
        <span className="inline-flex items-center gap-1">
          <GlobeIcon className="size-3.5" />
          {engine.platform}
        </span>
      )}
      {money && (
        <span className="inline-flex items-center gap-1">
          <WalletIcon className="size-3.5" />
          {money}
        </span>
      )}
      {engine.country && (
        <span className="inline-flex items-center gap-1">
          <MapPinIcon className="size-3.5" />
          {countryName(engine.country)}
        </span>
      )}
      {engine.category === "intent" && engine.intentLevel && engine.intentLevel !== "unknown" && <span>{INTENT_LABELS[engine.intentLevel]} intent</span>}
    </>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** Engine score factors as bars with their weights (spec section 10). */
export function EngineScoreBreakdown({ factors, total }: { factors: NonNullable<OpportunityDetail["engineFactors"]>; total: number }) {
  return (
    <div className="space-y-3">
      {factors.map((f) => (
        <div key={f.key}>
          <div className="flex items-baseline justify-between text-sm">
            <span>
              {f.label} <span className="text-xs text-muted-foreground">weight {f.weight}%</span>
            </span>
            <span className="tabular-nums text-muted-foreground">{f.score}/100</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-secondary">
            <div className="h-1.5 rounded-full bg-primary" style={{ width: `${f.score}%` }} />
          </div>
        </div>
      ))}
      <p className="border-t pt-3 text-sm text-muted-foreground">
        Weighted total <span className="font-medium text-foreground">{total}</span>. A priority for who to look at first, not a chance of winning. These weights are the spec&apos;s provisional defaults.
      </p>
    </div>
  );
}

/** What backs the opportunity, with each source's verification status (spec section 8), then its discovery history. */
/** The timeline marker's colour by intent: the same scale the signal timeline uses. */
const MARKER: Record<IntentLevel, string> = {
  explicit: "bg-[var(--signal-deep)] ring-[var(--signal-deep)]/20",
  high: "bg-primary ring-primary/20",
  medium: "bg-amber-400 ring-amber-400/25",
  low: "bg-slate-300 ring-slate-300/40",
  unknown: "bg-background ring-border border border-slate-300",
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * What backs an engine opportunity, laid out like the signal timeline on company opportunities:
 * a marker by intent, what it is and when, its badges, the source's own words quoted, and where
 * it was found.
 */
export function EngineEvidencePanel({ opportunity }: { opportunity: OpportunityDetail }) {
  const { engineEvidence: evidence, discoveries } = opportunity;
  const intent = opportunity.engine?.intentLevel ?? "unknown";
  const kind = opportunity.engine ? CATEGORY_LABELS[opportunity.engine.category] : "Evidence";
  return (
    <>
      {evidence.length === 0 && <p className="p-5 text-sm text-muted-foreground">No evidence stored.</p>}
      {evidence.length > 0 && (
        <ol className="relative px-5 py-2">
          {evidence.map((e, index) => (
            <li key={e.id} className="relative flex gap-4 py-4">
              {index < evidence.length - 1 && <span aria-hidden="true" className="absolute top-9 bottom-0 left-[7px] w-px bg-border" />}
              <span aria-hidden="true" className={cn("relative mt-1.5 size-[15px] shrink-0 rounded-full ring-4", MARKER[intent])} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {kind}
                  <VerificationBadge status={e.verification} />
                </p>
                <p className="text-xs text-muted-foreground">
                  {e.platform}
                  <span aria-hidden="true"> / </span>
                  captured {when(e.capturedAt)}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <IntentBadge level={intent} />
                  {opportunity.service && (
                    <span className="rounded-full border border-primary/15 bg-signal-tint px-2 py-0.5 text-xs text-[var(--signal-deep)]">{opportunity.service.name}</span>
                  )}
                </div>

                {(e.snippet || e.url) && (
                  <figure className="mt-3 rounded-lg border-l-4 border-primary/40 bg-canvas px-4 py-3">
                    {e.snippet && <blockquote className="line-clamp-6 whitespace-pre-line text-sm leading-relaxed text-foreground/85">“{e.snippet}”</blockquote>}
                    {e.url && (
                      <figcaption className={cn(e.snippet && "mt-2")}>
                        <Link
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex max-w-full items-center gap-1 text-xs font-medium text-primary hover:underline underline-offset-4"
                        >
                          <span className="truncate">{hostOf(e.url)}</span>
                          <ExternalLinkIcon className="size-3 shrink-0" />
                        </Link>
                      </figcaption>
                    )}
                  </figure>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                  <span>{e.verification === "verified" ? "The source states it directly" : "Not confirmed by the source"}</span>
                  <span className="inline-flex items-center gap-1">
                    <RadarIcon className="size-3" />
                    Found on {e.platform}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {discoveries.length > 0 && (
        <div className="border-t p-5">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <HistoryIcon className="size-4 text-muted-foreground" />
            Discovery history
          </p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {discoveries.slice(0, 8).map((d) => (
              <li key={d.seenAt}>
                {when(d.seenAt)}: {d.change === "created" ? "first found" : "seen again"}
                {d.changedFields.length > 0 && `, changed ${d.changedFields.join(", ")}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
