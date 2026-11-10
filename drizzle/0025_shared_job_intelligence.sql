CREATE TABLE "board_job_categories" (
	"board_job_id" uuid NOT NULL,
	"category_slug" text NOT NULL,
	"method" text NOT NULL,
	CONSTRAINT "board_job_categories_board_job_id_category_slug_pk" PRIMARY KEY("board_job_id","category_slug")
);
--> statement-breakpoint
CREATE TABLE "job_analyses" (
	"board_job_id" uuid PRIMARY KEY NOT NULL,
	"is_signal" boolean NOT NULL,
	"signal_type" text,
	"intent_level" "intent_level" NOT NULL,
	"urgency" "urgency_level" NOT NULL,
	"summary" text NOT NULL,
	"excerpt" text,
	"evidence_label" "evidence_label" NOT NULL,
	"confidence" integer NOT NULL,
	"occurred_on" text,
	"model" text NOT NULL,
	"analyzed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_jobs" ADD COLUMN "categorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "board_job_categories" ADD CONSTRAINT "board_job_categories_board_job_id_board_jobs_id_fk" FOREIGN KEY ("board_job_id") REFERENCES "public"."board_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_job_categories" ADD CONSTRAINT "board_job_categories_category_slug_service_categories_slug_fk" FOREIGN KEY ("category_slug") REFERENCES "public"."service_categories"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_analyses" ADD CONSTRAINT "job_analyses_board_job_id_board_jobs_id_fk" FOREIGN KEY ("board_job_id") REFERENCES "public"."board_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_analyses" ADD CONSTRAINT "job_analyses_signal_type_signal_types_slug_fk" FOREIGN KEY ("signal_type") REFERENCES "public"."signal_types"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_job_categories_category_idx" ON "board_job_categories" USING btree ("category_slug");--> statement-breakpoint
CREATE INDEX "board_jobs_uncategorized_idx" ON "board_jobs" USING btree ("first_seen_at") WHERE "board_jobs"."categorized_at" is null;