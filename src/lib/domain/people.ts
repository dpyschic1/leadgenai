/**
 * Closed value sets for people and their company roles. The database enums are built from these
 * arrays, so the schema, the API validation and the form options can never drift apart.
 */

export const SENIORITY_LEVELS = ["owner", "c_level", "vp", "director", "manager", "senior", "entry", "unknown"] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

export const SENIORITY_LABELS: Record<SeniorityLevel, string> = {
  owner: "Owner",
  c_level: "C-level",
  vp: "VP",
  director: "Director",
  manager: "Manager",
  senior: "Senior individual contributor",
  entry: "Entry level",
  unknown: "Unknown",
};

export const COMPANY_RELATIONSHIPS = [
  "employee",
  "founder",
  "owner",
  "board_member",
  "advisor",
  "contractor",
  "investor",
] as const;
export type CompanyRelationship = (typeof COMPANY_RELATIONSHIPS)[number];

export const RELATIONSHIP_LABELS: Record<CompanyRelationship, string> = {
  employee: "Employee",
  founder: "Founder",
  owner: "Owner",
  board_member: "Board member",
  advisor: "Advisor",
  contractor: "Contractor",
  investor: "Investor",
};

/** Whether a person is who we think they are (SRS Appendix B). */
export const IDENTITY_STATUSES = ["resolved", "ambiguous", "unresolved", "suppressed"] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

/** Deliverability of an email/phone (SRS Appendix B). Providers report all of these; people enter the first three. */
export const CONTACT_VERIFICATIONS = ["valid", "invalid", "accept_all", "webmail", "disposable", "unknown"] as const;
export type ContactVerification = (typeof CONTACT_VERIFICATIONS)[number];

export const VERIFICATION_LABELS: Record<ContactVerification, string> = {
  valid: "Verified",
  invalid: "Invalid",
  accept_all: "Can't be confirmed (server accepts everything)",
  webmail: "Personal webmail",
  disposable: "Disposable address",
  unknown: "Not checked",
};

/** What someone entering a contact by hand can say about it. */
export const MANUAL_VERIFICATIONS = ["unknown", "valid", "invalid"] as const satisfies readonly ContactVerification[];
export type ManualVerification = (typeof MANUAL_VERIFICATIONS)[number];

/**
 * How sure the team is about a person, in words (PRD §22: "a person is shown only when identity
 * confidence passes configured thresholds"). Stored as identity status + confidence, so contacts
 * from data providers, with their own confidence, fit the same scale later.
 */
export const IDENTITY_LEVELS = ["confirmed", "likely", "unsure", "do_not_contact"] as const;
export type IdentityLevel = (typeof IDENTITY_LEVELS)[number];

export const IDENTITY_LABELS: Record<IdentityLevel, string> = {
  confirmed: "Confirmed",
  likely: "Likely",
  unsure: "Unsure",
  do_not_contact: "Do not contact",
};

export const IDENTITY_DESCRIPTIONS: Record<IdentityLevel, string> = {
  confirmed: "You know they work there in this role.",
  likely: "Looks right, e.g. found on their profile, but not confirmed.",
  unsure: "Might be someone else, or may have left. Never suggested as the contact.",
  do_not_contact: "Must not be contacted. Never suggested, and left out of exports.",
};

/** Minimum identity confidence (0-100) for someone to be suggested as an opportunity's contact. */
export const CONTACT_CONFIDENCE_THRESHOLD = 60;

const IDENTITY_STORAGE: Record<IdentityLevel, { identityStatus: IdentityStatus; identityConfidence: number | null }> = {
  confirmed: { identityStatus: "resolved", identityConfidence: 100 },
  likely: { identityStatus: "resolved", identityConfidence: 75 },
  unsure: { identityStatus: "ambiguous", identityConfidence: 40 },
  do_not_contact: { identityStatus: "suppressed", identityConfidence: null },
};

/** The stored form of a level. */
export function identityColumns(level: IdentityLevel) {
  return IDENTITY_STORAGE[level];
}

/** The level for stored values, including any confidence a data provider reports. */
export function identityLevel(status: IdentityStatus, confidence: number | null): IdentityLevel {
  if (status === "suppressed") return "do_not_contact";
  if (status !== "resolved") return "unsure";
  // People added before confidence was recorded were entered by someone who knew them.
  if (confidence === null || confidence >= 90) return "confirmed";
  return confidence >= CONTACT_CONFIDENCE_THRESHOLD ? "likely" : "unsure";
}

/** Whether someone at this level may be suggested as the person to contact. */
export function isSuggestable(level: IdentityLevel): boolean {
  return level === "confirmed" || level === "likely";
}

export const LOCATION_TYPES = ["headquarters", "office", "branch", "store", "warehouse", "other"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];
