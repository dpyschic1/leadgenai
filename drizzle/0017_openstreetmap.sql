ALTER TYPE "public"."ingestion_job_kind" ADD VALUE 'match_osm';--> statement-breakpoint
CREATE TABLE "osm_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"company_location_id" uuid,
	"osm_type" text NOT NULL,
	"osm_id" bigint NOT NULL,
	"method" text NOT NULL,
	"confidence" integer NOT NULL,
	"verification" "contact_verification" DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "osm_places" (
	"osm_type" text NOT NULL,
	"osm_id" bigint NOT NULL,
	"version" integer,
	"name" text NOT NULL,
	"brand" text,
	"operator" text,
	"category" text NOT NULL,
	"postcode" text,
	"street" text,
	"housenumber" text,
	"city" text,
	"lat" double precision,
	"lon" double precision,
	"phone" text,
	"website" text,
	"email" text,
	"cqc_location_ref" text,
	"check_date" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "osm_places_osm_type_osm_id_pk" PRIMARY KEY("osm_type","osm_id")
);
--> statement-breakpoint
ALTER TABLE "osm_matches" ADD CONSTRAINT "osm_matches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "osm_matches" ADD CONSTRAINT "osm_matches_company_location_id_company_locations_id_fk" FOREIGN KEY ("company_location_id") REFERENCES "public"."company_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "osm_matches" ADD CONSTRAINT "osm_matches_company_fk" FOREIGN KEY ("company_id","workspace_id") REFERENCES "public"."companies"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "osm_matches" ADD CONSTRAINT "osm_matches_place_fk" FOREIGN KEY ("osm_type","osm_id") REFERENCES "public"."osm_places"("osm_type","osm_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "osm_matches_place_idx" ON "osm_matches" USING btree ("company_id","osm_type","osm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "osm_matches_location_idx" ON "osm_matches" USING btree ("company_location_id") WHERE "osm_matches"."company_location_id" is not null;--> statement-breakpoint
CREATE INDEX "osm_matches_workspace_idx" ON "osm_matches" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "osm_places_postcode_idx" ON "osm_places" USING btree ("postcode");--> statement-breakpoint
CREATE INDEX "osm_places_cqc_idx" ON "osm_places" USING btree ("cqc_location_ref");--> statement-breakpoint
-- Hand-added: the OpenStreetMap source (contacts only; data from a weekly self-processed UK extract).
INSERT INTO "sources" ("slug", "name", "type", "authorization_status", "terms_url", "notes") VALUES
  ('openstreetmap', 'OpenStreetMap', 'open_map_data', 'approved', 'https://www.openstreetmap.org/copyright', 'ODbL 1.0: show "© OpenStreetMap contributors" with a link to openstreetmap.org/copyright wherever OSM contacts appear (app and exports). OSM data is kept in osm_places/osm_matches, never copied into company rows; the filter and matching method are documented in the README (ODbL 4.6). Imported weekly from a Geofabrik extract processed with osmium; public Overpass and Nominatim are not used (their usage policies rule out SaaS backends and bulk lookups).')
ON CONFLICT ("slug") DO NOTHING;
