import "server-only";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, companyLocations, osmMatches, osmPlaces } from "@/db/schema";
import { normalizeDomain } from "@/lib/validation/companies";
import { PLACEHOLDER_EMAIL } from "./company-website";
import type { HealthStatus, SourceAdapter } from "./index";

/**
 * OpenStreetMap contact enrichment. Businesses on OpenStreetMap often carry a phone, website or
 * email. We use them to reach companies we already have, never to create or merge companies:
 *
 * 1. **Import** (weekly, offline): a UK extract from Geofabrik is filtered with osmium to the
 *    business categories below and loaded into `osm_places` (`scripts/import-osm.ts`). No public
 *    Overpass or Nominatim server is used: their policies rule out a SaaS backend and bulk lookups.
 * 2. **Match** (per workspace, daily): each practice or company site is linked to at most one place,
 *    only when the link is unambiguous: the CQC location id the place carries, or the same postcode
 *    with a clearly matching name and a fitting category. Anything less links nothing.
 * 3. **Show**: OSM contacts come after the company's own (website, register), labelled as published
 *    on OpenStreetMap and not verified, with the ODbL credit.
 *
 * Licence: OSM data is © OpenStreetMap contributors under the ODbL. It stays in its own tables
 * (`osm_places`, `osm_matches`) and is never copied into our company rows, so the OSM-derived
 * database is kept apart from ours. What we filter and how we match is documented in the README,
 * which is what ODbL 4.6 asks us to offer.
 */

/** The OSM tags we import, and the industry each one is. Only these businesses are matched. */
export const OSM_CATEGORY_INDUSTRY: Record<string, string> = {
  "amenity=dentist": "dental",
  "healthcare=dentist": "dental",
  "amenity=doctors": "healthcare",
  "healthcare=doctor": "healthcare",
  "amenity=clinic": "healthcare",
  "healthcare=clinic": "healthcare",
  "healthcare=physiotherapist": "healthcare",
  "healthcare=optometrist": "healthcare",
  "shop=optician": "healthcare",
  "amenity=pharmacy": "healthcare",
  "office=accountant": "accounting",
  "office=tax_advisor": "accounting",
  "office=lawyer": "legal",
  "office=notary": "legal",
  "office=estate_agent": "real_estate",
  "shop=estate_agent": "real_estate",
  "office=financial_advisor": "financial_services",
  "office=financial": "financial_services",
  "office=insurance": "insurance",
  "office=it": "it_services",
  "office=employment_agency": "recruitment_staffing",
  "office=consulting": "professional_services",
  "office=architect": "professional_services",
  "office=advertising_agency": "media_marketing",
  "amenity=school": "education",
  "amenity=college": "education",
  "tourism=hotel": "hospitality",
  "amenity=restaurant": "hospitality",
};

/** The osmium `tags-filter` expressions for the import: one per tag key, e.g. "nwr/amenity=dentist,doctors". */
export function osmiumFilters(): string[] {
  const byKey = new Map<string, string[]>();
  for (const tag of Object.keys(OSM_CATEGORY_INDUSTRY)) {
    const [key, value] = tag.split("=");
    byKey.set(key, [...(byKey.get(key) ?? []), value]);
  }
  return [...byKey.entries()].map(([key, values]) => `nwr/${key}=${values.join(",")}`);
}

export type OsmPlace = typeof osmPlaces.$inferInsert;

/** One line of `osmium export -f geojsonseq -a type,id,version`. */
type Feature = {
  type?: string;
  id?: string | number;
  properties?: Record<string, unknown>;
  geometry?: { type: string; coordinates: unknown } | null;
};

export const normalizePostcode = (postcode: string | null | undefined) => {
  const value = postcode?.replace(/\s+/g, "").toUpperCase();
  // A full UK postcode, e.g. LS14AP or SW1A1AA.
  return value && /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(value) ? value : null;
};

const firstValue = (value: unknown) => (typeof value === "string" ? value.split(";")[0].trim() || null : null);

function phoneOf(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "").replace(/^00/, "+");
  return /^(\+\d{10,14}|0\d{9,10})$/.test(digits) ? digits : null;
}

function websiteOf(raw: string | null): string | null {
  if (!raw) return null;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(url);
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(parsed.hostname) && url.length <= 500 ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function emailOf(raw: string | null): string | null {
  const email = raw?.replace(/^mailto:/i, "").trim().toLowerCase() ?? null;
  return email && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) && !PLACEHOLDER_EMAIL.test(email) ? email : null;
}

/** The middle of a feature: the point itself, or the centre of a shape's bounding box. */
function centreOf(geometry: Feature["geometry"]): { lat: number; lon: number } | null {
  if (!geometry) return null;
  const points: number[][] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") points.push(value as number[]);
    else if (Array.isArray(value)) value.forEach(walk);
  };
  walk(geometry.coordinates);
  if (points.length === 0) return null;
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return { lon: (Math.min(...lons) + Math.max(...lons)) / 2, lat: (Math.min(...lats) + Math.max(...lats)) / 2 };
}

/**
 * A business we can use from one exported OSM feature, or null: it needs a name, one of our
 * categories, and at least one usable phone, website or email (contact:* tags count too). Pure.
 */
export function placeFromFeature(feature: Feature): OsmPlace | null {
  const tags = feature.properties ?? {};
  const type = typeof tags["@type"] === "string" ? tags["@type"] : null;
  const id = Number(tags["@id"]);
  if (!type || !["node", "way", "relation"].includes(type) || !Number.isSafeInteger(id) || id <= 0) return null;
  const name = firstValue(tags.name);
  const category = Object.keys(OSM_CATEGORY_INDUSTRY).find((tag) => {
    const [key, value] = tag.split("=");
    return firstValue(tags[key]) === value;
  });
  if (!name || !category) return null;

  const phone = phoneOf(firstValue(tags.phone) ?? firstValue(tags["contact:phone"]));
  const website = websiteOf(firstValue(tags.website) ?? firstValue(tags["contact:website"]) ?? firstValue(tags.url));
  const email = emailOf(firstValue(tags.email) ?? firstValue(tags["contact:email"]));
  if (!phone && !website && !email) return null;

  const centre = centreOf(feature.geometry);
  return {
    osmType: type,
    osmId: id,
    version: Number.isInteger(Number(tags["@version"])) ? Number(tags["@version"]) : null,
    name: name.slice(0, 300),
    brand: firstValue(tags.brand),
    operator: firstValue(tags.operator),
    category,
    postcode: normalizePostcode(firstValue(tags["addr:postcode"])),
    street: firstValue(tags["addr:street"]),
    housenumber: firstValue(tags["addr:housenumber"]),
    city: firstValue(tags["addr:city"]),
    lat: centre?.lat ?? null,
    lon: centre?.lon ?? null,
    phone,
    website,
    email,
    cqcLocationRef: firstValue(tags["ref:GB:cqc_location"]),
    checkDate: firstValue(tags.check_date),
  };
}

// --- Matching -----------------------------------------------------------------------------------

/** Words every practice or firm might use: they don't tell one business from another. */
const COMMON_WORDS = new Set(
  ("ltd limited llp plc co company the and of uk group partners partnership services service " +
    "dental dentist dentists dentistry practice practices surgery surgeries clinic clinics centre center medical health healthcare care " +
    "family house street road accountants accountancy accounting solicitors solicitor law legal lawyers estate agents agent " +
    "property properties associates consultants consulting").split(" "),
);

/** The words that identify a business: "Smiles Dental Leeds Ltd" → ["smiles", "leeds"]. Pure. */
export function distinctiveWords(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !COMMON_WORDS.has(w));
}

/**
 * How well two business names agree, 0 to 1: the share of identifying words they have in common.
 * Names made only of common words ("The Dental Practice") never match. Pure.
 */
export function nameAgreement(a: string, b: string): number {
  const left = new Set(distinctiveWords(a));
  const right = new Set(distinctiveWords(b));
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((w) => right.has(w)).length;
  return shared / new Set([...left, ...right]).size;
}

/** Names must agree at least this well, with at least one identifying word of 4+ letters in common. */
export const MIN_NAME_AGREEMENT = 0.6;

export type MatchSite = {
  companyId: string;
  /** Null for a company matched as a whole (it has no site with a postcode). */
  locationId: string | null;
  /** The practice's own name (CQC), or the company's. */
  name: string;
  companyName: string;
  industry: string | null;
  postcode: string | null;
  domain: string | null;
  cqcLocationId: string | null;
};
export type MatchPlace = Pick<OsmPlace, "osmType" | "osmId" | "name" | "brand" | "operator" | "category" | "postcode" | "website" | "cqcLocationRef">;
export type ProposedMatch = { companyId: string; locationId: string | null; osmType: string; osmId: number; method: "cqc_ref" | "postcode_name" | "website"; confidence: number };

const placeKey = (p: { osmType: string; osmId: number }) => `${p.osmType}/${p.osmId}`;
const domainOf = (url: string | null | undefined) => (url ? normalizeDomain(url) : null);

function namesAgree(site: MatchSite, place: MatchPlace): boolean {
  const names = [place.name, place.brand, place.operator].filter((n): n is string => !!n);
  return names.some((placeName) =>
    [site.name, site.companyName].some((ours) => {
      const shared = distinctiveWords(ours).filter((w) => w.length >= 4 && distinctiveWords(placeName).includes(w));
      return shared.length > 0 && nameAgreement(ours, placeName) >= MIN_NAME_AGREEMENT;
    }),
  );
}

/**
 * The links to make, from a workspace's sites and the candidate places. Conservative by design:
 * - an exact CQC location id links that practice (when exactly one place carries it);
 * - otherwise the same postcode, a fitting category and clearly agreeing names, with exactly one
 *   such place; the same website domain as the company raises the confidence;
 * - a place that would link to two different companies links to neither.
 * Pure, so every rule is unit-tested.
 */
export function proposeMatches(sites: MatchSite[], places: MatchPlace[]): ProposedMatch[] {
  const byCqc = new Map<string, MatchPlace[]>();
  const byPostcode = new Map<string, MatchPlace[]>();
  for (const place of places) {
    if (place.cqcLocationRef) byCqc.set(place.cqcLocationRef, [...(byCqc.get(place.cqcLocationRef) ?? []), place]);
    if (place.postcode) byPostcode.set(place.postcode, [...(byPostcode.get(place.postcode) ?? []), place]);
  }

  const proposed: ProposedMatch[] = [];
  for (const site of sites) {
    const exact = site.cqcLocationId ? (byCqc.get(site.cqcLocationId) ?? []) : [];
    if (exact.length === 1) {
      proposed.push({ companyId: site.companyId, locationId: site.locationId, ...pick(exact[0]), method: "cqc_ref", confidence: 95 });
      continue;
    }
    if (exact.length > 1 || !site.postcode) continue;
    const fits = (byPostcode.get(site.postcode) ?? []).filter(
      (place) => site.industry !== null && OSM_CATEGORY_INDUSTRY[place.category] === site.industry && namesAgree(site, place),
    );
    if (fits.length !== 1) continue;
    const sameSite = site.domain !== null && domainOf(fits[0].website) === site.domain;
    proposed.push({
      companyId: site.companyId,
      locationId: site.locationId,
      ...pick(fits[0]),
      method: sameSite ? "website" : "postcode_name",
      confidence: sameSite ? 90 : 75,
    });
  }

  // One place is one business: claimed by two companies, it is ambiguous for both.
  const owners = new Map<string, Set<string>>();
  for (const m of proposed) owners.set(placeKey(m), (owners.get(placeKey(m)) ?? new Set()).add(m.companyId));
  const unambiguous = proposed.filter((m) => owners.get(placeKey(m))!.size === 1);
  // The same place reached through two sites of one company is kept once.
  return [...new Map(unambiguous.map((m) => [`${m.companyId}|${placeKey(m)}`, m])).values()];
}

const pick = (place: MatchPlace) => ({ osmType: place.osmType, osmId: place.osmId });

/**
 * Re-links one workspace's companies and practices to the current OSM places: links that still
 * hold are refreshed, new ones added, and ones that no longer hold (a renamed or deleted place,
 * an ambiguous newcomer) removed. Returns how many links the workspace has now.
 */
export async function matchWorkspace(workspaceId: string): Promise<number> {
  const rows = await db
    .select({
      companyId: companies.id,
      companyName: companies.canonicalName,
      industry: companies.industry,
      domain: companies.domain,
      locationId: companyLocations.id,
      locationName: companyLocations.name,
      postcode: companyLocations.postalCode,
      sourceSlug: companyLocations.sourceSlug,
      externalId: companyLocations.externalId,
    })
    .from(companies)
    .leftJoin(companyLocations, eq(companyLocations.companyId, companies.id))
    .where(eq(companies.workspaceId, workspaceId));

  const sites: MatchSite[] = rows
    .filter((r) => r.locationId !== null)
    .map((r) => ({
      companyId: r.companyId,
      locationId: r.locationId,
      name: r.locationName ?? r.companyName,
      companyName: r.companyName,
      industry: r.industry,
      postcode: normalizePostcode(r.postcode),
      domain: r.domain,
      cqcLocationId: r.sourceSlug === "cqc" ? r.externalId : null,
    }));
  const postcodes = [...new Set(sites.map((s) => s.postcode).filter((p): p is string => p !== null))];
  const cqcIds = [...new Set(sites.map((s) => s.cqcLocationId).filter((id): id is string => id !== null))];

  const places: MatchPlace[] = [];
  const columns = {
    osmType: osmPlaces.osmType,
    osmId: osmPlaces.osmId,
    name: osmPlaces.name,
    brand: osmPlaces.brand,
    operator: osmPlaces.operator,
    category: osmPlaces.category,
    postcode: osmPlaces.postcode,
    website: osmPlaces.website,
    cqcLocationRef: osmPlaces.cqcLocationRef,
  };
  for (let i = 0; i < postcodes.length; i += 1000) {
    places.push(...(await db.select(columns).from(osmPlaces).where(and(isNull(osmPlaces.removedAt), inArray(osmPlaces.postcode, postcodes.slice(i, i + 1000))))));
  }
  for (let i = 0; i < cqcIds.length; i += 1000) {
    places.push(...(await db.select(columns).from(osmPlaces).where(and(isNull(osmPlaces.removedAt), inArray(osmPlaces.cqcLocationRef, cqcIds.slice(i, i + 1000))))));
  }
  const unique = [...new Map(places.map((p) => [placeKey(p), p])).values()];
  const matches = proposeMatches(sites, unique);

  await db.transaction(async (tx) => {
    const keep = matches.map((m) => `${m.companyId}|${m.osmType}/${m.osmId}`);
    await tx
      .delete(osmMatches)
      .where(
        and(
          eq(osmMatches.workspaceId, workspaceId),
          keep.length > 0 ? notInArray(sql`${osmMatches.companyId}::text || '|' || ${osmMatches.osmType} || '/' || ${osmMatches.osmId}`, keep) : sql`true`,
        ),
      );
    for (const m of matches) {
      await tx
        .insert(osmMatches)
        .values({ workspaceId, companyId: m.companyId, companyLocationId: m.locationId, osmType: m.osmType, osmId: m.osmId, method: m.method, confidence: m.confidence })
        .onConflictDoUpdate({
          target: [osmMatches.companyId, osmMatches.osmType, osmMatches.osmId],
          set: { companyLocationId: m.locationId, method: m.method, confidence: m.confidence, lastCheckedAt: new Date() },
        });
    }
  });
  return matches.length;
}

export type OsmContact = {
  type: "phone" | "email" | "website";
  value: string;
  /** The place's name on OpenStreetMap (for a chain, which practice it is). */
  label: string;
  /** The element's page on openstreetmap.org. */
  url: string;
};

/** The phones, emails and websites a company's matched OpenStreetMap places publish, strongest match first. */
export async function osmContactsFor(companyId: string): Promise<OsmContact[]> {
  const rows = await db
    .select({ osmType: osmPlaces.osmType, osmId: osmPlaces.osmId, name: osmPlaces.name, phone: osmPlaces.phone, email: osmPlaces.email, website: osmPlaces.website })
    .from(osmMatches)
    .innerJoin(osmPlaces, and(eq(osmPlaces.osmType, osmMatches.osmType), eq(osmPlaces.osmId, osmMatches.osmId), isNull(osmPlaces.removedAt)))
    .where(eq(osmMatches.companyId, companyId))
    .orderBy(sql`${osmMatches.confidence} desc`, osmPlaces.name);
  return rows.flatMap((r) => {
    const base = { label: r.name, url: osmElementUrl(r.osmType, r.osmId) };
    return [
      ...(r.phone ? [{ ...base, type: "phone" as const, value: r.phone }] : []),
      ...(r.email ? [{ ...base, type: "email" as const, value: r.email }] : []),
      ...(r.website ? [{ ...base, type: "website" as const, value: r.website }] : []),
    ];
  });
}

/** The places a company was matched to, for its Sources card: what each publishes, how it was matched, when. */
export async function osmPlacesFor(companyId: string) {
  const rows = await db
    .select({
      osmType: osmPlaces.osmType,
      osmId: osmPlaces.osmId,
      name: osmPlaces.name,
      phone: osmPlaces.phone,
      email: osmPlaces.email,
      website: osmPlaces.website,
      method: osmMatches.method,
      checkedAt: osmMatches.lastCheckedAt,
    })
    .from(osmMatches)
    .innerJoin(osmPlaces, and(eq(osmPlaces.osmType, osmMatches.osmType), eq(osmPlaces.osmId, osmMatches.osmId), isNull(osmPlaces.removedAt)))
    .where(eq(osmMatches.companyId, companyId))
    .orderBy(sql`${osmMatches.confidence} desc`, osmPlaces.name);
  return rows.map((r) => ({
    name: r.name,
    url: osmElementUrl(r.osmType, r.osmId),
    phone: r.phone,
    email: r.email,
    website: r.website,
    matchedBy: r.method,
    checkedAt: r.checkedAt.toISOString(),
  }));
}

/** Whether any OSM places have been imported yet (the weekly import has run at least once). */
export async function osmImported(): Promise<boolean> {
  const [row] = await db.select({ osmId: osmPlaces.osmId }).from(osmPlaces).where(isNull(osmPlaces.removedAt)).limit(1);
  return Boolean(row);
}

/** The element's page on openstreetmap.org, linked as the source of a contact. */
export const osmElementUrl = (osmType: string, osmId: number) => `https://www.openstreetmap.org/${osmType}/${osmId}`;

export const openStreetMap: SourceAdapter = {
  slug: "openstreetmap",
  // Needs no key; nothing is matched until the weekly import has loaded places.
  isConfigured: () => true,
  async healthCheck(): Promise<HealthStatus> {
    return (await osmImported())
      ? { ok: true, message: "OpenStreetMap places imported." }
      : { ok: false, message: "No OpenStreetMap places imported yet: run `npm run osm:import`." };
  },
};
