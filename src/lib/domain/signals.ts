/**
 * Closed value sets for signals (SRS Appendix B, PRD §9). The database enums are built from
 * these arrays, so the schema, the AI output schema and the forms share one definition.
 */

export const INTENT_LEVELS = ["explicit", "high", "medium", "low", "unknown"] as const;
export type IntentLevel = (typeof INTENT_LEVELS)[number];

export const INTENT_LABELS: Record<IntentLevel, string> = {
  explicit: "Explicit",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unknown",
};

export const URGENCY_LEVELS = ["high", "medium", "low", "unknown"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export const URGENCY_LABELS: Record<UrgencyLevel, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unknown",
};

/** How well a claim is supported: seen in a source, derived from data, or inferred by AI. */
export const EVIDENCE_LABELS = ["observed", "derived", "inferred", "unknown"] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

export const EVIDENCE_LABEL_NAMES: Record<EvidenceLabel, string> = {
  observed: "Observed in source",
  derived: "Derived from data",
  inferred: "Inferred",
  unknown: "Unknown",
};

/** Where a signal's classification came from. */
export const SIGNAL_SOURCES = ["manual", "ai"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/** Display order of the signal taxonomy groups (PRD §10): strongest buying evidence first. */
export const SIGNAL_CATEGORY_ORDER = [
  "explicit_buying",
  "problem",
  "company_event",
  "workforce",
  "digital",
  "negative",
] as const;
