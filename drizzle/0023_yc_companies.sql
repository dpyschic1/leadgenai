ALTER TYPE "public"."company_id_scheme" ADD VALUE 'yc_company';--> statement-breakpoint
ALTER TYPE "public"."ingestion_job_kind" ADD VALUE 'discover_yc';--> statement-breakpoint
CREATE TABLE "yc_companies" (
	"id" integer PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"domain" text,
	"one_liner" text,
	"long_description" text,
	"locations" text,
	"country" text,
	"industry" text,
	"yc_industry" text,
	"yc_subindustry" text,
	"regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"team_size" integer,
	"batch" text,
	"status" text NOT NULL,
	"is_hiring" boolean DEFAULT false NOT NULL,
	"top_company" boolean DEFAULT false NOT NULL,
	"stage" text,
	"launched_at" timestamp with time zone,
	"url" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "yc_companies_slug_idx" ON "yc_companies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "yc_companies_pick_idx" ON "yc_companies" USING btree ("country","status","is_hiring");--> statement-breakpoint
-- Hand-added: the Y Combinator companies source.
INSERT INTO "sources" ("slug", "name", "type", "authorization_status", "terms_url", "notes") VALUES
  ('yc_directory', 'Y Combinator companies', 'company_directory', 'approved', 'https://github.com/yc-oss/api', 'Every YC company from the third-party yc-oss/api dataset (a daily copy of YC''s public directory via its search index), downloaded from yc-oss.github.io. Unofficial, no stated licence; YC''s site terms (ycombinator.com/legal) restrict scraping and commercial reuse of directory content. Approved by the product owner on 2026-11-10 against that advice. No people or contact details are taken from it.')
ON CONFLICT ("slug") DO NOTHING;
