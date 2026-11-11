DROP INDEX "opportunities_workspace_status_idx";--> statement-breakpoint
ALTER TABLE "opportunities" ALTER COLUMN "stage_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" DROP COLUMN "status";--> statement-breakpoint
DROP TYPE "public"."opportunity_status";