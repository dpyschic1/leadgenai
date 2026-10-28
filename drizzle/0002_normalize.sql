CREATE TYPE "public"."company_relationship" AS ENUM('employee', 'founder', 'owner', 'board_member', 'advisor', 'contractor', 'investor');--> statement-breakpoint
CREATE TYPE "public"."contact_point_type" AS ENUM('email', 'phone');--> statement-breakpoint
CREATE TYPE "public"."location_type" AS ENUM('headquarters', 'office', 'branch', 'store', 'warehouse', 'other');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('invited', 'active', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."seniority_level" AS ENUM('owner', 'c_level', 'vp', 'director', 'manager', 'senior', 'entry', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."signal_role" AS ENUM('primary', 'corroborating', 'negative');--> statement-breakpoint
CREATE TABLE "contact_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"type" "contact_point_type" NOT NULL,
	"value" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verification" "contact_verification" DEFAULT 'unknown' NOT NULL,
	"verified_at" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "industries" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_functions" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_types" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_categories" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_service_categories" (
	"service_id" uuid NOT NULL,
	"category_slug" text NOT NULL,
	CONSTRAINT "service_service_categories_service_id_category_slug_pk" PRIMARY KEY("service_id","category_slug")
);
--> statement-breakpoint
CREATE TABLE "service_target_countries" (
	"service_id" uuid NOT NULL,
	"country_code" text NOT NULL,
	CONSTRAINT "service_target_countries_service_id_country_code_pk" PRIMARY KEY("service_id","country_code"),
	CONSTRAINT "service_target_countries_code_chk" CHECK ("country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "service_target_industries" (
	"service_id" uuid NOT NULL,
	"industry_slug" text NOT NULL,
	CONSTRAINT "service_target_industries_service_id_industry_slug_pk" PRIMARY KEY("service_id","industry_slug")
);
--> statement-breakpoint
CREATE TABLE "service_target_job_functions" (
	"service_id" uuid NOT NULL,
	"job_function_slug" text NOT NULL,
	CONSTRAINT "service_target_job_functions_service_id_job_function_slug_pk" PRIMARY KEY("service_id","job_function_slug")
);
--> statement-breakpoint
CREATE TABLE "signal_categories" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_service_categories" (
	"signal_id" uuid NOT NULL,
	"category_slug" text NOT NULL,
	CONSTRAINT "signal_service_categories_signal_id_category_slug_pk" PRIMARY KEY("signal_id","category_slug")
);
--> statement-breakpoint
CREATE TABLE "signal_types" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category_slug" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "company_people" DROP CONSTRAINT "company_people_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "company_people" DROP CONSTRAINT "company_people_person_id_people_id_fk";
--> statement-breakpoint
ALTER TABLE "opportunities" DROP CONSTRAINT "opportunities_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "opportunities" DROP CONSTRAINT "opportunities_primary_person_id_people_id_fk";
--> statement-breakpoint
ALTER TABLE "opportunities" DROP CONSTRAINT "opportunities_service_id_services_id_fk";
--> statement-breakpoint
ALTER TABLE "opportunity_signals" DROP CONSTRAINT "opportunity_signals_opportunity_id_opportunities_id_fk";
--> statement-breakpoint
ALTER TABLE "opportunity_signals" DROP CONSTRAINT "opportunity_signals_signal_id_signals_id_fk";
--> statement-breakpoint
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_service_id_services_id_fk";
--> statement-breakpoint
ALTER TABLE "saved_opportunities" DROP CONSTRAINT "saved_opportunities_list_id_lists_id_fk";
--> statement-breakpoint
ALTER TABLE "saved_opportunities" DROP CONSTRAINT "saved_opportunities_opportunity_id_opportunities_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "signals" DROP CONSTRAINT "signals_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "signals" DROP CONSTRAINT "signals_person_id_people_id_fk";
--> statement-breakpoint
-- Hand-ordered: the text default can't be cast in place, so drop it, convert, then re-add.
ALTER TABLE "company_people" ALTER COLUMN "relationship" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "company_people" ALTER COLUMN "relationship" SET DATA TYPE "public"."company_relationship" USING "relationship"::"public"."company_relationship";--> statement-breakpoint
ALTER TABLE "company_people" ALTER COLUMN "relationship" SET DEFAULT 'employee'::"public"."company_relationship";--> statement-breakpoint
ALTER TABLE "company_locations" ADD COLUMN "type" "location_type" DEFAULT 'office' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_people" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "company_people" ADD COLUMN "seniority" "seniority_level" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_people" ADD COLUMN "job_function" text;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD COLUMN "role" "signal_role" DEFAULT 'corroborating' NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_opportunities" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_service_categories" ADD CONSTRAINT "service_service_categories_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_service_categories" ADD CONSTRAINT "service_service_categories_category_slug_service_categories_slug_fk" FOREIGN KEY ("category_slug") REFERENCES "public"."service_categories"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_target_countries" ADD CONSTRAINT "service_target_countries_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_target_industries" ADD CONSTRAINT "service_target_industries_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_target_industries" ADD CONSTRAINT "service_target_industries_industry_slug_industries_slug_fk" FOREIGN KEY ("industry_slug") REFERENCES "public"."industries"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_target_job_functions" ADD CONSTRAINT "service_target_job_functions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_target_job_functions" ADD CONSTRAINT "service_target_job_functions_job_function_slug_job_functions_slug_fk" FOREIGN KEY ("job_function_slug") REFERENCES "public"."job_functions"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_service_categories" ADD CONSTRAINT "signal_service_categories_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_service_categories" ADD CONSTRAINT "signal_service_categories_category_slug_service_categories_slug_fk" FOREIGN KEY ("category_slug") REFERENCES "public"."service_categories"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_types" ADD CONSTRAINT "signal_types_category_slug_signal_categories_slug_fk" FOREIGN KEY ("category_slug") REFERENCES "public"."signal_categories"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_points_person_value_idx" ON "contact_points" USING btree ("person_id","type","value");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_points_one_primary_idx" ON "contact_points" USING btree ("person_id","type") WHERE "contact_points"."is_primary";--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_industry_industries_slug_fk" FOREIGN KEY ("industry") REFERENCES "public"."industries"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_people" ADD CONSTRAINT "company_people_job_function_job_functions_slug_fk" FOREIGN KEY ("job_function") REFERENCES "public"."job_functions"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-moved: composite FKs below need these UNIQUE (id, workspace_id) targets to exist first.
ALTER TABLE "companies" ADD CONSTRAINT "companies_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "company_people" ADD CONSTRAINT "company_people_company_fk" FOREIGN KEY ("company_id","workspace_id") REFERENCES "public"."companies"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_people" ADD CONSTRAINT "company_people_person_fk" FOREIGN KEY ("person_id","workspace_id") REFERENCES "public"."people"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_type_opportunity_types_slug_fk" FOREIGN KEY ("type") REFERENCES "public"."opportunity_types"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_company_fk" FOREIGN KEY ("company_id","workspace_id") REFERENCES "public"."companies"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_person_fk" FOREIGN KEY ("primary_person_id","workspace_id") REFERENCES "public"."people"("id","workspace_id") ON DELETE SET NULL ("primary_person_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_service_fk" FOREIGN KEY ("service_id","workspace_id") REFERENCES "public"."services"("id","workspace_id") ON DELETE SET NULL ("service_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_opportunity_fk" FOREIGN KEY ("opportunity_id","workspace_id") REFERENCES "public"."opportunities"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_signal_fk" FOREIGN KEY ("signal_id","workspace_id") REFERENCES "public"."signals"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_service_fk" FOREIGN KEY ("service_id","workspace_id") REFERENCES "public"."services"("id","workspace_id") ON DELETE SET NULL ("service_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_opportunities" ADD CONSTRAINT "saved_opportunities_list_fk" FOREIGN KEY ("list_id","workspace_id") REFERENCES "public"."lists"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_opportunities" ADD CONSTRAINT "saved_opportunities_opportunity_fk" FOREIGN KEY ("opportunity_id","workspace_id") REFERENCES "public"."opportunities"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_members"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_signal_type_signal_types_slug_fk" FOREIGN KEY ("signal_type") REFERENCES "public"."signal_types"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_company_fk" FOREIGN KEY ("company_id","workspace_id") REFERENCES "public"."companies"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_person_fk" FOREIGN KEY ("person_id","workspace_id") REFERENCES "public"."people"("id","workspace_id") ON DELETE SET NULL ("person_id") ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_locations_one_hq_idx" ON "company_locations" USING btree ("company_id") WHERE "company_locations"."type" = 'headquarters';--> statement-breakpoint
CREATE INDEX "company_people_person_idx" ON "company_people" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "opportunity_signals_signal_idx" ON "opportunity_signals" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "saved_opportunities_opportunity_idx" ON "saved_opportunities" USING btree ("opportunity_id");--> statement-breakpoint
ALTER TABLE "company_locations" ADD CONSTRAINT "company_locations_country_chk" CHECK ("country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_company_size_chk" CHECK ("services"."target_company_size_min" is null or "services"."target_company_size_max" is null or "services"."target_company_size_min" <= "services"."target_company_size_max");--> statement-breakpoint
-- Hand-written data migration: carry existing rows into the normalized structure.
-- The old columns are dropped in a later migration, after this has run.
-- Array columns (services.*, signals.service_categories) are not carried over: their lookup
-- tables are seeded in 0003 and both tables were empty when this was written.
INSERT INTO "workspace_members" ("workspace_id", "user_id", "role", "status", "created_at", "updated_at")
SELECT "workspace_id", "id", "role", "status"::text::"membership_status", "created_at", "updated_at" FROM "users";--> statement-breakpoint
UPDATE "sessions" s SET "workspace_id" = u."workspace_id" FROM "users" u WHERE u."id" = s."user_id";--> statement-breakpoint
UPDATE "company_people" cp SET "workspace_id" = c."workspace_id" FROM "companies" c WHERE c."id" = cp."company_id";--> statement-breakpoint
UPDATE "company_people" cp SET "title" = COALESCE(cp."title", p."title") FROM "people" p WHERE p."id" = cp."person_id";--> statement-breakpoint
UPDATE "opportunity_signals" os
SET "workspace_id" = o."workspace_id",
    "role" = CASE WHEN os."relationship" IN ('primary', 'corroborating', 'negative')
                  THEN os."relationship"::"signal_role" ELSE 'corroborating' END
FROM "opportunities" o WHERE o."id" = os."opportunity_id";--> statement-breakpoint
UPDATE "saved_opportunities" so SET "workspace_id" = l."workspace_id" FROM "lists" l WHERE l."id" = so."list_id";--> statement-breakpoint
UPDATE "company_locations"
SET "type" = CASE WHEN "location_type" IN ('headquarters', 'office', 'branch', 'store', 'warehouse')
                  THEN "location_type"::"location_type" ELSE 'other' END
WHERE "location_type" IS NOT NULL;--> statement-breakpoint
INSERT INTO "company_locations" ("company_id", "type", "city", "country")
SELECT "id", 'headquarters', "city", CASE WHEN upper("country") ~ '^[A-Z]{2}$' THEN upper("country") END
FROM "companies" c
WHERE ("city" IS NOT NULL OR "country" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "company_locations" l WHERE l."company_id" = c."id" AND l."type" = 'headquarters');--> statement-breakpoint
INSERT INTO "contact_points" ("person_id", "type", "value", "is_primary", "verification", "verified_at")
SELECT "id", 'email', "email", true, "contact_verification", "contact_verified_at" FROM "people" WHERE "email" IS NOT NULL;--> statement-breakpoint
INSERT INTO "contact_points" ("person_id", "type", "value", "is_primary")
SELECT "id", 'phone', "phone", true FROM "people" WHERE "phone" IS NOT NULL;
