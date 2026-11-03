import "server-only";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { INDUSTRY_CQC_SERVICE_TYPES } from "@/lib/domain/uk-codes";
import { normalizeDomain } from "@/lib/validation/companies";
import { politeGet } from "./http";
import type { FoundCompany, FoundPerson, HealthStatus, SourceAdapter } from "./index";
import { titleCaseCompanyName } from "./names";

/**
 * The CQC register (England's health and care regulator): every registered dental practice,
 * clinic and care service, grouped by provider. Contains CQC information, used under the Open
 * Government Licence v3.0; we acknowledge that and never imply CQC endorsement. England only.
 *
 * Two ways in, so an outage of one doesn't stop the other:
 * - the weekly directory CSV (no key): name, address, postcode, phone, website, service types,
 *   provider and ids for every location; the main source;
 * - the API (optional key in CQC_API_KEY): adds each location's registration date and registered
 *   managers. Used only when configured, with a short timeout; any failure is skipped quietly.
 */

const DATA_PAGE = "https://www.cqc.org.uk/about-us/transparency/using-cqc-data";
const API = "https://api.service.cqc.org.uk/public/v1";
export const CQC_ATTRIBUTION = "Contains CQC information, used under the Open Government Licence v3.0.";
/** The directory is ~19 MB; allow some growth. */
const MAX_DIRECTORY_BYTES = 40 * 1024 * 1024;
const DIRECTORY_TIMEOUT_MS = 60_000;
const API_TIMEOUT_MS = 8_000;
/** The directory changes weekly; one download serves every workspace for this long. */
const CACHE_MS = 12 * 60 * 60 * 1000;

export type CqcLocation = {
  locationId: string;
  providerId: string;
  name: string;
  address: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  serviceTypes: string[];
  providerName: string;
  localAuthority: string | null;
  region: string | null;
  url: string | null;
};

export type CqcProvider = { providerId: string; providerName: string; locations: CqcLocation[] };

// --- Directory CSV ------------------------------------------------------------------------------

/** Splits one CSV line, honouring quotes and doubled quotes. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(current);
      current = "";
    } else current += ch;
  }
  fields.push(current);
  return fields;
}

const COLUMNS = {
  name: "Name",
  address: "Address",
  postcode: "Postcode",
  phone: "Phone number",
  website: "Service's website (if available)",
  serviceTypes: "Service types",
  providerName: "Provider name",
  localAuthority: "Local authority",
  region: "Region",
  url: "Location URL",
  locationId: "CQC Location ID (for office use only)",
  providerId: "CQC Provider ID (for office use only)",
} as const;

const clean = (value: string | undefined) => value?.trim() || null;

/** A UK phone as written in the directory ("2073770990" lost its leading 0). */
function phoneOf(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && !digits.startsWith("0")) return `0${digits}`;
  return digits.length >= 10 && digits.length <= 11 ? digits : null;
}

function websiteOf(raw: string | null): string | null {
  if (!raw) return null;
  const domain = normalizeDomain(raw);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/**
 * Parses the directory CSV. The file opens with a few lines of notes before the header row, so the
 * header is found by its column names; a file without them is rejected rather than misread. Pure.
 */
export function parseDirectory(text: string): CqcLocation[] {
  const lines = text.split(/\r?\n/);
  const headerAt = lines.findIndex((line) => line.startsWith("Name,") && line.includes(COLUMNS.providerId));
  if (headerAt === -1) throw new Error("The CQC directory's columns have changed.");
  const header = parseCsvLine(lines[headerAt]);
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([key, title]) => [key, header.indexOf(title)])) as Record<keyof typeof COLUMNS, number>;
  if (Object.values(col).some((index) => index === -1)) throw new Error("The CQC directory's columns have changed.");

  return lines.slice(headerAt + 1).flatMap((line) => {
    if (!line.trim()) return [];
    const f = parseCsvLine(line);
    const locationId = clean(f[col.locationId]);
    const providerId = clean(f[col.providerId]);
    const name = clean(f[col.name]);
    const providerName = clean(f[col.providerName]);
    if (!locationId || !providerId || !name || !providerName) return [];
    return [
      {
        locationId,
        providerId,
        name,
        address: clean(f[col.address]),
        postcode: clean(f[col.postcode]),
        phone: phoneOf(clean(f[col.phone])),
        website: websiteOf(clean(f[col.website])),
        serviceTypes: (f[col.serviceTypes] ?? "").split("|").map((s) => s.trim()).filter(Boolean),
        providerName,
        localAuthority: clean(f[col.localAuthority]),
        region: clean(f[col.region]),
        url: clean(f[col.url]),
      },
    ];
  });
}

/** Locations of the given industries, grouped by provider (one provider may run many practices). Pure. */
export function providersFor(locations: CqcLocation[], industries: string[]): CqcProvider[] {
  const wanted = new Set(industries.flatMap((slug) => INDUSTRY_CQC_SERVICE_TYPES[slug] ?? []));
  const providers = new Map<string, CqcProvider>();
  for (const location of locations) {
    if (!location.serviceTypes.some((type) => wanted.has(type))) continue;
    const provider = providers.get(location.providerId) ?? { providerId: location.providerId, providerName: location.providerName, locations: [] };
    provider.locations.push(location);
    providers.set(location.providerId, provider);
  }
  return [...providers.values()];
}

/** The industry a provider's locations belong to, among the wanted ones. */
function industryOf(provider: CqcProvider, industries: string[]): string | null {
  return industries.find((slug) => provider.locations.some((l) => l.serviceTypes.some((t) => INDUSTRY_CQC_SERVICE_TYPES[slug]?.includes(t)))) ?? null;
}

/**
 * The provider as a found company. Its website is set only when every location that lists one
 * lists the same site (the provider's own, as given to the regulator); otherwise each practice
 * keeps its own website on its location. Pure.
 */
export function toFoundCompany(provider: CqcProvider, industries: string[], companyNumber: string | null): FoundCompany {
  const sites = [...new Set(provider.locations.map((l) => l.website).filter((w): w is string => w !== null))];
  return {
    name: titleCaseCompanyName(provider.providerName),
    domain: sites.length === 1 ? sites[0] : null,
    industry: industryOf(provider, industries),
    hq: null,
    identifiers: [
      { scheme: "gb_cqc_provider", value: provider.providerId },
      ...(companyNumber ? [{ scheme: "gb_company_number" as const, value: companyNumber }] : []),
    ],
    identity: "verified",
    foundedOn: null,
    record: {
      sourceSlug: "cqc",
      externalId: `provider:${provider.providerId}`,
      url: `https://www.cqc.org.uk/provider/${provider.providerId}`,
      recordType: "cqc_provider",
      publishedAt: null,
      data: { providerId: provider.providerId, locationCount: provider.locations.length, attribution: CQC_ATTRIBUTION },
    },
  };
}

/**
 * The CSV inside the directory's zip (a single deflated file). Reads the zip's central directory
 * rather than trusting the local header, which may defer sizes to a trailing descriptor. Pure.
 */
export function csvFromZip(zip: Buffer): string {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1) throw new Error("The CQC directory zip is unreadable.");
  let entry = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    if (zip.readUInt32LE(entry) !== 0x02014b50) break;
    const method = zip.readUInt16LE(entry + 10);
    const compressedSize = zip.readUInt32LE(entry + 20);
    const nameLength = zip.readUInt16LE(entry + 28);
    const extraLength = zip.readUInt16LE(entry + 30);
    const commentLength = zip.readUInt16LE(entry + 32);
    const localHeader = zip.readUInt32LE(entry + 42);
    const name = zip.subarray(entry + 46, entry + 46 + nameLength).toString("utf8");
    if (name.toLowerCase().endsWith(".csv")) {
      const start = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) return data.toString("utf8");
      if (method === 8) return inflateRawSync(data).toString("utf8");
      throw new Error("The CQC directory zip uses an unsupported compression.");
    }
    entry += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("The CQC directory zip has no CSV.");
}

let cache: { url: string; at: number; locations: CqcLocation[] } | null = null;

/**
 * The current directory's download link, read from CQC's data page (its file name changes weekly).
 * The zip (~4 MB) is preferred: the plain CSV (~19 MB) can take over a minute to download.
 */
async function directoryUrl(): Promise<string> {
  const page = await politeGet(DATA_PAGE);
  const link = (ext: string) => page.body.match(new RegExp(`href="(https://www\\.cqc\\.org\\.uk/system/files/[^"]+_CQC_directory\\.${ext})"`))?.[1];
  const href = link("zip") ?? link("csv");
  if (!href) throw new Error("Couldn't find the CQC directory download on its data page.");
  return href;
}

/** Every registered location, from the weekly directory (cached, so all workspaces share one download). */
export async function loadDirectory(): Promise<CqcLocation[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.locations;
  const url = await directoryUrl();
  if (cache?.url === url) {
    cache.at = Date.now();
    return cache.locations;
  }
  const file = await politeGet(url, { timeoutMs: DIRECTORY_TIMEOUT_MS, maxBytes: MAX_DIRECTORY_BYTES });
  if (file.status >= 400) throw new Error(`The CQC directory answered ${file.status}.`);
  const locations = parseDirectory(url.endsWith(".zip") ? csvFromZip(file.bytes) : file.body);
  cache = { url, at: Date.now(), locations };
  return locations;
}

// --- API (optional) -----------------------------------------------------------------------------

const apiContact = z.object({
  personGivenName: z.string().nullish(),
  personFamilyName: z.string().nullish(),
  personTitle: z.string().nullish(),
  personRoles: z.array(z.string()).nullish(),
});
const apiLocation = z.object({
  registrationDate: z.string().nullish(),
  regulatedActivities: z.array(z.object({ contacts: z.array(z.unknown()).nullish() })).nullish(),
});

export type CqcLocationDetail = { registeredOn: string | null; managers: FoundPerson[] };

/** Registration date and registered managers from the API location record. Pure, for tests. */
export function toLocationDetail(raw: unknown, locationName: string): CqcLocationDetail | null {
  const parsed = apiLocation.safeParse(raw);
  if (!parsed.success) return null;
  const managers = new Map<string, FoundPerson>();
  for (const activity of parsed.data.regulatedActivities ?? []) {
    for (const rawContact of activity.contacts ?? []) {
      const contact = apiContact.safeParse(rawContact).data;
      if (!contact?.personRoles?.some((role) => /registered manager/i.test(role))) continue;
      const name = [contact.personGivenName, contact.personFamilyName].map((p) => p?.trim()).filter(Boolean).join(" ");
      if (name.split(" ").length < 2) continue;
      managers.set(name.toLowerCase(), {
        name,
        title: `Registered manager, ${locationName}`,
        seniority: "manager",
        jobFunction: "operations",
        relationship: "employee",
        // Named by the regulator as responsible for the location.
        confidence: 90,
      });
    }
  }
  const date = parsed.data.registrationDate?.slice(0, 10);
  return { registeredOn: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, managers: [...managers.values()] };
}

/** One location from the API; null without a key, or when the API is unavailable. */
export async function fetchLocationDetail(location: CqcLocation): Promise<CqcLocationDetail | null> {
  const key = process.env.CQC_API_KEY;
  if (!key) return null;
  try {
    const page = await politeGet(`${API}/locations/${encodeURIComponent(location.locationId)}`, {
      sameSite: false,
      headers: { "Ocp-Apim-Subscription-Key": key, accept: "application/json" },
      timeoutMs: API_TIMEOUT_MS,
    });
    if (page.status >= 400) return null;
    return toLocationDetail(JSON.parse(page.body), location.name);
  } catch {
    return null;
  }
}

export const cqc: SourceAdapter = {
  slug: "cqc",
  // The weekly directory needs no key; the API key only adds registration dates and managers.
  isConfigured: () => true,
  async healthCheck(): Promise<HealthStatus> {
    try {
      await directoryUrl();
      return { ok: true, message: "Weekly CQC directory available." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Unavailable." };
    }
  },
};
