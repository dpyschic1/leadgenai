import "server-only";
import type { CompanyIdentity, CompanyIdScheme, SourceSlug } from "@/lib/domain/sources";
import type { SeniorityLevel } from "@/lib/domain/people";
import { boardDirectory } from "./board-directory";
import { companiesHouse } from "./companies-house";
import { companyWebsite } from "./company-website";
import { cqc } from "./cqc";
import { nppes } from "./nppes";
import { theirStack } from "./theirstack";
import { openStreetMap } from "./osm";
import { ukTenders } from "./uk-tenders";

/**
 * The contract every data source implements (PRD §14 SourceAdapter, SRS §11.1). Capabilities are
 * optional: a register finds companies and people, a website finds people and signals, a tender
 * feed finds signals. Licensed providers (Apollo, Hunter…) plug in later by implementing the same
 * methods, plus `findContact` / `verifyContact`.
 *
 * Every result carries its provenance (`SourceRef`), so what is stored can always be traced back.
 */

/** Where a fact came from: becomes a `source_records` row. */
export type SourceRef = {
  sourceSlug: SourceSlug;
  externalId: string;
  url: string | null;
  recordType: string;
  publishedAt: Date | null;
  /** Hash of the content, to skip unchanged pages. */
  contentHash?: string | null;
  /** The minimum worth keeping (PRD §19). */
  data: Record<string, unknown>;
};

export type FoundCompany = {
  name: string;
  domain: string | null;
  industry: string | null;
  hq: { city: string | null; region: string | null; country: string | null; postalCode?: string | null } | null;
  identifiers: { scheme: CompanyIdScheme; value: string }[];
  /** How well identified the company is; defaults to verified with a registry number, else provisional. */
  identity?: CompanyIdentity;
  /** Date the company was formed (YYYY-MM-DD), if the source says. */
  foundedOn: string | null;
  record: SourceRef;
};

export type FoundPerson = {
  name: string;
  title: string | null;
  seniority: SeniorityLevel;
  jobFunction: string | null;
  relationship: "employee" | "founder" | "board_member" | "advisor";
  /** How sure the source is that this person is at this company (0-100). */
  confidence: number;
  /** A direct phone the register publishes for them (e.g. an NPI authorized official). */
  phone?: string | null;
  /** Their own email as the source publishes it (e.g. a tender's named buyer contact). */
  email?: string | null;
};

export type DiscoveryCriteria = {
  industries: string[];
  locations: string[];
  /** Only companies formed on or after this date (YYYY-MM-DD). */
  formedAfter: string | null;
  limit: number;
  /** Identifiers already known in the workspace, so results are new companies. */
  known: Set<string>;
};

export type HealthStatus = { ok: boolean; message: string };

export interface SourceAdapter {
  slug: SourceSlug;
  /** False when a required setting (e.g. an API key) is missing; the source is then skipped. */
  isConfigured(): boolean;
  healthCheck(): Promise<HealthStatus>;
  discoverCompanies?(criteria: DiscoveryCriteria): Promise<FoundCompany[]>;
  findPeople?(company: { identifiers: { scheme: CompanyIdScheme; value: string }[] }): Promise<{ people: FoundPerson[]; record: SourceRef } | null>;
}

/** The job-board adapter: the public Greenhouse/Lever/Ashby APIs in `src/server/jobs`. */
const jobBoard: SourceAdapter = {
  slug: "job_board",
  isConfigured: () => true,
  async healthCheck() {
    return { ok: true, message: "Public job-board APIs; no account needed." };
  },
};

/**
 * The FCA register stays switched off: its terms need written permission to store or redistribute
 * register data (seeded as `restricted`). Registered here only so it shows in Settings with why.
 */
const fcaRegister: SourceAdapter = {
  slug: "fca_register",
  isConfigured: () => false,
  async healthCheck() {
    return { ok: false, message: "Not used: needs the FCA's written permission for commercial reuse." };
  },
};

/** Every source adapter, by slug. Adding a provider = one adapter here + one `sources` row. */
export const SOURCE_ADAPTERS: Record<SourceSlug, SourceAdapter> = {
  companies_house: companiesHouse,
  cqc,
  company_website: companyWebsite,
  job_board: jobBoard,
  board_directory: boardDirectory,
  uk_tenders: ukTenders,
  openstreetmap: openStreetMap,
  us_npi: nppes,
  theirstack: theirStack,
  fca_register: fcaRegister,
};
