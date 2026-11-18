/**
 * Careers-page targets for the Web Scraping & Discovery Engine from Overture Maps places (US
 * businesses with their own website, in the categories we seed). Nothing of Overture is stored but
 * the chosen domains, as `collection_targets` with the place each came from.
 *
 *   npm run collect:overture -- sql places.json austin=-97.80,30.22,-97.68,30.34 [more areas…]
 *   duckdb -c "$(npm run -s collect:overture -- sql places.json austin=-97.80,30.22,-97.68,30.34)"
 *   npm run collect:overture -- seed places.json --limit 500 --per-category 40 --spread-hours 24
 *   npm run collect:overture -- seed places.json --dry-run      (what it would add; writes nothing)
 *
 * Areas are map boxes (west,south,east,north): read a few at a time, seed in batches. The rules are
 * in `src/server/collection/overture-seed.ts`. Data © Overture Maps Foundation, CDLA Permissive 2.0.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { existingTargetKeys, insertSeeds, pickBatch, seedCandidates, seedPlacesSql, type SeedArea, type SeedPlace } from "@/server/collection/overture-seed";
import { latestOvertureRelease } from "@/server/sources/overture";

const option = (args: string[], name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  const value = at === -1 ? NaN : Number(args[at + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

function parseArea(arg: string): SeedArea {
  const [name, coords] = arg.split("=");
  const box = (coords ?? "").split(",").map(Number);
  if (!name || box.length !== 4 || box.some((n) => !Number.isFinite(n))) throw new Error(`Area "${arg}" should look like name=west,south,east,north`);
  return { name, box: box as SeedArea["box"] };
}

async function readPlaces(file: string): Promise<SeedPlace[]> {
  const places: SeedPlace[] = [];
  for await (const line of createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    try {
      places.push(JSON.parse(line) as SeedPlace);
    } catch {
      // A malformed line: skip it.
    }
  }
  return places;
}

async function main() {
  const [command, file, ...args] = process.argv.slice(2);
  if (command === "sql" && file) {
    const areas = args.filter((a) => !a.startsWith("--")).map(parseArea);
    if (areas.length === 0) throw new Error("Give at least one area: name=west,south,east,north");
    const release = args.includes("--release") ? args[args.indexOf("--release") + 1] : await latestOvertureRelease();
    console.log(seedPlacesSql(release, areas, file));
    return;
  }
  if (command === "seed" && file) {
    const [places, existing, release] = await Promise.all([readPlaces(file), existingTargetKeys(), latestOvertureRelease().catch(() => "unknown")]);
    const { candidates, stats } = seedCandidates(places, existing);
    const batch = pickBatch(candidates, { limit: option(args, "limit", 500), perCategory: option(args, "per-category", 40) });
    console.log(`[collect:overture] ${JSON.stringify(stats)}; batch of ${batch.length}`);
    const tally = new Map<string, number>();
    for (const c of batch) tally.set(c.place.category!, (tally.get(c.place.category!) ?? 0) + 1);
    console.log([...tally].map(([category, n]) => `${category}: ${n}`).join(", "));
    const areas = new Map<string, number>();
    for (const c of batch) areas.set(c.place.area ?? "—", (areas.get(c.place.area ?? "—") ?? 0) + 1);
    console.log(`areas: ${[...areas].map(([area, n]) => `${area}: ${n}`).join(", ")}; tier 1: ${batch.filter((c) => c.tier === 1).length}, tier 2: ${batch.filter((c) => c.tier === 2).length}`);
    if (args.includes("--dry-run")) return;
    const added = await insertSeeds(batch, { release, spreadHours: option(args, "spread-hours", 24) });
    console.log(`[collect:overture] added ${added} careers-page targets (release ${release}).`);
    return;
  }
  console.error("Usage: collect:overture -- sql <out.json> <name=w,s,e,n>… | seed <places.json> [--limit N] [--per-category N] [--spread-hours H] [--dry-run]");
  process.exitCode = 1;
}

main()
  .then(() => process.exit())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
