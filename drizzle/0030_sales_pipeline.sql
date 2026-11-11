CREATE TYPE "public"."stage_kind" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "stage_kind" DEFAULT 'open' NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_stages_id_workspace_uq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_stages_workspace_idx" ON "pipeline_stages" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_name_uq" ON "pipeline_stages" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_stage_fk" FOREIGN KEY ("stage_id","workspace_id") REFERENCES "public"."pipeline_stages"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opportunities_workspace_stage_idx" ON "opportunities" USING btree ("workspace_id","stage_id");--> statement-breakpoint
-- Every existing workspace gets the spec's default stages.
INSERT INTO "pipeline_stages" ("workspace_id", "name", "kind", "position")
SELECT w."id", s."name", s."kind"::"stage_kind", s."position"
FROM "workspaces" w
CROSS JOIN (VALUES
  ('New', 'open', 0), ('Contacted', 'open', 1), ('Responded', 'open', 2), ('Meeting Scheduled', 'open', 3),
  ('Proposal Sent', 'open', 4), ('Won', 'won', 5), ('Lost', 'lost', 6)
) AS s("name", "kind", "position");--> statement-breakpoint
-- Fold the old statuses into stages: qualified and saved are New (saved is also what a list is for), the
-- in-progress ones map to their stage, and dismissed becomes an archive flag on top of New, not Lost.
UPDATE "opportunities" o
SET "stage_id" = ps."id",
    "archived_at" = CASE WHEN o."status" = 'dismissed' THEN o."updated_at" END
FROM "pipeline_stages" ps
WHERE ps."workspace_id" = o."workspace_id"
  AND ps."name" = CASE o."status"::text
    WHEN 'new' THEN 'New' WHEN 'qualified' THEN 'New' WHEN 'saved' THEN 'New'
    WHEN 'contacted' THEN 'Contacted' WHEN 'replied' THEN 'Responded' WHEN 'meeting' THEN 'Meeting Scheduled'
    WHEN 'proposal' THEN 'Proposal Sent' WHEN 'won' THEN 'Won' WHEN 'lost' THEN 'Lost' WHEN 'dismissed' THEN 'New'
  END;
