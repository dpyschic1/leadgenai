/**
 * Opportunity quality feedback (launch checklist: "users can flag incorrect company/person
 * matches and opportunity quality"). The database enum is built from this array.
 */

export const FEEDBACK_VERDICTS = ["good_fit", "not_relevant", "wrong_service", "wrong_person", "wrong_company"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export const FEEDBACK_LABELS: Record<FeedbackVerdict, string> = {
  good_fit: "Good fit",
  not_relevant: "Not relevant",
  wrong_service: "Wrong service match",
  wrong_person: "Wrong contact person",
  wrong_company: "Wrong company",
};

/** What each verdict means, and what it does, in the words the feedback panel shows. */
export const FEEDBACK_DESCRIPTIONS: Record<FeedbackVerdict, string> = {
  good_fit: "Worth pursuing: the need, the timing and the match look right.",
  not_relevant: "Not a real opportunity for us, even if the signals look strong.",
  wrong_service: "The need is real but it doesn't match this service. Another service is tried instead.",
  wrong_person: "This isn't the right person to contact. Someone else is suggested instead.",
  wrong_company: "The signals are about a different company than this one.",
};

/** Verdicts that correct the match: the scoring engine stops using what was flagged. */
export const CORRECTING_VERDICTS = ["wrong_service", "wrong_person"] as const satisfies readonly FeedbackVerdict[];

export const isPositiveVerdict = (verdict: FeedbackVerdict) => verdict === "good_fit";
