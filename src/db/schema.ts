/**
 * Core data model for the LeadGenAI MVP (PRD §13).
 *
 * MVP scope: no automated ingestion. Companies, people and signals are entered
 * manually, so the ingestion-only entities from the PRD (sources, source_records,
 * enrichment_jobs, provider_accounts) are intentionally omitted.
 * Funding and job signals are stored as `signals` with structured `metadata`.
 *
 * Normalization rules:
 * - Shared vocabularies (service categories, industries, job functions, signal types,
 *   opportunity types) are global lookup tables keyed by a stable slug.
 * - Multi-valued attributes are join tables, never arrays that get matched on.
 * - Tenant-owned rows carry `workspace_id`; every reference between tenant-owned rows is a
 *   composite FK on (id, workspace_id), so the database itself rejects cross-workspace links.
 *   Pure child rows (locations, contact points, evidence) are scoped through their parent.
 * - Deliberate denormalizations are marked "Denormalized:" with the reason.
 *
 * Column names are camelCase here and snake_case in Postgres (casing: "snake_case").
 */
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { FEEDBACK_VERDICTS } from "@/lib/domain/feedback";
import { MEMBER_ROLES } from "@/lib/domain/members";
import { OPPORTUNITY_STATUSES } from "@/lib/domain/opportunities";
import {
  COMPANY_RELATIONSHIPS,
  CONTACT_VERIFICATIONS,
  IDENTITY_STATUSES,
  LOCATION_TYPES,
  SENIORITY_LEVELS,
} from "@/lib/domain/people";
import { EVIDENCE_LABELS, INTENT_LEVELS, SIGNAL_SOURCES, URGENCY_LEVELS } from "@/lib/domain/signals";

// ---------------------------------------------------------------------------
// Enums (closed sets that code branches on; open vocabularies are lookup tables)
// ---------------------------------------------------------------------------

/** Workspace roles (SRS §3). Platform admin is an internal role, not a workspace member. */
export const memberRole = pgEnum("user_role", MEMBER_ROLES);
export const membershipStatus = pgEnum("membership_status", ["invited", "active", "deactivated"]);

/** SRS Appendix B. */
export const intentLevel = pgEnum("intent_level", INTENT_LEVELS);

export const urgencyLevel = pgEnum("urgency_level", URGENCY_LEVELS);

/** Whether a person/company match is trustworthy enough to show as fact (SRS Appendix B). */
export const identityStatus = pgEnum("identity_status", IDENTITY_STATUSES);

export const contactPointType = pgEnum("contact_point_type", ["email", "phone"]);

export const contactVerification = pgEnum("contact_verification", CONTACT_VERIFICATIONS);

export const locationType = pgEnum("location_type", LOCATION_TYPES);

export const companyRelationship = pgEnum("company_relationship", COMPANY_RELATIONSHIPS);

export const seniorityLevel = pgEnum("seniority_level", SENIORITY_LEVELS);

/** How well a claim is supported (PRD §9). */
export const evidenceLabel = pgEnum("evidence_label", EVIDENCE_LABELS);

/** Whether a signal was classified by hand or by AI (then reviewed by a person). */
export const signalSource = pgEnum("signal_source", SIGNAL_SOURCES);

/** How a signal contributes to an opportunity's signal stack. */
export const signalRole = pgEnum("signal_role", ["primary", "corroborating", "negative"]);

/** Opportunity lifecycle (SRS Appendix B). */
export const opportunityStatus = pgEnum("opportunity_status", OPPORTUNITY_STATUSES);

/** A teammate's quality verdict on an opportunity. */
export const feedbackVerdict = pgEnum("feedback_verdict", FEEDBACK_VERDICTS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const id = () => uuid().primaryKey().defaultRandom();
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const workspaceRef = () =>
  uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
/** 0-100 score; null means not yet scored. */
const score = () => integer();
/** ISO 3166-1 alpha-2 country code, e.g. "GB". */
const countryCode = () => text();
const isCountryCode = (column: string) => sql`${sql.identifier(column)} ~ '^[A-Z]{2}$'`;
/** Global lookup table keyed by a stable slug (the slug is what code and AI output use). */
const lookupTable = (name: string) =>
  pgTable(name, {
    slug: text().primaryKey(),
    name: text().notNull(),
  });

// ---------------------------------------------------------------------------
// Reference data (global, seeded by migration)
// ---------------------------------------------------------------------------

export const serviceCategories = lookupTable("service_categories");
export const industries = lookupTable("industries");
export const jobFunctions = lookupTable("job_functions");
export const opportunityTypes = lookupTable("opportunity_types");
/** Top-level groups from the signal taxonomy (PRD §10), plus negative signals (PRD §12). */
export const signalCategories = lookupTable("signal_categories");

export const signalTypes = pgTable("signal_types", {
  slug: text().primaryKey(),
  name: text().notNull(),
  categorySlug: text()
    .notNull()
    .references(() => signalCategories.slug),
});

// ---------------------------------------------------------------------------
// Tenancy & identity
// ---------------------------------------------------------------------------

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text().notNull(),
  plan: text().notNull().default("free"),
  timezone: text().notNull().default("UTC"),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A person's login identity. Workspace access and roles live in `workspace_members`. */
export const users = pgTable(
  "users",
  {
    id: id(),
    /** Stored lowercased; normalization happens in the validation schemas. */
    email: text().notNull(),
    name: text(),
    /** argon2id hash; null for invited users who have not set a password yet. */
    passwordHash: text(),
    lastLoginAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: workspaceRef(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole().notNull().default("member"),
    status: membershipStatus().notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_members_user_idx").on(t.userId),
  ],
);

/**
 * A pending invitation to join a workspace (SRS FR-AUTH). The invitee follows a one-time link;
 * only the token's SHA-256 is stored, so a leaked table can't be used to join. Accepting creates
 * the `workspace_members` row and stamps `acceptedAt`; revoking deletes the invitation.
 */
export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: id(),
    workspaceId: workspaceRef(),
    /** Stored lowercased, like `users.email`. */
    email: text().notNull(),
    role: memberRole().notNull(),
    tokenHash: text().notNull(),
    invitedById: uuid().references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("workspace_invitations_token_idx").on(t.tokenHash),
    // One open invitation per person per workspace; inviting again replaces it.
    uniqueIndex("workspace_invitations_pending_idx")
      .on(t.workspaceId, t.email)
      .where(sql`${t.acceptedAt} is null`),
  ],
);

/** Database sessions, so they can be revoked (SRS FR-AUTH-004). Bound to one workspace. */
export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the session token; the raw token only ever lives in the cookie. */
    id: text().primaryKey(),
    userId: uuid().notNull(),
    workspaceId: uuid().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    // Losing workspace membership ends the sessions for that workspace.
    foreignKey({
      name: "sessions_member_fk",
      columns: [t.workspaceId, t.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const companies = pgTable(
  "companies",
  {
    id: id(),
    workspaceId: workspaceRef(),
    canonicalName: text().notNull(),
    domain: text(),
    industry: text().references(() => industries.slug),
    employeeCount: integer(),
    revenueRange: text(),
    description: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("companies_workspace_idx").on(t.workspaceId),
    uniqueIndex("companies_workspace_domain_idx").on(t.workspaceId, t.domain),
    unique("companies_id_workspace_uq").on(t.id, t.workspaceId),
  ],
);

/** Where a company operates. Location count and headquarters are derived from these rows. */
export const companyLocations = pgTable(
  "company_locations",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: locationType().notNull().default("office"),
    address: text(),
    city: text(),
    region: text(),
    country: countryCode(),
    postalCode: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("company_locations_company_idx").on(t.companyId),
    uniqueIndex("company_locations_one_hq_idx")
      .on(t.companyId)
      .where(sql`${t.type} = 'headquarters'`),
    check("company_locations_country_chk", isCountryCode("country")),
  ],
);

/** A real-world person. Their role at a company lives on `company_people`. */
export const people = pgTable(
  "people",
  {
    id: id(),
    workspaceId: workspaceRef(),
    name: text().notNull(),
    location: text(),
    professionalUrl: text(),
    identityStatus: identityStatus().notNull().default("unresolved"),
    identityConfidence: score(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("people_workspace_idx").on(t.workspaceId),
    unique("people_id_workspace_uq").on(t.id, t.workspaceId),
  ],
);

/** A person's business email/phone, each with its own source and freshness (PRD §13). */
export const contactPoints = pgTable(
  "contact_points",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    type: contactPointType().notNull(),
    value: text().notNull(),
    isPrimary: boolean().notNull().default(false),
    verification: contactVerification().notNull().default("unknown"),
    /** When the value was last verified; null = never verified. */
    verifiedAt: timestamp({ withTimezone: true }),
    /** Where the value came from, e.g. "manual" or a provider name. */
    source: text().notNull().default("manual"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("contact_points_person_value_idx").on(t.personId, t.type, t.value),
    uniqueIndex("contact_points_one_primary_idx")
      .on(t.personId, t.type)
      .where(sql`${t.isPrimary}`),
  ],
);

/** Employment / relationship graph: a person's role at a company. */
export const companyPeople = pgTable(
  "company_people",
  {
    workspaceId: uuid().notNull(),
    companyId: uuid().notNull(),
    personId: uuid().notNull(),
    relationship: companyRelationship().notNull().default("employee"),
    title: text(),
    seniority: seniorityLevel().notNull().default("unknown"),
    jobFunction: text().references(() => jobFunctions.slug),
    startedAt: timestamp({ withTimezone: true }),
    endedAt: timestamp({ withTimezone: true }),
    confidence: score(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.personId] }),
    index("company_people_person_idx").on(t.personId),
    foreignKey({
      name: "company_people_company_fk",
      columns: [t.companyId, t.workspaceId],
      foreignColumns: [companies.id, companies.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "company_people_person_fk",
      columns: [t.personId, t.workspaceId],
      foreignColumns: [people.id, people.workspaceId],
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------
// Signals & evidence
// ---------------------------------------------------------------------------

export const signals = pgTable(
  "signals",
  {
    id: id(),
    workspaceId: workspaceRef(),
    companyId: uuid().notNull(),
    /** Composite FK uses ON DELETE SET NULL (person_id) — hand-written in migration 0002. */
    personId: uuid(),
    signalType: text()
      .notNull()
      .references(() => signalTypes.slug),
    intentLevel: intentLevel().notNull().default("unknown"),
    urgency: urgencyLevel().notNull().default("unknown"),
    summary: text().notNull(),
    evidenceLabel: evidenceLabel().notNull().default("observed"),
    source: signalSource().notNull().default("manual"),
    /** Model confidence (0-100) for AI-classified signals; null when entered by hand. */
    confidence: score(),
    /** Type-specific details, e.g. { round, amount, currency } for funding. */
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** When the underlying event happened / was published. Drives recency. */
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("signals_workspace_idx").on(t.workspaceId),
    index("signals_company_occurred_idx").on(t.companyId, t.occurredAt),
    unique("signals_id_workspace_uq").on(t.id, t.workspaceId),
    foreignKey({
      name: "signals_company_fk",
      columns: [t.companyId, t.workspaceId],
      foreignColumns: [companies.id, companies.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "signals_person_fk",
      columns: [t.personId, t.workspaceId],
      foreignColumns: [people.id, people.workspaceId],
    }).onDelete("set null"),
  ],
);

/** Service categories a signal points to (AI classification output). */
export const signalServiceCategories = pgTable(
  "signal_service_categories",
  {
    signalId: uuid()
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    categorySlug: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.signalId, t.categorySlug] }),
    // Named explicitly: the generated name exceeds Postgres' 63-character limit.
    foreignKey({
      name: "signal_service_categories_category_fk",
      columns: [t.categorySlug],
      foreignColumns: [serviceCategories.slug],
    }),
  ],
);

export const signalEvidence = pgTable(
  "signal_evidence",
  {
    id: id(),
    signalId: uuid()
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    sourceUrl: text(),
    excerpt: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    capturedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("signal_evidence_signal_idx").on(t.signalId)],
);

// ---------------------------------------------------------------------------
// Customer configuration
// ---------------------------------------------------------------------------

/** Something the workspace sells. Targeting criteria are the join tables below. */
export const services = pgTable(
  "services",
  {
    id: id(),
    workspaceId: workspaceRef(),
    name: text().notNull(),
    description: text(),
    targetCompanySizeMin: integer(),
    targetCompanySizeMax: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("services_workspace_idx").on(t.workspaceId),
    unique("services_id_workspace_uq").on(t.id, t.workspaceId),
    check(
      "services_company_size_chk",
      sql`${t.targetCompanySizeMin} is null or ${t.targetCompanySizeMax} is null or ${t.targetCompanySizeMin} <= ${t.targetCompanySizeMax}`,
    ),
  ],
);

export const serviceServiceCategories = pgTable(
  "service_service_categories",
  {
    serviceId: uuid()
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    categorySlug: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.serviceId, t.categorySlug] }),
    foreignKey({
      name: "service_service_categories_category_fk",
      columns: [t.categorySlug],
      foreignColumns: [serviceCategories.slug],
    }),
  ],
);

export const serviceTargetIndustries = pgTable(
  "service_target_industries",
  {
    serviceId: uuid()
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    industrySlug: text()
      .notNull()
      .references(() => industries.slug),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.industrySlug] })],
);

/** Buyer roles the service sells to, e.g. engineering for staff augmentation. */
export const serviceTargetJobFunctions = pgTable(
  "service_target_job_functions",
  {
    serviceId: uuid()
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    jobFunctionSlug: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.serviceId, t.jobFunctionSlug] }),
    foreignKey({
      name: "service_target_job_functions_job_function_fk",
      columns: [t.jobFunctionSlug],
      foreignColumns: [jobFunctions.slug],
    }),
  ],
);

export const serviceTargetCountries = pgTable(
  "service_target_countries",
  {
    serviceId: uuid()
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    countryCode: countryCode().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.serviceId, t.countryCode] }),
    check("service_target_countries_code_chk", isCountryCode("country_code")),
  ],
);

/**
 * Score weights and ICP criteria (PRD §12). One active profile per workspace for MVP.
 * `config` is JSONB on purpose: the weights are always read and validated (Zod) as one unit.
 */
export const scoringProfiles = pgTable(
  "scoring_profiles",
  {
    id: id(),
    workspaceId: workspaceRef(),
    name: text().notNull(),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("scoring_profiles_workspace_idx").on(t.workspaceId),
    uniqueIndex("scoring_profiles_one_active_idx")
      .on(t.workspaceId)
      .where(sql`${t.active}`),
  ],
);

/** Saved search / monitor definition (PRD §16). Scheduled runs come after the MVP. */
export const recipes = pgTable(
  "recipes",
  {
    id: id(),
    workspaceId: workspaceRef(),
    /** Composite FK uses ON DELETE SET NULL (service_id) — hand-written in migration 0002. */
    serviceId: uuid(),
    name: text().notNull(),
    /** Structured search criteria (filters, signal types, date window). */
    query: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Cron expression; null = run on demand only. */
    schedule: text(),
    active: boolean().notNull().default(true),
    lastRunAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("recipes_workspace_idx").on(t.workspaceId),
    foreignKey({
      name: "recipes_service_fk",
      columns: [t.serviceId, t.workspaceId],
      foreignColumns: [services.id, services.workspaceId],
    }).onDelete("set null"),
  ],
);

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export const opportunities = pgTable(
  "opportunities",
  {
    id: id(),
    workspaceId: workspaceRef(),
    companyId: uuid().notNull(),
    /** Composite FK uses ON DELETE SET NULL (primary_person_id) — hand-written in migration 0002. */
    primaryPersonId: uuid(),
    /** Composite FK uses ON DELETE SET NULL (service_id) — hand-written in migration 0002. */
    serviceId: uuid(),
    type: text()
      .notNull()
      .references(() => opportunityTypes.slug),
    problem: text(),
    businessImpact: text(),
    desiredOutcome: text(),
    /** Display-only list generated from evidence; never matched or joined on. */
    requirements: text().array().notNull().default(sql`'{}'::text[]`),
    urgency: urgencyLevel().notNull().default("unknown"),
    /** Display-only "why now" lines; the supporting signals are in opportunity_signals. */
    whyNow: text().array().notNull().default(sql`'{}'::text[]`),
    suggestedAction: text(),
    notes: text(),
    // Denormalized: scores are computed from signals + scoring profile, stored so the feed can
    // sort/filter by them with an index. `scoreFactors` keeps the breakdown (PRD App. B).
    intentScore: score(),
    icpScore: score(),
    identityConfidence: score(),
    serviceFit: score(),
    /** Prioritization score, not a purchase probability (PRD §12). */
    opportunityScore: score(),
    scoreFactors: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: opportunityStatus().notNull().default("new"),
    /** When the scores were last computed; recency changes with time, so stale rows are re-scored. */
    scoredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Denormalized: max(occurred_at) of linked signals, cached for freshness sorting. */
    latestSignalAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("opportunities_workspace_status_idx").on(t.workspaceId, t.status),
    index("opportunities_workspace_score_idx").on(t.workspaceId, t.opportunityScore),
    // MVP: one opportunity per company, matched to its best-fitting service. Drop this to allow
    // one per (company, service) later.
    uniqueIndex("opportunities_company_uq").on(t.companyId),
    unique("opportunities_id_workspace_uq").on(t.id, t.workspaceId),
    foreignKey({
      name: "opportunities_company_fk",
      columns: [t.companyId, t.workspaceId],
      foreignColumns: [companies.id, companies.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "opportunities_person_fk",
      columns: [t.primaryPersonId, t.workspaceId],
      foreignColumns: [people.id, people.workspaceId],
    }).onDelete("set null"),
    foreignKey({
      name: "opportunities_service_fk",
      columns: [t.serviceId, t.workspaceId],
      foreignColumns: [services.id, services.workspaceId],
    }).onDelete("set null"),
  ],
);

/** The signal stack behind an opportunity. */
export const opportunitySignals = pgTable(
  "opportunity_signals",
  {
    workspaceId: uuid().notNull(),
    opportunityId: uuid().notNull(),
    signalId: uuid().notNull(),
    weight: integer(),
    role: signalRole().notNull().default("corroborating"),
  },
  (t) => [
    primaryKey({ columns: [t.opportunityId, t.signalId] }),
    index("opportunity_signals_signal_idx").on(t.signalId),
    foreignKey({
      name: "opportunity_signals_opportunity_fk",
      columns: [t.opportunityId, t.workspaceId],
      foreignColumns: [opportunities.id, opportunities.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "opportunity_signals_signal_fk",
      columns: [t.signalId, t.workspaceId],
      foreignColumns: [signals.id, signals.workspaceId],
    }).onDelete("cascade"),
  ],
);

/**
 * A teammate's verdict on an opportunity (launch checklist: users flag incorrect matches and
 * opportunity quality). Each person has at most one opinion (good fit / not relevant) and one
 * wrong-company flag per opportunity, plus one flag per contact or service they rejected, so
 * flagging a second wrong contact doesn't bring back the first. It records what was judged at
 * that moment, so it stays a true label for learning later (PRD §21) after re-scoring.
 */
export const opportunityFeedback = pgTable(
  "opportunity_feedback",
  {
    id: id(),
    workspaceId: uuid().notNull(),
    opportunityId: uuid().notNull(),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    verdict: feedbackVerdict().notNull(),
    reason: text(),
    /** The contact this verdict was about; for wrong_person the engine stops suggesting them. */
    personId: uuid().references(() => people.id, { onDelete: "set null" }),
    /** The matched service; for wrong_service the engine stops matching it. */
    serviceId: uuid().references(() => services.id, { onDelete: "set null" }),
    /** Snapshot: the opportunity score when the verdict was given. */
    scoreAtFeedback: score(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("opportunity_feedback_opportunity_idx").on(t.opportunityId),
    index("opportunity_feedback_workspace_idx").on(t.workspaceId),
    foreignKey({
      name: "opportunity_feedback_opportunity_fk",
      columns: [t.opportunityId, t.workspaceId],
      foreignColumns: [opportunities.id, opportunities.workspaceId],
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export const lists = pgTable(
  "lists",
  {
    id: id(),
    workspaceId: workspaceRef(),
    name: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("lists_workspace_idx").on(t.workspaceId),
    // Names are how people pick a list, so two lists can't differ only by letter case.
    uniqueIndex("lists_workspace_name_uq").on(t.workspaceId, sql`lower(${t.name})`),
    unique("lists_id_workspace_uq").on(t.id, t.workspaceId),
  ],
);

export const savedOpportunities = pgTable(
  "saved_opportunities",
  {
    workspaceId: uuid().notNull(),
    listId: uuid().notNull(),
    opportunityId: uuid().notNull(),
    addedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.listId, t.opportunityId] }),
    index("saved_opportunities_opportunity_idx").on(t.opportunityId),
    foreignKey({
      name: "saved_opportunities_list_fk",
      columns: [t.listId, t.workspaceId],
      foreignColumns: [lists.id, lists.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "saved_opportunities_opportunity_fk",
      columns: [t.opportunityId, t.workspaceId],
      foreignColumns: [opportunities.id, opportunities.workspaceId],
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    workspaceId: workspaceRef(),
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);

/**
 * Fixed-window request counters for rate limiting (SRS §14). Kept in Postgres so limits hold
 * across server instances. `key` is "<rule>:<sha256 of the subject>", so no emails or IPs are stored.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text().primaryKey(),
    count: integer().notNull(),
    windowStart: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("rate_limits_window_start_idx").on(t.windowStart)],
);
