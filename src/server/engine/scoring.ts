import { DEFAULT_ENGINE_WEIGHTS, type VerificationStatus } from "@/lib/domain/engine";
import type { IntentLevel } from "@/lib/domain/signals";
import type { ScoreFactorKey } from "./types";

/**
 * Opportunity score for engine opportunities (spec §10): rules for the measurable factors, intent
 * from the text reading. These weights are the spec's PROVISIONAL defaults (not final approved values).
 */
export { DEFAULT_ENGINE_WEIGHTS };

const INTENT_POINTS: Record<IntentLevel, number> = { explicit: 100, high: 90, medium: 60, low: 30, unknown: 10 };

export const intentPoints = (level: IntentLevel) => INTENT_POINTS[level];

export function serviceFitPoints(matched: number, serviceCount: number): number {
  if (serviceCount === 0 || matched === 0) return 0;
  return matched === 1 ? 50 : matched === 2 ? 75 : 100;
}

export function icpFitPoints(inCountry: boolean, inIndustry: boolean): number {
  return (inCountry ? 50 : 0) + (inIndustry ? 50 : 0);
}

/** Project budget against the user's minimum. No stated budget is low, never "meets the minimum" (spec §5). */
export function projectBudgetPoints(budgetUsd: number | null, minUsd: number): number {
  if (budgetUsd === null) return 25;
  if (minUsd <= 0) return 60;
  const ratio = budgetUsd / minUsd;
  return ratio >= 4 ? 100 : ratio >= 2 ? 80 : ratio >= 1 ? 60 : 20;
}

/** Funding as a sign the company can pay; any disclosed round counts, amount only ranks them. */
export function fundingPoints(amountUsd: number | null): number {
  if (amountUsd === null || amountUsd <= 0) return 25;
  return amountUsd >= 10_000_000 ? 100 : amountUsd >= 2_000_000 ? 80 : amountUsd >= 500_000 ? 60 : 40;
}

export function timingPoints(postedAt: Date | null, now: Date): number {
  if (!postedAt) return 20;
  const days = (now.getTime() - postedAt.getTime()) / 86_400_000;
  return days <= 1 ? 100 : days <= 3 ? 85 : days <= 7 ? 70 : days <= 30 ? 45 : days <= 90 ? 20 : 5;
}

export function evidencePoints(status: VerificationStatus, hasUrl: boolean, hasSnippet: boolean): number {
  const base = status === "verified" ? 80 : status === "unverified" ? 45 : 10;
  return Math.min(100, base + (hasUrl ? 10 : 0) + (hasSnippet ? 10 : 0));
}

export function totalScore(factors: Record<ScoreFactorKey, number>, weights = DEFAULT_ENGINE_WEIGHTS): number {
  const sum = (Object.keys(weights) as ScoreFactorKey[]).reduce((acc, k) => acc + weights[k], 0);
  if (sum === 0) return 0;
  const weighted = (Object.keys(weights) as ScoreFactorKey[]).reduce((acc, k) => acc + factors[k] * weights[k], 0);
  return Math.round(weighted / sum);
}
