/**
 * Where an opportunity is in the sales process is a pipeline stage (`@/lib/domain/pipeline`), not a fixed
 * list: each workspace defines its own stages. The feed's tabs are derived from stage kind.
 */
export { STATUS_GROUP_KEYS, type StatusGroup } from "./pipeline";

/**
 * How a lead can be reached, by what the system holds for it:
 * - `person`: the suggested person has their own email or phone
 * - `company`: only the company's own line (switchboard, info@, a practice's phone)
 * - `none`: no way in yet
 * `any` (person or company) is the "has contact" filter.
 */
export const CONTACT_REACH = ["any", "person", "company", "none"] as const;
export type ContactReach = (typeof CONTACT_REACH)[number];

export const CONTACT_REACH_LABELS: Record<ContactReach, string> = {
  any: "Has contact",
  person: "Named contact",
  company: "Company line only",
  none: "No contact yet",
};

/**
 * The Leads page: every lead still being worked (any open stage, not archived), by how it can be
 * reached. `email` / `phone`: some email or phone (the person's or the company's) is known.
 */
export const LEAD_TABS = ["all", "email", "phone", "person", "company", "none"] as const;
export type LeadTab = (typeof LEAD_TABS)[number];

/**
 * The kind of role a lead is hiring for, read from its job titles ("Senior Engineer, Backend" is
 * backend). A lead hiring several kinds is in each.
 */
export const ROLE_FAMILIES = [
  "backend",
  "frontend",
  "fullstack",
  "mobile",
  "ai_ml",
  "data",
  "devops",
  "qa",
  "security",
  "embedded",
  "product_design",
  "graphic_design",
  "leadership",
] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

export const ROLE_FAMILY_LABELS: Record<RoleFamily, string> = {
  backend: "Backend",
  frontend: "Frontend",
  fullstack: "Full-stack",
  mobile: "Mobile",
  ai_ml: "AI / ML",
  data: "Data",
  devops: "DevOps & cloud",
  qa: "QA & testing",
  security: "Security",
  embedded: "Embedded & robotics",
  product_design: "UI/UX & product design",
  graphic_design: "Graphic & brand design",
  leadership: "Architects & managers",
};

export const ROLE_FAMILY_PATTERNS: Record<RoleFamily, RegExp> = {
  backend: /back[- ]?end|server[- ]side|\bapi\b|\b(java|golang|scala|elixir|ruby|php|django|rails|nodejs|node\.js)\b|\.net\b/i,
  frontend: /front[- ]?end|\breact\b|angular|\bvue|\bui (engineer|developer)|web developer|fiori/i,
  fullstack: /full[- ]?stack/i,
  mobile: /mobile|\bios\b|android|flutter|react native|\bswift\b|kotlin/i,
  ai_ml: /\bai\b|\bml\b|mlops|machine learning|deep learning|\bllm|genai|generative|artificial intelligence|\bnlp\b|computer vision|reinforcement learning|applied scientist|research (scientist|engineer)/i,
  data: /\bdata\b|analytics|\betl\b|\bbi\b|business intelligence/i,
  devops: /devops|\bsre\b|site reliability|\bcloud\b|infrastructure|kubernetes|platform engineer|ci\/cd|build engineer/i,
  qa: /\bqa\b|quality assurance|\btest(ing)?\b|in test|\bsdet\b/i,
  security: /secur|cyber/i,
  embedded: /embedded|firmware|robotic|\bdsp\b/i,
  product_design: /\bux\b|\bui\/ux|user experience|product designer|interaction design|experience design/i,
  graphic_design: /graphic|visual design|brand design|illustrat|motion design|creative designer/i,
  leadership: /architect|engineering manager|manager, (software|engineering)|director|head of|\bvp\b|\bcto\b/i,
};

/** The role types a job title belongs to. */
export const roleFamiliesOf = (title: string): RoleFamily[] => ROLE_FAMILIES.filter((family) => ROLE_FAMILY_PATTERNS[family].test(title));
