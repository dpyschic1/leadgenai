CREATE TYPE "public"."collected_item_kind" AS ENUM('job', 'post', 'search_result', 'tender');--> statement-breakpoint
CREATE TYPE "public"."extraction_method" AS ENUM('json_ld', 'api', 'feed', 'html', 'rendered');--> statement-breakpoint
CREATE TABLE "collected_item_categories" (
	"item_id" uuid NOT NULL,
	"category_slug" text NOT NULL,
	"method" text NOT NULL,
	CONSTRAINT "collected_item_categories_item_id_category_slug_pk" PRIMARY KEY("item_id","category_slug")
);
--> statement-breakpoint
CREATE TABLE "collected_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_slug" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" "collected_item_kind" NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"extraction" "extraction_method" NOT NULL,
	"fetched_url" text,
	"title" text NOT NULL,
	"body" text,
	"company_name" text,
	"company_domain" text,
	"location" text,
	"country" text,
	"remote" boolean,
	"posted_at" timestamp with time zone,
	"valid_through" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"content_hash" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"duplicate_of" uuid,
	"last_target_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "collected_items_country_chk" CHECK ("collected_items"."country" is null or "collected_items"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "collection_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "run_status",
	"complete" boolean DEFAULT false NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"fetched" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"closed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_slug" text NOT NULL,
	"target_key" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"interval_minutes" integer NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_targets_interval_chk" CHECK ("collection_targets"."interval_minutes" between 15 and 43200)
);
--> statement-breakpoint
ALTER TABLE "collected_item_categories" ADD CONSTRAINT "collected_item_categories_item_id_collected_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."collected_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collected_item_categories" ADD CONSTRAINT "collected_item_categories_category_slug_service_categories_slug_fk" FOREIGN KEY ("category_slug") REFERENCES "public"."service_categories"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collected_items" ADD CONSTRAINT "collected_items_source_slug_sources_slug_fk" FOREIGN KEY ("source_slug") REFERENCES "public"."sources"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collected_items" ADD CONSTRAINT "collected_items_last_target_id_collection_targets_id_fk" FOREIGN KEY ("last_target_id") REFERENCES "public"."collection_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collected_items" ADD CONSTRAINT "collected_items_duplicate_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."collected_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_target_id_collection_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."collection_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_targets" ADD CONSTRAINT "collection_targets_source_slug_sources_slug_fk" FOREIGN KEY ("source_slug") REFERENCES "public"."sources"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collected_item_categories_category_idx" ON "collected_item_categories" USING btree ("category_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "collected_items_external_idx" ON "collected_items" USING btree ("source_slug","external_id");--> statement-breakpoint
CREATE INDEX "collected_items_dedupe_idx" ON "collected_items" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "collected_items_company_idx" ON "collected_items" USING btree ("company_domain");--> statement-breakpoint
CREATE INDEX "collected_items_kind_posted_idx" ON "collected_items" USING btree ("kind","posted_at");--> statement-breakpoint
CREATE INDEX "collected_items_target_idx" ON "collected_items" USING btree ("last_target_id");--> statement-breakpoint
CREATE INDEX "collection_runs_target_idx" ON "collection_runs" USING btree ("target_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_targets_key_idx" ON "collection_targets" USING btree ("source_slug","target_key");--> statement-breakpoint
CREATE INDEX "collection_targets_due_idx" ON "collection_targets" USING btree ("enabled","next_run_at");--> statement-breakpoint
-- Hand-added: the Phase 0 source review (Web Scraping & Discovery Engine). Only `approved` sources
-- run. LinkedIn, Indeed and Google Search are recorded as `restricted` so the decision and its
-- reasons stay with the data; the collection HTTP layer also refuses their hosts outright.
INSERT INTO "sources" ("slug", "name", "type", "authorization_status", "terms_url", "notes") VALUES
  ('career_pages', 'Employer careers pages', 'job_page', 'approved', NULL, 'Jobs published on a company''s own careers pages as schema.org JobPosting markup (the data Google for Jobs reads). Read politely: robots.txt honoured for every page, one request a second per site, public addresses only, identified user agent. Pages a browser must render are flagged, not rendered. Companies whose careers page links to a job board the Company Discovery Engine already reads (Greenhouse, Lever, Ashby…) are skipped. Approved 2026-11-17 (Phase 0 review).'),
  ('linkedin', 'LinkedIn', 'restricted_site', 'restricted', 'https://www.linkedin.com/legal/user-agreement', 'Not collected. The User Agreement forbids scraping and automated access (including browser plugins); robots.txt bars crawlers without permission; LinkedIn enforces it in court (Proxycurl: permanent injunction, 2025; ProAPIs sued 2025). APIs are partner-only. LinkedIn jobs are reached at their source instead: the employer''s careers page or job board. Phase 0 review, 2026-11-17.'),
  ('indeed', 'Indeed', 'restricted_site', 'restricted', 'https://www.indeed.com/legal', 'Not collected. Indeed''s terms forbid scraping, robots.txt restricts crawlers, and the public job-search (Publisher) API is retired; partner APIs only post jobs. Indeed jobs are reached at their source instead (careers pages, job boards), or through the licensed TheirStack source. Phase 0 review, 2026-11-17.'),
  ('google_search', 'Google Search', 'restricted_site', 'restricted', 'https://policies.google.com/terms', 'Not queried directly. Google''s terms forbid automated queries and its SearchGuard system blocks them; the Custom Search JSON API takes no new customers and ends on 2027-01-01. Search-style discovery comes from our own index (Common Crawl, sitemaps, careers pages). The existing SerpAPI provider is unchanged. Phase 0 review, 2026-11-17.')
ON CONFLICT ("slug") DO NOTHING;
