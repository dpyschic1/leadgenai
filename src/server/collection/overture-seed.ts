import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { MIN_PLACE_CONFIDENCE, OVERTURE_ATTRIBUTION, OVERTURE_BUCKET, placeDomains } from "@/server/sources/overture";
import { isBlockedUrl } from "./fetch";

/**
 * Careers-page targets from Overture Maps places: US businesses with their own website, in the
 * categories most likely to hire staff and to buy our customers' services. Nothing of Overture is
 * copied into the database except the chosen domains as `collection_targets`, each with the place
 * it came from (`params.overture`, with release and attribution). The places are read offline
 * (`scripts/collect-overture.ts`, DuckDB on Overture's public bucket), a few areas at a time, and
 * seeded in controlled batches whose first runs are spread over time.
 *
 * The existing Overture integration (contacts for our companies, `src/server/sources/overture.ts`)
 * is unchanged; only its domain parser, confidence floor and attribution are reused.
 */

/** One place as the pilot query writes it (one JSON object per line). */
export type SeedPlace = {
  id: string;
  name: string | null;
  category: string | null;
  confidence: number;
  websites: string[] | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  datasets: string[] | null;
  area?: string | null;
};

/**
 * Overture's basic categories worth seeding, by priority: real `basic_category` values (release
 * 2026-10-21.0; Overture has no separate IT, marketing, accounting or staffing categories, they
 * fall under professional, technical and b2b services). Tier 1: offices of firms that employ
 * professional and technical staff and buy web, software and marketing work. Tier 2: practices,
 * trades and industry that hire and buy websites, booking and marketing, but less often post jobs
 * on a careers page of their own. Not seeded: restaurants, shops, beauty, worship, parks, schools,
 * government, and bank branches, hospitals and pharmacies (enterprise chains on enterprise ATSs).
 */
export const SEED_CATEGORY_TIERS: Record<string, 1 | 2> = {
  corporate_or_business_office: 1,
  professional_service: 1,
  technical_service: 1,
  b2b_service: 1,
  b2b_office_and_professional_service: 1,
  b2b_science_and_technology_service: 1,
  financial_service: 1,
  attorney_or_law_firm: 1,
  legal_service: 1,
  design_service: 1,
  media_service: 1,
  manufacturer: 2,
  supplier_or_distributor: 2,
  wholesaler: 2,
  b2b_industrial_and_machine_service: 2,
  b2b_energy_and_utility_service: 2,
  b2b_transportation_and_storage_service: 2,
  shipping_or_delivery_service: 2,
  telecommunications_service: 2,
  research_institute: 2,
  specialized_health_care: 2,
  health_care: 2,
  medical_service: 2,
  behavioral_or_mental_health_clinic: 2,
  dental_clinic: 2,
  pediatric_clinic: 2,
  primary_care_or_general_clinic: 2,
  vision_or_eye_care_clinic: 2,
  physical_medicine_and_rehabilitation: 2,
  diagnostics_imaging_or_lab_service: 2,
  outpatient_care_facility: 2,
  surgery: 2,
  real_estate_service: 2,
  home_service: 2,
  building_or_construction_service: 2,
  specialty_school: 2,
};

/**
 * Website hosts shared by many unrelated businesses (site builders, booking and review platforms,
 * link pages): the registrable domain there is the platform's, never the business's own.
 */
const SHARED_HOSTS = new Set([
  "wixsite.com", "wix.com", "squarespace.com", "godaddysites.com", "business.site", "weebly.com", "wordpress.com",
  "blogspot.com", "webflow.io", "carrd.co", "square.site", "squareup.com", "myshopify.com", "shopify.com", "linktr.ee",
  "yelp.com", "yellowpages.com", "bbb.org", "mapquest.com", "nextdoor.com", "vagaro.com", "booksy.com", "mindbodyonline.com",
  "schedulicity.com", "styleseat.com", "zocdoc.com", "healthgrades.com", "psychologytoday.com", "opentable.com",
  "toasttab.com", "doordash.com", "grubhub.com", "ubereats.com", "eventbrite.com", "github.io", "netlify.app",
  "vercel.app", "herokuapp.com", "sites.google.com", "tripadvisor.com", "realtor.com", "zillow.com", "apartments.com",
  "kw.com", "remax.com", "coldwellbanker.com", "edwardjones.com", "statefarm.com", "allstate.com", "farmers.com",
]);

/** The business's own website domain among a place's websites; null when it has none we can use. Pure. */
export function seedDomain(websites: string[] | null): string | null {
  for (const domain of placeDomains({ websites })) {
    if (SHARED_HOSTS.has(domain) || isBlockedUrl(`https://${domain}/`)) continue;
    // Government and military sites are not companies.
    if (/\.(gov|mil)(\.[a-z]{2})?$/.test(domain) || /^\d+\.\d+$/.test(domain)) continue;
    return domain;
  }
  return null;
}

export type SeedCandidate = { domain: string; tier: 1 | 2; place: SeedPlace; places: number };
export type SeedStats = { places: number; inCategories: number; withDomain: number; domains: number; alreadyTargets: number; candidates: number };

/**
 * The domains worth seeding from these places: in a seeded category, with a usable website, above
 * Overture's confidence floor, one per domain (a chain's branches share their website: the place
 * with the best confidence stands for it), and not already a target. Pure.
 */
export function seedCandidates(places: SeedPlace[], existing: Set<string>): { candidates: SeedCandidate[]; stats: SeedStats } {
  const byDomain = new Map<string, SeedCandidate>();
  let inCategories = 0;
  let withDomain = 0;
  for (const place of places) {
    const tier = place.category ? SEED_CATEGORY_TIERS[place.category] : undefined;
    if (!tier || place.confidence < MIN_PLACE_CONFIDENCE) continue;
    inCategories++;
    const domain = seedDomain(place.websites);
    if (!domain) continue;
    withDomain++;
    const known = byDomain.get(domain);
    if (!known) byDomain.set(domain, { domain, tier, place, places: 1 });
    else {
      known.places++;
      if (tier < known.tier || (tier === known.tier && place.confidence > known.place.confidence)) Object.assign(known, { tier, place });
    }
  }
  const all = [...byDomain.values()];
  const candidates = all.filter((c) => !existing.has(c.domain));
  return {
    candidates,
    stats: { places: places.length, inCategories, withDomain, domains: all.length, alreadyTargets: all.length - candidates.length, candidates: candidates.length },
  };
}

/**
 * A batch of `limit` candidates: tier 1 before tier 2, and within a tier the categories take turns
 * (at most `perCategory` each), so one common category can't fill the batch. Deterministic: the
 * same places give the same batch. Pure.
 */
export function pickBatch(candidates: SeedCandidate[], { limit, perCategory }: { limit: number; perCategory: number }): SeedCandidate[] {
  const picked: SeedCandidate[] = [];
  for (const tier of [1, 2] as const) {
    const queues = new Map<string, SeedCandidate[]>();
    for (const c of candidates.filter((c) => c.tier === tier).sort((a, b) => b.place.confidence - a.place.confidence || a.domain.localeCompare(b.domain))) {
      const key = c.place.category!;
      queues.set(key, [...(queues.get(key) ?? []), c]);
    }
    const lists = [...queues.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => byArea(list).slice(0, perCategory));
    for (let round = 0; picked.length < limit && lists.some((l) => round < l.length); round++) {
      for (const list of lists) if (round < list.length && picked.length < limit) picked.push(list[round]);
    }
  }
  return picked;
}

/** A category's candidates with the areas taking turns (best first within each), so a batch spans every area read. */
function byArea(list: SeedCandidate[]): SeedCandidate[] {
  const areas = new Map<string, SeedCandidate[]>();
  for (const c of list) areas.set(c.place.area ?? "", [...(areas.get(c.place.area ?? "") ?? []), c]);
  const lanes = [...areas.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, l]) => l);
  const mixed: SeedCandidate[] = [];
  for (let i = 0; mixed.length < list.length; i++) for (const lane of lanes) if (i < lane.length) mixed.push(lane[i]);
  return mixed;
}

/** Domains that are already collection targets of the careers collector (any state, moved ones too). */
export async function existingTargetKeys(): Promise<Set<string>> {
  const rows = await db.execute<{ target_key: string }>(sql`select target_key from collection_targets where source_slug = 'career_pages'`);
  return new Set(rows.map((r) => r.target_key));
}

/**
 * Adds a batch as careers-page targets, with the place each came from. First runs are spread evenly
 * over `spreadHours`, so a batch never arrives at once; tier 2 goes behind tier 1 and YC's hiring
 * companies (priority 1). A domain that became a target meanwhile is left as it is. Returns how
 * many were added.
 */
export async function insertSeeds(batch: SeedCandidate[], { release, spreadHours }: { release: string; spreadHours: number }): Promise<number> {
  let added = 0;
  const step = batch.length > 1 ? (spreadHours * 3_600_000) / batch.length : 0;
  const start = Date.now();
  for (const [i, c] of batch.entries()) {
    const rows = await db.execute<{ id: string }>(sql`
      insert into collection_targets (source_slug, target_key, interval_minutes, priority, next_run_at, params)
      values ('career_pages', ${c.domain}, ${24 * 60}, ${c.tier === 1 ? 0 : -1}, ${new Date(start + i * step).toISOString()}::timestamptz,
        ${JSON.stringify({
          seed: "overture",
          overture: {
            id: c.place.id,
            name: c.place.name,
            category: c.place.category,
            city: c.place.city,
            region: c.place.region,
            postcode: c.place.postcode,
            confidence: c.place.confidence,
            places: c.places,
            datasets: c.place.datasets,
            release,
          },
          attribution: OVERTURE_ATTRIBUTION,
        })}::jsonb)
      on conflict (source_slug, target_key) do nothing
      returning id`);
    added += rows.length;
  }
  return added;
}

/** Map box (west, south, east, north) of an area to read places from. */
export type SeedArea = { name: string; box: [number, number, number, number] };

/**
 * The DuckDB query that reads the places to seed from one Overture release: US places above the
 * confidence floor with a website, in the seeded categories, in the given areas (one scan per area,
 * so Overture's area-sorted files are skipped outside it). Writes one JSON object per line.
 */
export function seedPlacesSql(release: string, areas: SeedArea[], outJson: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const categories = Object.keys(SEED_CATEGORY_TIERS).map(q).join(", ");
  const select = ({ name, box: [w, s, e, n] }: SeedArea) => `
    SELECT id, names.primary AS name, basic_category AS category, confidence, websites,
      addresses[1].locality AS city, addresses[1].region AS region, addresses[1].postcode AS postcode,
      [s.dataset FOR s IN sources] AS datasets, ${q(name)} AS area
    FROM read_parquet('s3://${OVERTURE_BUCKET}/release/${release}/theme=places/type=place/*')
    WHERE bbox.xmin BETWEEN ${w} AND ${e} AND bbox.ymin BETWEEN ${s} AND ${n}
      AND confidence >= ${MIN_PLACE_CONFIDENCE} AND websites IS NOT NULL AND addresses[1].country = 'US'
      AND basic_category IN (${categories})`;
  return `INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';
COPY (${areas.map(select).join("\n    UNION ALL")}
) TO ${q(outJson)} (FORMAT json);`;
}
