import "server-only";
import { registrableDomain } from "./http";
import type { HealthStatus, SourceAdapter } from "./index";
import { distinctiveWords, MIN_NAME_AGREEMENT, nameAgreement, normalizePostcode } from "./osm";
import { PLACEHOLDER_EMAIL } from "./company-website";

/**
 * Overture Maps places: a free, monthly map dataset of businesses (about 88 million worldwide) with
 * their websites, phones and emails, built from Meta, Microsoft, Foursquare and other sources.
 *
 * We never copy the whole dataset. `scripts/overture.ts` lists the websites and postcodes of the
 * companies we already have, DuckDB looks only those up in the current release (read straight from
 * Overture's public bucket), and the places found are matched here:
 * - **website**: a place whose website is the company's own domain is that company. Its phone and
 *   email become company contacts (source "overture").
 * - **postcode_name**: for a company with no website yet, a place at the same postcode with clearly
 *   the same name. Its website is only a *candidate*: `enrich_company` accepts it after the usual
 *   evidence check on the site itself (company number, or name with postcode or town).
 * Anything ambiguous matches nothing.
 *
 * Licence: CDLA Permissive 2.0 for most sources (Apache 2.0 for Foursquare, CC0 for some); it allows
 * storing and showing the data, with attribution to Overture and its sources (see OVERTURE_ATTRIBUTION).
 */

export const OVERTURE_ATTRIBUTION =
  "© Overture Maps Foundation (overturemaps.org), CDLA Permissive 2.0; includes data from Meta, Microsoft, Foursquare (© 2024 Foursquare Labs, Inc.) and others.";

/** Places below this confidence are left out: Overture's own guidance on junk and closed places. */
export const MIN_PLACE_CONFIDENCE = 0.7;

/** One place as the DuckDB lookup writes it (one JSON object per line). */
export type OverturePlace = {
  id: string;
  name: string;
  category: string | null;
  confidence: number;
  websites: string[] | null;
  phones: string[] | null;
  emails: string[] | null;
  postcode: string | null;
  country: string | null;
  city: string | null;
  /** The datasets behind it (meta, microsoft, Foursquare…), for attribution. */
  datasets: string[] | null;
};

/** A company we look up: its own website, or (without one) where it is. */
export type OvertureTarget = {
  companyId: string;
  workspaceId: string;
  name: string;
  domain: string | null;
  postcode: string | null;
  country: string | null;
};

export type OvertureMatch = {
  companyId: string;
  workspaceId: string;
  place: OverturePlace;
  method: "website" | "postcode_name";
  confidence: number;
  /** website matches: the contacts to add. */
  phones: string[];
  emails: string[];
  /** postcode_name matches: the site to check. */
  candidateDomain: string | null;
};

/** A postcode in one comparable form per country: "SW1A 1AA" → "SW1A1AA", "02139-4307" → "02139". */
export function comparablePostcode(postcode: string | null | undefined, country: string | null | undefined): string | null {
  if (!postcode || !country) return null;
  if (country === "GB") return normalizePostcode(postcode);
  if (country === "US") return /^\d{5}/.test(postcode.trim()) ? postcode.trim().slice(0, 5) : null;
  const value = postcode.replace(/\s+/g, "").toUpperCase();
  return value.length >= 3 ? value : null;
}

/** The registrable domains a place's websites point to ("https://www.smiles.co.uk/book" → "smiles.co.uk"). */
export function placeDomains(place: Pick<OverturePlace, "websites">): string[] {
  const domains = (place.websites ?? []).flatMap((raw) => {
    try {
      const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
      return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? [registrableDomain(host)] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(domains)];
}

/** A phone in international form, or null: "+44 20 7946 0000" → "+442079460000". */
export function cleanPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "").replace(/^00/, "+");
  return /^(\+\d{10,14}|0\d{9,10})$/.test(digits) ? digits : null;
}

const cleanEmail = (raw: string, domain: string): string | null => {
  const email = raw.replace(/^mailto:/i, "").trim().toLowerCase();
  // Only an address at the company's own domain: a place's email can be a franchise or agency inbox.
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) && !PLACEHOLDER_EMAIL.test(email) && email.endsWith(`@${domain}`) ? email : null;
};

/** The same business by name: a shared identifying word of 4+ letters and clearly agreeing names. */
function namesAgree(ours: string, theirs: string): boolean {
  const shared = distinctiveWords(ours).filter((w) => w.length >= 4 && distinctiveWords(theirs).includes(w));
  return shared.length > 0 && nameAgreement(ours, theirs) >= MIN_NAME_AGREEMENT;
}

/** Contacts kept per company from one place: enough to reach it, not a dump of a chain's branches. */
const MAX_CONTACTS = 2;

/**
 * The matches to make, from the companies looked up and the places found. Conservative by design:
 * - a company with a website takes the place(s) on that same domain: the one at its own postcode
 *   if there is one, else the most confident; its phones and own-domain emails are kept;
 * - a company without a website takes a candidate site only from exactly one place at its
 *   postcode with clearly the same name, and only when no other company in the workspace claims
 *   that place.
 * Pure, so every rule is unit-tested.
 */
export function proposeOvertureMatches(targets: OvertureTarget[], places: OverturePlace[]): OvertureMatch[] {
  const usable = places.filter((p) => p.confidence >= MIN_PLACE_CONFIDENCE && p.name);
  const byDomain = new Map<string, OverturePlace[]>();
  const byPostcode = new Map<string, OverturePlace[]>();
  for (const place of usable) {
    for (const domain of placeDomains(place)) byDomain.set(domain, [...(byDomain.get(domain) ?? []), place]);
    const postcode = comparablePostcode(place.postcode, place.country);
    if (postcode) byPostcode.set(`${place.country}|${postcode}`, [...(byPostcode.get(`${place.country}|${postcode}`) ?? []), place]);
  }

  const matches: OvertureMatch[] = [];
  for (const target of targets) {
    const ourPostcode = comparablePostcode(target.postcode, target.country);
    if (target.domain) {
      const same = byDomain.get(target.domain) ?? [];
      if (same.length === 0) continue;
      const local = same.filter((p) => ourPostcode && comparablePostcode(p.postcode, p.country) === ourPostcode);
      const best = [...(local.length > 0 ? local : same)].sort((a, b) => b.confidence - a.confidence)[0];
      const phones = [...new Set((best.phones ?? []).map(cleanPhone).filter((p): p is string => p !== null))].slice(0, MAX_CONTACTS);
      const emails = [...new Set((best.emails ?? []).map((e) => cleanEmail(e, target.domain!)).filter((e): e is string => e !== null))].slice(0, MAX_CONTACTS);
      if (phones.length === 0 && emails.length === 0) continue;
      matches.push({ ...ids(target), place: best, method: "website", confidence: local.length > 0 ? 95 : 85, phones, emails, candidateDomain: null });
      continue;
    }
    if (!ourPostcode || !target.country) continue;
    const fits = (byPostcode.get(`${target.country}|${ourPostcode}`) ?? []).filter((p) => placeDomains(p).length > 0 && namesAgree(target.name, p.name));
    if (fits.length !== 1) continue;
    matches.push({ ...ids(target), place: fits[0], method: "postcode_name", confidence: 70, phones: [], emails: [], candidateDomain: placeDomains(fits[0])[0] });
  }

  // One place, one business: a candidate claimed by two companies of a workspace is ambiguous for both.
  const claims = new Map<string, Set<string>>();
  for (const m of matches.filter((m) => m.method === "postcode_name")) {
    const key = `${m.workspaceId}|${m.place.id}`;
    claims.set(key, (claims.get(key) ?? new Set()).add(m.companyId));
  }
  return matches.filter((m) => m.method === "website" || claims.get(`${m.workspaceId}|${m.place.id}`)!.size === 1);
}

const ids = (t: OvertureTarget) => ({ companyId: t.companyId, workspaceId: t.workspaceId });

/** Overture's public bucket, and the newest release in it (listed anonymously over HTTPS). */
export const OVERTURE_BUCKET = "overturemaps-us-west-2";

export async function latestOvertureRelease(): Promise<string> {
  const response = await fetch(`https://${OVERTURE_BUCKET}.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Overture bucket answered ${response.status}.`);
  const releases = [...(await response.text()).matchAll(/<Prefix>release\/([^/<]+)\/<\/Prefix>/g)].map((m) => m[1]).sort();
  if (releases.length === 0) throw new Error("No Overture release found.");
  return releases[releases.length - 1];
}

/**
 * The DuckDB query that looks our targets up in one release: places whose website is one of our
 * domains, or whose postcode is one of our postcodes (country-checked), above the confidence floor.
 * `targets` is a CSV with columns kind (domain | postcode), value, country.
 */
export function overtureLookupSql(release: string, targetsCsv: string, outJson: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return `
INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';
CREATE TABLE targets AS SELECT * FROM read_csv(${q(targetsCsv)}, header = true, all_varchar = true);
SET VARIABLE domains = (SELECT coalesce(list(DISTINCT value), []) FROM targets WHERE kind = 'domain');
SET VARIABLE postcodes = (SELECT coalesce(list(DISTINCT country || '|' || value), []) FROM targets WHERE kind = 'postcode');
-- One streaming pass over the release: a place is kept when one of its website hosts (or that
-- host's parent: shop.smiles.co.uk → smiles.co.uk) is one of our domains, or its postcode is ours.
COPY (
  SELECT id, name, category, confidence, websites, phones, emails, postcode, country, city, datasets FROM (
    SELECT id, names.primary AS name, basic_category AS category, confidence, websites, phones, emails,
      addresses[1].postcode AS postcode, addresses[1].country AS country, addresses[1].locality AS city,
      [s.dataset FOR s IN sources] AS datasets,
      [regexp_replace(lower(regexp_extract(w, '^(?:https?://)?([^/:?#]+)', 1)), '^www\\.', '') FOR w IN coalesce(websites, [])] AS hosts,
      addresses[1].country || '|' || CASE
        WHEN addresses[1].country = 'GB' THEN upper(replace(addresses[1].postcode, ' ', ''))
        WHEN addresses[1].country = 'US' THEN left(addresses[1].postcode, 5)
        ELSE upper(replace(addresses[1].postcode, ' ', '')) END AS pc
    FROM read_parquet('s3://${OVERTURE_BUCKET}/release/${release}/theme=places/type=place/*')
    WHERE confidence >= ${MIN_PLACE_CONFIDENCE} AND (websites IS NOT NULL OR phones IS NOT NULL)
  )
  WHERE list_has_any(list_concat(hosts, [regexp_replace(h, '^[^.]+\\.', '') FOR h IN hosts]), getvariable('domains'))
     OR list_contains(getvariable('postcodes'), pc)
) TO ${q(outJson)} (FORMAT json);
`;
}

export const overture: SourceAdapter = {
  slug: "overture",
  // Needs no key: the lookup runs offline (`npm run overture -- …`, scheduled in GitHub Actions).
  isConfigured: () => true,
  async healthCheck(): Promise<HealthStatus> {
    try {
      return { ok: true, message: `Latest Overture release: ${await latestOvertureRelease()}.` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Overture bucket unreachable." };
    }
  },
};
