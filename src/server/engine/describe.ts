import { CATEGORY_LABELS } from "@/lib/domain/engine";
import type { DiscoveredItem, EngineScore } from "./types";

const fmtUsd = (n: number) => (n >= 1_000_000 ? `$${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `$${+(n / 1000).toFixed(1)}k` : `$${n}`);

function ago(date: Date, now: Date): string {
  const hours = Math.max(0, Math.round((now.getTime() - date.getTime()) / 3_600_000));
  if (hours < 1) return "within the last hour";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The "why now" lines: facts from the source only, nothing inferred. */
export function whyNow(item: DiscoveredItem, now: Date): string[] {
  const lines: string[] = [];
  if (item.funding) {
    const { amountUsd, stage, date } = item.funding;
    // Without an amount (a directory listing) say what the source says, not that money was "raised".
    lines.push(
      amountUsd
        ? `Raised ${[fmtUsd(amountUsd), stage].filter(Boolean).join(" ")}${date ? ` on ${date}` : ""}.`
        : `Funding: ${stage ?? "a funding round"}${date ? ` (${date})` : ""}; amount not disclosed.`,
    );
  }
  if (item.postedAt) lines.push(`Posted ${ago(item.postedAt, now)} on ${item.platform}.`);
  if (item.budget?.usd) lines.push(`Stated budget about ${fmtUsd(item.budget.usd)}.`);
  else if (item.capability === "freelance") lines.push("No budget stated.");
  return lines;
}

/** Sales guidance per category. Suggests an angle; never claims the buyer's need as fact. */
export function suggestedAction(item: DiscoveredItem, score: EngineScore): string {
  const who = item.buyerName ?? "the poster";
  switch (item.category) {
    case "intent":
      return score.intentLevel === "low"
        ? `Low intent: ${who} is asking what this costs. Answer helpfully in the thread before pitching.`
        : `Reply to ${who} on ${item.platform} with relevant past work${score.matchedTerms.length ? ` (${score.matchedTerms.slice(0, 3).join(", ")})` : ""}, then move to a direct message.`;
    case "funded_company":
      return `Research the founders and reach out about ${score.matchedTerms.length ? score.matchedTerms.slice(0, 3).join(", ") : "your services"}; mention the recent round.`;
    case "freelance_project":
      return item.budget?.usd
        ? "Send a proposal that addresses the stated requirements, priced against the budget."
        : "Ask about budget and timeline before investing in a full proposal.";
  }
}

export const categoryLabel = (item: DiscoveredItem) => CATEGORY_LABELS[item.category];

/** Fields compared on rediscovery, so history records what actually changed. */
export const TRACKED_FIELDS = ["title", "budgetUsd", "budgetMax", "fundingAmountUsd", "fundingStage", "country", "verification", "intentLevel"] as const;
export type TrackedField = (typeof TRACKED_FIELDS)[number];

export function changedFields(before: Partial<Record<TrackedField, unknown>>, after: Partial<Record<TrackedField, unknown>>): TrackedField[] {
  return TRACKED_FIELDS.filter((f) => (before[f] ?? null) !== (after[f] ?? null));
}

/** A verified status is never downgraded by a later, weaker sighting. */
export function mergeVerification(current: string, incoming: string): string {
  const rank = { unavailable: 0, unverified: 1, verified: 2 } as const;
  return (rank[incoming as keyof typeof rank] ?? 0) >= (rank[current as keyof typeof rank] ?? 0) ? incoming : current;
}
