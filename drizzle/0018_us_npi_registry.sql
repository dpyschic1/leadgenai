ALTER TYPE "public"."company_id_scheme" ADD VALUE 'us_npi';--> statement-breakpoint
ALTER TYPE "public"."ingestion_job_kind" ADD VALUE 'discover_npi';--> statement-breakpoint
-- Hand-added: the US NPI Registry source (public data from CMS's own API, no key).
INSERT INTO "sources" ("slug", "name", "type", "authorization_status", "terms_url", "notes") VALUES
  ('us_npi', 'NPI Registry (US)', 'regulator_register', 'approved', 'https://npiregistry.cms.hhs.gov/', 'NPPES data is public (disclosable under FOIA, no charge). API limits: 200 results per request, 1,200 per query, an hourly query limit; bulk use must use the monthly download file. No website or email in the data. US outreach laws (CAN-SPAM, TCPA) apply to how contacts are used.')
ON CONFLICT ("slug") DO NOTHING;
