import type { SignalAnalysis } from "@/lib/api/types";
import { signalSchema, type DetectedSignalValues } from "@/lib/validation/signals";
import { isFaithfulQuote } from "@/server/ai/finalize-analysis";

/** Turning what a source found into a signal to record. Pure, so it is unit-tested. */

/** Analyses below this confidence aren't recorded automatically. */
export const MIN_FOUND_CONFIDENCE = 50;

/**
 * The signal an AI analysis supports, or null (no signal, too unsure, invalid). The quote must
 * appear in `evidenceText`, the source's own words; otherwise the signal counts as inferred.
 */
export function signalFromAnalysis(
  analysis: SignalAnalysis,
  { url, occurredOn, evidenceText }: { url: string | null; occurredOn: string; evidenceText: string },
): DetectedSignalValues | null {
  if (!analysis.isSignal || !analysis.signalType || analysis.confidence < MIN_FOUND_CONFIDENCE) return null;
  const excerpt = analysis.excerpt && isFaithfulQuote(analysis.excerpt, evidenceText) ? analysis.excerpt : null;
  const result = signalSchema.safeParse({
    signalType: analysis.signalType,
    intentLevel: analysis.intentLevel,
    urgency: analysis.urgency,
    serviceCategories: analysis.serviceCategories,
    summary: analysis.summary,
    personId: null,
    occurredOn,
    sourceUrl: url,
    excerpt,
    evidenceLabel: analysis.evidenceLabel === "observed" && !excerpt ? "inferred" : analysis.evidenceLabel,
    source: "ai",
    confidence: analysis.confidence,
  });
  return result.success ? result.data : null;
}

const DAY_MS = 86_400_000;
/** A company formed within this many days counts as a new startup. */
export const NEW_COMPANY_DAYS = 365;

/**
 * A location newly registered with the CQC (a new practice or clinic opening): stated by the
 * regulator itself. Low intent on its own; corroborated by website, hiring or tender signals.
 * Null for registrations older than a year.
 */
export function newLocationSignal(
  location: {
    providerName: string;
    name: string;
    registeredOn: string | null;
    url: string | null;
    /** When it first appeared in the weekly directory, for a provider we already follow (no API date needed). */
    firstListedOn?: string;
  },
  serviceCategories: string[],
  now = new Date(),
): DetectedSignalValues | null {
  const on = location.registeredOn ?? location.firstListedOn;
  if (!on) return null;
  const registered = new Date(`${on}T12:00:00Z`);
  const age = (now.getTime() - registered.getTime()) / DAY_MS;
  if (Number.isNaN(age) || age < 0 || age > NEW_COMPANY_DAYS) return null;
  const date = registered.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return {
    signalType: "new_location",
    intentLevel: "low",
    urgency: "unknown",
    serviceCategories,
    summary: location.registeredOn
      ? `${location.providerName} registered a new location, ${location.name}, with the CQC on ${date}.`
      : `${location.providerName} added a new location, ${location.name}: it first appeared on the CQC register on ${date}.`,
    personId: null,
    occurredOn: on,
    sourceUrl: location.url,
    excerpt: null,
    evidenceLabel: "observed",
    source: "provider",
    // Stated by the regulator; a first-seen date is up to a week after the registration itself.
    confidence: location.registeredOn ? 95 : 85,
  };
}

/** What a newly registered business plausibly needs first; software only for a software or IT business. */
const NEW_BUSINESS_NEEDS = ["web_development", "branding_design", "seo"];
const NEW_TECH_BUSINESS_NEEDS = ["mvp_development", "software_development", "ui_ux_design"];

/** The services a newly registered company might need, among those the workspace sells. Pure. */
export function newBusinessNeeds(industry: string | null, sold: string[]): string[] {
  const needs = [...NEW_BUSINESS_NEEDS, ...(industry === "saas" || industry === "it_services" ? NEW_TECH_BUSINESS_NEEDS : [])];
  return sold.filter((category) => needs.includes(category));
}

/**
 * A company registered within the last year, exactly as the register states it ("registered at
 * Companies House on 12 October 2026"): a fact about the company, recorded as context. It doesn't
 * say the company needs anything, so on its own it never makes an opportunity (see
 * `CONTEXT_SIGNAL_TYPES` in the scoring engine); with real evidence it adds that the company is new.
 * Null for older companies, or when the workspace sells nothing a new business plausibly needs.
 */
export function formationSignal(
  company: { name: string; foundedOn: string | null; registerUrl: string | null; register?: string; industry?: string | null },
  serviceCategories: string[],
  now = new Date(),
): DetectedSignalValues | null {
  if (!company.foundedOn) return null;
  const formed = new Date(`${company.foundedOn}T12:00:00Z`);
  const age = (now.getTime() - formed.getTime()) / DAY_MS;
  if (Number.isNaN(age) || age < 0 || age > NEW_COMPANY_DAYS) return null;
  const categories = newBusinessNeeds(company.industry ?? null, serviceCategories);
  if (categories.length === 0) return null;
  const date = formed.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return {
    signalType: "company_formation",
    intentLevel: "low",
    urgency: "unknown",
    serviceCategories: categories,
    summary: `${company.name} was registered ${company.register ?? "at Companies House"} on ${date}.`,
    personId: null,
    occurredOn: company.foundedOn,
    sourceUrl: company.registerUrl,
    excerpt: null,
    evidenceLabel: "observed",
    source: "provider",
    confidence: null,
  };
}
