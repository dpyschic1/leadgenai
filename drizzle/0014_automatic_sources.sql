-- Hand-edited (see the comments below): SET NULL column lists on composite FKs, the enum value
-- added only if missing, and the seeded source registry.
CREATE TYPE "public"."company_id_scheme" AS ENUM('gb_company_number');--> statement-breakpoint
CREATE TYPE "public"."ingestion_job_kind" AS ENUM('discover_companies', 'enrich_company', 'scan_website', 'scan_job_board', 'scan_tenders');--> statement-breakpoint
CREATE TYPE "public"."ingestion_job_status" AS ENUM('queued', 'running', 'done', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."source_authorization" AS ENUM('approved', 'restricted', 'pending_review', 'disabled');--> statement-breakpoint
ALTER TYPE "public"."signal_source" ADD VALUE IF NOT EXISTS 'provider';--> statement-breakpoint
CREATE TABLE "company_contact_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" "contact_point_type" NOT NULL,
	"value" text NOT NULL,
	"source_slug" text,
	"source_url" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_identifiers" (
	"workspace_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"scheme" "company_id_scheme" NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "company_identifiers_company_id_scheme_pk" PRIMARY KEY("company_id","scheme")
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "ingestion_job_kind" NOT NULL,
	"entity_id" uuid NOT NULL,
	"status" "ingestion_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"ai_calls" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_slug" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"record_type" text NOT NULL,
	"published_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text,
	"company_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "source_records_id_workspace_uq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"authorization_status" "source_authorization" DEFAULT 'pending_review' NOT NULL,
	"terms_url" text,
	"notes" text
);
--> statement-breakpoint
-- Hand-added: the source registry (one row per adapter in src/server/sources).
INSERT INTO "sources" ("slug", "name", "type", "authorization_status", "terms_url", "notes") VALUES
  ('companies_house', 'Companies House', 'company_registry', 'approved', 'https://developer-specs.company-information.service.gov.uk/', 'Official UK register, Open Government Licence. Free API key; 600 requests per 5 minutes.'),
  ('company_website', 'Company website', 'company_website', 'approved', NULL, 'The company''s own public pages only. robots.txt respected, one request a second per site, at most a few pages per visit; only extracted facts are kept.'),
  ('job_board', 'Job boards', 'job_api', 'approved', NULL, 'Public job-board APIs published by Greenhouse, Lever and Ashby for this purpose.'),
  ('uk_tenders', 'UK public tenders', 'procurement', 'approved', 'https://www.contractsfinder.service.gov.uk/apidocumentation', 'Contracts Finder public API, Open Government Licence.')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
CREATE TABLE "workspace_sources" (
	"workspace_id" uuid NOT NULL,
	"source_slug" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_sources_workspace_id_source_slug_pk" PRIMARY KEY("workspace_id","source_slug")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "source_slug" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "discovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_job_boards" ADD COLUMN "auto_detected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_people" ADD COLUMN "source_slug" text;--> statement-breakpoint
ALTER TABLE "company_people" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "source_record_id" uuid;--> statement-breakpoint
ALTER TABLE "company_contact_points" ADD CONSTRAINT "company_contact_points_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_contact_points" ADD CONSTRAINT "company_contact_points_source_slug_sources_slug_fk" FOREIGN KEY ("source_slug") REFERENCES "public"."sources"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_identifiers" ADD CONSTRAINT "company_identifiers_company_fk" FOREIGN KEY ("company_id","workspace_id") REFERENCES "public"."companies"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_source_slug_sources_slug_fk" FOREIGN KEY ("source_slug") REFERENCES "public"."sources"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_company_fk" FOREIGN KEY ("company_id","workspace_id") REFERENCES "public"."companies"("id","workspace_id") ON DELETE SET NULL ("company_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_sources" ADD CONSTRAINT "workspace_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_sources" ADD CONSTRAINT "workspace_sources_source_slug_sources_slug_fk" FOREIGN KEY ("source_slug") REFERENCES "public"."sources"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_contact_points_value_idx" ON "company_contact_points" USING btree ("company_id","type","value");--> statement-breakpoint
CREATE UNIQUE INDEX "company_identifiers_value_idx" ON "company_identifiers" USING btree ("workspace_id","scheme","value");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_due_idx" ON "ingestion_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_jobs_open_idx" ON "ingestion_jobs" USING btree ("workspace_id","kind","entity_id") WHERE "ingestion_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_external_idx" ON "source_records" USING btree ("workspace_id","source_slug","external_id");--> statement-breakpoint
CREATE INDEX "source_records_company_idx" ON "source_records" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_source_slug_sources_slug_fk" FOREIGN KEY ("source_slug") REFERENCES "public"."sources"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_people" ADD CONSTRAINT "company_people_source_slug_sources_slug_fk" FOREIGN KEY ("source_slug") REFERENCES "public"."sources"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_source_record_fk" FOREIGN KEY ("source_record_id","workspace_id") REFERENCES "public"."source_records"("id","workspace_id") ON DELETE SET NULL ("source_record_id") ON UPDATE no action;