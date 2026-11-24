ALTER TABLE "services" DROP CONSTRAINT "services_client_types_chk";--> statement-breakpoint
-- Freelance projects were dropped: take "project" out of every service (a service left with nothing is sold to companies).
UPDATE "services" SET "client_types" = coalesce(nullif(array_remove("client_types", 'project'), '{}'), '{company}');--> statement-breakpoint
ALTER TABLE "services" ALTER COLUMN "client_types" SET DEFAULT '{company,individual}'::text[];--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_client_types_chk" CHECK (cardinality("services"."client_types") > 0 and "services"."client_types" <@ '{company,individual}'::text[]);