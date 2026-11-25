-- JobSpy import → Opportunities switch (off by default). To remove: delete the jobspy signals/companies first
-- (Settings switch off does it per workspace), then DROP TABLE "jobspy_workspaces"; DELETE FROM "sources" WHERE slug = 'jobspy';
CREATE TABLE "jobspy_workspaces" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"send_to_opportunities" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobspy_workspaces" ADD CONSTRAINT "jobspy_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "sources" ("slug", "name", "type", "authorization_status", "terms_url", "notes") VALUES ('jobspy', 'JobSpy import', 'job_api', 'approved', NULL, 'Jobs from Indeed, LinkedIn, Glassdoor and ZipRecruiter fetched by the separate JobSpy service (Settings → JobSpy import). Scraped against those boards'' terms at the owner''s decision (2026-11-25). Becomes companies and rule-based signals only in workspaces that switch it on; switching off deletes them. Not listed under Data sources.') ON CONFLICT ("slug") DO NOTHING;
