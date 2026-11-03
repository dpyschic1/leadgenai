-- Additive only: new enum values, tables, nullable columns and indexes. Hand-added at the end:
-- the new source registry rows and signal types.
CREATE TYPE "public"."board_validation" AS ENUM('unverified', 'valid', 'invalid', 'error');--> statement-breakpoint
CREATE TYPE "public"."company_identity" AS ENUM('provisional', 'partial', 'verified');--> statement-breakpoint
ALTER TYPE "public"."company_id_scheme" ADD VALUE 'gb_cqc_provider';--> statement-breakpoint
ALTER TYPE "public"."ingestion_job_kind" ADD VALUE 'discover_cqc' BEFORE 'enrich_company';--> statement-breakpoint
ALTER TYPE "public"."ingestion_job_kind" ADD VALUE 'evaluate_boards' BEFORE 'enrich_company';--> statement-breakpoint
CREATE TABLE "board_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "job_board_provider" NOT NULL,
	"board_token" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"department" text,
	"location" text,
	"url" text NOT NULL,
	"description" text,
	"posted_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "directory_crawls" (
	"provider" "job_board_provider" NOT NULL,
	"crawl_id" text NOT NULL,
	"next_page" integer DEFAULT 0 NOT NULL,
	"total_pages" integer,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_crawls_provider_crawl_id_pk" PRIMARY KEY("provider","crawl_id")
);
--> statement-breakpoint
CREATE TABLE "job_board_directory" (
	"provider" "job_board_provider" NOT NULL,
	"board_token" text NOT NULL,
	"board_name" text,
	"discovery_url" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validation_status" "board_validation" DEFAULT 'unverified' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_fetched_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "job_board_directory_provider_board_token_pk" PRIMARY KEY("provider","board_token")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "identity_status" "company_identity" DEFAULT 'verified' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_locations" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "company_locations" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "company_locations" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "company_locations" ADD COLUMN "source_slug" text;--> statement-breakpoint
ALTER TABLE "company_locations" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "board_job_id" uuid;--> statement-breakpoint
ALTER TABLE "board_jobs" ADD CONSTRAINT "board_jobs_board_fk" FOREIGN KEY ("provider","board_token") REFERENCES "public"."job_board_directory"("provider","board_token") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_jobs_external_idx" ON "board_jobs" USING btree ("provider","board_token","external_id");--> statement-breakpoint
CREATE INDEX "board_jobs_seen_idx" ON "board_jobs" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "job_board_directory_due_idx" ON "job_board_directory" USING btree ("validation_status","next_check_at");--> statement-breakpoint
ALTER TABLE "company_locations" ADD CONSTRAINT "company_locations_source_slug_sources_slug_fk" FOREIGN KEY ("source_slug") REFERENCES "public"."sources"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_board_job_id_board_jobs_id_fk" FOREIGN KEY ("board_job_id") REFERENCES "public"."board_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_job_boards_board_idx" ON "company_job_boards" USING btree ("workspace_id","provider","board_token");--> statement-breakpoint
CREATE UNIQUE INDEX "company_locations_external_idx" ON "company_locations" USING btree ("company_id","source_slug","external_id") WHERE "company_locations"."external_id" is not null;--> statement-breakpoint
-- Hand-added: sources for the CQC register, job-board discovery, and the FCA register (restricted).
INSERT INTO "sources" ("slug", "name", "type", "authorization_status", "terms_url", "notes") VALUES
  ('cqc', 'CQC care directory', 'regulator_register', 'approved', 'https://www.cqc.org.uk/about-us/transparency/using-cqc-data', 'England only. Open Government Licence v3.0: we must acknowledge we use CQC information and must not imply CQC endorsement. Weekly directory CSV (no key); the API (free key) is optional.'),
  ('board_directory', 'Job-board discovery', 'archive_index', 'approved', 'https://commoncrawl.org/terms-of-use', 'Common Crawl index suggests Greenhouse/Lever/Ashby boards; each is confirmed against the provider''s public job-board API. Not complete coverage.'),
  ('fca_register', 'FCA register', 'regulator_register', 'restricted', 'https://www.fca.org.uk/legal', 'Not used: FCA terms require prior written permission to store or redistribute register data; reseller use is a paid licence.')
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
-- Hand-added: website problems found by deterministic checks (possible problems, not buying intent).
INSERT INTO "signal_types" ("slug", "name", "category_slug") VALUES
  ('outdated_website', 'Outdated website technology', 'digital'),
  ('insecure_website', 'Website without HTTPS', 'digital'),
  ('no_online_booking', 'No online booking', 'problem')
ON CONFLICT ("slug") DO NOTHING;
