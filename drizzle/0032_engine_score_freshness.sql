ALTER TABLE "engine_settings" ADD COLUMN "scoring_weights" jsonb;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "source_posted_at" timestamp with time zone;--> statement-breakpoint
-- Best available posting time for rows found before it was stored: the funding date for funded companies,
-- else when we first saw it. A rediscovery replaces it with the source's own date.
UPDATE "opportunities" SET "source_posted_at" = COALESCE("funding_date"::timestamptz, "discovered_at")
WHERE "category" IS NOT NULL AND "source_posted_at" IS NULL;
