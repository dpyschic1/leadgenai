/**
 * Core data model for the LeadGenAI MVP (PRD §13).
 *
 * MVP scope: companies and people are entered manually; signals are entered manually or fetched
 * from a company's public job board (`company_job_boards`, `job_postings`). The other
 * ingestion-only entities from the PRD (sources, source_records, enrichment_jobs,
 * provider_accounts) are intentionally omitted.
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
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
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
import { JOB_BOARD_PROVIDERS, JOB_TRIAGE_STATES } from "@/lib/domain/job-boards";
import {
  BOARD_VALIDATIONS,
  COMPANY_ID_SCHEMES,
  COMPANY_IDENTITIES,
  INGESTION_JOB_KINDS,
  INGESTION_JOB_STATUSES,
  SOURCE_AUTHORIZATIONS,
} from "@/lib/domain/sources";
import { CAPABILITIES, OPPORTUNITY_CATEGORIES, RUN_STATUSES, VERIFICATION_STATUSES } from "@/lib/domain/engine";
import { MEMBER_ROLES } from "@/lib/domain/members";
import { STAGE_KINDS } from "@/lib/domain/pipeline";
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

/** Whether a pipeline stage is still being worked, won or lost (spec section 12). */
export const stageKind = pgEnum("stage_kind", STAGE_KINDS);

/** LeadGen Engine discovery capabilities, opportunity categories, evidence status, run outcome. */
export const engineCapability = pgEnum("engine_capability", CAPABILITIES);
export const opportunityCategory = pgEnum("opportunity_category", OPPORTUNITY_CATEGORIES);
export const verificationStatus = pgEnum("verification_status", VERIFICATION_STATUSES);
export const runStatus = pgEnum("run_status", RUN_STATUSES);

/** A teammate's quality verdict on an opportunity. */
export const feedbackVerdict = pgEnum("feedback_verdict", FEEDBACK_VERDICTS);

export const jobBoardProvider = pgEnum("job_board_provider", JOB_BOARD_PROVIDERS);

/** What the AI made of a fetched job (see `JOB_TRIAGE_STATES`). */
export const jobTriage = pgEnum("job_triage", JOB_TRIAGE_STATES);

/** Platform-level permission to run a source (SRS §11.3). */
export const sourceAuthorization = pgEnum("source_authorization", SOURCE_AUTHORIZATIONS);

export const ingestionJobKind = pgEnum("ingestion_job_kind", INGESTION_JOB_KINDS);

export const ingestionJobStatus = pgEnum("ingestion_job_status", INGESTION_JOB_STATUSES);

export const companyIdScheme = pgEnum("company_id_scheme", COMPANY_ID_SCHEMES);

/** How sure we are a company record is the real, identified business (see `COMPANY_IDENTITIES`). */
export const companyIdentity = pgEnum("company_identity", COMPANY_IDENTITIES);

/** Whether a job board found in the archive was confirmed by the provider's own endpoint. */
export const boardValidation = pgEnum("board_validation", BOARD_VALIDATIONS);

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

/**
 * Registry of data sources (PRD §14, SRS §11.3), one row per adapter in `src/server/sources`.
 * Seeded by migration. Changing `authorizationStatus` stops or resumes a source for every workspace
 * without a deploy; only `approved` sources run.
 */
export const sources = pgTable("sources", {
  slug: text().primaryKey(),
  name: text().notNull(),
  /** e.g. company_registry, company_website, job_api, procurement. */
  type: text().notNull(),
  authorizationStatus: sourceAuthorization().notNull().default("pending_review"),
  termsUrl: text(),
  /** Compliance notes: what the terms allow, rate limits, retention. */
  notes: text(),
});

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
    /** The source that found this company; null when it was added by hand. */
    sourceSlug: text().references(() => sources.slug),
    discoveredAt: timestamp({ withTimezone: true }),
    /**
     * Provisional when known only from one source's own name for it (e.g. a job board), partial
     * once its official website is confirmed, verified when matched to a register or entered by hand.
     */
    identityStatus: companyIdentity().notNull().default("verified"),
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
    /**
     * A site with its own identity, e.g. one of a provider's dental practices on the CQC register:
     * its name, website and phone, and the source's id for it. Null for addresses entered by hand.
     */
    name: text(),
    website: text(),
    phone: text(),
    sourceSlug: text().references(() => sources.slug),
    externalId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("company_locations_company_idx").on(t.companyId),
    uniqueIndex("company_locations_one_hq_idx")
      .on(t.companyId)
      .where(sql`${t.type} = 'headquarters'`),
    // One row per source location, so re-reading the register updates it instead of duplicating.
    uniqueIndex("company_locations_external_idx")
      .on(t.companyId, t.sourceSlug, t.externalId)
      .where(sql`${t.externalId} is not null`),
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
    /** Where this person-company link was found; null when it was added by hand. */
    sourceSlug: text().references(() => sources.slug),
    observedAt: timestamp({ withTimezone: true }),
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
// Automatically gathered data: provenance and identity
// ---------------------------------------------------------------------------

/**
 * One item fetched from a source (PRD §13: source_records): a company profile, web page, tender…
 * The unique key makes ingestion idempotent (FR-SIG-004); `contentHash` tells a changed page from
 * an unchanged one. Only the minimum needed is kept in `data` (PRD §19: minimise raw content).
 */
export const sourceRecords = pgTable(
  "source_records",
  {
    id: id(),
    workspaceId: workspaceRef(),
    sourceSlug: text()
      .notNull()
      .references(() => sources.slug),
    externalId: text().notNull(),
    url: text(),
    /** e.g. company_profile, officer_list, web_page, tender. */
    recordType: text().notNull(),
    publishedAt: timestamp({ withTimezone: true }),
    observedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    contentHash: text(),
    /** Composite FK uses ON DELETE SET NULL (company_id) — hand-written in migration 0014. */
    companyId: uuid(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    uniqueIndex("source_records_external_idx").on(t.workspaceId, t.sourceSlug, t.externalId),
    index("source_records_company_idx").on(t.companyId),
    unique("source_records_id_workspace_uq").on(t.id, t.workspaceId),
    foreignKey({
      name: "source_records_company_fk",
      columns: [t.companyId, t.workspaceId],
      foreignColumns: [companies.id, companies.workspaceId],
    }).onDelete("set null"),
  ],
);

/** Registry identifiers (e.g. the UK company number), used to recognise a company again. */
export const companyIdentifiers = pgTable(
  "company_identifiers",
  {
    workspaceId: uuid().notNull(),
    companyId: uuid().notNull(),
    scheme: companyIdScheme().notNull(),
    value: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.scheme] }),
    uniqueIndex("company_identifiers_value_idx").on(t.workspaceId, t.scheme, t.value),
    foreignKey({
      name: "company_identifiers_company_fk",
      columns: [t.companyId, t.workspaceId],
      foreignColumns: [companies.id, companies.workspaceId],
    }).onDelete("cascade"),
  ],
);

/** A company's own published business contacts (switchboard, info@), as opposed to a person's. */
export const companyContactPoints = pgTable(
  "company_contact_points",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: contactPointType().notNull(),
    value: text().notNull(),
    sourceSlug: text().references(() => sources.slug),
    sourceUrl: text(),
    observedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("company_contact_points_value_idx").on(t.companyId, t.type, t.value)],
);

/** A workspace switching a source off for itself (on unless a row says otherwise). */
export const workspaceSources = pgTable(
  "workspace_sources",
  {
    workspaceId: workspaceRef(),
    sourceSlug: text()
      .notNull()
      .references(() => sources.slug),
    enabled: boolean().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.sourceSlug] })],
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
    /**
     * The source record a found signal came from (FR-SIG-003); null when entered by hand.
     * Composite FK uses ON DELETE SET NULL (source_record_id) — hand-written in migration 0014.
     */
    sourceRecordId: uuid(),
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
    foreignKey({
      name: "signals_source_record_fk",
      columns: [t.sourceRecordId, t.workspaceId],
      foreignColumns: [sourceRecords.id, sourceRecords.workspaceId],
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
// Job boards (signals fetched from a company's public job board)
// ---------------------------------------------------------------------------

/**
 * Every public job board the system knows of, shared by all workspaces (a board's existence is a
 * public fact; nothing workspace-specific is stored here). Candidates come from the Common Crawl
 * archive, company websites and boards entered by hand, and are only `valid` once the provider's
 * own endpoint confirms them. Also the work queue for checking boards (`next_check_at`).
 */
export const jobBoardDirectory = pgTable(
  "job_board_directory",
  {
    provider: jobBoardProvider().notNull(),
    boardToken: text().notNull(),
    /** The board's own name for the company, as its provider returns it; null until validated. */
    boardName: text(),
    /**
     * The company website the board's provider states (Workable's account record). Only a
     * candidate: it is set on a company once that site is read and links back to this board.
     */
    statedWebsite: text(),
    /** Where the board was first found, e.g. an archived URL or a company's careers page. */
    discoveryUrl: text(),
    discoveredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    validationStatus: boardValidation().notNull().default("unverified"),
    lastVerifiedAt: timestamp({ withTimezone: true }),
    /** When the jobs were last downloaded into `board_jobs`. */
    lastFetchedAt: timestamp({ withTimezone: true }),
    nextCheckAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    lastError: text(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.boardToken] }),
    index("job_board_directory_due_idx").on(t.validationStatus, t.nextCheckAt),
  ],
);

/**
 * The open jobs of a validated board, downloaded once for all workspaces and deduplicated by
 * provider + board + the provider's job id. Only what evaluation and evidence need is kept, and
 * closed jobs are pruned. Each workspace's verdict on a job lives in its own `job_postings`.
 */
export const boardJobs = pgTable(
  "board_jobs",
  {
    id: id(),
    provider: jobBoardProvider().notNull(),
    boardToken: text().notNull(),
    externalId: text().notNull(),
    title: text().notNull(),
    department: text(),
    location: text(),
    url: text().notNull(),
    /**
     * Only what the AI reads and evidence quotes (`jobDigest`): the posting without perks and legal
     * small print, at most `MAX_JOB_TEXT`, for a job that fits a service; just the links and emails
     * it names for any other. Null for an undated job past `MAX_JOB_AGE_DAYS`.
     */
    description: text(),
    postedAt: timestamp({ withTimezone: true }),
    /** When the provider says the job last changed, if it does. */
    updatedAt: timestamp({ withTimezone: true }),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp({ withTimezone: true }),
    /** When the title rules sorted it into service categories (`board_job_categories`); null = not yet. */
    categorizedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("board_jobs_external_idx").on(t.provider, t.boardToken, t.externalId),
    index("board_jobs_uncategorized_idx").on(t.firstSeenAt).where(sql`${t.categorizedAt} is null`),
    index("board_jobs_seen_idx").on(t.firstSeenAt),
    foreignKey({
      name: "board_jobs_board_fk",
      columns: [t.provider, t.boardToken],
      foreignColumns: [jobBoardDirectory.provider, jobBoardDirectory.boardToken],
    }).onDelete("cascade"),
  ],
);

/**
 * The service categories a shared job points to (what a company hiring for it may buy), so every
 * workspace finds its jobs with one query and no AI. First from the title rules
 * (`categorizeJob`, method "rule"); replaced by the AI's own categories once the job is analysed
 * (method "ai").
 */
export const boardJobCategories = pgTable(
  "board_job_categories",
  {
    boardJobId: uuid()
      .notNull()
      .references(() => boardJobs.id, { onDelete: "cascade" }),
    categorySlug: text()
      .notNull()
      .references(() => serviceCategories.slug),
    /** rule or ai. */
    method: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardJobId, t.categorySlug] }), index("board_job_categories_category_idx").on(t.categorySlug)],
);

/**
 * The AI's reading of one shared job, made once for every workspace (the analysis depends only on
 * the job and the company, never on who is looking). Workspaces' signals from the job are upgraded
 * from it; its service categories replace the rule ones in `board_job_categories`.
 */
export const jobAnalyses = pgTable("job_analyses", {
  boardJobId: uuid()
    .primaryKey()
    .references(() => boardJobs.id, { onDelete: "cascade" }),
  isSignal: boolean().notNull(),
  signalType: text().references(() => signalTypes.slug),
  intentLevel: intentLevel().notNull(),
  urgency: urgencyLevel().notNull(),
  summary: text().notNull(),
  excerpt: text(),
  evidenceLabel: evidenceLabel().notNull(),
  confidence: integer().notNull(),
  /** YYYY-MM-DD, when the text states one. */
  occurredOn: text(),
  model: text().notNull(),
  analyzedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** How far the archive has been read per provider and crawl, so slow index queries can resume. */
export const directoryCrawls = pgTable(
  "directory_crawls",
  {
    provider: jobBoardProvider().notNull(),
    /** The archive's crawl id, e.g. "CC-MAIN-2026-43". */
    crawlId: text().notNull(),
    nextPage: integer().notNull().default(0),
    totalPages: integer(),
    finishedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.crawlId] })],
);

/** The job board a company publishes its openings on. One per company. */
export const companyJobBoards = pgTable(
  "company_job_boards",
  {
    companyId: uuid().primaryKey(),
    workspaceId: workspaceRef(),
    provider: jobBoardProvider().notNull(),
    /** The board's name in the provider's URL, e.g. "stripe" in boards.greenhouse.io/stripe. */
    boardToken: text().notNull(),
    lastFetchedAt: timestamp({ withTimezone: true }),
    /** Why the last fetch failed; cleared by the next successful one. */
    lastError: text(),
    /** Found by the system (careers-page link or name match) rather than entered by a person. */
    autoDetected: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("company_job_boards_workspace_idx").on(t.workspaceId),
    // One company per board per workspace, so a board found twice never makes two companies.
    uniqueIndex("company_job_boards_board_idx").on(t.workspaceId, t.provider, t.boardToken),
    foreignKey({
      name: "company_job_boards_company_fk",
      columns: [t.companyId, t.workspaceId],
      foreignColumns: [companies.id, companies.workspaceId],
    }).onDelete("cascade"),
  ],
);

/**
 * A job seen on a company's board, with this workspace's verdict on it (triage, signal). Kept after
 * it closes, so a role that stays open for months (a staffing signal in itself) can be told apart
 * from a new one, and a job is never analysed twice.
 *
 * Denormalized: title, location and url repeat the shared `board_jobs` row (linked by
 * `board_job_id`), so the workspace keeps its record of a job after the shared row is pruned. The
 * description is not repeated: it is read from the shared row (`jobText`).
 */
export const jobPostings = pgTable(
  "job_postings",
  {
    id: id(),
    workspaceId: workspaceRef(),
    companyId: uuid().notNull(),
    provider: jobBoardProvider().notNull(),
    /** The provider's own id for the job. */
    externalId: text().notNull(),
    title: text().notNull(),
    department: text(),
    location: text(),
    url: text().notNull(),
    /** Only for jobs saved before the shared pool (no `board_job_id`); otherwise null, the text being in `board_jobs`. */
    description: text(),
    /** When the company published it, if the provider says. */
    postedAt: timestamp({ withTimezone: true }),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Set when the job is no longer listed; cleared if it comes back. */
    closedAt: timestamp({ withTimezone: true }),
    triage: jobTriage().notNull().default("pending"),
    triageReason: text(),
    /** The signal recorded from this job. Composite FK uses ON DELETE SET NULL (signal_id) — hand-written in migration 0013. */
    signalId: uuid(),
    /** The shared public job this row evaluates; null for jobs fetched before the shared cache. */
    boardJobId: uuid().references(() => boardJobs.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("job_postings_company_external_idx").on(t.companyId, t.provider, t.externalId),
    index("job_postings_company_closed_idx").on(t.companyId, t.closedAt),
    index("job_postings_signal_idx").on(t.signalId),
    // "Has this workspace seen this shared job?" is asked for thousands of jobs per match.
    index("job_postings_board_job_idx").on(t.boardJobId),
    foreignKey({
      name: "job_postings_company_fk",
      columns: [t.companyId, t.workspaceId],
      foreignColumns: [companies.id, companies.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "job_postings_signal_fk",
      columns: [t.signalId, t.workspaceId],
      foreignColumns: [signals.id, signals.workspaceId],
    }).onDelete("set null"),
  ],
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

/**
 * Background work (Spec §11; PRD's enrichment_jobs, generalised): find companies for the
 * workspace's ICP, enrich one, read its website, check its job board, look for tenders. Claimed
 * with SKIP LOCKED by the worker, retried with backoff, never queued twice while open.
 */
export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    id: id(),
    workspaceId: workspaceRef(),
    kind: ingestionJobKind().notNull(),
    /** The workspace (discover_companies, scan_tenders) or company (the others) the job is about. */
    entityId: uuid().notNull(),
    status: ingestionJobStatus().notNull().default("queued"),
    attempts: integer().notNull().default(0),
    runAfter: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    /** AI calls the job used (cost metering, PRD §20). */
    aiCalls: integer().notNull().default(0),
    /** Higher goes first: a person is waiting for it (e.g. opened an opportunity without contacts). */
    priority: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("ingestion_jobs_due_idx").on(t.status, t.runAfter),
    // At most one open job per thing to do.
    uniqueIndex("ingestion_jobs_open_idx")
      .on(t.workspaceId, t.kind, t.entityId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

/**
 * A workspace's sales pipeline (spec section 12). Positions order the stages; `kind` keeps Won and Lost
 * identifiable. Every workspace keeps at least one stage of each kind (enforced in the service).
 */
export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: id(),
    workspaceId: workspaceRef(),
    name: text().notNull(),
    kind: stageKind().notNull().default("open"),
    position: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("pipeline_stages_workspace_idx").on(t.workspaceId, t.position),
    unique("pipeline_stages_id_workspace_uq").on(t.id, t.workspaceId),
    uniqueIndex("pipeline_stages_name_uq").on(t.workspaceId, sql`lower(${t.name})`),
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
    /** Null for buyers who are not identified (an intent post by an anonymous account). */
    companyId: uuid(),
    /** Null for opportunities from the original signal-driven flow. */
    category: opportunityCategory(),
    title: text(),
    /** Who posted or asked, when the source shows it; never guessed. */
    buyerName: text(),
    buyerProfileUrl: text(),
    country: countryCode(),
    sourceSlug: text(),
    sourceUrl: text(),
    /** The source's own ID for the post / project / funding event: the deduplication key. */
    sourceExternalId: text(),
    /** Budget as the source states it (original currency); `budgetUsd` is the figure used for filtering and scoring. */
    budgetMin: integer(),
    budgetMax: integer(),
    budgetCurrency: text(),
    budgetUsd: integer(),
    fundingAmountUsd: bigint({ mode: "number" }),
    fundingStage: text(),
    fundingDate: date({ mode: "string" }),
    investors: text().array(),
    /** How strongly the source text shows buying intent (spec §3: high / medium / low). */
    intentLevel: intentLevel(),
    verification: verificationStatus().notNull().default("unverified"),
    discoveredAt: timestamp({ withTimezone: true }),
    /** When the source says it was posted (or the funding date); the timing score is recomputed from it as it ages. */
    sourcePostedAt: timestamp({ withTimezone: true }),
    /** Last time a discovery run saw this source item again. */
    lastSeenAt: timestamp({ withTimezone: true }),
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
    /** Where it is in the workspace's sales pipeline; discovery never changes it. */
    stageId: uuid().notNull(),
    /** Set when archived (replaces "dismissed"): hidden from the working tabs, kept for history. */
    archivedAt: timestamp({ withTimezone: true }),
    /** When the scores were last computed; recency changes with time, so stale rows are re-scored. */
    scoredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Denormalized: max(occurred_at) of linked signals, cached for freshness sorting. */
    latestSignalAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("opportunities_workspace_stage_idx").on(t.workspaceId, t.stageId),
    foreignKey({
      name: "opportunities_stage_fk",
      columns: [t.stageId, t.workspaceId],
      foreignColumns: [pipelineStages.id, pipelineStages.workspaceId],
    }).onDelete("restrict"),
    index("opportunities_workspace_score_idx").on(t.workspaceId, t.opportunityScore),
    // MVP: one opportunity per company, matched to its best-fitting service. Drop this to allow
    // one per (company, service) later.
    uniqueIndex("opportunities_company_uq").on(t.companyId),
    // Source-based deduplication (spec §9): a rediscovery updates the row, never duplicates it.
    uniqueIndex("opportunities_source_uq")
      .on(t.workspaceId, t.sourceSlug, t.sourceExternalId)
      .where(sql`${t.sourceExternalId} is not null`),
    index("opportunities_workspace_category_idx").on(t.workspaceId, t.category),
    check("opportunities_country_chk", sql`${t.country} is null or ${t.country} ~ '^[A-Z]{2}$'`),
    check(
      "opportunities_identity_chk",
      sql`${t.companyId} is not null or ${t.category} is not null`,
    ),
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

// ---------------------------------------------------------------------------
// LeadGen Engine (Opportunities Engine specification)
// ---------------------------------------------------------------------------

/** One row per workspace: the master switch. Absent row = defaults (enabled). */
export const engineSettings = pgTable("engine_settings", {
  workspaceId: uuid()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  enabled: boolean().notNull().default(true),
  /** The workspace's own factor weights for discovered opportunities (spec section 10); null = the defaults. */
  scoringWeights: jsonb().$type<Record<string, number>>(),
  updatedAt: updatedAt(),
});

/**
 * One row per (workspace, capability): switch, schedule, targeting override and filters. A null
 * targeting column means "inherit the workspace's Services & ICP"; an array replaces it for that
 * dimension only. `config` is JSONB because it is always read and validated as one unit.
 */
export const engineCapabilities = pgTable(
  "engine_capabilities",
  {
    workspaceId: workspaceRef(),
    capability: engineCapability().notNull(),
    enabled: boolean().notNull().default(true),
    frequencyMinutes: integer().notNull(),
    targetCountries: text().array(),
    targetIndustries: text().array(),
    targetServiceIds: uuid().array(),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    lastRunAt: timestamp({ withTimezone: true }),
    lastSuccessAt: timestamp({ withTimezone: true }),
    lastStatus: runStatus(),
    lastError: text(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.capability] }),
    check("engine_capabilities_frequency_chk", sql`${t.frequencyMinutes} between 15 and 10080`),
  ],
);

/** One execution of a capability, so a failing source is visible apart from the whole run failing. */
export const discoveryRuns = pgTable(
  "discovery_runs",
  {
    id: id(),
    workspaceId: workspaceRef(),
    capability: engineCapability().notNull(),
    trigger: text().notNull().default("schedule"),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    /** Null while running. */
    status: runStatus(),
    found: integer().notNull().default(0),
    created: integer().notNull().default(0),
    updated: integer().notNull().default(0),
    /** Per-source outcome: [{ source, ok, found, error }]. */
    sources: jsonb().$type<{ source: string; ok: boolean; found: number; error?: string; note?: string }[]>().notNull().default([]),
    error: text(),
  },
  (t) => [
    index("discovery_runs_workspace_idx").on(t.workspaceId, t.capability, t.startedAt),
    unique("discovery_runs_id_workspace_uq").on(t.id, t.workspaceId),
  ],
);

/**
 * What backs an opportunity (spec §8). One row per distinct source reference; rediscovery updates
 * `capturedAt`/`snippet` in place and never removes earlier evidence.
 */
export const opportunityEvidence = pgTable(
  "opportunity_evidence",
  {
    id: id(),
    workspaceId: uuid().notNull(),
    opportunityId: uuid().notNull(),
    sourceSlug: text().notNull(),
    /** Human-readable platform, e.g. "Hacker News". */
    platform: text().notNull(),
    url: text(),
    snippet: text(),
    verification: verificationStatus().notNull().default("unverified"),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    contentHash: text(),
    capturedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("opportunity_evidence_opportunity_idx").on(t.opportunityId),
    uniqueIndex("opportunity_evidence_ref_uq").on(t.opportunityId, t.sourceSlug, t.url),
    foreignKey({
      name: "opportunity_evidence_opportunity_fk",
      columns: [t.opportunityId, t.workspaceId],
      foreignColumns: [opportunities.id, opportunities.workspaceId],
    }).onDelete("cascade"),
  ],
);

/** Each time a run saw an opportunity: discovery history, kept separate from sales progress. */
export const opportunityDiscoveries = pgTable(
  "opportunity_discoveries",
  {
    id: id(),
    workspaceId: uuid().notNull(),
    opportunityId: uuid().notNull(),
    runId: uuid(),
    seenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** "created" or "updated", plus which fields changed on an update. */
    change: text().notNull(),
    changedFields: text().array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    index("opportunity_discoveries_opportunity_idx").on(t.opportunityId, t.seenAt),
    foreignKey({
      name: "opportunity_discoveries_opportunity_fk",
      columns: [t.opportunityId, t.workspaceId],
      foreignColumns: [opportunities.id, opportunities.workspaceId],
    }).onDelete("cascade"),
    // Composite FK uses ON DELETE SET NULL (run_id) — hand-written in migration 0034.
    foreignKey({
      name: "opportunity_discoveries_run_fk",
      columns: [t.runId, t.workspaceId],
      foreignColumns: [discoveryRuns.id, discoveryRuns.workspaceId],
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

// ---------------------------------------------------------------------------
// OpenStreetMap (ODbL): kept in its own tables, never copied into company rows
// ---------------------------------------------------------------------------

/**
 * Businesses on OpenStreetMap that carry a phone, website or email, imported weekly from a UK
 * extract (`scripts/import-osm.ts`), shared by every workspace. Open Database License: this
 * table is the OSM-derived database. Contacts are shown from here with the OSM credit, never
 * written into `companies` or `company_contact_points`, so our own data stays separate from it.
 * An element gone from the latest extract is marked `removed_at` and stops matching.
 */
export const osmPlaces = pgTable(
  "osm_places",
  {
    /** node, way or relation. Ids can change when an element is redrawn, so matches are redone on every import. */
    osmType: text().notNull(),
    osmId: bigint({ mode: "number" }).notNull(),
    version: integer(),
    name: text().notNull(),
    brand: text(),
    operator: text(),
    /** The tag that makes it a business we use, e.g. "amenity=dentist". */
    category: text().notNull(),
    /** Normalised: upper case, no spaces ("LS14AP"). */
    postcode: text(),
    street: text(),
    housenumber: text(),
    city: text(),
    lat: doublePrecision(),
    lon: doublePrecision(),
    phone: text(),
    website: text(),
    email: text(),
    /** `ref:GB:cqc_location`: the CQC location id, an exact link to a CQC practice. */
    cqcLocationRef: text(),
    /** The mapper's own "last checked" date, when tagged. */
    checkDate: text(),
    importedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.osmType, t.osmId] }),
    index("osm_places_postcode_idx").on(t.postcode),
    index("osm_places_cqc_idx").on(t.cqcLocationRef),
  ],
);

/**
 * A workspace's link from one of its companies (and, for a chain, one of its practices) to the
 * OpenStreetMap place it is, made only when the match is unambiguous. The contacts themselves stay
 * in `osm_places`; `verification` stays "unknown": published on OpenStreetMap, not verified by us.
 */
export const osmMatches = pgTable(
  "osm_matches",
  {
    id: id(),
    workspaceId: workspaceRef(),
    companyId: uuid().notNull(),
    /** The practice or site matched; null when the company itself (one site) was matched. */
    companyLocationId: uuid().references(() => companyLocations.id, { onDelete: "cascade" }),
    osmType: text().notNull(),
    osmId: bigint({ mode: "number" }).notNull(),
    /** cqc_ref (exact register link), postcode_name, or website (same domain). */
    method: text().notNull(),
    confidence: integer().notNull(),
    verification: contactVerification().notNull().default("unknown"),
    lastCheckedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("osm_matches_place_idx").on(t.companyId, t.osmType, t.osmId),
    uniqueIndex("osm_matches_location_idx").on(t.companyLocationId).where(sql`${t.companyLocationId} is not null`),
    index("osm_matches_workspace_idx").on(t.workspaceId),
    foreignKey({
      name: "osm_matches_company_fk",
      columns: [t.companyId, t.workspaceId],
      foreignColumns: [companies.id, companies.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "osm_matches_place_fk",
      columns: [t.osmType, t.osmId],
      foreignColumns: [osmPlaces.osmType, osmPlaces.osmId],
    }).onDelete("cascade"),
  ],
);

/**
 * The Y Combinator startup directory (every YC company), imported whole from the third-party
 * `yc-oss/api` dataset (`npm run yc -- import`, refreshed by `discover_yc` when a week old). Global:
 * no workspace data. Each workspace's `discover_yc` takes the companies matching its services into
 * `companies` (identifier `yc_company`), and the usual website and job-board reading follows.
 * Country and industry are matched on (derived columns); `regions` and `tags` are display-only.
 */
export const ycCompanies = pgTable(
  "yc_companies",
  {
    /** YC's own company id. */
    id: integer().primaryKey(),
    slug: text().notNull(),
    name: text().notNull(),
    website: text(),
    /** Registrable domain of the website ("https://www.acme.ai/" → "acme.ai"). */
    domain: text(),
    oneLiner: text(),
    longDescription: text(),
    /** As YC lists them: "San Francisco, CA, USA; New York, NY, USA". */
    locations: text(),
    /** Main country (ISO code) from YC's regions: US, GB, … null when not one we know. */
    country: text(),
    /** Our industry slug, mapped from YC's industry and subindustry. */
    industry: text(),
    ycIndustry: text(),
    ycSubindustry: text(),
    /** Display-only. */
    regions: text().array().notNull().default(sql`'{}'::text[]`),
    /** Display-only. */
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    teamSize: integer(),
    batch: text(),
    /** Active, Acquired, Inactive or Public. */
    status: text().notNull(),
    isHiring: boolean().notNull().default(false),
    topCompany: boolean().notNull().default(false),
    stage: text(),
    launchedAt: timestamp({ withTimezone: true }),
    /** The company's YC directory page. */
    url: text(),
    importedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /**
     * Its own job board, found once for every workspace (`detectYcBoards`), so its jobs join the
     * shared pool; null when none was found. Checked again after a while (`boardCheckedAt`).
     */
    boardProvider: jobBoardProvider(),
    boardToken: text(),
    boardCheckedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("yc_companies_slug_idx").on(t.slug),
    index("yc_companies_pick_idx").on(t.country, t.status, t.isHiring),
    index("yc_companies_board_idx").on(t.boardProvider, t.boardToken),
    foreignKey({
      name: "yc_companies_board_fk",
      columns: [t.boardProvider, t.boardToken],
      foreignColumns: [jobBoardDirectory.provider, jobBoardDirectory.boardToken],
    }).onDelete("set null"),
  ],
);

/**
 * TheirStack job posts, bought once for the whole platform (each costs an API credit) and shared by
 * every workspace: a post one workspace's search bought is offered to the others without another
 * credit, and the AI reads it once (`analysis`). Which workspace has looked at which post is in its
 * own `source_records` (external id "job:<id>").
 */
export const theirstackJobs = pgTable(
  "theirstack_jobs",
  {
    /** TheirStack's own job id. */
    id: bigint({ mode: "number" }).primaryKey(),
    title: text().notNull(),
    /** YYYY-MM-DD. */
    postedOn: text().notNull(),
    /** The hiring company's country (ISO code), when TheirStack knows it. */
    country: text(),
    companyDomain: text(),
    /** The post as `searchJobs` returns it (`TheirStackJob`). */
    data: jsonb().$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** The AI's one reading of the post (`SignalAnalysis`); null until read. Display/upgrade only, never matched on. */
    analysis: jsonb().$type<Record<string, unknown>>(),
    analyzedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("theirstack_jobs_posted_idx").on(t.postedOn)],
);

/**
 * A company website as last read, shared by every workspace (keyed by its domain): the pages,
 * published contacts and job-board link, and the AI's reading of its profile pages (description and
 * team) with the content they were read from. A workspace saves its own copy of what it uses
 * (contacts, people, page records); this only spares re-downloading the site and asking the AI again.
 */
export const siteReads = pgTable("site_reads", {
  domain: text().primaryKey(),
  /** `readWebsite`'s result (`SiteRead`). */
  read: jsonb().$type<Record<string, unknown>>().notNull(),
  readAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** The AI's reading (`WebsiteFacts`) of the profile pages whose content hashes are `factsFrom`. */
  facts: jsonb().$type<Record<string, unknown>>(),
  factsFrom: text(),
  factsAt: timestamp({ withTimezone: true }),
});
