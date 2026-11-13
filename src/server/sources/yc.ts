import "server-only";
import { and, desc, eq, inArray, max, notInArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { boardJobs, jobBoardDirectory, ycCompanies } from "@/db/schema";
import type { JobBoardProvider } from "@/lib/domain/job-boards";
import { candidateTokens } from "@/server/jobs/detect";
import { boardExists } from "@/server/jobs/fetch-jobs";
import { canonicalToken, refreshBoard } from "./board-directory";
import { readWebsite } from "./company-website";
import { registrableDomain } from "./http";
import type { FoundCompany, HealthStatus, SourceAdapter } from "./index";

/**
 * Y Combinator companies: every startup YC has funded (about 6,400), with website, location,
 * industry, team size and whether it is hiring. Read from the third-party `yc-oss/api` dataset
 * (https://github.com/yc-oss/api), which copies YC's public directory daily. It is unofficial and
 * states no licence, and YC's own site terms restrict reuse of directory content: using it is the
 * product owner's decision (2026-11-10), noted on the `sources` row.
 *
 * The whole dataset goes into the global `yc_companies` table; each workspace's `discover_yc` then
 * takes the active companies matching its services, hiring ones first. YC companies are mostly
 * tech startups, so the opportunity comes from their open jobs (website and job-board reading),
 * not from being in YC.
 */

export const YC_DATASET_URL = "https://yc-oss.github.io/api/companies/all.json";
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** The table is refreshed when its newest import is older than this. */
export const YC_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** One company as the dataset has it (only the fields we use). */
export type YcRecord = {
  id: number;
  name: string;
  slug: string;
  website?: string | null;
  all_locations?: string | null;
  one_liner?: string | null;
  long_description?: string | null;
  team_size?: number | null;
  industry?: string | null;
  subindustry?: string | null;
  tags?: string[] | null;
  regions?: string[] | null;
  batch?: string | null;
  status?: string | null;
  isHiring?: boolean | null;
  top_company?: boolean | null;
  stage?: string | null;
  launched_at?: number | null;
  url?: string | null;
};

export type YcRow = typeof ycCompanies.$inferInsert;

/** Country names as YC writes them (last part of a location, or a region), to ISO codes. */
const COUNTRY_CODES: Record<string, string> = {
  USA: "US",
  "United States of America": "US",
  "United Kingdom": "GB",
  Canada: "CA",
  India: "IN",
  Germany: "DE",
  France: "FR",
  Ireland: "IE",
  Netherlands: "NL",
  Spain: "ES",
  Sweden: "SE",
  Denmark: "DK",
  Norway: "NO",
  Australia: "AU",
  Singapore: "SG",
  Brazil: "BR",
  Mexico: "MX",
  Israel: "IL",
};

/** The company's main country: its first listed location's country, else the first known region. Pure. */
export function ycCountry(record: Pick<YcRecord, "all_locations" | "regions">): string | null {
  const first = record.all_locations?.split(";")[0]?.split(",").at(-1)?.trim();
  if (first && COUNTRY_CODES[first]) return COUNTRY_CODES[first];
  for (const region of record.regions ?? []) if (COUNTRY_CODES[region]) return COUNTRY_CODES[region];
  return null;
}

/** YC subindustries ("B2B -> Marketing") to our industry slugs; then YC industries. */
const SUBINDUSTRY_INDUSTRY: Record<string, string> = {
  "B2B -> Marketing": "media_marketing",
  "B2B -> Finance and Accounting": "accounting",
  "B2B -> Supply Chain and Logistics": "logistics",
  "B2B -> Retail": "retail",
  "B2B -> Recruiting and Talent": "recruitment_staffing",
  "B2B -> Human Resources": "professional_services",
  "B2B -> Legal": "legal",
  "Fintech -> Insurance": "insurance",
  "Consumer -> Food and Beverage": "food_beverage",
  "Consumer -> Apparel and Cosmetics": "ecommerce",
  "Consumer -> Home and Personal": "ecommerce",
  "Consumer -> Travel, Leisure and Tourism": "hospitality",
  "Consumer -> Content": "media_marketing",
  "Industrials -> Manufacturing and Robotics": "manufacturing",
  "Industrials -> Energy": "energy",
  "Industrials -> Climate": "energy",
  "Industrials -> Agriculture": "agriculture",
  "Industrials -> Automotive": "automotive",
  "Real Estate and Construction -> Construction": "construction",
  "Real Estate and Construction -> Housing and Real Estate": "real_estate",
};
const INDUSTRY_INDUSTRY: Record<string, string> = {
  B2B: "saas",
  Fintech: "financial_services",
  Healthcare: "healthcare",
  Education: "education",
  Government: "government",
  Industrials: "manufacturing",
  "Real Estate and Construction": "real_estate",
};

/** Our industry slug for a YC company, or null (e.g. a consumer app). Pure. */
export function ycIndustry(record: Pick<YcRecord, "industry" | "subindustry">): string | null {
  return SUBINDUSTRY_INDUSTRY[record.subindustry ?? ""] ?? INDUSTRY_INDUSTRY[record.industry ?? ""] ?? null;
}

const domainOf = (website: string | null | undefined): string | null => {
  if (!website) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase();
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? registrableDomain(host) : null;
  } catch {
    return null;
  }
};

/** One dataset record as a `yc_companies` row; null for a record without id, name or slug. Pure. */
export function toYcRow(record: YcRecord): YcRow | null {
  if (!Number.isInteger(record.id) || !record.name?.trim() || !record.slug) return null;
  const text = (value: string | null | undefined) => value?.trim() || null;
  return {
    id: record.id,
    slug: record.slug,
    name: record.name.trim(),
    website: text(record.website),
    domain: domainOf(record.website),
    oneLiner: text(record.one_liner),
    longDescription: text(record.long_description),
    locations: text(record.all_locations),
    country: ycCountry(record),
    industry: ycIndustry(record),
    ycIndustry: text(record.industry),
    ycSubindustry: text(record.subindustry),
    regions: (record.regions ?? []).filter((r) => typeof r === "string"),
    tags: (record.tags ?? []).filter((t) => typeof t === "string"),
    teamSize: Number.isInteger(record.team_size) ? record.team_size! : null,
    batch: text(record.batch),
    status: text(record.status) ?? "Unspecified",
    isHiring: record.isHiring === true,
    topCompany: record.top_company === true,
    stage: text(record.stage),
    launchedAt: typeof record.launched_at === "number" ? new Date(record.launched_at * 1000) : null,
    url: text(record.url),
  };
}

/** Downloads the whole dataset and upserts it into `yc_companies`. Returns the rows saved. */
export async function importYcCompanies(): Promise<number> {
  const response = await fetch(YC_DATASET_URL, { cache: "no-store", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`The YC dataset answered ${response.status}.`);
  const records = (await response.json()) as unknown;
  if (!Array.isArray(records) || records.length === 0) throw new Error("The YC dataset was empty.");
  const rows = records.flatMap((r) => (r && typeof r === "object" ? [toYcRow(r as YcRecord)].filter((x): x is YcRow => x !== null) : []));
  const columns = Object.keys(rows[0]).filter((c) => c !== "id") as (keyof YcRow)[];
  const set = Object.fromEntries(columns.map((c) => [c, sql.raw(`excluded."${toSnake(c)}"`)]));
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insert(ycCompanies)
      .values(rows.slice(i, i + 500))
      .onConflictDoUpdate({ target: ycCompanies.id, set: { ...set, importedAt: sql`now()` } });
  }
  return rows.length;
}

const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** When the table was last imported (null when empty). */
export async function ycImportedAt(): Promise<Date | null> {
  const [row] = await db.select({ at: max(ycCompanies.importedAt) }).from(ycCompanies);
  return row?.at ?? null;
}

/**
 * Active companies in these countries (and, when given, industries), not yet in the workspace:
 * hiring ones first, then the most recently launched.
 */
export async function pickYcCompanies(query: { countries: string[]; industries: string[]; exclude: string[]; limit: number }) {
  const where: SQL[] = [inArray(ycCompanies.country, query.countries), eq(ycCompanies.status, "Active"), sql`${ycCompanies.domain} is not null`];
  if (query.industries.length > 0) where.push(inArray(ycCompanies.industry, query.industries));
  if (query.exclude.length > 0) where.push(notInArray(sql`${ycCompanies.id}::text`, query.exclude));
  return db
    .select()
    .from(ycCompanies)
    .where(and(...where))
    .orderBy(desc(ycCompanies.isHiring), sql`${ycCompanies.launchedAt} desc nulls last`, ycCompanies.id)
    .limit(query.limit);
}

/** A picked company in the shape discovery saves. Pure. */
export function toYcCompany(row: typeof ycCompanies.$inferSelect): FoundCompany {
  const [city, region] = (row.locations?.split(";")[0] ?? "").split(",").map((part) => part.trim());
  return {
    name: row.name,
    domain: row.domain,
    industry: row.industry,
    hq: row.country ? { city: city || null, region: row.country === "US" ? region || null : null, country: row.country } : null,
    identifiers: [{ scheme: "yc_company", value: String(row.id) }],
    // The website comes from the company's own YC listing, not from a registry: partly verified.
    identity: "partial",
    foundedOn: null,
    record: {
      sourceSlug: "yc_directory",
      externalId: `company:${row.id}`,
      url: row.url,
      recordType: "company_profile",
      publishedAt: row.launchedAt,
      data: {
        oneLiner: row.oneLiner,
        batch: row.batch,
        teamSize: row.teamSize,
        isHiring: row.isHiring,
        stage: row.stage,
        ycIndustry: row.ycSubindustry ?? row.ycIndustry,
        tags: row.tags,
        locations: row.locations,
      },
    },
  };
}

export const ycDirectory: SourceAdapter = {
  slug: "yc_directory",
  isConfigured: () => true,
  async healthCheck(): Promise<HealthStatus> {
    try {
      const at = await ycImportedAt();
      return at ? { ok: true, message: `YC companies imported ${at.toISOString().slice(0, 10)}.` } : { ok: true, message: "Not imported yet; the first run imports it." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "YC table unreadable." };
    }
  },
};

// --- Job boards: each YC company's own board, found once for every workspace -------------------

/** The providers YC startups use; others are rare among them and cost a request each. */
const YC_BOARD_PROVIDERS = ["ashby", "greenhouse", "lever", "workable"] as const;
/** A company with no board found is looked at again after this long (it may start hiring). */
const BOARD_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Board names to try for a YC company, strongest first: its YC slug, then its own domain and name
 * (`candidateTokens`). Pure.
 */
export function ycBoardTokens(row: { slug: string; name: string; domain: string | null }): string[] {
  return [...new Set([row.slug, row.slug.replace(/-/g, ""), ...candidateTokens({ name: row.name, domain: row.domain })])].slice(0, 4);
}

/**
 * Whether a board found by guessing its name is the company's: the provider states the company's
 * own website, or its jobs link to or mention the company's domain. A shared name alone proves
 * nothing ("Preload" the AI startup is not "Preload" the tank maker). Pure.
 */
export function boardFitsCompany(
  board: { statedWebsite: string | null; jobs: { url: string; description: string | null }[] },
  company: { domain: string | null },
): boolean {
  if (!company.domain) return false;
  if (board.statedWebsite) return domainOf(board.statedWebsite) === company.domain;
  const mention = new RegExp(`(^|[^a-z0-9-])${company.domain.replace(/[.]/g, "\.")}($|[^a-z0-9-])`, "i");
  return board.jobs.some((job) => mention.test(job.url) || mention.test(job.description ?? ""));
}

/**
 * Finds the job boards of US YC companies not checked yet (hiring and bigger ones first): the board
 * their own website links to, else a board under one of their own names that shows it is theirs.
 * A found board is downloaded into the shared cache and linked. Its jobs then join the shared pool, sorted and matched like any
 * other. Returns how many companies it checked.
 */
export async function detectYcBoards({ limit, deadline }: { limit: number; deadline: number }): Promise<number> {
  const due = await db
    .select({ id: ycCompanies.id, slug: ycCompanies.slug, name: ycCompanies.name, domain: ycCompanies.domain })
    .from(ycCompanies)
    .where(
      and(
        eq(ycCompanies.country, "US"),
        eq(ycCompanies.status, "Active"),
        sql`${ycCompanies.boardProvider} is null`,
        sql`(${ycCompanies.boardCheckedAt} is null or ${ycCompanies.boardCheckedAt} < now() - make_interval(secs => ${BOARD_RECHECK_MS / 1000}))`,
      ),
    )
    // Hiring ones first, bigger teams first (more open roles), then the newest.
    .orderBy(desc(ycCompanies.isHiring), sql`${ycCompanies.teamSize} desc nulls last`, sql`${ycCompanies.launchedAt} desc nulls last`, ycCompanies.id)
    .limit(limit);
  let checked = 0;
  for (const company of due) {
    if (Date.now() > deadline) break;
    const board = await findYcBoard(company);
    await db
      .update(ycCompanies)
      .set({ boardProvider: board?.provider ?? null, boardToken: board ? canonicalToken(board.boardToken) : null, boardCheckedAt: sql`now()` })
      .where(eq(ycCompanies.id, company.id));
    checked++;
  }
  return checked;
}

async function findYcBoard(company: { slug: string; name: string; domain: string | null }) {
  // The board the company's own website links to: proof it is theirs.
  if (company.domain) {
    const site = await readWebsite(company.domain).catch(() => null);
    if (site?.jobBoard && (await refreshBoard(site.jobBoard.provider, site.jobBoard.boardToken)) === "valid") return site.jobBoard;
  }
  // Else a board under one of its own names, only with evidence it is theirs.
  const attempts = ycBoardTokens(company).flatMap((boardToken) => YC_BOARD_PROVIDERS.map((provider) => ({ provider, boardToken })));
  const exists = await Promise.all(attempts.map((a) => boardExists(a.provider, a.boardToken)));
  for (const [index, attempt] of attempts.entries()) {
    if (!exists[index]) continue;
    if ((await refreshBoard(attempt.provider, attempt.boardToken)) !== "valid") continue;
    const [[listed], jobs] = await Promise.all([
      db
        .select({ statedWebsite: jobBoardDirectory.statedWebsite })
        .from(jobBoardDirectory)
        .where(and(eq(jobBoardDirectory.provider, attempt.provider), eq(jobBoardDirectory.boardToken, attempt.boardToken))),
      db
        .select({ url: boardJobs.url, description: boardJobs.description })
        .from(boardJobs)
        .where(and(eq(boardJobs.provider, attempt.provider), eq(boardJobs.boardToken, attempt.boardToken)))
        .limit(50),
    ]);
    // A guessed board with no open jobs adds nothing (and is weak evidence on its own).
    if (listed && jobs.length > 0 && boardFitsCompany({ statedWebsite: listed.statedWebsite, jobs }, company)) return attempt;
  }
  return null;
}

/** The YC company a shared board belongs to, if one was linked to it. */
export async function ycCompanyForBoard(provider: JobBoardProvider, boardToken: string) {
  const [row] = await db
    .select()
    .from(ycCompanies)
    .where(and(eq(ycCompanies.boardProvider, provider), eq(ycCompanies.boardToken, boardToken)))
    .limit(1);
  return row ?? null;
}
