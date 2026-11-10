/**
 * Overture Maps lookup: phones, emails and candidate websites for the companies we already have.
 *
 *   npm run overture -- targets targets.csv              (our companies' websites and postcodes)
 *   npm run overture -- sql targets.csv places.json      (prints the DuckDB query for the newest release)
 *   duckdb -c "$(npm run -s overture -- sql targets.csv places.json)"
 *   npm run overture -- load places.json                 (matches and saves)
 *   npm run overture -- load places.json --dry-run       (shows what it would save, writes nothing)
 *
 * Only the places matching our own companies are ever read into the app; the full dataset stays
 * in Overture's public bucket. Scheduled in `.github/workflows/overture-match.yml`. Matching rules:
 * `proposeOvertureMatches` in `src/server/sources/overture.ts`.
 */
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, companyContactPoints, companyLocations } from "@/db/schema";
import { enqueue } from "@/server/ingestion/queue";
import { replaceCompanyContacts, saveSourceRecord } from "@/server/ingestion/resolve";
import { rescoreCompany } from "@/server/scoring/rescore";
import {
  comparablePostcode,
  latestOvertureRelease,
  overtureLookupSql,
  proposeOvertureMatches,
  type OverturePlace,
  type OvertureTarget,
} from "@/server/sources/overture";

/** Every company of every workspace: its website, or else its headquarters' postcode. */
async function loadTargets(): Promise<OvertureTarget[]> {
  return db
    .select({
      companyId: companies.id,
      workspaceId: companies.workspaceId,
      name: companies.canonicalName,
      domain: companies.domain,
      postcode: companyLocations.postalCode,
      country: companyLocations.country,
    })
    .from(companies)
    .leftJoin(companyLocations, and(eq(companyLocations.companyId, companies.id), eq(companyLocations.type, "headquarters")));
}

async function writeTargets(file: string) {
  const targets = await loadTargets();
  const rows = new Set<string>();
  for (const t of targets) {
    if (t.domain) rows.add(`domain,${t.domain},${t.country ?? ""}`);
    else {
      const postcode = comparablePostcode(t.postcode, t.country);
      if (postcode && t.country) rows.add(`postcode,${postcode},${t.country}`);
    }
  }
  writeFileSync(file, ["kind,value,country", ...rows].join("\n") + "\n");
  console.log(`[overture] ${rows.size} targets from ${targets.length} companies → ${file}`);
}

/**
 * The countries in a targets file. Websites of companies with no known country are looked up only
 * within these countries; with no country at all, the scan is worldwide.
 */
function targetCountries(file: string): string[] {
  const countries = readFileSync(file, "utf8")
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[2]?.trim() ?? "")
    .filter(Boolean);
  return [...new Set(countries)];
}

async function readPlaces(file: string): Promise<OverturePlace[]> {
  const places: OverturePlace[] = [];
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      places.push(JSON.parse(line) as OverturePlace);
    } catch {
      // A malformed line: skip it.
    }
  }
  return places;
}

async function load(file: string, dryRun: boolean) {
  const [places, targets, release] = await Promise.all([readPlaces(file), loadTargets(), latestOvertureRelease().catch(() => null)]);
  const matches = proposeOvertureMatches(targets, places);
  if (dryRun) {
    const names = new Map(targets.map((t) => [t.companyId, t.name]));
    for (const m of matches.slice(0, 40)) {
      const found = m.method === "website" ? [...m.phones, ...m.emails].join(", ") : `site? ${m.candidateDomain}`;
      console.log(`${m.method.padEnd(13)} ${names.get(m.companyId)} ↔ ${m.place.name}: ${found}`);
    }
    const count = (method: string) => matches.filter((m) => m.method === method).length;
    console.log(`[overture] dry run: ${places.length} places; ${count("website")} contact matches, ${count("postcode_name")} website candidates.`);
    return;
  }
  let contacts = 0;
  let candidates = 0;
  for (const m of matches) {
    const record = {
      sourceSlug: "overture" as const,
      externalId: `place:${m.place.id}`,
      url: null,
      recordType: m.method === "website" ? "place" : "place_candidate",
      publishedAt: null,
      data: {
        name: m.place.name,
        category: m.place.category,
        city: m.place.city,
        postcode: m.place.postcode,
        method: m.method,
        confidence: m.confidence,
        phones: m.phones,
        emails: m.emails,
        candidateWebsite: m.candidateDomain,
        datasets: m.place.datasets,
        release,
      },
    };
    if (m.method === "website") {
      await db.transaction(async (tx) => {
        await saveSourceRecord(tx, m.workspaceId, record, m.companyId);
        // This release's contacts replace the earlier ones entirely (an email gone stays gone).
        await tx
          .delete(companyContactPoints)
          .where(
            and(
              eq(companyContactPoints.companyId, m.companyId),
              eq(companyContactPoints.sourceSlug, "overture"),
              notInArray(companyContactPoints.value, [...m.emails, ...m.phones]),
            ),
          );
        await replaceCompanyContacts(tx, m.companyId, { emails: m.emails, phones: m.phones }, { slug: "overture", url: null });
      });
      // Reachability feeds the opportunity's contact; its score stays as it was otherwise.
      await rescoreCompany(m.workspaceId, m.companyId);
      contacts++;
    } else {
      await db.transaction((tx) => saveSourceRecord(tx, m.workspaceId, record, m.companyId));
      // Still without a website: check the candidate on the site itself.
      const [company] = await db
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.id, m.companyId), isNull(companies.domain)));
      if (company) await enqueue(db, { workspaceId: m.workspaceId, kind: "enrich_company", entityId: m.companyId });
      candidates++;
    }
  }
  const removed = places.length > 0 ? await removeUnmatchedContacts(new Set(matches.filter((m) => m.method === "website").map((m) => m.companyId))) : 0;
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(companies);
  console.log(
    `[overture] ${places.length} places read; ${contacts} companies got contacts, ${candidates} got a website to check, ${removed} lost contacts that no longer match (of ${total} companies).`,
  );
}

/**
 * Overture contacts of companies this run no longer matches (stricter rules, or the place left the
 * map) are removed, and those companies rescored. Skipped when the lookup found nothing at all: an
 * empty file means a failed lookup, not a world without places.
 */
async function removeUnmatchedContacts(matched: Set<string>): Promise<number> {
  const stale = await db
    .selectDistinct({ companyId: companies.id, workspaceId: companies.workspaceId })
    .from(companyContactPoints)
    .innerJoin(companies, eq(companies.id, companyContactPoints.companyId))
    .where(eq(companyContactPoints.sourceSlug, "overture"));
  let removed = 0;
  for (const s of stale.filter((s) => !matched.has(s.companyId))) {
    await db.delete(companyContactPoints).where(and(eq(companyContactPoints.companyId, s.companyId), eq(companyContactPoints.sourceSlug, "overture")));
    await rescoreCompany(s.workspaceId, s.companyId);
    removed++;
  }
  return removed;
}

async function main() {
  const [command, a, b] = process.argv.slice(2);
  if (command === "targets" && a) return writeTargets(a);
  if (command === "sql" && a && b) return console.log(overtureLookupSql(await latestOvertureRelease(), a, b, targetCountries(a)));
  if (command === "load" && a) return load(a, b === "--dry-run");
  throw new Error("Usage: overture targets <targets.csv> | sql <targets.csv> <places.json> | load <places.json>");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
