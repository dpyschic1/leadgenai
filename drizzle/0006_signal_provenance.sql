CREATE TYPE "public"."signal_source" AS ENUM('manual', 'ai');--> statement-breakpoint
DROP INDEX "signals_company_idx";--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "source" "signal_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "created_by_id" uuid;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signals_company_occurred_idx" ON "signals" USING btree ("company_id","occurred_at");