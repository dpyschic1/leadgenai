/** Response DTOs shared by the route handlers and the client. Only these shapes leave the server. */
import type { memberRole, signalRole } from "@/db/schema";
import type { FeedbackVerdict } from "@/lib/domain/feedback";
import type { CompanyIdentity, SourceAuthorization, SourceSlug } from "@/lib/domain/sources";
import type { LeadTab, StatusGroup } from "@/lib/domain/opportunities";
import type { StageRef } from "@/lib/domain/pipeline";
import type {
  CompanyRelationship,
  ContactVerification,
  IdentityLevel,
  LocationType,
  SeniorityLevel,
} from "@/lib/domain/people";
import type { EvidenceLabel, IntentLevel, SignalSource, UrgencyLevel } from "@/lib/domain/signals";
import type { OpportunityFilters } from "@/lib/validation/opportunities";
import type { Page } from "@/lib/validation/pagination";
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
  /** The source that found the company; null when added by hand. */
  discoveredBy: SourceSlug | null;
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
  /** Where this person was found (register, company website); null when added by hand. */
  source: SourceSlug | null;
  title: string | null;
  seniority: SeniorityLevel;
  jobFunction: string | null;
  relationship: CompanyRelationship;
  email: string | null;
  phone: string | null;
  professionalUrl: string | null;
  location: string | null;
  /** How sure the team is that this is the right person, and the underlying 0-100 confidence. */
  identity: IdentityLevel;
  identityConfidence: number | null;
  /** Deliverability of the email/phone above, and when it was last checked. */
  emailVerification: ContactCheck | null;
  phoneVerification: ContactCheck | null;
};

/** A contact point's verification state (PRD §22: "contact verification state is displayed"). */
/**
 * An email or phone's state. `origin` is kept apart from `state`: an address published on the
 * company's site or inferred from its pattern is never shown as verified unless a person verifies it.
 */
export type ContactCheck = { state: ContactVerification; checkedAt: string | null; origin: "entered" | "published" | "inferred" };

export type CompanyDetail = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  description: string | null;
  /** The source that found the company; null when added by hand. */
  discoveredBy: SourceSlug | null;
  /** How well the business is identified: provisional (one source's name only), partial (website confirmed), verified. */
  identityStatus: CompanyIdentity;
  locations: CompanyLocation[];
  people: CompanyPerson[];
  /** This company's opportunity, if its signals have produced one. */
  opportunity: { id: string; score: number | null; stage: StageRef; archived: boolean } | null;
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
  /** The data source a found signal came from; null when entered by hand. */
  origin: SourceSlug | null;
  createdAt: string;
};

/** A data source as the workspace sees it (Settings → Data sources). */
export type DataSource = {
  slug: SourceSlug;
  name: string;
  description: string;
  /** Platform-level permission (only "approved" runs). */
  authorization: SourceAuthorization;
  /** The workspace's own switch. */
  enabled: boolean;
  /** False when a setting it needs is missing (e.g. an API key). */
  configured: boolean;
  termsUrl: string | null;
  lastSuccessAt: string | null;
  lastFailure: { at: string; message: string } | null;
};

/** What "Run now" found: new companies and signals, and whether work is still queued. */
export type SourcesRunResult = { companiesAdded: number; signalsCreated: number; pendingJobs: number };

/** Where a found company's information came from (company page "Sources" card). */
export type CompanySources = {
  discoveredBy: SourceSlug | null;
  discoveredAt: string | null;
  companyNumber: string | null;
  website: { domain: string; confidence: number; matchedBy: string } | null;
  contacts: { type: "email" | "phone"; value: string; source: SourceSlug | null; observedAt: string }[];
  /**
   * The OpenStreetMap places this company (or one of its practices) was matched to, with what they
   * publish. Kept apart from our own contacts: published on OSM, not verified, credited (ODbL).
   */
  openStreetMap: { name: string; url: string; phone: string | null; email: string | null; website: string | null; matchedBy: string; checkedAt: string }[];
  /** Sites a register lists for the company, e.g. each of a CQC provider's practices. */
  sites: { name: string; website: string | null; phone: string | null; postalCode: string | null; source: SourceSlug | null }[];
  /** Attribution a source's licence asks us to show, e.g. for CQC data. */
  attributions: string[];
  records: { source: SourceSlug; recordType: string; url: string | null; observedAt: string }[];
  /** Background work still queued for this company. */
  pendingJobs: number;
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
  /** Null for engine opportunities whose buyer has no identified company (an intent post, a freelance project). */
  company: { id: string; name: string; domain: string | null } | null;
  /** Set for opportunities found by the LeadGen Engine; null for the company-signal flow. */
  engine: EngineOpportunity | null;
  service: { id: string; name: string } | null;
  type: string;
  /** Priority 0-100, not a purchase probability. Null once no positive signal remains. */
  score: number | null;
  scores: Record<ScoreFactor, number> | null;
  urgency: UrgencyLevel;
  /** Where it is in the workspace's sales pipeline. */
  stage: StageRef;
  /** Archived opportunities are hidden from the working tabs but kept. */
  archived: boolean;
  problem: string | null;
  /** YYYY-MM-DD of the newest supporting signal. */
  latestSignalOn: string | null;
  signalCount: number;
  /** The suggested person, with their own email/phone when known (never for a suppressed person). */
  contact: { id: string; name: string; title: string | null; email: string | null; phone: string | null } | null;
  /** The company's own published phone and email (switchboard, info@, a practice's phone): a way in even with no named person. */
  companyContact: {
    phone: string | null;
    email: string | null;
    /** The phone or email shown is from OpenStreetMap (the company has none of its own): credit it (ODbL). */
    fromOpenStreetMap: boolean;
  };
  /** Where its evidence can be read (the primary or newest linked signal's source), with that signal's summary. */
  evidence: { url: string; summary: string } | null;
  /** Who on the team judged it and how, newest first; the card shows these as "1 good fit" / "2 flagged". */
  feedbackVotes: FeedbackVote[];
  updatedAt: string;
};

/** What the LeadGen Engine knows about an opportunity it discovered (spec section 11). */
export type EngineOpportunity = {
  category: import("@/lib/domain/engine").OpportunityCategory;
  title: string;
  /** The poster or, for a funding event, the company. Never guessed. */
  buyerName: string | null;
  buyerProfileUrl: string | null;
  country: string | null;
  sourceSlug: string | null;
  /** Where it was found, as the newest evidence names it ("Reddit" for a Google result). */
  platform: string | null;
  sourceUrl: string | null;
  /** Budget as stated; `budgetUsd` is the comparable figure. */
  budgetUsd: number | null;
  budgetMin: number | null;
  budgetMax: number | null;
  budgetCurrency: string | null;
  fundingAmountUsd: number | null;
  fundingStage: string | null;
  fundingDate: string | null;
  investors: string[];
  verification: import("@/lib/domain/engine").VerificationStatus;
  intentLevel: import("@/lib/domain/signals").IntentLevel | null;
  discoveredAt: string | null;
  lastSeenAt: string | null;
  whyNow: string[];
};

/** One page of the feed; `total` is the selected tab's count. */
export type OpportunityList = Page<OpportunitySummary> & {
  /** Totals per status tab, independent of the selected tab. */
  counts: Record<StatusGroup, number>;
};

/** One page of the Leads page; `total` is the selected tab's count. */
export type LeadList = Page<OpportunitySummary> & { counts: Record<LeadTab, number> };

export type CompanyList = Page<CompanySummary>;
export type ServiceList = Page<Service>;

export type OpportunitySignal = Signal & { role: SignalRole };

/** A published company phone, email or website; `label` names the site it belongs to, if any. */
export type CompanyContact = { type: "email" | "phone" | "website"; value: string; label: string | null; source: SourceSlug | null; url: string | null };

export type OpportunityDetail = OpportunitySummary & {
  suggestedAction: string | null;
  notes: string | null;
  factors: Record<ScoreFactor, OpportunityFactor> | null;
  signals: OpportunitySignal[];
  contactDetails: CompanyPerson | null;
  /** The other people found at the company, those with an email, phone or profile first. */
  otherPeople: CompanyPerson[];
  /** Every published company phone/email, with where it came from (e.g. "Swindon practice" from CQC). */
  companyContacts: CompanyContact[];
  /** For a public tender: its notice and closing date (ISO), shown with the contact. */
  tender: { url: string | null; closesAt: string | null; closed: boolean } | null;
  /** The engine's score factors with their weights; null for company-signal opportunities. */
  engineFactors: { key: string; label: string; score: number; weight: number }[] | null;
  /** What backs an engine opportunity, newest first (spec section 8). */
  engineEvidence: EngineEvidence[];
  /** Each time a discovery run saw it, newest first. */
  discoveries: { seenAt: string; change: string; changedFields: string[] }[];
  scoredAt: string;
  /** Saved lists this opportunity is on. */
  listIds: string[];
  /** The team's verdicts, newest first. */
  feedback: OpportunityFeedback[];
};

/** One source reference behind an engine opportunity. */
export type EngineEvidence = {
  id: string;
  platform: string;
  url: string | null;
  snippet: string | null;
  verification: import("@/lib/domain/engine").VerificationStatus;
  capturedAt: string;
  metadata: Record<string, unknown>;
};

/** A teammate's verdict as the feed shows it: who, and what they said. */
export type FeedbackVote = { name: string; verdict: FeedbackVerdict };

/** One teammate's verdict on an opportunity, with what was being judged at the time. */
export type OpportunityFeedback = {
  id: string;
  verdict: FeedbackVerdict;
  reason: string | null;
  author: { id: string; name: string } | null;
  /** Given by the signed-in user, who can change or remove it. */
  isMine: boolean;
  /** The suggested contact, matched service and score when the verdict was given. */
  personName: string | null;
  serviceName: string | null;
  scoreAtFeedback: number | null;
  updatedAt: string;
};

/** What the AI search understood: filters the user can inspect and change, plus what it couldn't express. */
export type InterpretedSearch = {
  filters: OpportunityFilters;
  /** Parts of the request no filter covers, e.g. "React experience". */
  unmatched: string[];
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

// ---------------------------------------------------------------------------
// LeadGen Engine
// ---------------------------------------------------------------------------

export type CapabilityState = {
  capability: import("@/lib/domain/engine").Capability;
  enabled: boolean;
  frequencyMinutes: number;
  /** Per-dimension override; null = inherits the workspace value. */
  override: import("@/lib/domain/engine").TargetingOverride;
  /** What the capability will actually target (override replaces, never adds to, the workspace). */
  effective: import("@/lib/domain/engine").Targeting;
  config: import("@/lib/domain/engine").CapabilityConfig;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  lastStatus: import("@/lib/domain/engine").RunStatus | null;
  lastError: string | null;
};

export type EngineState = {
  enabled: boolean;
  /** Targeting derived from Services & ICP: the default every capability inherits. */
  workspaceTargeting: import("@/lib/domain/engine").Targeting;
  capabilities: CapabilityState[];
};
