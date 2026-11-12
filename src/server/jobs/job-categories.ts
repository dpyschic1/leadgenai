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
      /\b(machine learning|ml|ai|a\.i\.|artificial intelligence|llms?|nlp|computer vision|deep learning|gen ?ai|generative|prompt engineer\w*|mlops|data scien\w*|ai engineer\w*|ai agents?|agentic)\b/,
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
  // A plain "Design Engineer" is usually roadway, mechanical or chip design; only a web/UI one is UX work.
  {
    pattern: /\b(ux|ui|product designer|interaction designer|user research\w*|visual designer|(web|ux|ui|product|front ?end|interface) design engineer)\b/,
    categories: ["ui_ux_design"],
  },
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
/**
 * Physical engineering: mechanical, electrical, civil, chip and plant work. A "Mechanical Engineer"
 * in an Engineering department is not a software role, so these never count as tech work unless the
 * title also says software ("Embedded Software Engineer" stays software).
 */
const PHYSICAL_ENGINEERING =
  /\b(mechanical|mechatronics?|electrical|electronics?|civil|structural|geotechnical|chemical|process|manufacturing|industrial|hardware|rf|antenna|analog|asic|fpga|pcb|silicon|semiconductor|photonics?|optical|materials?|metallurg\w*|aerospace|propulsion|avionics|flight test|structures? test|reactor|thermal|hvac|piping|plumbing|power|energy|battery|charging|solar|grid|substation|nuclear|petroleum|mining|environmental|water|wastewater|roadway|transportation|traffic|bridge|construction|facilities|maintenance|field service|packaging|biomedical|controls?|instrumentation|robotics hardware|quality engineer\w*|environmental test|design verification|layout|manufacturing engineer|supplier quality|estimator|surveyor)\b/;
const SOFTWARE_WORDS =
  /\b(software|firmware|embedded|web|full ?stack|front ?end|back ?end|cloud|data|ml|ai|machine learning|deep learning|computer vision|llms?|platform|devops|site reliability|security|mobile|app|application|automation|forward deployed)\b/;
/** Chip and board design: hardware even when the chip is for AI ("Design Verification Engineer (AI Fabric Switches)"). */
const CHIP_DESIGN = /\b(design verification|asic|fpga|pcb|analog|silicon|rtl|physical design|technician)\b/;
/** Physical engineering, unless the title also says software. Chip design and technicians stay hardware even "for AI". */
const isPhysical = (t: string) => (PHYSICAL_ENGINEERING.test(t) && !SOFTWARE_WORDS.test(t)) || (CHIP_DESIGN.test(t) && !/\b(software|firmware)\b/.test(t));
/** Sales roles about a technology (not building it). Sales engineers build demos, so they stay. */
const SELLING = /\b(sales(?! engineer)|account executive|account manager|business develop(ment|er)|partnerships?)\b/;
/**
 * Trainees and academic posts (interns, students, graduates, postdocs, fellowships): a company taking
 * these on is not buying a service, so they are never a lead. A "Technical Fellow" is a senior engineer.
 */
const TRAINEE =
  /\b(interns?|internships?|externs?|externships?|co ?op|student|graduate|new grad|postdoc\w*|post doctoral|(?<!technical |distinguished )fellows?|fellowship|scholars?|apprentices?|apprenticeships?|trainee)\b/;
/**
 * Roles that work around a technology without building it: product, marketing, writing, legal,
 * recruiting, and training AI models by hand (rating, labelling). "Product Manager, AI" or "Data
 * Journalist, AI" doesn't mean the company needs AI built.
 */
const NOT_BUILDING =
  /\b(product (manager|management|owner|lead|marketing)|program manager|marketing|marketer|journalist|reporter|writer|editor|copywriter|recruit\w*|talent|counsel|attorney|lawyer|legal|paralegal|policy|communications|evangelist|advocate|developer relations|devrel|community|ai (trainer|tutor|training)|training (specialist|data)|data (annotat\w*|label\w*)|annotat\w*|label(l)?er|label(l)?ing|rater|evaluator|evaluation specialist|transcri\w*)\b/;
/** A title that names a building role keeps it: "Applied AI Architect, International Policy". */
const BUILDER = /\b(engineer\w*|developer|architect|programmer)\b/;
/** Never a building role, even when the title also says "engineering" or "developer". */
const ALWAYS_AROUND = /\b(product (manager|management|owner|lead)|developer relations|devrel|developer advocate)\b/;
/** Works around the technology: selling it, or a non-building role that doesn't also name a building one. */
const worksAround = (t: string) => SELLING.test(t) || ALWAYS_AROUND.test(t) || (NOT_BUILDING.test(t) && !BUILDER.test(t));
/** Analysts and data scientists: data work that may involve models, a weaker sign of buying AI work than hiring to build it. */
const DATA_SCIENCE_ONLY = /\b(data scien\w*|scientist|analyst|analytics)\b/;
const BUILDS_AI = /\b(machine learning|ml|ai|llms?|nlp|computer vision|deep learning|gen ?ai|generative|mlops|agents?|agentic)\b/;
const AI_TRAINING_WORK =
  /\b(ai (trainer|tutor|training)|ai \w+ training|training (specialist|data|mentor)|data (annotat\w*|label\w*)|annotat\w*|label(l)?ing|rater|evaluator|evaluation specialist|transcri\w*|mentor|tutor\w*)\b/;

const normalize = (text: string | null) =>
  ` ${(text ?? "")
    .toLowerCase()
    // "AI&T" is assembly, integration and test, not AI.
    .replace(/\bai ?& ?t\b/g, "integration and test")
    .replace(/[-_/,()|:]+/g, " ")
    .replace(/\s+/g, " ")} `;

/** The service categories a job's title and department point to; empty when none fits. Pure. */
export function categorizeJob(job: { title: string; department: string | null }): string[] {
  const title = normalize(job.title);
  const department = normalize(job.department);
  if (TRAINEE.test(title)) return [];
  const found = new Set<string>();
  for (const rule of RULES) if (rule.pattern.test(title)) for (const c of rule.categories) found.add(c);
  // "VP of AI Sales", "Product Manager, AI": working around the technology, not building it.
  const around = worksAround(title);
  if (around) for (const c of TECH_CATEGORIES) found.delete(c);
  // Mechanical, electrical, civil, chip work: not a software role, whatever the department.
  const physical = isPhysical(title);
  if (physical) for (const c of TECH_CATEGORIES) found.delete(c);
  if (found.size === 0 && !around && !physical && TECH_DEPARTMENT.test(department) && PLAIN_ENGINEER.test(title)) found.add("software_development");
  if ([...found].some((c) => TECH_CATEGORIES.has(c))) found.add("staff_augmentation");
  return [...found];
}

/**
 * The job's categories as read by the AI, held to the same title rules: a trainee post is never a
 * lead and a non-building role never means tech work, whatever the post's text mentions. Pure.
 */
export function refineCategories(title: string, categories: string[]): string[] {
  const t = normalize(title);
  if (TRAINEE.test(t)) return [];
  if (isPhysical(t)) return categories.filter((c) => !TECH_CATEGORIES.has(c) && c !== "staff_augmentation");
  if (!worksAround(t)) return categories;
  return categories.filter((c) => !TECH_CATEGORIES.has(c) && c !== "staff_augmentation");
}

/** A data-science or analyst role with no AI-building words: a weaker sign of buying AI work. Pure. */
export function isDataScienceOnly(title: string): boolean {
  const t = normalize(title);
  return DATA_SCIENCE_ONLY.test(t) && !BUILDS_AI.test(t);
}

/** Hand-training AI models (rating, labelling, "AI trainer" gigs): work for people, not a project to build. Pure. */
export function isAiTrainingWork(title: string): boolean {
  return AI_TRAINING_WORK.test(normalize(title));
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
  // An analyst or data scientist (no AI-building words) is a weaker sign than hiring to build AI.
  const weak = signalType === "recruiting_pressure" || isDataScienceOnly(lead.title);
  return {
    signalType,
    intentLevel: weak ? "low" : "medium",
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
