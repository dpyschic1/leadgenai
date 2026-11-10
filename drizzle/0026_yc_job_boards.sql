ALTER TABLE "yc_companies" ADD COLUMN "board_provider" "job_board_provider";--> statement-breakpoint
ALTER TABLE "yc_companies" ADD COLUMN "board_token" text;--> statement-breakpoint
ALTER TABLE "yc_companies" ADD COLUMN "board_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "yc_companies" ADD CONSTRAINT "yc_companies_board_fk" FOREIGN KEY ("board_provider","board_token") REFERENCES "public"."job_board_directory"("provider","board_token") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "yc_companies_board_idx" ON "yc_companies" USING btree ("board_provider","board_token");