import "server-only";
import { categorizeJob } from "@/server/jobs/job-categories";
import { scoreCompany, type EngineCompany, type EngineLabels, type EngineService, type EngineSignal, type ScoreResult } from "@/server/scoring/engine";
import { getReferenceData } from "@/server/services/reference-data.service";
import { loadWeights } from "@/server/services/scoring.service";
import { loadServices } from "@/server/services/services.service";
import type { ScoreWeights } from "@/lib/validation/scoring";
import type { DiscoveredItem, EngineScore } from "./types";

/**
 * Discovered opportunities (LeadGen Engine) scored by the same rules as company opportunities: each
 * item becomes one signal (type, intent, urgency, the services it needs, when, how well evidenced)
 * on a company-like record, and `scoreCompany` scores it (intent, ICP fit, recency, identity,
 * service fit, with the workspace's own weights). So every opportunity in the list is ranked on one
 * scale, and its score is explained the same way.
 */

/** What the scorer needs about one discovered item; stored with the opportunity so it can be re-scored as it ages. */
export type DiscoveredInput = {
  signal: Omit<EngineSignal, "occurredAt"> & { occurredAt: string };
  company: EngineCompany;
};

export type ScoreContext = { services: EngineService[]; weights: ScoreWeights; labels: EngineLabels };

export async function loadScoreContext(workspaceId: string): Promise<ScoreContext> {
  const [services, weights, ref] = await Promise.all([loadServices(workspaceId), loadWeights(workspaceId), getReferenceData()]);
  const name = (rows: { slug: string; name: string }[]) => {
    const map = new Map(rows.map((r) => [r.slug, r.name]));
    return (slug: string) => map.get(slug) ?? slug;
  };
  return {
    services,
    weights,
    labels: { signalType: name(ref.signalTypes), category: name(ref.serviceCategories), industry: name(ref.industries), jobFunction: name(ref.jobFunctions) },
  };
}

/** The signal type a discovered item is, in the shared taxonomy. Pure. */
export function signalTypeOf(item: Pick<DiscoveredItem, "capability" | "title" | "text">): string {
  if (item.capability === "funded") return "funding";
  if (item.capability === "freelance") return "project_request";
  return /\bmvp\b/i.test(`${item.title} ${item.text}`) ? "mvp_request" : "service_request";
}

/**
 * The services an item needs: the job-title rules on its title and listed skills (and, for a funded
 * company, its own description), else the categories of the service it matched by name. Pure.
 */
export function needsOf(item: Pick<DiscoveredItem, "title" | "text" | "metadata">, fallback: string[]): string[] {
  const skills = Array.isArray(item.metadata?.skills) ? (item.metadata.skills as unknown[]).filter((s): s is string => typeof s === "string") : [];
  const found = new Set([
    ...categorizeJob({ title: item.title, department: null }),
    ...categorizeJob({ title: `${item.title} ${skills.join(" ")}`, department: null }),
    ...categorizeJob({ title: item.text.split("\n")[0] ?? "", department: null }),
  ]);
  return found.size > 0 ? [...found] : fallback;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The signal's summary: one plain sentence saying what happened, in the voice of a company signal
 * ("Acme is hiring an ML Engineer. Posted 8 Nov 2026."), shown as "Why it's an opportunity". Pure.
 */
export function summaryOf(item: Pick<DiscoveredItem, "capability" | "platform" | "title" | "postedAt" | "budget" | "buyerName">): string {
  const title = item.title.replace(/\s+/g, " ").trim().slice(0, 160);
  if (item.capability === "funded") return /[.!?]$/.test(title) ? title : `${title}.`;
  const who = item.buyerName ?? (item.capability === "freelance" ? "A client" : "Someone");
  const budget = item.budget?.usd ? `, budget about ${item.budget.usd >= 1000 ? `${Math.round(item.budget.usd / 1000)}k` : item.budget.usd}` : "";
  const posted = item.postedAt ? ` Posted ${DATE.format(item.postedAt)}.` : "";
  const what = item.capability === "freelance" ? `posted a freelance project on ${item.platform}` : `on ${item.platform} asked for help`;
  return `${who} ${what}: “${title}”${budget}.${posted}`.slice(0, 500);
}

/** The scorer's input for one discovered item. `score` is the engine's own reading (intent). Pure. */
export function discoveredInput(item: DiscoveredItem, score: EngineScore, fallbackCategories: string[], now: Date): DiscoveredInput {
  // A posted project is a direct request to hire; a funding round shows ability to buy, not a request.
  const intentLevel = item.capability === "freelance" ? "explicit" : score.intentLevel;
  const occurredAt = item.postedAt ?? (item.funding?.date ? new Date(`${item.funding.date}T12:00:00Z`) : now);
  const teamSize = typeof item.metadata?.teamSize === "number" ? item.metadata.teamSize : null;
  return {
    signal: {
      id: `${item.sourceSlug}:${item.externalId}`,
      signalType: signalTypeOf(item),
      category: item.capability === "funded" ? "company_event" : "explicit_buying",
      intentLevel,
      urgency: "unknown",
      serviceCategories: needsOf(item, fallbackCategories),
      summary: summaryOf(item),
      occurredAt: occurredAt.toISOString(),
      personId: null,
      evidenceLabel: item.verification === "verified" ? "observed" : "inferred",
      hasSourceUrl: item.url !== null,
    },
    company: {
      name: item.companyName ?? item.buyerName ?? item.title,
      domain: item.companyDomain,
      industry: item.industry,
      employeeCount: teamSize,
      hqCountry: item.country,
      hasHeadquarters: item.country !== null,
    },
  };
}

/** Scores a discovered item's stored input with the workspace's rules; null when nothing positive. Pure. */
export function scoreDiscovered(input: DiscoveredInput, context: ScoreContext, now: Date): ScoreResult | null {
  return scoreCompany({
    company: input.company,
    // The buyer is not identified from a post: identity scores what is known, never a guess.
    people: [],
    signals: [{ ...input.signal, occurredAt: new Date(input.signal.occurredAt) }],
    services: context.services,
    weights: context.weights,
    labels: context.labels,
    now,
  });
}

/** The opportunity columns a score sets, the same as for a company opportunity. */
export function scoreColumns(result: ScoreResult, input: DiscoveredInput) {
  return {
    intentLevel: input.signal.intentLevel,
    // "Why it's an opportunity": the lead signal's sentence, as for a company opportunity.
    problem: result.problem,
    serviceId: result.serviceId,
    type: result.type,
    urgency: result.urgency,
    intentScore: result.factors.intent.score,
    icpScore: result.factors.icpFit.score,
    identityConfidence: result.factors.identity.score,
    serviceFit: result.factors.serviceFit.score,
    opportunityScore: result.opportunityScore,
    // The factors as company opportunities store them, plus what to re-score from as the item ages.
    scoreFactors: { ...result.factors, input } as Record<string, unknown>,
  };
}

