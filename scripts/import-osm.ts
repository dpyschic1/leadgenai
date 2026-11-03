/**
 * Loads OpenStreetMap businesses into `osm_places` from a filtered UK extract.
 *
 *   npm run osm:import -- pois.geojsonseq
 *   npm run osm:import -- --print-filters        (the osmium tags-filter expressions)
 *
 * The file is made offline (see `.github/workflows/osm-import.yml` and the README), never by
 * querying public OSM servers:
 *
 *   curl -L -o gb.osm.pbf https://download.geofabrik.de/europe/great-britain-latest.osm.pbf
 *   osmium tags-filter gb.osm.pbf $(npm run -s osm:import -- --print-filters) -o pois.osm.pbf
 *   osmium export pois.osm.pbf -f geojsonseq -a type,id,version -o pois.geojsonseq
 *
 * Places are upserted; ones missing from this file are marked removed (and stop matching), unless
 * the file looks truncated. Matching runs per workspace in the daily `match_osm` job.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { and, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { osmPlaces } from "@/db/schema";
import { osmiumFilters, placeFromFeature, type OsmPlace } from "@/server/sources/osm";

const BATCH = 500;
/** A file with fewer than this share of the places we hold is treated as incomplete: nothing is removed. */
const MIN_SHARE_TO_PRUNE = 0.8;

async function main() {
  const arg = process.argv[2];
  if (arg === "--print-filters") {
    console.log(osmiumFilters().join(" "));
    return;
  }
  if (!arg) throw new Error("Give the path of a .geojsonseq file made by `osmium export`.");

  const startedAt = new Date();
  const [{ active }] = await db.select({ active: sql<number>`count(*)::int` }).from(osmPlaces).where(isNull(osmPlaces.removedAt));
  let read = 0;
  let kept = 0;
  let batch: OsmPlace[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    // The same element twice in one batch would fail the upsert; the last copy wins.
    const unique = [...new Map(batch.map((p) => [`${p.osmType}/${p.osmId}`, p])).values()];
    await db
      .insert(osmPlaces)
      .values(unique)
      .onConflictDoUpdate({
        target: [osmPlaces.osmType, osmPlaces.osmId],
        set: {
          ...Object.fromEntries(
            ["version", "name", "brand", "operator", "category", "postcode", "street", "housenumber", "city", "lat", "lon", "phone", "website", "email", "cqc_location_ref", "check_date"].map((column) => [
              column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
              sql.raw(`excluded.${column}`),
            ]),
          ),
          // Seen in this extract: current again, even if an earlier import had marked it removed.
          importedAt: sql`now()`,
          removedAt: null,
        },
      });
    kept += unique.length;
    batch = [];
  };

  const lines = createInterface({ input: createReadStream(arg, "utf8"), crlfDelay: Infinity });
  for await (const raw of lines) {
    // GeoJSON text sequences start each record with an RS character.
    const line = raw.replace(/^\x1e/, "").trim();
    if (!line) continue;
    read++;
    try {
      const place = placeFromFeature(JSON.parse(line));
      if (place) batch.push(place);
    } catch {
      // A malformed line: skip it.
    }
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  let removed = 0;
  if (kept >= active * MIN_SHARE_TO_PRUNE) {
    const rows = await db
      .update(osmPlaces)
      .set({ removedAt: new Date() })
      .where(and(isNull(osmPlaces.removedAt), lt(osmPlaces.importedAt, startedAt)))
      .returning({ osmId: osmPlaces.osmId });
    removed = rows.length;
  } else {
    console.warn(`[osm] kept ${kept} of ${active} known places: the file looks incomplete, so nothing was marked removed.`);
  }
  console.log(`[osm] read ${read} features, kept ${kept} businesses with contacts, marked ${removed} removed.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
