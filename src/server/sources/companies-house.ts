import "server-only";
import { z } from "zod";
import { INDUSTRY_SIC_CODES, industryForSicCodes } from "@/lib/domain/uk-codes";
import type { DiscoveryCriteria, FoundCompany, FoundPerson, HealthStatus, SourceAdapter } from "./index";
import { politeGet } from "./http";
import { officerToPerson, titleCaseCompanyName } from "./names";

/**
 * Companies House (official UK register, Open Government Licence): advanced company search by SIC
 * code, location and formation date, and each company's officers (directors). Free API key in
 * COMPANIES_HOUSE_API_KEY; 600 requests per 5 minutes.
 */

const API = "https://api.company-information.service.gov.uk";
const PUBLIC_PAGE = (number: string) => `https://find-and-update.company-information.service.gov.uk/company/${number}`;
/** Results per search page (the API allows up to 5,000; small pages keep each request light). */
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

const address = z
  .object({
    address_line_1: z.string().nullish(),
    locality: z.string().nullish(),
    region: z.string().nullish(),
    postal_code: z.string().nullish(),
    country: z.string().nullish(),
  })
  .nullish();

const searchItem = z.object({
  company_name: z.string(),
  company_number: z.string(),
  company_status: z.string().nullish(),
  company_type: z.string().nullish(),
  date_of_creation: z.string().nullish(),
  registered_office_address: address,
  sic_codes: z.array(z.string()).nullish(),
});
const searchResponse = z.object({ items: z.array(z.unknown()).nullish(), hits: z.number().nullish() });

const officer = z.object({
  name: z.string(),
  officer_role: z.string(),
  occupation: z.string().nullish(),
  appointed_on: z.string().nullish(),
  resigned_on: z.string().nullish(),
});
const officersResponse = z.object({ items: z.array(z.unknown()).nullish() });

/** Company types that are businesses we could sell to (not e.g. charitable incorporated bodies' sub-entities). */
const BUSINESS_TYPES = new Set(["ltd", "plc", "llp", "private-unlimited", "private-limited-guarant-nsc", "private-limited-guarant-nsc-limited-exemption"]);

function authHeader(): Record<string, string> {
  const key = process.env.COMPANIES_HOUSE_API_KEY ?? "";
  return { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, accept: "application/json" };
}

async function getJson(path: string): Promise<unknown> {
  const page = await politeGet(`${API}${path}`, { sameSite: false, headers: authHeader() });
  if (page.status === 404) return null;
  if (page.status === 401) throw new Error("Companies House rejected the API key (401).");
  if (page.status === 429) throw new Error("Companies House rate limit reached (429).");
  if (page.status >= 400) throw new Error(`Companies House answered ${page.status}.`);
  return JSON.parse(page.body);
}

/** Maps one search result to a company; null for types we don't target. Exported for tests. */
export function toFoundCompany(raw: unknown): FoundCompany | null {
  const parsed = searchItem.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  if (item.company_type && !BUSINESS_TYPES.has(item.company_type)) return null;
  const office = item.registered_office_address;
  return {
    name: titleCaseCompanyName(item.company_name),
    domain: null,
    industry: industryForSicCodes(item.sic_codes ?? []),
    hq: { city: office?.locality?.trim() || null, region: office?.region?.trim() || null, country: "GB", postalCode: office?.postal_code?.trim() || null },
    identifiers: [{ scheme: "gb_company_number", value: item.company_number }],
    foundedOn: item.date_of_creation ?? null,
    record: {
      sourceSlug: "companies_house",
      externalId: `company:${item.company_number}`,
      url: PUBLIC_PAGE(item.company_number),
      recordType: "company_profile",
      publishedAt: item.date_of_creation ? new Date(`${item.date_of_creation}T12:00:00Z`) : null,
      data: {
        companyNumber: item.company_number,
        registeredName: item.company_name,
        status: item.company_status ?? null,
        type: item.company_type ?? null,
        sicCodes: item.sic_codes ?? [],
        postalCode: office?.postal_code ?? null,
      },
    },
  };
}

/** Active directors and members, as people. Exported for tests. */
export function toFoundPeople(raw: unknown): FoundPerson[] {
  const items = officersResponse.safeParse(raw).data?.items ?? [];
  return items.flatMap((item) => {
    const parsed = officer.safeParse(item);
    if (!parsed.success || parsed.data.resigned_on) return [];
    const person = officerToPerson(parsed.data);
    return person ? [person] : [];
  });
}

const nameSearchItem = z.object({
  title: z.string(),
  company_number: z.string(),
  company_status: z.string().nullish(),
  address: z.object({ postal_code: z.string().nullish() }).nullish(),
  address_snippet: z.string().nullish(),
});

const comparableName = (name: string) =>
  name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(limited|ltd|plc|llp)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const compactPostcode = (value: string | null | undefined) => value?.replace(/\s+/g, "").toUpperCase() || null;

/**
 * The single active company whose registered name is exactly `name` and whose registered address
 * has one of `postcodes`. Anything less certain (no match, several, or the name alone) gives null,
 * so a record is only linked to a company number on clear evidence. Pure, for tests.
 */
export function pickCompanyNumber(items: unknown[], name: string, postcodes: string[]): string | null {
  const wanted = comparableName(name);
  const codes = new Set(postcodes.map(compactPostcode).filter(Boolean));
  const exact = items.flatMap((raw) => {
    const item = nameSearchItem.safeParse(raw);
    if (!item.success || item.data.company_status !== "active" || comparableName(item.data.title) !== wanted) return [];
    return [item.data];
  });
  if (exact.length !== 1) return null;
  const postcode = compactPostcode(exact[0].address?.postal_code) ?? compactPostcode(exact[0].address_snippet?.match(/[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i)?.[0]);
  return postcode && codes.has(postcode) ? exact[0].company_number : null;
}

/** Looks up a business's company number by exact name and postcode; null when not clear-cut or unavailable. */
export async function findCompanyNumber(name: string, postcodes: string[]): Promise<string | null> {
  if (!companiesHouse.isConfigured() || postcodes.length === 0) return null;
  try {
    const body = await getJson(`/search/companies?q=${encodeURIComponent(name)}&items_per_page=20`);
    const items = z.object({ items: z.array(z.unknown()).nullish() }).safeParse(body).data?.items ?? [];
    return pickCompanyNumber(items, name, postcodes);
  } catch (error) {
    console.warn("[sources] Companies House name lookup failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

export const companiesHouse: SourceAdapter = {
  slug: "companies_house",

  isConfigured: () => Boolean(process.env.COMPANIES_HOUSE_API_KEY),

  async healthCheck(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { ok: false, message: "COMPANIES_HOUSE_API_KEY is not set." };
    try {
      await getJson("/advanced-search/companies?size=1");
      return { ok: true, message: "Reachable." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Unreachable." };
    }
  },

  async discoverCompanies(criteria: DiscoveryCriteria): Promise<FoundCompany[]> {
    const sicCodes = [...new Set(criteria.industries.flatMap((slug) => INDUSTRY_SIC_CODES[slug] ?? []))];
    if (sicCodes.length === 0) return [];
    const locations = criteria.locations.length > 0 ? criteria.locations : [null];
    const found: FoundCompany[] = [];

    for (const location of locations) {
      for (let page = 0; page < MAX_PAGES && found.length < criteria.limit; page++) {
        const params = new URLSearchParams({
          sic_codes: sicCodes.join(","),
          company_status: "active",
          size: String(PAGE_SIZE),
          start_index: String(page * PAGE_SIZE),
        });
        if (location) params.set("location", location);
        if (criteria.formedAfter) params.set("incorporated_from", criteria.formedAfter);

        const body = searchResponse.safeParse(await getJson(`/advanced-search/companies?${params}`)).data;
        const items = body?.items ?? [];
        for (const raw of items) {
          const company = toFoundCompany(raw);
          if (!company) continue;
          const number = company.identifiers[0].value;
          if (criteria.known.has(number) || found.some((f) => f.identifiers[0].value === number)) continue;
          found.push(company);
          if (found.length >= criteria.limit) break;
        }
        if (items.length < PAGE_SIZE) break;
      }
      if (found.length >= criteria.limit) break;
    }
    return found;
  },

  async findPeople(company) {
    const number = company.identifiers.find((i) => i.scheme === "gb_company_number")?.value;
    if (!number) return null;
    const body = await getJson(`/company/${encodeURIComponent(number)}/officers?items_per_page=50&register_view=false`);
    if (!body) return null;
    return {
      people: toFoundPeople(body),
      record: {
        sourceSlug: "companies_house",
        externalId: `officers:${number}`,
        url: `${PUBLIC_PAGE(number)}/officers`,
        recordType: "officer_list",
        publishedAt: null,
        data: { companyNumber: number },
      },
    };
  },
};
