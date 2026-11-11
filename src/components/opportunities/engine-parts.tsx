"use client";

import Link from "next/link";
import { BadgeCheckIcon, CircleHelpIcon, ExternalLinkIcon, GlobeIcon, HistoryIcon, MapPinIcon, TagIcon, WalletIcon } from "lucide-react";
import type { EngineEvidence, EngineOpportunity, OpportunityDetail } from "@/lib/api/types";
import { countryName } from "@/lib/countries";
import { CATEGORY_LABELS, VERIFICATION_LABELS, type VerificationStatus } from "@/lib/domain/engine";
import { INTENT_LABELS } from "@/lib/domain/signals";
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

/** The buyer behind an engine opportunity; identity is shown only when the source gave it. */
export function BuyerCard({ opportunity }: { opportunity: OpportunityDetail }) {
  const engine = opportunity.engine;
  if (!engine) return null;
  const heading = engine.category === "funded_company" ? "Company" : "Buyer";
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-semibold">{heading}</h2>
      {engine.buyerName ? (
        <div className="mt-3 text-sm">
          <p className="font-medium">{engine.buyerName}</p>
          {engine.buyerProfileUrl && (
            <a href={engine.buyerProfileUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-primary hover:underline underline-offset-4">
              {engine.category === "funded_company" ? "Website" : "Profile"}
              <ExternalLinkIcon className="size-3" />
            </a>
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Not identified. The source doesn&apos;t say who posted this, and we don&apos;t guess.</p>
      )}
      {engine.investors.length > 0 && <p className="mt-3 text-sm text-muted-foreground">Investors: {engine.investors.join(", ")}</p>}
      {opportunity.engineEvidence.some((e) => Array.isArray((e.metadata as { people?: unknown }).people)) && <FilingPeople evidence={opportunity.engineEvidence} />}
    </section>
  );
}

/** Officers named on a Form D filing: the decision-makers the source itself lists. */
function FilingPeople({ evidence }: { evidence: EngineEvidence[] }) {
  const people = evidence.flatMap((e) => ((e.metadata as { people?: { name: string; roles: string[] }[] }).people ?? []));
  if (people.length === 0) return null;
  return (
    <div className="mt-4 border-t pt-3">
      <p className="mb-1.5 text-xs text-muted-foreground">Named in the filing</p>
      <ul className="space-y-1 text-sm">
        {people.slice(0, 6).map((p) => (
          <li key={p.name}>
            {p.name}
            {p.roles.length > 0 && <span className="text-muted-foreground">, {p.roles.join(", ")}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

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
export function EngineEvidencePanel({ opportunity }: { opportunity: OpportunityDetail }) {
  const { engineEvidence: evidence, discoveries } = opportunity;
  return (
    <>
      <div className="divide-y">
        {evidence.length === 0 && <p className="p-5 text-sm text-muted-foreground">No evidence stored.</p>}
        {evidence.map((e) => (
          <div key={e.id} className="space-y-1.5 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{e.platform}</span>
              <VerificationBadge status={e.verification} />
              <span className="text-xs text-muted-foreground">captured {when(e.capturedAt)}</span>
            </div>
            {e.snippet && <p className="line-clamp-6 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{e.snippet}</p>}
            {e.url && (
              <Link href={e.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4">
                View source
                <ExternalLinkIcon className="size-3" />
              </Link>
            )}
          </div>
        ))}
      </div>
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
