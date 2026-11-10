CREATE TABLE "site_reads" (
	"domain" text PRIMARY KEY NOT NULL,
	"read" jsonb NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"facts" jsonb,
	"facts_from" text,
	"facts_at" timestamp with time zone
);
