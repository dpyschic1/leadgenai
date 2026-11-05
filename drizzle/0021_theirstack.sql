ALTER TYPE "public"."ingestion_job_kind" ADD VALUE 'discover_theirstack';--> statement-breakpoint
-- Hand-added: the TheirStack job-posts source (paid API with a free monthly allowance).
INSERT INTO "sources" ("slug", "name", "type", "authorization_status", "terms_url", "notes") VALUES
  ('theirstack', 'TheirStack job posts', 'job_data_provider', 'approved', 'https://theirstack.com/en/terms', 'Licensed job-post data via the TheirStack API (THEIRSTACK_API_KEY). Posts come from public job boards and career sites (mostly Indeed and LinkedIn). 1 API credit per job returned; free plan 200 API credits a month. Searches are capped per day (THEIRSTACK_JOBS_PER_DAY, default 6) and skip seen jobs and existing opportunity companies, so credits are not spent twice.')
ON CONFLICT ("slug") DO NOTHING;
