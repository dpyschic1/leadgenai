ALTER TABLE "opportunities" ADD COLUMN "qualification" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "qualification_score" integer;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "qualification_reason" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "qualification_quote" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "qualification_hints" jsonb;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "qualified_by" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "qualified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "opportunities_workspace_qualification_idx" ON "opportunities" USING btree ("workspace_id","qualification");--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_qualification_chk" CHECK ("opportunities"."qualification" is null or "opportunities"."qualification" in ('hot', 'warm', 'not_fit'));--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_qualified_by_chk" CHECK ("opportunities"."qualified_by" is null or "opportunities"."qualified_by" in ('ai', 'team'));