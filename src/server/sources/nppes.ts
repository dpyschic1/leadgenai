import "server-only";
import { z } from "zod";
import { politeGet } from "./http";
import type { FoundCompany, FoundPerson, HealthStatus, SourceAdapter } from "./index";
import { jobFunctionFromTitle, seniorityFromTitle, titleCaseCompanyName } from "./names";

/**
 * The US NPI Registry (NPPES, run by CMS): every US healthcare organization with a National
 * Provider Identifier: dental practices, clinics, therapy and optometry practices. Public data
 * (disclosable under FOIA, no charge, no key), from the registry's own API.
 *
 * Limits we work within: at most 200 results per request and 1,200 per query (`skip` max 1000),
 * results in name order with no date filter, and an hourly query limit. So each run reads one page
 * of one (category, state) and moves on; bulk use would need the monthly download instead.
 * The registry has no website or email: those come from our own website matching afterwards.
 */

const API = "https://npiregistry.cms.hhs.gov/api/";
const PAGE_SIZE = 200;
/** The registry's own cap: `skip` beyond this returns the same rows. */
export const MAX_SKIP = 1000;

/**
 * The registry's taxonomy searches for each industry (`taxonomy_description` matches either half
 * of a description, e.g. "Dentist" or "Dental"), and the taxonomy codes we accept as that industry.
 */
export const INDUSTRY_NPI_TAXONOMIES: Record<string, { searches: string[]; codes: RegExp }> = {
  dental: { searches: ["Dentist", "Dental"], codes: /^(1223|261QD)/ },
  healthcare: {
    searches: ["Clinic/Center", "Multi-Specialty", "Physical Therapy", "Optometrist", "Chiropractor", "Federally Qualified Health Center (FQHC)"],
    codes: /^(261Q|2251|152W|111N|207Q|208D)/,
  },
};

/** US states and DC, in the order discovery walks them. */
export const US_STATES = [
  "CA", "TX", "FL", "NY", "PA", "IL", "OH", "GA", "NC", "MI", "NJ", "VA", "WA", "AZ", "MA", "TN", "IN", "MD", "MO", "WI",
  "CO", "MN", "SC", "AL", "LA", "KY", "OR", "OK", "CT", "UT", "IA", "NV", "AR", "MS", "KS", "NM", "NE", "ID", "WV", "HI",
  "NH", "ME", "MT", "RI", "DE", "SD", "ND", "AK", "DC", "VT", "WY",
] as const;

const text = z.string().nullish();
const address = z.object({
  address_purpose: text,
  address_1: text,
  address_2: text,
  city: text,
  state: text,
  postal_code: text,
  country_code: text,
  telephone_number: text,
});
const npiOrganization = z.object({
  number: z.union([z.string(), z.number()]).transform(String),
  enumeration_type: z.literal("NPI-2"),
  basic: z.object({
    organization_name: z.string(),
    organizational_subpart: text,
    enumeration_date: text,
    status: text,
    authorized_official_first_name: text,
    authorized_official_last_name: text,
    authorized_official_title_or_position: text,
    authorized_official_telephone_number: text,
  }),
  addresses: z.array(address).default([]),
  taxonomies: z.array(z.object({ code: z.string(), desc: text, primary: z.boolean().nullish() })).default([]),
  other_names: z.array(z.object({ type: text, organization_name: text })).nullish(),
});
export type NpiOrganization = z.infer<typeof npiOrganization>;

/** "5123273631" or "512-327-3631" → "512-327-3631"; anything else → null. */
export function usPhone(raw: string | null | undefined): string | null {
  const digits = raw?.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits && /^[2-9]\d{9}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : null;
}

const zip5 = (raw: string | null | undefined) => (raw && /^\d{5}/.test(raw) ? raw.slice(0, 5) : null);
const titleCase = (value: string | null | undefined) => (value ? value.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null);

/** Organizations from one API reply; an error reply (HTTP 200 with `Errors`) throws. Pure. */
export function parseSearch(body: unknown): NpiOrganization[] {
  const reply = z.object({ results: z.array(z.unknown()).optional(), Errors: z.array(z.object({ description: text })).optional() }).parse(body);
  if (reply.Errors?.length) throw new Error(`NPI Registry: ${reply.Errors.map((e) => e.description).join("; ")}`);
  return (reply.results ?? []).flatMap((item) => {
    const parsed = npiOrganization.safeParse(item);
    return parsed.success && parsed.data.basic.status !== "D" ? [parsed.data] : [];
  });
}

/** The practice's place of business (not its mailing address). */
export const locationOf = (org: NpiOrganization) => org.addresses.find((a) => a.address_purpose === "LOCATION") ?? org.addresses[0] ?? null;

/** Whether its main taxonomy belongs to the industry (a search can match a secondary one). Pure. */
export function fitsIndustry(org: NpiOrganization, industry: string): boolean {
  const codes = INDUSTRY_NPI_TAXONOMIES[industry]?.codes;
  const primary = org.taxonomies.find((t) => t.primary) ?? org.taxonomies[0];
  return Boolean(codes && primary && codes.test(primary.code));
}

/** The organization as a found company: registry id, location, and the NPI record as its source. Pure. */
export function toFoundCompany(org: NpiOrganization, industry: string): FoundCompany {
  const place = locationOf(org);
  const dba = org.other_names?.find((n) => /doing business as/i.test(n.type ?? ""))?.organization_name;
  const primary = org.taxonomies.find((t) => t.primary) ?? org.taxonomies[0];
  return {
    // The legal name; a "doing business as" name is often the dentist's own, so it is kept as a fact only.
    name: titleCaseCompanyName(org.basic.organization_name.trim()),
    domain: null,
    industry,
    hq: place ? { city: titleCase(place.city), region: place.state ?? null, country: "US", postalCode: zip5(place.postal_code) } : null,
    identifiers: [{ scheme: "us_npi", value: org.number }],
    identity: "verified",
    foundedOn: org.basic.enumeration_date ?? null,
    record: {
      sourceSlug: "us_npi",
      externalId: `npi:${org.number}`,
      url: `https://npiregistry.cms.hhs.gov/provider-view/${org.number}`,
      recordType: "npi_organization",
      publishedAt: null,
      data: { npi: org.number, legalName: org.basic.organization_name, tradingName: dba ?? null, taxonomy: primary?.desc ?? null, taxonomyCode: primary?.code ?? null, enumeratedOn: org.basic.enumeration_date ?? null },
    },
  };
}

/** The practice's phone and address, as its location. Pure. */
export function toLocation(org: NpiOrganization) {
  const place = locationOf(org);
  if (!place) return null;
  return {
    externalId: org.number,
    name: titleCaseCompanyName(org.basic.organization_name),
    address: [place.address_1, place.address_2].map(titleCase).filter(Boolean).join(", ") || null,
    city: titleCase(place.city),
    region: place.state ?? null,
    postalCode: zip5(place.postal_code),
    website: null,
    phone: usPhone(place.telephone_number),
  };
}

/** The organization's authorized official (who signs for it with CMS), with the phone the registry lists. Pure. */
export function toPeople(org: NpiOrganization): FoundPerson[] {
  const first = titleCase(org.basic.authorized_official_first_name);
  const last = titleCase(org.basic.authorized_official_last_name);
  if (!first || !last) return [];
  const title = titleCase(org.basic.authorized_official_title_or_position);
  return [
    {
      name: `${first} ${last}`,
      title,
      seniority: seniorityFromTitle(title),
      jobFunction: jobFunctionFromTitle(title),
      relationship: "employee",
      // Named by the organization itself to CMS as its authorized official.
      confidence: 90,
      phone: usPhone(org.basic.authorized_official_telephone_number),
    },
  ];
}

/** One page of organizations for a taxonomy search in a state (by place of business). */
export async function searchOrganizations(search: { taxonomy: string; state: string; skip: number }): Promise<NpiOrganization[]> {
  const params = new URLSearchParams({
    version: "2.1",
    enumeration_type: "NPI-2",
    taxonomy_description: search.taxonomy,
    state: search.state,
    address_purpose: "LOCATION",
    limit: String(PAGE_SIZE),
    skip: String(Math.min(search.skip, MAX_SKIP)),
  });
  const page = await politeGet(`${API}?${params}`, { sameSite: false, timeoutMs: 20_000, headers: { accept: "application/json" } });
  if (page.status >= 400) throw new Error(`The NPI Registry answered ${page.status}.`);
  return parseSearch(JSON.parse(page.body));
}

export { PAGE_SIZE as NPI_PAGE_SIZE };

export const nppes: SourceAdapter = {
  slug: "us_npi",
  isConfigured: () => true,
  async healthCheck(): Promise<HealthStatus> {
    try {
      await searchOrganizations({ taxonomy: "Dentist", state: "DE", skip: 0 });
      return { ok: true, message: "NPI Registry reachable." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Unavailable." };
    }
  },
};
