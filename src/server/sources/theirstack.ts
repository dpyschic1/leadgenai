import "server-only";
import { z } from "zod";
import type { FoundPerson, HealthStatus, SourceAdapter } from "./index";
import { jobFunctionFromTitle, seniorityFromTitle } from "./names";

/**
 * Job posts from TheirStack (paid API, free monthly allowance): jobs it collects from public job
 * boards and career sites (mostly Indeed and LinkedIn, then company sites and ATS boards), each
 * with the hiring company's domain, size and industry. One API credit per job returned, so every
 * search is narrow (the workspace's services, countries and recent posts) and capped per day.
 * Docs: https://theirstack.com/en/docs/api-reference/jobs/search_jobs_v1
 */

const API = "https://api.theirstack.com";
const TIMEOUT_MS = 30_000;
/** Most results one search page may return on the free plan. */
const THEIRSTACK_PAGE_SIZE = 25;

/** The key from the environment. */
export const theirStackKey = () => process.env.THEIRSTACK_API_KEY ?? "";

/** Jobs fetched per daily run: each costs a credit (200 free a month ≈ 6 a day). */
/** Largest company searched when a service sets no maximum: giants rarely buy from agencies. */
export const THEIRSTACK_DEFAULT_MAX_EMPLOYEES = 2000;

/** The size range to search, from the services: the widest range they cover, capped by default. Pure. */
export function employeeRange(services: { companySizeMin: number | null; companySizeMax: number | null }[]): { min: number | null; max: number } {
  const mins = services.map((s) => s.companySizeMin ?? 1);
  const maxes = services.map((s) => s.companySizeMax);
  const min = mins.length > 0 ? Math.min(...mins) : 1;
  const max = maxes.length > 0 && maxes.every((m) => m !== null) ? Math.min(Math.max(...(maxes as number[])), THEIRSTACK_DEFAULT_MAX_EMPLOYEES) : THEIRSTACK_DEFAULT_MAX_EMPLOYEES;
  return { min: min > 1 ? min : null, max };
}

/** Jobs fetched per day across the whole platform (one API key, one allowance). */
export const theirStackJobsPerRun = () => {
  const raw = process.env.THEIRSTACK_JOBS_PER_DAY;
  const n = Number(raw);
  // 0 turns it off (e.g. on a local copy sharing production's key); unset means the default.
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 100) : 6;
};

/**
 * Job titles that show a company needs what a category of service provides: hiring for the role
 * in-house means the work exists, and an agency or contractor can fill it. Matched by TheirStack as
 * "all these words, any order", case-insensitive.
 */
export const CATEGORY_JOB_TITLES: Record<string, string[]> = {
  software_development: ["software engineer", "software developer", "full stack developer", "backend developer"],
  web_development: ["web developer", "frontend developer", "react developer", "wordpress developer"],
  mobile_development: ["ios developer", "android developer", "mobile developer", "flutter developer", "react native developer"],
  mvp_development: ["founding engineer"],
  staff_augmentation: ["contract developer", "contract software engineer"],
  qa_testing: ["qa engineer", "test automation engineer", "software tester"],
  cloud_devops: ["devops engineer", "site reliability engineer", "platform engineer", "cloud engineer"],
  data_analytics: ["data engineer", "analytics engineer", "bi developer", "power bi developer"],
  ai_ml: ["machine learning engineer", "ai engineer", "llm engineer"],
  ui_ux_design: ["ux designer", "product designer", "ui designer"],
  branding_design: ["brand designer", "graphic designer"],
  ecommerce_development: ["shopify developer", "ecommerce manager"],
  seo: ["seo manager", "seo specialist"],
  digital_marketing: ["digital marketing manager", "performance marketing manager"],
  content_marketing: ["content marketing manager", "content writer"],
  paid_media: ["ppc manager", "paid social manager", "paid media manager"],
  conversion_optimization: ["conversion rate optimization"],
  cybersecurity: ["security engineer", "penetration tester", "information security manager"],
  crm_implementation: ["salesforce developer", "hubspot administrator", "crm manager"],
  erp_implementation: ["erp consultant", "netsuite administrator", "sap consultant"],
  it_managed_services: ["it support engineer", "it manager", "systems administrator"],
  customer_support_outsourcing: ["customer support representative", "customer service representative"],
  back_office_outsourcing: ["data entry clerk", "bookkeeper"],
  appointment_setting: ["sales development representative", "appointment setter"],
  recruitment_rpo: ["talent acquisition specialist", "recruiter"],
};

/** The titles to search for a workspace's service categories, capped so the query stays focused. */
export function titlesFor(categories: string[], max = 20): string[] {
  return [...new Set(categories.flatMap((c) => CATEGORY_JOB_TITLES[c] ?? []))].slice(0, max);
}

/** TheirStack's (LinkedIn) industry names to ours, by keyword; null when unsure. */
const INDUSTRY_KEYWORDS: [RegExp, string][] = [
  [/dent/i, "dental"],
  [/hospital|health|medical|clinic|pharma|wellness/i, "healthcare"],
  [/software|saas|internet|computer software/i, "saas"],
  [/it services|information technology|computer.*network|technology, information/i, "it_services"],
  [/bank|financial|fintech|investment|capital markets/i, "financial_services"],
  [/insurance/i, "insurance"],
  [/accounting/i, "accounting"],
  [/legal|law practice/i, "legal"],
  [/retail|apparel|consumer goods/i, "retail"],
  [/e-?commerce|online audio|marketplace/i, "ecommerce"],
  [/education|e-learning|higher education/i, "education"],
  [/real estate/i, "real_estate"],
  [/hospitality|restaurant|hotel|leisure|travel/i, "hospitality"],
  [/logistic|transport|supply chain/i, "logistics"],
  [/manufactur|industrial|machinery/i, "manufacturing"],
  [/marketing|advertising|media|publishing/i, "media_marketing"],
  [/telecom/i, "telecommunications"],
  [/construction|architecture/i, "construction"],
  [/automotive/i, "automotive"],
  [/energy|utilities|oil|renewable/i, "energy"],
  [/government|public policy/i, "government"],
  [/non-?profit|philanthrop/i, "nonprofit"],
  [/staffing|recruit/i, "recruitment_staffing"],
  [/consult|professional services/i, "professional_services"],
];
export function industryOf(name: string | null | undefined): string | null {
  return name ? (INDUSTRY_KEYWORDS.find(([pattern]) => pattern.test(name))?.[1] ?? null) : null;
}

const company = z.object({
  name: z.string(),
  domain: z.string().nullish(),
  industry: z.string().nullish(),
  employee_count: z.number().nullish(),
  country_code: z.string().nullish(),
  city: z.string().nullish(),
  linkedin_url: z.string().nullish(),
  founded_year: z.number().nullish(),
  is_recruiting_agency: z.boolean().nullish(),
});
const job = z.object({
  id: z.number(),
  job_title: z.string(),
  url: z.string(),
  final_url: z.string().nullish(),
  source_url: z.string().nullish(),
  date_posted: z.string(),
  description: z.string().nullish(),
  short_location: z.string().nullish(),
  location: z.string().nullish(),
  country_code: z.string().nullish(),
  remote: z.boolean().nullish(),
  company_object: company,
  hiring_team: z.array(z.object({ full_name: z.string().nullish(), role: z.string().nullish(), linkedin_url: z.string().nullish() })).nullish(),
});

export type TheirStackJob = {
  id: number;
  title: string;
  /** The post itself: the company's career page when known, else where TheirStack found it. */
  url: string;
  /** The site the post was found on (indeed.com, linkedin.com, a careers page). */
  foundOn: string | null;
  postedOn: string;
  description: string;
  location: string | null;
  company: {
    name: string;
    domain: string | null;
    industry: string | null;
    employeeCount: number | null;
    country: string | null;
    city: string | null;
    linkedinUrl: string | null;
  };
  hiringTeam: FoundPerson[];
};

const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};
const safeUrl = (url: string | null | undefined) => (url && /^https?:\/\//i.test(url) ? url : null);

/** One search hit as a job; null when unusable (no link, or a recruiting agency's post). Exported for tests. */
export function toJob(raw: unknown): TheirStackJob | null {
  const parsed = job.safeParse(raw);
  if (!parsed.success) return null;
  const j = parsed.data;
  const url = safeUrl(j.final_url) ?? safeUrl(j.url);
  // An agency's post doesn't say which company has the need.
  if (!url || j.company_object.is_recruiting_agency) return null;
  const c = j.company_object;
  const domain = c.domain?.toLowerCase().replace(/^www\./, "") || null;
  return {
    id: j.id,
    title: j.job_title.trim(),
    url,
    foundOn: hostOf(j.source_url ?? j.url),
    postedOn: j.date_posted.slice(0, 10),
    description: (j.description ?? "").trim(),
    location: j.remote ? [j.short_location ?? j.location, "Remote"].filter(Boolean).join("; ") : (j.short_location ?? j.location ?? null),
    company: {
      name: c.name.trim(),
      domain,
      industry: industryOf(c.industry),
      employeeCount: c.employee_count ?? null,
      country: c.country_code?.toUpperCase() ?? j.country_code?.toUpperCase() ?? null,
      city: c.city ?? null,
      linkedinUrl: safeUrl(c.linkedin_url),
    },
    // The people the source lists as posting the job (LinkedIn's "meet the hiring team").
    hiringTeam: (j.hiring_team ?? []).flatMap((p) => {
      const name = p.full_name?.trim();
      if (!name || name.split(" ").length < 2) return [];
      const title = p.role?.trim() || null;
      return [{ name, title, seniority: seniorityFromTitle(title ?? ""), jobFunction: jobFunctionFromTitle(title ?? ""), relationship: "employee" as const, confidence: 85 }];
    }),
  };
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const key = theirStackKey();
  if (!key) throw new Error("TheirStack API key is not set.");
  return fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json", ...init.headers },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** API credits left this period; free to ask. */
export async function creditsLeft(): Promise<number> {
  const result = await call("/v0/billing/credit-balance");
  if (!result.ok) throw new Error(`TheirStack answered ${result.status}.`);
  const body = (await result.json()) as { api_credits?: number; used_api_credits?: number };
  return Math.max(0, (body.api_credits ?? 0) - (body.used_api_credits ?? 0));
}

/**
 * Recent direct-employer jobs with these titles in these countries, newest first. Jobs already seen
 * and companies to skip (e.g. already opportunities) are excluded server-side, so no credit is
 * spent on them. Returns at most `limit` jobs (one credit each).
 */
export async function searchJobs(query: {
  titles: string[];
  countries: string[];
  maxAgeDays: number;
  limit: number;
  seenJobIds: number[];
  skipDomains: string[];
  /** Company size range (employees); the giants an agency rarely wins are left out by default. */
  minEmployees: number | null;
  maxEmployees: number | null;
}): Promise<TheirStackJob[]> {
  if (query.titles.length === 0 || query.limit <= 0) return [];
  const filters = {
    job_title_or: query.titles,
    ...(query.countries.length > 0 && { job_country_code_or: query.countries }),
    posted_at_max_age_days: query.maxAgeDays,
    company_type: "direct_employer",
    ...(query.minEmployees && { min_employee_count: query.minEmployees }),
    ...(query.maxEmployees && { max_employee_count: query.maxEmployees }),
    // Only jobs whose company is identified by its website: that's how it's matched to ours.
    property_exists_and: ["company_object.domain"],
    ...(query.seenJobIds.length > 0 && { job_id_not: query.seenJobIds.slice(-500) }),
    ...(query.skipDomains.length > 0 && { company_domain_not: query.skipDomains.slice(0, 500) }),
    order_by: [{ field: "date_posted", desc: true }],
  };
  // The free plan returns at most 25 results per page (403 E-020 above that), so read page by page.
  // Every page the same size (the offset is page × size), split evenly: 50 → 2 × 25, 30 → 2 × 15.
  const pageSize = Math.ceil(query.limit / Math.ceil(query.limit / THEIRSTACK_PAGE_SIZE));
  const found: unknown[] = [];
  for (let page = 0; found.length < query.limit; page++) {
    const result = await call("/v1/jobs/search", { method: "POST", body: JSON.stringify({ ...filters, limit: pageSize, page }) });
    if (result.status === 402) throw new Error("TheirStack credits are used up for this period.");
    if (!result.ok) {
      // Keep what earlier pages bought (their credits are spent) rather than losing them.
      if (found.length > 0) break;
      throw new Error(`TheirStack answered ${result.status}.`);
    }
    const data = z.object({ data: z.array(z.unknown()) }).safeParse(await result.json()).data?.data ?? [];
    found.push(...data);
    if (data.length < pageSize) break; // no more matches
  }
  return found.map(toJob).filter((j): j is TheirStackJob => j !== null);
}

/** The text the AI analyses for a job: the facts, then the description. */
export function theirStackJobText(j: TheirStackJob, maxDescription = 6000): string {
  return [
    `Job post: ${j.title}`,
    `Company: ${j.company.name}${j.company.domain ? ` (${j.company.domain})` : ""}`,
    `Posted: ${j.postedOn}`,
    j.location && `Location: ${j.location}`,
    j.foundOn && `Found on: ${j.foundOn}`,
    "",
    j.description.slice(0, maxDescription),
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

export const theirStack: SourceAdapter = {
  slug: "theirstack",
  isConfigured: () => Boolean(theirStackKey()),
  async healthCheck(): Promise<HealthStatus> {
    try {
      const left = await creditsLeft();
      return { ok: true, message: `Connected: ${left} API credits left this period.` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Unreachable." };
    }
  },
};
