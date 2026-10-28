/**
 * Core data model for the LeadGenAI MVP (PRD §13).
 *
 * MVP scope: no automated ingestion. Companies, people and signals are entered
 * manually, so the ingestion-only entities from the PRD (sources, source_records,
 * enrichment_jobs, provider_accounts, recipes) are intentionally omitted.
 * Funding and job signals are stored as `signals` with structured `metadata`.
 *
 * Column names are camelCase here and snake_case in Postgres (casing: "snake_case").
 */
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum("user_role", ["owner", "admin", "member"]);
export const userStatus = pgEnum("user_status", ["invited", "active", "deactivated"]);

/** Top-level groups from the signal taxonomy (PRD §10). */
export const signalCategory = pgEnum("signal_category", [
  "explicit_buying",
  "problem",
  "company_event",
  "workforce",
  "digital",
]);

export const intentLevel = pgEnum("intent_level", ["explicit", "implicit"]);

/** How well a claim is supported (PRD §9). */
export const evidenceLabel = pgEnum("evidence_label", [
  "observed",
  "derived",
  "inferred",
  "unknown",
]);

/** Opportunity lifecycle (PRD §9). */
export const opportunityStatus = pgEnum("opportunity_status", [
  "detected",
  "analyzing",
  "qualified",
  "saved",
  "contacted",
  "replied",
  "meeting",
  "proposal",
  "won",
  "lost",
]);

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

// ---------------------------------------------------------------------------
// Tenancy
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

export const users = pgTable(
  "users",
  {
    id: id(),
    workspaceId: workspaceRef(),
    email: text().notNull(),
    name: text(),
    role: userRole().notNull().default("member"),
    status: userStatus().notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
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
    industry: text(),
    employeeCount: integer(),
    revenueRange: text(),
    locationCount: integer(),
    country: text(),
    city: text(),
    description: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("companies_workspace_idx").on(t.workspaceId),
    uniqueIndex("companies_workspace_domain_idx").on(t.workspaceId, t.domain),
  ],
);

export const people = pgTable(
  "people",
  {
    id: id(),
    workspaceId: workspaceRef(),
    name: text().notNull(),
    title: text(),
    seniority: text(),
    location: text(),
    professionalUrl: text(),
    email: text(),
    phone: text(),
    /** When contact details were last verified; null = unverified (PRD §13 freshness rule). */
    contactVerifiedAt: timestamp({ withTimezone: true }),
    identityConfidence: score(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("people_workspace_idx").on(t.workspaceId)],
);

export const companyPeople = pgTable(
  "company_people",
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    personId: uuid()
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    relationship: text().notNull().default("employee"),
    title: text(),
    startedAt: timestamp({ withTimezone: true }),
    endedAt: timestamp({ withTimezone: true }),
    confidence: score(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.personId] })],
);

// ---------------------------------------------------------------------------
// Signals & evidence
// ---------------------------------------------------------------------------

export const signals = pgTable(
  "signals",
  {
    id: id(),
    workspaceId: workspaceRef(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    personId: uuid().references(() => people.id, { onDelete: "set null" }),
    category: signalCategory().notNull(),
    /** Specific type within the category, e.g. "website_redesign_request", "funding", "hiring_surge". */
    signalType: text().notNull(),
    intentLevel: intentLevel().notNull().default("implicit"),
    summary: text().notNull(),
    evidenceLabel: evidenceLabel().notNull().default("observed"),
    confidence: score(),
    /** Type-specific details, e.g. { round, amount, currency } for funding. */
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** When the underlying event happened / was published. Drives recency. */
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("signals_workspace_idx").on(t.workspaceId),
    index("signals_company_idx").on(t.companyId),
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

export const services = pgTable(
  "services",
  {
    id: id(),
    workspaceId: workspaceRef(),
    name: text().notNull(),
    categories: text().array().notNull().default(sql`'{}'::text[]`),
    capabilities: text().array().notNull().default(sql`'{}'::text[]`),
    targetRoles: text().array().notNull().default(sql`'{}'::text[]`),
    targetIndustries: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("services_workspace_idx").on(t.workspaceId)],
);

/** Score weights and ICP criteria (PRD §12). One active profile per workspace for MVP. */
export const scoringProfiles = pgTable(
  "scoring_profiles",
  {
    id: id(),
    workspaceId: workspaceRef(),
    name: text().notNull(),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("scoring_profiles_workspace_idx").on(t.workspaceId)],
);

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export const opportunities = pgTable(
  "opportunities",
  {
    id: id(),
    workspaceId: workspaceRef(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    primaryPersonId: uuid().references(() => people.id, { onDelete: "set null" }),
    serviceId: uuid().references(() => services.id, { onDelete: "set null" }),
    /** e.g. "website_redesign", "staff_augmentation", "bpo", "rpo", "mvp", "rfp". */
    type: text().notNull(),
    problem: text(),
    whyNow: text().array().notNull().default(sql`'{}'::text[]`),
    suggestedAction: text(),
    notes: text(),
    intentScore: score(),
    icpScore: score(),
    identityConfidence: score(),
    serviceFit: score(),
    /** Prioritization score, not a purchase probability (PRD §12). */
    opportunityScore: score(),
    status: opportunityStatus().notNull().default("qualified"),
    latestSignalAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("opportunities_workspace_status_idx").on(t.workspaceId, t.status),
    index("opportunities_workspace_score_idx").on(t.workspaceId, t.opportunityScore),
    index("opportunities_company_idx").on(t.companyId),
  ],
);

export const opportunitySignals = pgTable(
  "opportunity_signals",
  {
    opportunityId: uuid()
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    signalId: uuid()
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    weight: integer(),
    /** e.g. "primary", "corroborating", "negative". */
    relationship: text().notNull().default("corroborating"),
  },
  (t) => [primaryKey({ columns: [t.opportunityId, t.signalId] })],
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
  },
  (t) => [index("lists_workspace_idx").on(t.workspaceId)],
);

export const savedOpportunities = pgTable(
  "saved_opportunities",
  {
    listId: uuid()
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    opportunityId: uuid()
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.listId, t.opportunityId] })],
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
