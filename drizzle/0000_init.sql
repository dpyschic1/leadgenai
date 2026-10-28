CREATE TYPE "public"."contact_verification" AS ENUM('valid', 'invalid', 'accept_all', 'webmail', 'disposable', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."evidence_label" AS ENUM('observed', 'derived', 'inferred', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."identity_status" AS ENUM('resolved', 'ambiguous', 'unresolved', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."intent_level" AS ENUM('explicit', 'high', 'medium', 'low', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('new', 'qualified', 'saved', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."signal_category" AS ENUM('explicit_buying', 'problem', 'company_event', 'workforce', 'digital');--> statement-breakpoint
CREATE TYPE "public"."urgency_level" AS ENUM('high', 'medium', 'low', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'manager', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'deactivated');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_name" text NOT NULL,
	"domain" text,
	"industry" text,
	"employee_count" integer,
	"revenue_range" text,
	"location_count" integer,
	"country" text,
	"city" text,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"address" text,
	"city" text,
	"region" text,
	"country" text,
	"postal_code" text,
	"location_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_people" (
	"company_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"relationship" text DEFAULT 'employee' NOT NULL,
	"title" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"confidence" integer,
	CONSTRAINT "company_people_company_id_person_id_pk" PRIMARY KEY("company_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"primary_person_id" uuid,
	"service_id" uuid,
	"type" text NOT NULL,
	"problem" text,
	"business_impact" text,
	"desired_outcome" text,
	"requirements" text[] DEFAULT '{}'::text[] NOT NULL,
	"urgency" "urgency_level" DEFAULT 'unknown' NOT NULL,
	"why_now" text[] DEFAULT '{}'::text[] NOT NULL,
	"suggested_action" text,
	"notes" text,
	"intent_score" integer,
	"icp_score" integer,
	"identity_confidence" integer,
	"service_fit" integer,
	"opportunity_score" integer,
	"score_factors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "opportunity_status" DEFAULT 'new' NOT NULL,
	"latest_signal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_signals" (
	"opportunity_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"weight" integer,
	"relationship" text DEFAULT 'corroborating' NOT NULL,
	CONSTRAINT "opportunity_signals_opportunity_id_signal_id_pk" PRIMARY KEY("opportunity_id","signal_id")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"seniority" text,
	"location" text,
	"professional_url" text,
	"email" text,
	"phone" text,
	"contact_verification" "contact_verification" DEFAULT 'unknown' NOT NULL,
	"contact_verified_at" timestamp with time zone,
	"identity_status" "identity_status" DEFAULT 'unresolved' NOT NULL,
	"identity_confidence" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"service_id" uuid,
	"name" text NOT NULL,
	"query" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_opportunities" (
	"list_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_opportunities_list_id_opportunity_id_pk" PRIMARY KEY("list_id","opportunity_id")
);
--> statement-breakpoint
CREATE TABLE "scoring_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_industries" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_company_size_min" integer,
	"target_company_size_max" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"source_url" text,
	"excerpt" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"person_id" uuid,
	"category" "signal_category" NOT NULL,
	"signal_type" text NOT NULL,
	"intent_level" "intent_level" DEFAULT 'unknown' NOT NULL,
	"urgency" "urgency_level" DEFAULT 'unknown' NOT NULL,
	"service_categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"summary" text NOT NULL,
	"evidence_label" "evidence_label" DEFAULT 'observed' NOT NULL,
	"confidence" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_locations" ADD CONSTRAINT "company_locations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_people" ADD CONSTRAINT "company_people_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_people" ADD CONSTRAINT "company_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_primary_person_id_people_id_fk" FOREIGN KEY ("primary_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_opportunities" ADD CONSTRAINT "saved_opportunities_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_opportunities" ADD CONSTRAINT "saved_opportunities_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_profiles" ADD CONSTRAINT "scoring_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_workspace_created_idx" ON "audit_logs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "companies_workspace_idx" ON "companies" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_workspace_domain_idx" ON "companies" USING btree ("workspace_id","domain");--> statement-breakpoint
CREATE INDEX "company_locations_company_idx" ON "company_locations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "lists_workspace_idx" ON "lists" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "opportunities_workspace_status_idx" ON "opportunities" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "opportunities_workspace_score_idx" ON "opportunities" USING btree ("workspace_id","opportunity_score");--> statement-breakpoint
CREATE INDEX "opportunities_company_idx" ON "opportunities" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "people_workspace_idx" ON "people" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "recipes_workspace_idx" ON "recipes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "scoring_profiles_workspace_idx" ON "scoring_profiles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "services_workspace_idx" ON "services" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "signal_evidence_signal_idx" ON "signal_evidence" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "signals_workspace_idx" ON "signals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "signals_company_idx" ON "signals" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");