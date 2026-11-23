import { z } from "zod";
import { COUNTRY_CODES } from "@/lib/countries";

/** Shared by the service form and the route handlers. */

/**
 * Who a service is sold to: companies (hiring and funding signals), individuals (people asking for
 * help in a post) and project-based work (freelance marketplace projects).
 */
export const CLIENT_TYPES = ["company", "individual", "project"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export const CLIENT_TYPE_LABELS: Record<ClientType, string> = { company: "Companies", individual: "Individuals", project: "Project-based" };

/** How the work is done. A preference: matching work ranks higher; work that clearly says otherwise isn't offered. */
export const WORK_TYPES = ["any", "remote", "hybrid", "onsite"] as const;
export type WorkType = (typeof WORK_TYPES)[number];
export const WORK_TYPE_LABELS: Record<WorkType, string> = { any: "Any", remote: "Remote", hybrid: "Hybrid", onsite: "Onsite" };

/** Company size as one choice; stored as the employee range it stands for. */
export const SIZE_PRESETS = [
  { value: "any", label: "Any size", min: null, max: null },
  { value: "startup", label: "Startups (1–50 employees)", min: 1, max: 50 },
  { value: "small", label: "Small (11–200 employees)", min: 11, max: 200 },
  { value: "mid", label: "Mid-size (51–1,000 employees)", min: 51, max: 1000 },
] as const;

/**
 * The categories a service can pick: development and AI work. The reference list keeps the others,
 * since jobs are already sorted into them; a service saved with one still shows it.
 */
export const SERVICE_FORM_CATEGORIES: readonly string[] = [
  "ai_ml",
  "software_development",
  "web_development",
  "mobile_development",
  "mvp_development",
  "ecommerce_development",
  "cloud_devops",
  "qa_testing",
  "ui_ux_design",
  "data_analytics",
  "staff_augmentation",
];

const slugs = (max: number) =>
  z
    .array(z.string().min(1).max(64))
    .max(max)
    .transform((values) => [...new Set(values)]);

const companySize = z.number().int("Use a whole number").min(1, "Must be at least 1").max(10_000_000).nullable();

export const serviceSchema = z
  .object({
    name: z.string().trim().min(1, "Service name is required").max(100, "Service name is too long"),
    description: z.string().trim().max(1000, "Keep the description under 1,000 characters"),
    categories: slugs(10).refine((values) => values.length > 0, "Pick at least one category"),
    // No longer on the form: saving a service from the form clears them. Kept for the API.
    targetIndustries: slugs(30).default([]),
    targetJobFunctions: slugs(20).default([]),
    targetCountries: z
      .array(z.enum(COUNTRY_CODES, "Unknown country"))
      .max(60)
      .transform((values) => [...new Set(values)]),
    companySizeMin: companySize,
    companySizeMax: companySize,
    clientTypes: z
      .array(z.enum(CLIENT_TYPES))
      .max(CLIENT_TYPES.length)
      .default([...CLIENT_TYPES])
      .transform((values) => [...new Set(values)])
      .refine((values) => values.length > 0, "Pick at least one"),
    workType: z.enum(WORK_TYPES).default("any"),
  })
  .refine(
    (s) => s.companySizeMin === null || s.companySizeMax === null || s.companySizeMin <= s.companySizeMax,
    { message: "Maximum must be at least the minimum", path: ["companySizeMax"] },
  );

export type ServiceInput = z.input<typeof serviceSchema>;
export type ServiceValues = z.output<typeof serviceSchema>;

/** What the AI drafts "What does it include?" from. */
export const describeServiceSchema = z.object({
  name: z.string().trim().min(2, "Enter the service name first").max(100),
  categories: z.array(z.string().min(1).max(64)).max(10).default([]),
});
export type DescribeServiceInput = z.input<typeof describeServiceSchema>;
