import { CAPABILITY_CATEGORY, DEFAULT_ENGINE_WEIGHTS, type EngineWeights, type FreelanceConfig, type Targeting } from "@/lib/domain/engine";
import type { IntentLevel } from "@/lib/domain/signals";
import { readIntent } from "./intent";
import { matchedTerms, matchesCountry } from "./match";
import {
  evidencePoints,
  fundingPoints,
  icpFitPoints,
  intentPoints,
  projectBudgetPoints,
  serviceFitPoints,
  timingPoints,
  totalScore,
} from "./scoring";
import type { DiscoveredItem, EngineScore } from "./types";

/** Baseline intent for a funded company: a funding round shows ability to buy, not a request to. */
const FUNDED_INTENT: IntentLevel = "low";

export type ScoreInput = {
  item: DiscoveredItem;
  targeting: Targeting;
  serviceTerms: string[];
  freelance?: Pick<FreelanceConfig, "minBudgetUsd">;
  /** The workspace's weights; the spec's defaults when omitted. */
  weights?: EngineWeights;
  now: Date;
};

/** Scores one discovered item; every factor is explainable from the item and the workspace settings. */
export function scoreItem({ item, targeting, serviceTerms, freelance, weights = DEFAULT_ENGINE_WEIGHTS, now }: ScoreInput): EngineScore {
  const text = `${item.title}\n${item.text}`;
  const terms = matchedTerms(serviceTerms, text);

  let intentLevel: IntentLevel;
  if (CAPABILITY_CATEGORY[item.capability] === "funded_company") intentLevel = FUNDED_INTENT;
  else if (item.capability === "freelance") intentLevel = "high"; // a posted project is an explicit request to hire
  else intentLevel = item.intentHint ?? readIntent(text)?.level ?? "unknown";

  const inIndustry = targeting.industries.length === 0 || (item.industry !== null && targeting.industries.includes(item.industry));
  const budget =
    item.capability === "funded"
      ? fundingPoints(item.funding?.amountUsd ?? null)
      : projectBudgetPoints(item.budget?.usd ?? null, freelance?.minBudgetUsd ?? 5000);

  const factors = {
    serviceFit: serviceFitPoints(terms.length, serviceTerms.length),
    intent: intentPoints(intentLevel),
    icpFit: icpFitPoints(matchesCountry(targeting, item.country), inIndustry),
    budget,
    timing: timingPoints(item.postedAt ?? (item.funding?.date ? new Date(item.funding.date) : null), now),
    evidence: evidencePoints(item.verification, item.url !== null, item.text.length > 0),
  };
  return { total: totalScore(factors, weights), factors, weights, intentLevel, matchedTerms: terms };
}
