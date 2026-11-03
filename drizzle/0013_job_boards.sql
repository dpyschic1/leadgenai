-- Hand-edited: job_postings_signal_fk uses ON DELETE SET NULL (signal_id), so deleting a signal clears only
-- the link and keeps workspace_id (NOT NULL). drizzle-kit cannot express the column list.
CREATE TYPE "public"."job_board_provider" AS ENUM('greenhouse', 'lever', 'ashby');--> statement-breakpoint
CREATE TYPE "public"."job_triage" AS ENUM('pending', 'relevant', 'skipped');--> statement-breakpoint
CREATE TABLE "company_job_boards" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" "job_board_provider" NOT NULL,
	"board_token" text NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" "job_board_provider" NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"department" text,
	"location" text,
	"url" text NOT NULL,
	"description" text,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"triage" "job_triage" DEFAULT 'pending' NOT NULL,
	"triage_reason" text,
	"signal_id" uuid
);
--> statement-breakpoint
ALTER TABLE "company_job_boards" ADD CONSTRAINT "company_job_boards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_job_boards" ADD CONSTRAINT "company_job_boards_company_fk" FOREIGN KEY ("company_id","workspace_id") REFERENCES "public"."companies"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_company_fk" FOREIGN KEY ("company_id","workspace_id") REFERENCES "public"."companies"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_signal_fk" FOREIGN KEY ("signal_id","workspace_id") REFERENCES "public"."signals"("id","workspace_id") ON DELETE SET NULL ("signal_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_job_boards_workspace_idx" ON "company_job_boards" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_postings_company_external_idx" ON "job_postings" USING btree ("company_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "job_postings_company_closed_idx" ON "job_postings" USING btree ("company_id","closed_at");--> statement-breakpoint
CREATE INDEX "job_postings_signal_idx" ON "job_postings" USING btree ("signal_id");