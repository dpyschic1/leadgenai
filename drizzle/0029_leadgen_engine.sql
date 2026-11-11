CREATE TYPE "public"."engine_capability" AS ENUM('intent', 'funded', 'freelance');--> statement-breakpoint
CREATE TYPE "public"."opportunity_category" AS ENUM('intent', 'funded_company', 'freelance_project');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('verified', 'unverified', 'unavailable');--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"capability" "engine_capability" NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "run_status",
	"found" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "discovery_runs_id_workspace_uq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "engine_capabilities" (
	"workspace_id" uuid NOT NULL,
	"capability" "engine_capability" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"frequency_minutes" integer NOT NULL,
	"target_countries" text[],
	"target_industries" text[],
	"target_service_ids" uuid[],
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_status" "run_status",
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engine_capabilities_workspace_id_capability_pk" PRIMARY KEY("workspace_id","capability"),
	CONSTRAINT "engine_capabilities_frequency_chk" CHECK ("engine_capabilities"."frequency_minutes" between 15 and 10080)
);
--> statement-breakpoint
CREATE TABLE "engine_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_discoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"run_id" uuid,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"change" text NOT NULL,
	"changed_fields" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"source_slug" text NOT NULL,
	"platform" text NOT NULL,
	"url" text,
	"snippet" text,
	"verification" "verification_status" DEFAULT 'unverified' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunities" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "category" "opportunity_category";--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "buyer_name" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "buyer_profile_url" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "source_slug" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "source_external_id" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "budget_min" integer;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "budget_max" integer;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "budget_currency" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "budget_usd" integer;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "funding_amount_usd" bigint;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "funding_stage" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "funding_date" date;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "investors" text[];--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "intent_level" "intent_level";--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "verification" "verification_status" DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "discovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_capabilities" ADD CONSTRAINT "engine_capabilities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_settings" ADD CONSTRAINT "engine_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_discoveries" ADD CONSTRAINT "opportunity_discoveries_opportunity_fk" FOREIGN KEY ("opportunity_id","workspace_id") REFERENCES "public"."opportunities"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_discoveries" ADD CONSTRAINT "opportunity_discoveries_run_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."discovery_runs"("id","workspace_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_evidence" ADD CONSTRAINT "opportunity_evidence_opportunity_fk" FOREIGN KEY ("opportunity_id","workspace_id") REFERENCES "public"."opportunities"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_runs_workspace_idx" ON "discovery_runs" USING btree ("workspace_id","capability","started_at");--> statement-breakpoint
CREATE INDEX "opportunity_discoveries_opportunity_idx" ON "opportunity_discoveries" USING btree ("opportunity_id","seen_at");--> statement-breakpoint
CREATE INDEX "opportunity_evidence_opportunity_idx" ON "opportunity_evidence" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_evidence_ref_uq" ON "opportunity_evidence" USING btree ("opportunity_id","source_slug","url");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_source_uq" ON "opportunities" USING btree ("workspace_id","source_slug","source_external_id") WHERE "opportunities"."source_external_id" is not null;--> statement-breakpoint
CREATE INDEX "opportunities_workspace_category_idx" ON "opportunities" USING btree ("workspace_id","category");--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_country_chk" CHECK ("opportunities"."country" is null or "opportunities"."country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_identity_chk" CHECK ("opportunities"."company_id" is not null or "opportunities"."category" is not null);