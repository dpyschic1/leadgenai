/** Response DTOs shared by the route handlers and the client. Only these shapes leave the server. */
import type { memberRole, signalRole } from "@/db/schema";
import type { OpportunityStatus, StatusGroup } from "@/lib/domain/opportunities";
import type { CompanyRelationship, LocationType, SeniorityLevel } from "@/lib/domain/people";
import type { EvidenceLabel, IntentLevel, SignalSource, UrgencyLevel } from "@/lib/domain/signals";
import type { ScoreFactor, ScoreWeights } from "@/lib/validation/scoring";

export type UserRole = (typeof memberRole.enumValues)[number];
export type SignalRole = (typeof signalRole.enumValues)[number];

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

/** Someone with access to the workspace. */
export type TeamMember = {
  userId: string;
  name: string | null;
  email: string;
  role: UserRole;
  joinedAt: string;
  lastLoginAt: string | null;
};

/** An invitation that hasn't been accepted yet. Its link is only shown when it's created. */
export type PendingInvitation = {
  id: string;
  email: string;
  role: UserRole;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
};

export type Team = {
  members: TeamMember[];
  /** Only owners and admins see invitations; empty for everyone else. */
  invitations: PendingInvitation[];
};

/** Returned once when an invitation is created: the raw token is never stored, so it can't be shown again. */
export type CreatedInvitation = { invitation: PendingInvitation; token: string };

/** What someone opening an invitation link sees before accepting. */
export type InvitationPreview = {
  workspaceName: string;
  email: string;
  role: UserRole;
  invitedBy: string | null;
  /** True when the email already has a LeadGenAI account, so only the password is needed. */
  accountExists: boolean;
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
  opportunityTypes: LookupOption[];
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
  /** This company's opportunity, if its signals have produced one. */
  opportunity: { id: string; score: number | null; status: OpportunityStatus } | null;
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

/** One of the five score factors, with the reasons behind it (PRD: scores are explainable). */
export type OpportunityFactor = { score: number; weight: number; contribution: number; reasons: string[] };

export type OpportunitySummary = {
  id: string;
  company: { id: string; name: string; domain: string | null };
  service: { id: string; name: string } | null;
  type: string;
  /** Priority 0-100, not a purchase probability. Null once no positive signal remains. */
  score: number | null;
  scores: Record<ScoreFactor, number> | null;
  urgency: UrgencyLevel;
  status: OpportunityStatus;
  problem: string | null;
  /** YYYY-MM-DD of the newest supporting signal. */
  latestSignalOn: string | null;
  signalCount: number;
  contact: { id: string; name: string; title: string | null } | null;
  updatedAt: string;
};

export type OpportunityList = {
  items: OpportunitySummary[];
  /** Totals per status tab, independent of the selected tab. */
  counts: Record<StatusGroup, number>;
};

export type OpportunitySignal = Signal & { role: SignalRole };

export type OpportunityDetail = OpportunitySummary & {
  suggestedAction: string | null;
  notes: string | null;
  factors: Record<ScoreFactor, OpportunityFactor> | null;
  signals: OpportunitySignal[];
  contactDetails: CompanyPerson | null;
  scoredAt: string;
  /** Saved lists this opportunity is on. */
  listIds: string[];
};

/** A saved list of opportunities (PRD §8.10), e.g. "Contact today". */
export type SavedList = {
  id: string;
  name: string;
  opportunityCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SavedListDetail = SavedList & {
  /** Highest priority first, whatever their status. */
  items: OpportunitySummary[];
};
