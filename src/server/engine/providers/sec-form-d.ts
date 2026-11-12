import "server-only";
import { decodeEntities } from "@/server/jobs/html-to-text";
import { fetchText } from "../http";
import type { DiscoveredItem, DiscoveryProvider } from "../types";

/**
 * SEC EDGAR Form D: the legal notice a US company files when it raises money by selling securities
 * privately. It is first-hand evidence of an actual funding event, which is what this capability
 * needs (a directory listing is not). Funds, SPVs and trusts file Form D too, so they are filtered out.
 */

const val = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim() ?? null;
const num = (s: string | null) => (s && /^\d+(\.\d+)?$/.test(s) ? Number(s) : null);

/** Names that mark an investment vehicle rather than an operating company. */
// A year in the name ("Gaingels Palmetto 2026 LLC") marks a one-deal syndicate.
const VEHICLE_NAME =
  /(\bfund\b|\bseries\b|a series of|\bspv\b|\btrust\b|\bl\.?p\.?\b|\bpartners\b|\bholdings? (i|ii|iii)\b|\bventures? (i|ii|iii|iv)\b|\bcapital\b|\binvest(ments?|ors?)?\b|\b(19|20)\d{2}\b)/i;
/** Form D industry groups that are finance, real estate or funds, not companies that buy services. */
const FINANCE_INDUSTRIES = /^(pooled investment fund|hedge fund|private equity fund|venture capital fund|other investment fund|investing|investment banking|commercial banking|insurance|reits & finance|residential|commercial|construction|other real estate|other banking & financial services)$/i;
/**
 * The Form D industries whose companies buy tech and agency services: technology and business
 * services. Biotech, manufacturing, lodging, clubs and "Other" are left out: a filing alone says
 * nothing about needing software, AI or marketing work.
 */
const BUYING_INDUSTRIES = /^(computers|telecommunications|other technology|business services)$/i;
/** Below this, a raise is too small to pay for outside work. */
const MIN_RAISE_USD = 100_000;

const US_STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
const CA_PROVINCES = new Set("AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" "));
const COUNTRY_BY_NAME: Record<string, string> = {
  "UNITED KINGDOM": "GB", IRELAND: "IE", GERMANY: "DE", NETHERLANDS: "NL", FRANCE: "FR", ISRAEL: "IL", INDIA: "IN", SINGAPORE: "SG", AUSTRALIA: "AU",
};

export function countryOf(stateOrCountry: string | null, description: string | null): string | null {
  if (stateOrCountry && US_STATES.has(stateOrCountry)) return "US";
  if (stateOrCountry && CA_PROVINCES.has(stateOrCountry)) return "CA";
  return (description && COUNTRY_BY_NAME[description.toUpperCase()]) || null;
}

export function isVehicleName(name: string): boolean {
  return VEHICLE_NAME.test(name);
}

export type Filing = { indexUrl: string; accession: string; filedOn: string | null };

/** Pulls new-filing (not amendment) entries from EDGAR's "latest filings" Atom feed. */
export function parseFeed(xml: string): (Filing & { name: string })[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap(([, raw]) => {
    // The feed escapes its HTML summary (&lt;b&gt;Filed:&lt;/b&gt;), so read the decoded text.
    const e = decodeEntities(raw);
    const title = e.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    const m = title.match(/^D - (.+?) \(\d+\) \(Filer\)$/);
    const href = e.match(/<link[^>]*href="([^"]+)"/)?.[1];
    const accession = e.match(/AccNo:<\/b>\s*([\d-]+)/)?.[1] ?? e.match(/accession-number=([\d-]+)/)?.[1] ?? "";
    if (!m || !href || !accession) return [];
    return [{ name: m[1], indexUrl: href, accession, filedOn: e.match(/Filed:<\/b>\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null }];
  });
}

export function parseFormD(xml: string, filing: Filing): DiscoveredItem | null {
  if (val(xml, "isAmendment") === "true") return null;
  const name = val(xml, "entityName");
  if (!name || isVehicleName(name)) return null;
  const industry = val(xml, "industryGroupType");
  if (industry && FINANCE_INDUSTRIES.test(industry)) return null;
  if (!industry || !BUYING_INDUSTRIES.test(industry)) return null;

  const sold = num(val(xml, "totalAmountSold"));
  const offering = num(val(xml, "totalOfferingAmount"));
  // Money actually sold is confirmed funding; an opened-but-unsold offering is only a claim.
  const confirmed = sold !== null && sold > 0;
  const amount = confirmed ? sold : offering;
  if (amount !== null && amount < MIN_RAISE_USD) return null;
  const date = xml.match(/<dateOfFirstSale>\s*<value>(\d{4}-\d{2}-\d{2})</)?.[1] ?? filing.filedOn;
  const state = val(xml, "stateOrCountry");
  const people = [...xml.matchAll(/<relatedPersonInfo>([\s\S]*?)<\/relatedPersonInfo>/g)].flatMap(([, p]) => {
    const first = val(p, "firstName");
    const last = val(p, "lastName");
    const roles = [...p.matchAll(/<relationship>([^<]+)<\/relationship>/g)].map((r) => r[1]);
    return first || last ? [{ name: [first, last].filter(Boolean).join(" "), roles }] : [];
  });

  return {
    capability: "funded",
    category: "funded_company",
    sourceSlug: "sec_form_d",
    platform: "SEC EDGAR (Form D)",
    externalId: filing.accession,
    url: filing.indexUrl,
    title: `${name} filed a Form D${amount ? ` for $${Math.round(amount).toLocaleString("en-US")}` : ""}`,
    text: [`${name}${industry ? ` (${industry})` : ""}`, val(xml, "entityType"), confirmed ? `Amount sold: $${sold!.toLocaleString("en-US")}` : "No sales reported yet"].filter(Boolean).join(". "),
    postedAt: filing.filedOn ? new Date(filing.filedOn) : null,
    buyerName: null,
    buyerProfileUrl: null,
    companyName: name,
    companyDomain: null, // Form D has no website; never guessed
    country: countryOf(state, val(xml, "stateOrCountryDescription")),
    city: val(xml, "city"),
    industry: null,
    remote: null,
    clientType: "company",
    budget: null,
    funding: { amountUsd: amount, stage: "Private placement (Form D)", date, investors: [] },
    intentHint: null,
    verification: confirmed ? "verified" : "unverified",
    metadata: { industryGroup: industry, amountKind: confirmed ? "sold" : "offering", people, accession: filing.accession },
  };
}

export const secFormD: DiscoveryProvider = {
  slug: "sec_form_d",
  name: "SEC EDGAR (Form D)",
  capability: "funded",
  async discover({ signal }) {
    const feed = await fetchText("https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=D&count=100&output=atom", { signal });
    const filings = parseFeed(feed).filter((f) => !isVehicleName(f.name)).slice(0, 30);
    const items: DiscoveredItem[] = [];
    for (const filing of filings) {
      // SEC allows 10 requests a second; one every 250 ms stays well under.
      await new Promise((r) => setTimeout(r, 250));
      try {
        const xml = await fetchText(filing.indexUrl.replace(/[^/]*$/, "primary_doc.xml"), { signal });
        const item = parseFormD(xml, filing);
        if (item) items.push(item);
      } catch {
        // One unreadable filing must not hide the rest.
      }
    }
    return items;
  },
};
