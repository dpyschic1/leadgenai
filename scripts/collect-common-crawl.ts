/**
 * Careers-page targets for the Web Scraping & Discovery Engine from Common Crawl's URL index: `.com`
 * websites with a careers page, found offline with DuckDB, a few index files at a time (each ~80 MB
 * read; the newest crawl has 300). Only the domains are stored, as `collection_targets` that start
 * at the careers page found, with the crawl in `params.commonCrawl`.
 *
 *   npm run -s collect:common-crawl -- sql sites.json --files 150-152 [--crawl CC-MAIN-2026-43] > crawl.sql
 *   duckdb < crawl.sql
 *   npm run collect:common-crawl -- seed sites.json --limit 500 --spread-hours 24 [--crawl …] [--dry-run]
 *
 * The rules are in `src/server/collection/common-crawl-seed.ts`.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";
import { existingTargetKeys } from "@/server/collection/overture-seed";
import { COMMON_CRAWL_DATA, crawlCandidates, crawlSitesSql, indexFiles, insertCrawlSeeds, latestCrawl, pickCrawlBatch, type CrawlSite } from "@/server/collection/common-crawl-seed";

const value = (args: string[], name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const number = (args: string[], name: string, fallback: number) => {
  const n = Number(value(args, name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

async function readSites(file: string): Promise<CrawlSite[]> {
  const sites: CrawlSite[] = [];
  for await (const line of createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    try {
      sites.push(JSON.parse(line) as CrawlSite);
    } catch {
      // A malformed line: skip it.
    }
  }
  return sites;
}

async function main() {
  const [command, file, ...args] = process.argv.slice(2);
  const crawl = value(args, "crawl") ?? (command === "sql" || command === "seed" ? await latestCrawl().catch(() => "unknown") : "");
  if (command === "sql" && file) {
    const picks = value(args, "files");
    if (!picks) throw new Error("Give the index files to read: --files 150-152");
    if (crawl === "unknown") throw new Error("Common Crawl's crawl list could not be read; give --crawl CC-MAIN-…");
    const response = await fetch(`${COMMON_CRAWL_DATA}/crawl-data/${crawl}/cc-index-table.paths.gz`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`The index list of ${crawl} answered ${response.status}`);
    const list = gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
    console.log(crawlSitesSql(indexFiles(list, picks), file));
    return;
  }
  if (command === "seed" && file) {
    const [rows, existing] = await Promise.all([readSites(file), existingTargetKeys()]);
    const { candidates, stats } = crawlCandidates(rows, existing);
    const batch = pickCrawlBatch(candidates, number(args, "limit", 500));
    console.log(`[collect:common-crawl] ${JSON.stringify(stats)}; batch of ${batch.length}`);
    if (args.includes("--dry-run")) {
      console.log(batch.slice(0, 20).map((s) => s.careersUrl).join("\n"));
      return;
    }
    const added = await insertCrawlSeeds(batch, { crawl, spreadHours: number(args, "spread-hours", 24) });
    console.log(`[collect:common-crawl] added ${added} careers-page targets (crawl ${crawl}).`);
    return;
  }
  console.error("Usage: collect:common-crawl -- sql <out.json> --files 150-152 [--crawl CC-MAIN-…] | seed <sites.json> [--limit N] [--spread-hours H] [--crawl CC-MAIN-…] [--dry-run]");
  process.exitCode = 1;
}

main()
  .then(() => process.exit())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
