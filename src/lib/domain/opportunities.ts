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

/**
 * How a lead can be reached, by what the system holds for it:
 * - `person`: the suggested person has their own email or phone
 * - `company`: only the company's own line (switchboard, info@, a practice's phone)
 * - `none`: no way in yet
 * `any` (person or company) is the "has contact" filter.
 */
export const CONTACT_REACH = ["any", "person", "company", "none"] as const;
export type ContactReach = (typeof CONTACT_REACH)[number];

export const CONTACT_REACH_LABELS: Record<ContactReach, string> = {
  any: "Has contact",
  person: "Named contact",
  company: "Company line only",
  none: "No contact yet",
};

/** The Leads page: every lead still being worked (new or in progress), by how it can be reached. */
export const LEAD_TABS = ["all", "person", "company", "none"] as const;
export type LeadTab = (typeof LEAD_TABS)[number];
export const LEAD_STATUSES = [...STATUS_GROUPS.open, ...STATUS_GROUPS.inProgress];
