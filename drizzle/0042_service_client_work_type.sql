ALTER TABLE "services" ADD COLUMN "client_types" text[] DEFAULT '{company,individual,project}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "work_type" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_client_types_chk" CHECK (cardinality("services"."client_types") > 0 and "services"."client_types" <@ '{company,individual,project}'::text[]);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_work_type_chk" CHECK ("services"."work_type" in ('any', 'remote', 'hybrid', 'onsite'));