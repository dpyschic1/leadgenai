/** Response DTOs shared by the route handlers and the client. Only these shapes leave the server. */
import type { memberRole } from "@/db/schema";
import type { CompanyRelationship, LocationType, SeniorityLevel } from "@/lib/domain/people";
import type { EvidenceLabel, IntentLevel, SignalSource, UrgencyLevel } from "@/lib/domain/signals";
import type { ScoreWeights } from "@/lib/validation/scoring";

export type UserRole = (typeof memberRole.enumValues)[number];

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
};

export type Workspace = {
  id: string;
  name: string;
  plan: string;
  timezone: string;
};

/** The signed-in user and their workspace; returned by register, login and GET /workspaces/me. */
export type Me = {
  user: CurrentUser;
  workspace: Workspace;
};

/** An entry in a global lookup table (service categories, industries, job functions). */
export type LookupOption = { slug: string; name: string };

export type SignalTypeOption = LookupOption & { categorySlug: string };

export type ReferenceData = {
  serviceCategories: LookupOption[];
  industries: LookupOption[];
  jobFunctions: LookupOption[];
  /** Taxonomy groups (PRD §10): explicit buying first, negative last. */
  signalCategories: LookupOption[];
  signalTypes: SignalTypeOption[];
};

/** Something the workspace sells, with who it is sold to. Empty targeting lists mean "any". */
export type Service = {
  id: string;
  name: string;
  description: string;
  categories: string[];
  targetIndustries: string[];
  targetJobFunctions: string[];
  targetCountries: string[];
  companySizeMin: number | null;
  companySizeMax: number | null;
};

export type ScoringProfile = {
  weights: ScoreWeights;
};

/** A row in the companies list. */
export type CompanySummary = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  headquarters: { city: string | null; country: string | null } | null;
  peopleCount: number;
};

export type CompanyLocation = {
  id: string;
  type: LocationType;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postalCode: string | null;
};

/** A person in the context of one company: their role there plus primary contact details. */
export type CompanyPerson = {
  id: string;
  name: string;
  title: string | null;
  seniority: SeniorityLevel;
  jobFunction: string | null;
  relationship: CompanyRelationship;
  email: string | null;
  phone: string | null;
  professionalUrl: string | null;
  location: string | null;
};

export type CompanyDetail = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  description: string | null;
  locations: CompanyLocation[];
  people: CompanyPerson[];
};

export type Signal = {
  id: string;
  companyId: string;
  personId: string | null;
  signalType: string;
  intentLevel: IntentLevel;
  urgency: UrgencyLevel;
  serviceCategories: string[];
  summary: string;
  evidenceLabel: EvidenceLabel;
  source: SignalSource;
  confidence: number | null;
  /** ISO date (YYYY-MM-DD) the underlying event happened or was published. */
  occurredOn: string;
  evidence: { sourceUrl: string | null; excerpt: string | null } | null;
  createdAt: string;
};

/** AI suggestion for a pasted source; the user reviews it before saving. */
export type SignalAnalysis = {
  /** False when the text holds no business signal; the other fields are then best-effort. */
  isSignal: boolean;
  /** Null when there is no signal (`isSignal` false). */
  signalType: string | null;
  intentLevel: IntentLevel;
  urgency: UrgencyLevel;
  serviceCategories: string[];
  summary: string;
  /** Verbatim quote from the source; null when the model's quote couldn't be found in it. */
  excerpt: string | null;
  evidenceLabel: EvidenceLabel;
  confidence: number;
  /** Date mentioned in the source (YYYY-MM-DD), if any. */
  occurredOn: string | null;
  model: string;
};
