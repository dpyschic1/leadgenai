CREATE TABLE "theirstack_jobs" (
	"id" bigint PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"posted_on" text NOT NULL,
	"country" text,
	"company_domain" text,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"analysis" jsonb,
	"analyzed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "theirstack_jobs_posted_idx" ON "theirstack_jobs" USING btree ("posted_on");--> statement-breakpoint
-- Hand-added: the posts already bought (kept per workspace until now) join the shared table, so
-- none is bought again and those not yet read by the AI are still offered.
INSERT INTO "theirstack_jobs" ("id", "title", "posted_on", "country", "company_domain", "data", "fetched_at")
SELECT DISTINCT ON (substring("external_id" from 5)::bigint)
  substring("external_id" from 5)::bigint,
  left("data"->>'title', 300),
  "data"->>'postedOn',
  "data"->'company'->>'country',
  "data"->'company'->>'domain',
  "data" - 'analysed' - 'relevant' - 'fetchedOn',
  "observed_at"
FROM "source_records"
WHERE "source_slug" = 'theirstack' AND "record_type" = 'job_post' AND "external_id" ~ '^job:[0-9]+$'
  AND "data" ? 'description' AND "data" ? 'title' AND "data" ? 'postedOn'
ORDER BY substring("external_id" from 5)::bigint, "observed_at"
ON CONFLICT DO NOTHING;
