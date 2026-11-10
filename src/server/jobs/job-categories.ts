import type { DetectedSignalValues } from "@/lib/validation/signals";
import { openDays, openedAt } from "./job-signal";

/**
 * The free first pass over every shared job: its title (and department) say which of our service
 * categories a company hiring for it may need. It runs on all jobs in seconds, with no AI, so each
 * workspace can be matched to the jobs that fit its services instantly. The AI later reads the
 * matched jobs in full once (`job_analyses`) and its own categories replace these. Pure, unit-tested.
 */

type Rule = { pattern: RegExp; categories: string[] };

/** Most specific first; a title can fall under several. */
const RULES: Rule[] = [
  {
    pattern:
      /\b(machine learning|ml|ai|a\.i\.|artificial intelligence|llms?|nlp|computer vision|deep learning|gen ?ai|generative|prompt engineer\w*|mlops|data scien\w*|applied scien\w*|research scien\w*|ai engineer\w*|ai agents?|agentic)\b/,
    categories: ["ai_ml"],
  },
  { pattern: /\b(data scien\w*|data engineer\w*|analytics engineer\w*|data analyst|bi (developer|engineer|analyst)|business intelligence|data warehous\w*|etl)\b/, categories: ["data_analytics"] },
  { pattern: /\b(ios|android|mobile (developer|engineer)|react native|flutter|swift|kotlin)\b/, categories: ["mobile_development"] },
  {
    pattern:
      /\b(front ?end|back ?end|full ?stack|software|developer|programmer|engineering manager|web engineer|golang|java|python|ruby|php|\.net|node\.?js|typescript|javascript|react|angular|vue|rails|django|embedded|firmware|staff engineer|principal engineer|founding engineer|member of technical staff|mts)\b/,
    categories: ["software_development"],
  },
  {
    pattern: /\b(devops|dev ops|sre|site reliability|cloud (engineer|architect|infrastructure|operations)|infrastructure engineer\w*|platform engineer\w*|kubernetes)\b/,
    categories: ["cloud_devops"],
  },
  { pattern: /\b(qa|quality assurance|test (engineer|analyst|automation)|automation tester|sdet|software tester)\b/, categories: ["qa_testing"] },
  {
    pattern: /\b(security (engineer|analyst|architect|operations)|cyber ?security|cyber|appsec|infosec|penetration test\w*|soc analyst)\b/,
    categories: ["cybersecurity"],
  },
  { pattern: /\b(ux|ui|product designer|interaction designer|user research\w*|visual designer|design engineer)\b/, categories: ["ui_ux_design"] },
  { pattern: /\b(graphic designer|brand designer|creative director|art director|illustrator|motion designer)\b/, categories: ["branding_design"] },
  { pattern: /\bseo\b/, categories: ["seo"] },
  { pattern: /\b(content (writer|marketer|marketing|strategist|manager)|copywriter|social media)\b/, categories: ["content_marketing"] },
  { pattern: /\b(paid (media|social|search)|ppc|performance marketing|media buyer|sem)\b/, categories: ["paid_media"] },
  { pattern: /\b(marketing|growth marketer|growth manager|head of growth|demand gen\w*|email marketing|lifecycle marketing)\b/, categories: ["digital_marketing"] },
  { pattern: /\b(cro|conversion rate)\b/, categories: ["conversion_optimization"] },
  { pattern: /\b(shopify|e ?commerce developer|magento|woocommerce)\b/, categories: ["ecommerce_development"] },
  { pattern: /\b(salesforce|hubspot|crm (developer|administrator|admin|manager|consultant))\b/, categories: ["crm_implementation"] },
  { pattern: /\b(sap|erp|netsuite|dynamics 365|oracle (ebs|fusion))\b/, categories: ["erp_implementation"] },
  {
    pattern: /\b(it support|help ?desk|service desk|desktop support|system administrator|sysadmin|it technician|network engineer|it manager|it specialist)\b/,
    categories: ["it_managed_services"],
  },
  {
    pattern: /\b(customer (support|service|care)|support (agent|specialist|representative|associate)|call cent(er|re)|contact cent(er|re))\b/,
    categories: ["customer_support_outsourcing"],
  },
  {
    pattern: /\b(bookkeep\w*|accounts payable|accounts receivable|payroll (specialist|administrator)|data entry|back office|administrative assistant|admin assistant)\b/,
    categories: ["back_office_outsourcing"],
  },
  { pattern: /\b(sdr|bdr|sales development|business development rep\w*|appointment setter|lead generation)\b/, categories: ["appointment_setting"] },
  { pattern: /\b(recruiter|talent acquisition|sourcer)\b/, categories: ["recruitment_rpo"] },
];

/** Roles a firm can staff with its own people: these also mean staff augmentation. */
const TECH_CATEGORIES = new Set(["ai_ml", "data_analytics", "mobile_development", "software_development", "cloud_devops", "qa_testing", "cybersecurity"]);
/** A department like "Engineering" makes a plain "Engineer" title a software role. */
const TECH_DEPARTMENT = /\b(engineering|r ?& ?d|technology|product development|software)\b/;
const PLAIN_ENGINEER = /\b(engineer|developer)\b/;
/** Sales roles about a technology (not building it). Sales engineers build demos, so they stay. */
const SELLING = /\b(sales(?! engineer)|account executive|account manager|business development|partnerships?)\b/;

const normalize = (text: string | null) =>
  ` ${(text ?? "")
    .toLowerCase()
    .replace(/[-_/,()|:]+/g, " ")
    .replace(/\s+/g, " ")} `;

/** The service categories a job's title and department point to; empty when none fits. Pure. */
export function categorizeJob(job: { title: string; department: string | null }): string[] {
  const title = normalize(job.title);
  const department = normalize(job.department);
  const found = new Set<string>();
  for (const rule of RULES) if (rule.pattern.test(title)) for (const c of rule.categories) found.add(c);
  // "VP of AI Sales", "Account Executive, Cloud": selling the technology, not building it.
  if (SELLING.test(title)) for (const c of TECH_CATEGORIES) found.delete(c);
  if (found.size === 0 && !SELLING.test(title) && TECH_DEPARTMENT.test(department) && PLAIN_ENGINEER.test(title)) found.add("software_development");
  if ([...found].some((c) => TECH_CATEGORIES.has(c))) found.add("staff_augmentation");
  return [...found];
}

const CONTRACT = /\b(contract|contractor|freelance|interim|temporary|temp|fixed term|\d+ ?(week|month)s?)\b/;
/** Open this long or more: a role that's hard to fill. */
const LONG_OPEN_DAYS = 60;

type RuleJob = {
  title: string;
  department: string | null;
  location: string | null;
  url: string;
  postedAt: Date | null;
  firstSeenAt: Date;
};

/**
 * The signal a matching job supports before the AI has read it: stated facts only (the company is
 * hiring for this role, since this date, in these places), recorded as "provider" with a modest
 * confidence. The shared analysis later replaces it with the AI's reading in every workspace that
 * has it. `categories` are the matched ones (the job's categories the workspace sells). Pure.
 */
export function ruleJobSignal(company: string, lead: RuleJob, openings: number, categories: string[], now = new Date()): DetectedSignalValues {
  const title = normalize(lead.title);
  const days = openDays(lead, now);
  // The kind of role comes from the job itself, not from what the workspace sells.
  const tech = categorizeJob(lead).some((c) => TECH_CATEGORIES.has(c));
  const signalType = CONTRACT.test(title)
    ? "contractor_hiring"
    : openings >= 3
      ? "multiple_same_role_openings"
      : days >= LONG_OPEN_DAYS
        ? "long_running_vacancy"
        : tech
          ? "engineering_hiring"
          : categories.includes("customer_support_outsourcing")
            ? "customer_support_hiring"
            : "recruiting_pressure";
  const date = openedAt(lead).toISOString().slice(0, 10);
  const where = lead.location ? ` (${lead.location.slice(0, 80)})` : "";
  const more = openings > 1 ? `, with ${openings} open postings for this role` : "";
  const age = days >= LONG_OPEN_DAYS ? `; it has been open for ${days} days` : "";
  return {
    signalType,
    intentLevel: signalType === "recruiting_pressure" ? "low" : "medium",
    urgency: CONTRACT.test(title) ? "medium" : "unknown",
    serviceCategories: categories.slice(0, 8),
    summary: `${company} is hiring a ${lead.title.slice(0, 120)}${where}${more}${age}. Posted ${date}.`.slice(0, 500),
    personId: null,
    occurredOn: date,
    sourceUrl: lead.url,
    excerpt: null,
    evidenceLabel: "observed",
    source: "provider",
    confidence: 60,
  };
}
