-- JobSpy import (Settings → JobSpy import). Self-contained: to remove the feature, drop both tables:
--   DROP TABLE "jobspy_jobs"; DROP TABLE "jobspy_runs";
CREATE TABLE "jobspy_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board" text NOT NULL,
	"job_url" text NOT NULL,
	"job_url_direct" text,
	"title" text NOT NULL,
	"company" text,
	"company_url" text,
	"location" text,
	"is_remote" boolean,
	"job_type" text,
	"date_posted" date,
	"salary_min" double precision,
	"salary_max" double precision,
	"salary_interval" text,
	"currency" text,
	"description" text,
	"first_run_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobspy_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text,
	"search_term" text NOT NULL,
	"location" text NOT NULL,
	"boards" text[] NOT NULL,
	"results_per_board" integer NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "jobspy_runs_status_chk" CHECK ("jobspy_runs"."status" is null or "jobspy_runs"."status" in ('success', 'partial', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "jobspy_jobs" ADD CONSTRAINT "jobspy_jobs_first_run_id_jobspy_runs_id_fk" FOREIGN KEY ("first_run_id") REFERENCES "public"."jobspy_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobspy_runs" ADD CONSTRAINT "jobspy_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobspy_jobs_job_url_idx" ON "jobspy_jobs" USING btree ("job_url");--> statement-breakpoint
CREATE INDEX "jobspy_jobs_first_seen_idx" ON "jobspy_jobs" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "jobspy_runs_started_at_idx" ON "jobspy_runs" USING btree ("started_at");