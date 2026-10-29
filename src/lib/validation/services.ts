import { z } from "zod";
import { COUNTRY_CODES } from "@/lib/countries";

/** Shared by the service form and the route handlers. */

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
    targetIndustries: slugs(30),
    targetJobFunctions: slugs(20),
    targetCountries: z
      .array(z.enum(COUNTRY_CODES, "Unknown country"))
      .max(60)
      .transform((values) => [...new Set(values)]),
    companySizeMin: companySize,
    companySizeMax: companySize,
  })
  .refine(
    (s) => s.companySizeMin === null || s.companySizeMax === null || s.companySizeMin <= s.companySizeMax,
    { message: "Maximum must be at least the minimum", path: ["companySizeMax"] },
  );

export type ServiceInput = z.input<typeof serviceSchema>;
export type ServiceValues = z.output<typeof serviceSchema>;
