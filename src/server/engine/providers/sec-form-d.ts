import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { decodeEntities } from "@/server/jobs/html-to-text";
import { fetchText } from "../http";
import type { DiscoveredItem, DiscoveryProvider } from "../types";

/**
 * SEC EDGAR Form D: the legal notice a US company files when it raises money by selling securities
 * privately. It is first-hand evidence of an actual funding event, which is what this capability
 * needs (a directory listing is not). Funds, SPVs and trusts file Form D too, so they are filtered out.
 * Only filers that are also hiring, on a job board in the shared pool, are kept (`withOpenRoles`).
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

/** Legal forms left out when matching a filer to a job board ("ANDROMEDA ROBOTICS, INC." = "Andromeda Robotics"). */
const LEGAL_FORM = "inc|incorporated|llc|l\\.l\\.c|pbc|corp|corporation|co|company|ltd|limited|plc|lp|llp";
/** Shorter keys ("Abc") would match unrelated companies. */
const MIN_KEY_LENGTH = 5;
const MAX_ROLES = 5;

/** A company name without its legal form, case or punctuation: how a filer is matched to a job board's name. Pure. */
export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(new RegExp(`\\b(${LEGAL_FORM})\\b\\.?`, "g"), "")
    .replace(/[^a-z0-9]+/g, "");
}

type OpenRoles = { titles: string[]; categories: string[] };

/**
 * The open roles of the filers' own job boards in the shared pool, matched by name (the board's own
 * name for the company), with their service categories. A name that fits two boards is left out:
 * it could be either company.
 */
export async function openRolesByName(names: string[]): Promise<Map<string, OpenRoles>> {
  const keys = [...new Set(names.map(companyKey).filter((k) => k.length >= MIN_KEY_LENGTH))];
  const result = new Map<string, OpenRoles>();
  if (keys.length === 0) return result;
  const rows = await db.execute<{ key: string; board: string; title: string; categories: string[] | null }>(sql`
    select k.key, k.provider || ':' || k.board_token as board, j.title,
      array_agg(c.category_slug) filter (where c.category_slug is not null) as categories
    from (
      select d.provider, d.board_token,
        regexp_replace(regexp_replace(lower(d.board_name), ${`\\m(${LEGAL_FORM})\\M\\.?`}, '', 'g'), '[^a-z0-9]+', '', 'g') as key
      from job_board_directory d
      where d.validation_status = 'valid' and d.board_name is not null
    ) k
    join board_jobs j on j.provider = k.provider and j.board_token = k.board_token and j.closed_at is null
    left join board_job_categories c on c.board_job_id = j.id
    where k.key in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
    group by k.key, k.provider, k.board_token, j.id
    order by coalesce(j.posted_at, j.first_seen_at) desc`);
  const boards = new Map<string, Set<string>>();
  for (const r of rows) boards.set(r.key, (boards.get(r.key) ?? new Set()).add(r.board));
  for (const r of rows) {
    if ((boards.get(r.key)?.size ?? 0) > 1) continue;
    const roles = result.get(r.key) ?? { titles: [], categories: [] };
    const categories = r.categories ?? [];
    if (categories.length > 0 && roles.titles.length < MAX_ROLES && !roles.titles.includes(r.title)) roles.titles.push(r.title);
    for (const c of categories) if (!roles.categories.includes(c)) roles.categories.push(c);
    result.set(r.key, roles);
  }
  return result;
}

/**
 * Raising money alone says nothing about needing outside work; raising and hiring for it does (the
 * same rule as Y Combinator startups). A filing is kept only when the company's own job board has
 * open roles, listed with them and their service categories: the runner keeps it only when a role
 * fits a service the workspace sells. Pure.
 */
export function withOpenRoles(item: DiscoveredItem, roles: OpenRoles | undefined): DiscoveredItem | null {
  if (!roles || roles.titles.length === 0) return null;
  return {
    ...item,
    title: `${item.title} and is hiring: ${roles.titles.slice(0, 3).join(", ")}`.slice(0, 300),
    metadata: { ...item.metadata, roles: roles.titles, jobCategories: roles.categories },
  };
}

export const secFormD: DiscoveryProvider = {
  slug: "sec_form_d",
  name: "SEC EDGAR (Form D)",
  capability: "funded",
  async discover({ signal }) {
    const feed = await fetchText("https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=D&count=100&output=atom", { signal });
    const filings = parseFeed(feed).filter((f) => !isVehicleName(f.name)).slice(0, 30);
    const parsed: DiscoveredItem[] = [];
    for (const filing of filings) {
      // SEC allows 10 requests a second; one every 250 ms stays well under.
      await new Promise((r) => setTimeout(r, 250));
      try {
        const xml = await fetchText(filing.indexUrl.replace(/[^/]*$/, "primary_doc.xml"), { signal });
        const item = parseFormD(xml, filing);
        if (item) parsed.push(item);
      } catch {
        // One unreadable filing must not hide the rest.
      }
    }
    const roles = await openRolesByName(parsed.map((i) => i.companyName ?? ""));
    return parsed.flatMap((item) => withOpenRoles(item, roles.get(companyKey(item.companyName ?? ""))) ?? []);
  },
};
