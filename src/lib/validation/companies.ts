import { z } from "zod";
import { COUNTRY_CODES } from "@/lib/countries";
import { COMPANY_RELATIONSHIPS, IDENTITY_LEVELS, MANUAL_VERIFICATIONS, SENIORITY_LEVELS } from "@/lib/domain/people";
import { paginationFields } from "./pagination";

/**
 * Shared by the company/person forms and the route handlers. Optional fields accept "" (from a
 * form) or null (from a client sending already-validated values) and normalise both to null.
 */

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PHONE_PATTERN = /^\+?[0-9 ().-]{6,30}$/;

/** "https://www.Example.com/about" -> "example.com". */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#:]/)[0];
}

/** Optional text, trimmed and normalised; `isValid` checks it when present. */
function optionalText(
  max: number,
  label: string,
  { normalize = (value: string) => value.trim(), isValid, invalidMessage = "" }: {
    normalize?: (value: string) => string;
    isValid?: (value: string) => boolean;
    invalidMessage?: string;
  } = {},
) {
  return z
    .string()
    .nullable()
    .transform((value) => (value === null ? "" : normalize(value)))
    .refine((value) => value.length <= max, `${label} is too long`)
    .refine((value) => value === "" || !isValid || isValid(value), invalidMessage)
    .transform((value) => value || null);
}

export const companySchema = z.object({
  name: z.string().trim().min(1, "Company name is required").max(200, "Company name is too long"),
  domain: optionalText(253, "Domain", {
    normalize: normalizeDomain,
    isValid: (value) => DOMAIN_PATTERN.test(value),
    invalidMessage: "Enter a domain like example.com",
  }),
  industry: z.string().min(1).max(64).nullable(),
  employeeCount: z.number().int("Use a whole number").min(1, "Must be at least 1").max(10_000_000).nullable(),
  description: optionalText(2000, "Description"),
  hqCity: optionalText(120, "City"),
  hqRegion: optionalText(120, "Region"),
  hqCountry: z.enum(COUNTRY_CODES, "Unknown country").nullable(),
});

export const personSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200, "Name is too long"),
  title: optionalText(200, "Job title"),
  seniority: z.enum(SENIORITY_LEVELS),
  jobFunction: z.string().min(1).max(64).nullable(),
  relationship: z.enum(COMPANY_RELATIONSHIPS),
  email: optionalText(254, "Email", {
    normalize: (value) => value.trim().toLowerCase(),
    isValid: (value) => z.email().safeParse(value).success,
    invalidMessage: "Enter a valid email address",
  }),
  phone: optionalText(30, "Phone", {
    isValid: (value) => PHONE_PATTERN.test(value),
    invalidMessage: "Enter a valid phone number",
  }),
  professionalUrl: optionalText(500, "Profile link", {
    isValid: (value) => z.url({ protocol: /^https?$/ }).safeParse(value).success,
    invalidMessage: "Enter a full link starting with https://",
  }),
  location: optionalText(200, "Location"),
  /** How sure the team is that this is the right person (see IDENTITY_LEVELS). */
  identity: z.enum(IDENTITY_LEVELS).default("likely"),
  emailVerification: z.enum(MANUAL_VERIFICATIONS).default("unknown"),
  phoneVerification: z.enum(MANUAL_VERIFICATIONS).default("unknown"),
});

export const companyListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  ...paginationFields,
});

export type CompanyInput = z.input<typeof companySchema>;
export type CompanyValues = z.output<typeof companySchema>;
export type PersonInput = z.input<typeof personSchema>;
export type PersonValues = z.output<typeof personSchema>;
