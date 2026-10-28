-- Hand-edited: Postgres truncated these generated names to 63 chars in 0002, so rename the
-- truncated constraints instead of dropping (non-existent) full names and re-adding them.
ALTER TABLE "service_service_categories" RENAME CONSTRAINT "service_service_categories_category_slug_service_categories_slu" TO "service_service_categories_category_fk";
--> statement-breakpoint
ALTER TABLE "service_target_job_functions" RENAME CONSTRAINT "service_target_job_functions_job_function_slug_job_functions_sl" TO "service_target_job_functions_job_function_fk";
--> statement-breakpoint
ALTER TABLE "signal_service_categories" RENAME CONSTRAINT "signal_service_categories_category_slug_service_categories_slug" TO "signal_service_categories_category_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "company_people" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_opportunities" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "location_count";--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "country";--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "city";--> statement-breakpoint
ALTER TABLE "company_locations" DROP COLUMN "location_type";--> statement-breakpoint
ALTER TABLE "opportunity_signals" DROP COLUMN "relationship";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "seniority";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "phone";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "contact_verification";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "contact_verified_at";--> statement-breakpoint
ALTER TABLE "services" DROP COLUMN "categories";--> statement-breakpoint
ALTER TABLE "services" DROP COLUMN "capabilities";--> statement-breakpoint
ALTER TABLE "services" DROP COLUMN "target_roles";--> statement-breakpoint
ALTER TABLE "services" DROP COLUMN "target_industries";--> statement-breakpoint
ALTER TABLE "services" DROP COLUMN "target_countries";--> statement-breakpoint
ALTER TABLE "signals" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "signals" DROP COLUMN "service_categories";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "status";--> statement-breakpoint
DROP TYPE "public"."signal_category";--> statement-breakpoint
DROP TYPE "public"."user_status";