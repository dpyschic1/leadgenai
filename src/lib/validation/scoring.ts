import { z } from "zod";

/** Opportunity score weights (PRD §12). They must add up to 100. */

export const SCORE_FACTORS = [
  { key: "intent", label: "Intent", hint: "How clearly the company is looking to buy" },
  { key: "icpFit", label: "ICP fit", hint: "How closely the company matches who you sell to" },
  { key: "recency", label: "Recency", hint: "How fresh the supporting signals are" },
  { key: "identity", label: "Identity confidence", hint: "How sure we are about the company and person" },
  { key: "serviceFit", label: "Service fit", hint: "How well the need matches what you sell" },
] as const;

export type ScoreFactor = (typeof SCORE_FACTORS)[number]["key"];

export const DEFAULT_SCORE_WEIGHTS: Record<ScoreFactor, number> = {
  intent: 40,
  icpFit: 25,
  recency: 15,
  identity: 10,
  serviceFit: 10,
};

const weight = z.number().int("Use a whole number").min(0).max(100);

export const scoreWeightsSchema = z
  .object({
    intent: weight,
    icpFit: weight,
    recency: weight,
    identity: weight,
    serviceFit: weight,
  })
  .refine((w) => Object.values(w).reduce((sum, value) => sum + value, 0) === 100, {
    message: "Weights must add up to 100%",
  });

export const scoringProfileSchema = z.object({ weights: scoreWeightsSchema });

export type ScoreWeights = z.infer<typeof scoreWeightsSchema>;
export type ScoringProfileInput = z.infer<typeof scoringProfileSchema>;

export function totalWeight(weights: Record<ScoreFactor, number>): number {
  return Object.values(weights).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}
