/**
 * Opportunity lifecycle (SRS Appendix B). The database enum is built from this array, so the
 * schema, the API validation and the status picker share one definition.
 */

export const OPPORTUNITY_STATUSES = [
  "new",
  "qualified",
  "saved",
  "contacted",
  "replied",
  "meeting",
  "proposal",
  "won",
  "lost",
  "dismissed",
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const STATUS_LABELS: Record<OpportunityStatus, string> = {
  new: "New",
  qualified: "Qualified",
  saved: "Saved",
  contacted: "Contacted",
  replied: "Replied",
  meeting: "Meeting booked",
  proposal: "Proposal sent",
  won: "Won",
  lost: "Lost",
  dismissed: "Dismissed",
};

/** Groups used by the feed's filter tabs. */
export const STATUS_GROUPS = {
  open: ["new", "qualified", "saved"],
  inProgress: ["contacted", "replied", "meeting", "proposal"],
  won: ["won"],
  closed: ["lost", "dismissed"],
} as const satisfies Record<string, readonly OpportunityStatus[]>;

export type StatusGroup = keyof typeof STATUS_GROUPS;
