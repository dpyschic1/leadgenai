/**
 * Where automatically gathered data comes from (PRD §14, SRS §11). Each source is one adapter in
 * `src/server/sources`; the database enums and the seeded `sources` rows use these slugs.
 */

export const SOURCE_SLUGS = [
  "companies_house",
  "cqc",
  "company_website",
  "job_board",
  "board_directory",
  "uk_tenders",
  "fca_register",
] as const;
export type SourceSlug = (typeof SOURCE_SLUGS)[number];

export const SOURCE_LABELS: Record<SourceSlug, string> = {
  companies_house: "Companies House",
  cqc: "CQC care directory",
  company_website: "Company website",
  job_board: "Job boards",
  board_directory: "Job-board discovery",
  uk_tenders: "UK public tenders",
  fca_register: "FCA register",
};

export const SOURCE_DESCRIPTIONS: Record<SourceSlug, string> = {
  companies_house: "Official UK company register: finds companies by industry and area, with their directors.",
  cqc: "Every dental practice, clinic and care service registered in England, with each location's website and phone. Contains CQC information, used under the Open Government Licence v3.0.",
  company_website: "Reads a company's own public pages (about, team, contact, careers, news), politely and within robots.txt.",
  job_board: "Open jobs from the company's Greenhouse, Lever or Ashby board, through their public APIs.",
  board_directory:
    "Finds Greenhouse, Lever and Ashby boards in the Common Crawl web archive, checks each one, and keeps the jobs that match your services. Coverage is broad but not complete.",
  uk_tenders: "Public-sector contracts on Contracts Finder that match your services.",
  fca_register: "Financial firms and approved people. Not used: the FCA's terms need written permission to store or redistribute register data.",
};

/** Platform-level permission to run a source (SRS §11.3). Only `approved` sources run. */
export const SOURCE_AUTHORIZATIONS = ["approved", "restricted", "pending_review", "disabled"] as const;
export type SourceAuthorization = (typeof SOURCE_AUTHORIZATIONS)[number];

/** Work items processed in the background (Spec §11). */
export const INGESTION_JOB_KINDS = [
  "discover_companies",
  "discover_cqc",
  "evaluate_boards",
  "enrich_company",
  "scan_website",
  "scan_job_board",
  "scan_tenders",
] as const;
export type IngestionJobKind = (typeof INGESTION_JOB_KINDS)[number];

/** The source each kind of job uses, for health and per-workspace switches. */
export const JOB_KIND_SOURCE: Record<IngestionJobKind, SourceSlug> = {
  discover_companies: "companies_house",
  discover_cqc: "cqc",
  evaluate_boards: "board_directory",
  enrich_company: "companies_house",
  scan_website: "company_website",
  scan_job_board: "job_board",
  scan_tenders: "uk_tenders",
};

export const INGESTION_JOB_STATUSES = ["queued", "running", "done", "failed", "skipped"] as const;
export type IngestionJobStatus = (typeof INGESTION_JOB_STATUSES)[number];

/** Identifier schemes for `company_identifiers`. */
export const COMPANY_ID_SCHEMES = ["gb_company_number", "gb_cqc_provider"] as const;
export type CompanyIdScheme = (typeof COMPANY_ID_SCHEMES)[number];

/**
 * How sure we are that a company record is the real, identified business:
 * - `provisional`: known only from one source's own name for it (e.g. a job board's name)
 * - `partial`: its official website is confirmed by evidence, but no registry number yet
 * - `verified`: matched to an official register number, or entered by a person
 */
export const COMPANY_IDENTITIES = ["provisional", "partial", "verified"] as const;
export type CompanyIdentity = (typeof COMPANY_IDENTITIES)[number];

export const COMPANY_IDENTITY_LABELS: Record<CompanyIdentity, string> = {
  provisional: "Provisional",
  partial: "Partly verified",
  verified: "Verified",
};

/** Whether a job board found in the archive is real: checked against the provider's own endpoint. */
export const BOARD_VALIDATIONS = ["unverified", "valid", "invalid", "error"] as const;
export type BoardValidation = (typeof BOARD_VALIDATIONS)[number];
