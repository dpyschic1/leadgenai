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
  "openstreetmap",
  "us_npi",
  "theirstack",
  "overture",
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
  openstreetmap: "OpenStreetMap",
  us_npi: "NPI Registry (US)",
  theirstack: "TheirStack job posts",
  overture: "Overture Maps",
  fca_register: "FCA register",
};

export const SOURCE_DESCRIPTIONS: Record<SourceSlug, string> = {
  companies_house: "Official UK company register: finds companies by industry and area, with their directors.",
  cqc: "Every dental practice, clinic and care service registered in England, with each location's website and phone. Contains CQC information, used under the Open Government Licence v3.0.",
  company_website: "Reads a company's own public pages (about, team, contact, careers, news), politely and within robots.txt.",
  job_board: "Open jobs from the company's own job board on Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Personio or Breezy HR, through their public feeds.",
  board_directory:
    "Finds Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Personio and Breezy HR boards in the Common Crawl web archive, checks each one, and keeps the jobs that match your services. Coverage is broad but not complete.",
  uk_tenders: "Public-sector contracts on Contracts Finder that match your services.",
  us_npi:
    "Every US healthcare organization registered with CMS (dental practices, clinics, therapy, optometry): each practice's address and phone, and its authorized official. Public data, no key.",
  openstreetmap:
    "Phone, website and email that businesses have on OpenStreetMap, matched carefully to your companies and their practices. Shown as published there, not verified. © OpenStreetMap contributors, ODbL.",
  theirstack:
    "Recent job posts from Indeed, LinkedIn, company career sites and ATS boards, through TheirStack (paid API, free monthly allowance). Searches only the roles your services fill, in your target countries, and skips companies already in your opportunities, so each credit buys a new lead. Needs THEIRSTACK_API_KEY.",
  overture:
    "Phone, email and website from Overture Maps places (Meta, Microsoft, Foursquare and others), matched to your companies by their own website, or a candidate website by postcode and name that is then checked on the site. © Overture Maps Foundation, CDLA Permissive 2.0.",
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
  "match_osm",
  "discover_npi",
  "discover_theirstack",
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
  match_osm: "openstreetmap",
  discover_npi: "us_npi",
  discover_theirstack: "theirstack",
};

/** The credit ODbL requires wherever OpenStreetMap data is shown or exported. */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors, available under the Open Database License (ODbL)";
export const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

/** The credit Overture Maps asks for wherever its place data is shown (CDLA Permissive 2.0). */
export const OVERTURE_ATTRIBUTION_URL = "https://docs.overturemaps.org/attribution/";

export const INGESTION_JOB_STATUSES = ["queued", "running", "done", "failed", "skipped"] as const;
export type IngestionJobStatus = (typeof INGESTION_JOB_STATUSES)[number];

/** Identifier schemes for `company_identifiers`. */
export const COMPANY_ID_SCHEMES = ["gb_company_number", "gb_cqc_provider", "us_npi"] as const;
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
