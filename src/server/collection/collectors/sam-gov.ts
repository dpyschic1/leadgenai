import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { countryCodeOf, parseDate } from "../normalize";
import type { CollectedItemInput, CollectContext, CollectResult, Collector } from "../types";

/**
 * US federal contract opportunities from SAM.gov's Get Opportunities Public API (needs a free key:
 * SAM.gov → Account Details → Public API Key, as SAM_GOV_API_KEY). Public data of the US government.
 *
 * A personal key may allow only about 10 calls a day, so one target reads everything posted since
 * its last run, at most `MAX_PAGES` pages of 1,000 a run, once a day, and keeps only what our
 * customers sell: solicitations, presolicitations and sources-sought notices in IT, web, design and
 * marketing service codes (NAICS), or whose title names such work. Each is a tender: the buying
 * agency, place of performance, response deadline and set-aside. Contracting officers' names and
 * emails are not kept.
 */

const API = "https://api.sam.gov/opportunities/v2/search";
/** Pages of 1,000 notices read per run (one call each). */
const MAX_PAGES = 3;
/** The first run looks back this far. */
const FIRST_LOOKBACK_DAYS = 2;

/** NAICS codes of the work our customers sell, with the service categories each points to. */
export const SAM_NAICS: Record<string, string[]> = {
  "541511": ["software_development", "web_development"],
  "541512": ["software_development", "cloud_devops"],
  "541513": ["it_managed_services"],
  "541519": ["software_development", "it_managed_services"],
  "518210": ["cloud_devops"],
  "541430": ["branding_design"],
  "541613": ["digital_marketing"],
  "541810": ["digital_marketing", "paid_media"],
  "541820": ["content_marketing"],
  "541830": ["paid_media"],
  "541890": ["digital_marketing"],
  "541910": ["data_analytics"],
};

/** Titles naming such work under any code ("Website Redesign", "Mobile App Development"…). */
const WORK_IN_TITLE: [RegExp, string[]][] = [
  [/\b(website|web ?site|web portal|web application|web development|wordpress|drupal)\b/i, ["web_development"]],
  [/\b(mobile app|ios app|android app|mobile application)\b/i, ["mobile_development"]],
  [/\b(software development|custom software|application development|app development)\b/i, ["software_development"]],
  [/\b(digital marketing|social media|marketing campaign|advertising campaign|paid media)\b/i, ["digital_marketing"]],
  [/\b(search engine optimization|seo)\b/i, ["seo"]],
  [/\b(user experience|ux design|ui\/ux|graphic design|branding)\b/i, ["ui_ux_design", "branding_design"]],
];

/** Notices that ask for offers or interest, not awards, justifications or sales. */
const OPEN_TYPES = /^(solicitation|combined synopsis\/solicitation|presolicitation|sources sought)$/i;

type SamNotice = {
  noticeId?: string;
  title?: string | null;
  solicitationNumber?: string | null;
  fullParentPathName?: string | null;
  department?: string | null;
  office?: string | null;
  postedDate?: string | null;
  type?: string | null;
  baseType?: string | null;
  responseDeadLine?: string | null;
  naicsCode?: string | null;
  typeOfSetAsideDescription?: string | null;
  active?: string | null;
  uiLink?: string | null;
  placeOfPerformance?: { city?: { name?: string | null } | null; state?: { code?: string | null } | null; country?: { code?: string | null } | null } | null;
};

/** The service categories a notice is for: its NAICS code's, else its title's; empty when neither. Pure. */
export function noticeCategories(notice: Pick<SamNotice, "naicsCode" | "title">): string[] {
  const byCode = SAM_NAICS[(notice.naicsCode ?? "").trim()];
  if (byCode) return byCode;
  return [...new Set(WORK_IN_TITLE.filter(([re]) => re.test(notice.title ?? "")).flatMap(([, c]) => c))];
}

/** "MM/dd/yyyy", the date format the API takes. */
export const samDate = (date: Date) =>
  `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}`;

/** The open notices our customers could bid on, as tenders. Expired ones are left out. Pure. */
export function samTenders(notices: SamNotice[], now: Date): CollectedItemInput[] {
  return notices.flatMap((n): CollectedItemInput[] => {
    if (!n.noticeId || !n.title?.trim() || n.active === "No") return [];
    if (!OPEN_TYPES.test((n.type ?? n.baseType ?? "").trim())) return [];
    const categories = noticeCategories(n);
    if (categories.length === 0) return [];
    const deadline = parseDate(n.responseDeadLine);
    if (deadline && deadline < now) return [];
    const place = n.placeOfPerformance;
    const country = countryCodeOf(place?.country?.code) ?? "US";
    const location = [place?.city?.name, place?.state?.code].filter(Boolean).join(", ") || null;
    const agency = (n.fullParentPathName ?? n.department ?? "").split(".")[0]?.trim() || null;
    return [
      {
        externalId: n.noticeId,
        kind: "tender",
        url: n.uiLink || `https://sam.gov/opp/${n.noticeId}/view`,
        extraction: "api",
        fetchedUrl: null,
        title: n.title.trim(),
        text: null,
        companyName: agency,
        companyDomain: null,
        location,
        country,
        remote: null,
        postedAt: parseDate(n.postedDate),
        validThrough: deadline,
        categories,
        data: {
          noticeType: n.type ?? n.baseType ?? null,
          solicitationNumber: n.solicitationNumber?.trim() || null,
          naicsCode: n.naicsCode ?? null,
          setAside: n.typeOfSetAsideDescription ?? null,
          buyer: n.fullParentPathName ?? n.department ?? null,
          office: n.office ?? null,
        },
      },
    ];
  });
}

const apiKey = () => process.env.SAM_GOV_API_KEY?.trim() ?? "";

async function collect({ target, fetcher, now }: CollectContext): Promise<CollectResult> {
  const last = parseDate(target.cursor.postedThrough);
  // From the last day read (again, as notices keep arriving during it) to today.
  const from = last ?? new Date(now.getTime() - FIRST_LOOKBACK_DAYS * 86_400_000);
  const items: CollectedItemInput[] = [];
  let total = 0;
  let read = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ api_key: apiKey(), postedFrom: samDate(from), postedTo: samDate(now), limit: "1000", offset: String(page * 1000) });
    const answer = await fetcher.get(`${API}?${params}`);
    // Never let the key reach logs: errors name the status only.
    if (answer.status === 429) throw new Error("SAM.gov answered 429: the key's daily limit is used up");
    if (answer.status >= 400) throw new Error(`SAM.gov answered ${answer.status}`);
    const body = JSON.parse(answer.body) as { totalRecords?: number; opportunitiesData?: SamNotice[] };
    total = body.totalRecords ?? 0;
    const notices = body.opportunitiesData ?? [];
    read += notices.length;
    items.push(...samTenders(notices, now));
    if (read >= total || notices.length === 0) break;
  }
  const complete = read >= total;
  return {
    items,
    // A day not read to the end is read again next time.
    cursor: { postedThrough: (complete ? now : from).toISOString().slice(0, 10) },
    // Searches by date, not a listing: a notice not found again is not closed by it (its deadline closes it).
    complete: false,
    // Always once a day, however much changed: the key's daily limit allows no more.
    intervalMinutes: 24 * 60,
    note: `${read} of ${total} notices since ${samDate(from)}; ${items.length} fit`,
  };
}

async function seed(): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into collection_targets (source_slug, target_key, interval_minutes)
    values ('sam_gov', 'opportunities', ${24 * 60}) on conflict (source_slug, target_key) do nothing returning id`);
  return rows.length;
}

export const samGov: Collector = {
  slug: "sam_gov",
  access: "api",
  // Once a day: a personal key may allow only about 10 calls a day.
  defaultIntervalMinutes: 24 * 60,
  configured: () => apiKey().length > 0,
  collect,
  seed,
};
