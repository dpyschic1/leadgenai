/**
 * Where an opportunity is in the sales process is a pipeline stage (`@/lib/domain/pipeline`), not a fixed
 * list: each workspace defines its own stages. The feed's tabs are derived from stage kind.
 */
export { STATUS_GROUP_KEYS, type StatusGroup } from "./pipeline";

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

/** The Leads page: every lead still being worked (any open stage, not archived), by how it can be reached. */
export const LEAD_TABS = ["all", "person", "company", "none"] as const;
export type LeadTab = (typeof LEAD_TABS)[number];
