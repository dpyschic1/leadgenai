-- opportunity_discoveries_run_fk is over (run_id, workspace_id): a plain ON DELETE SET NULL clears
-- both columns, and workspace_id is NOT NULL, so deleting a discovery run (or a workspace, whose runs
-- go with it) failed. Clear only the run link, as the other composite keys do (see 0002, 0014).
ALTER TABLE "opportunity_discoveries" DROP CONSTRAINT "opportunity_discoveries_run_fk";--> statement-breakpoint
ALTER TABLE "opportunity_discoveries" ADD CONSTRAINT "opportunity_discoveries_run_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."discovery_runs"("id","workspace_id") ON DELETE SET NULL ("run_id") ON UPDATE no action;
