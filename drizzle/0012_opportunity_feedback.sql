CREATE TYPE "public"."feedback_verdict" AS ENUM('good_fit', 'not_relevant', 'wrong_service', 'wrong_person', 'wrong_company');--> statement-breakpoint
CREATE TABLE "opportunity_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"user_id" uuid,
	"verdict" "feedback_verdict" NOT NULL,
	"reason" text,
	"person_id" uuid,
	"service_id" uuid,
	"score_at_feedback" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunity_feedback" ADD CONSTRAINT "opportunity_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_feedback" ADD CONSTRAINT "opportunity_feedback_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_feedback" ADD CONSTRAINT "opportunity_feedback_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_feedback" ADD CONSTRAINT "opportunity_feedback_opportunity_fk" FOREIGN KEY ("opportunity_id","workspace_id") REFERENCES "public"."opportunities"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opportunity_feedback_opportunity_idx" ON "opportunity_feedback" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "opportunity_feedback_workspace_idx" ON "opportunity_feedback" USING btree ("workspace_id");