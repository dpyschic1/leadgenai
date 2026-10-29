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

export const LOCATION_TYPES = ["headquarters", "office", "branch", "store", "warehouse", "other"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];
