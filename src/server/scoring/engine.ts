import type { SeniorityLevel } from "@/lib/domain/people";
import { SENIORITY_LEVELS } from "@/lib/domain/people";
import type { EvidenceLabel, IntentLevel, UrgencyLevel } from "@/lib/domain/signals";
import type { ScoreFactor, ScoreWeights } from "@/lib/validation/scoring";

/**
 * Opportunity scoring (PRD §12). Deterministic and pure: the same inputs always give the same
 * score, and every factor carries the reasons behind it, so the ranking is explainable.
 * The score ranks priority. It is not a probability of purchase.
 *
 *   Opportunity = Intent×0.40 + ICP fit×0.25 + Recency×0.15 + Identity×0.10 + Service fit×0.10
 *   (the workspace can re-weight these in Settings)
 *
 * Intent and ICP fit are themselves weighted blends of sub-factors, with the PRD's initial weights.
 */

export type EngineSignal = {
  id: string;
  signalType: string;
  /** Taxonomy group of the type; "negative" signals reduce intent instead of adding to it. */
  category: string | null;
  intentLevel: IntentLevel;
  urgency: UrgencyLevel;
  serviceCategories: string[];
  summary: string;
  occurredAt: Date;
  personId: string | null;
  /** Feeds "source reliability": observed with a link is the most reliable. */
  evidenceLabel: EvidenceLabel;
  hasSourceUrl: boolean;
};

export type EngineService = {
  id: string;
  name: string;
  categories: string[];
  targetIndustries: string[];
  targetJobFunctions: string[];
  targetCountries: string[];
  companySizeMin: number | null;
  companySizeMax: number | null;
};

export type EngineCompany = {
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  hqCountry: string | null;
  hasHeadquarters: boolean;
};

export type EnginePerson = {
  id: string;
  name: string;
  seniority: SeniorityLevel;
  jobFunction: string | null;
  /** An email/phone that isn't known to be invalid. */
  hasEmail: boolean;
  hasPhone: boolean;
  /** Identity confidence passes the threshold (PRD §22); only these are suggested as the contact. */
  suggestable: boolean;
  /** Whether the email or phone has been verified, for the identity reasons. */
  verifiedContact: boolean;
};

export type EngineLabels = {
  signalType: (slug: string) => string;
  category: (slug: string) => string;
  industry: (slug: string) => string;
  jobFunction: (slug: string) => string;
};

export type EngineInput = {
  company: EngineCompany;
  people: EnginePerson[];
  signals: EngineSignal[];
  services: EngineService[];
  weights: ScoreWeights;
  labels: EngineLabels;
  now: Date;
  /** Matches the team flagged as wrong (feedback): never suggested again for this company. */
  rejected?: { personIds: string[]; serviceIds: string[] };
};

export type FactorResult = { score: number; weight: number; contribution: number; reasons: string[] };

export type SignalRole = { signalId: string; role: "primary" | "corroborating" | "negative"; weight: number };

export type ScoreResult = {
  opportunityScore: number;
  factors: Record<ScoreFactor, FactorResult>;
  serviceId: string | null;
  type: string;
  urgency: UrgencyLevel;
  problem: string;
  suggestedAction: string;
  primaryPersonId: string | null;
  latestSignalAt: Date;
  signalRoles: SignalRole[];
};

/** Strength of each intent level before recency. */
export const INTENT_BASE: Record<IntentLevel, number> = { explicit: 100, high: 80, medium: 55, low: 30, unknown: 15 };

const DAY_MS = 86_400_000;

/** PRD §12 recency multipliers by signal age (whole days): [max age, multiplier]. 60+ days: 0.05. */
const RECENCY_STEPS: readonly [number, number][] = [
  [2, 1],
  [7, 0.85],
  [14, 0.65],
  [30, 0.4],
  [60, 0.2],
];
const OLD_SIGNAL_MULTIPLIER = 0.05;

/** PRD §12 initial intent sub-weights (sum 100). */
const INTENT_WEIGHTS = {
  explicitRequest: 30,
  problemSeverity: 15,
  evaluationActivity: 15,
  recency: 15,
  urgency: 10,
  corroboration: 10,
  sourceReliability: 5,
} as const;

/**
 * PRD §12 initial ICP sub-weights for the criteria we hold data for. Location count, revenue,
 * technology and business model aren't captured yet; buyer roles stands in with the weight the PRD
 * gives location count. Only criteria the service defines are scored, then re-normalised.
 */
const ICP_WEIGHTS = { industry: 15, geography: 10, size: 15, buyerRoles: 10, serviceCompatibility: 20 } as const;

/** Signal types that show the company is actively evaluating vendors. */
const EVALUATION_TYPES = new Set([
  "vendor_search",
  "vendor_recommendation_request",
  "solution_comparison",
  "development_partner_request",
  "rfp_tender",
  "rfq",
]);
const SOURCE_RELIABILITY: Record<EvidenceLabel, number> = { observed: 0.8, derived: 0.7, inferred: 0.4, unknown: 0.2 };
const URGENCY_VALUE: Record<UrgencyLevel, number> = { high: 1, medium: 0.6, low: 0.3, unknown: 0.1 };
const EXPLICITNESS: Record<IntentLevel, number> = { explicit: 1, high: 0.5, medium: 0.25, low: 0.1, unknown: 0 };

/** Older positive signals no longer count towards intent. */
const INTENT_WINDOW_DAYS = 180;
/** Negative signals within this window reduce intent (PRD: "may reduce opportunity priority"). */
const NEGATIVE_WINDOW_DAYS = 120;
const NEGATIVE_PENALTY = 25;
const URGENCY_WINDOW_DAYS = 90;

const URGENCY_RANK: Record<UrgencyLevel, number> = { high: 3, medium: 2, low: 1, unknown: 0 };

/** Service category -> opportunity type (most specific first). */
const TYPE_BY_CATEGORY: Record<string, string> = {
  mvp_development: "mvp_startup",
  staff_augmentation: "staff_augmentation",
  recruitment_rpo: "recruitment_rpo",
  web_development: "website_redesign",
  ui_ux_design: "website_redesign",
  branding_design: "website_redesign",
  conversion_optimization: "website_redesign",
  ecommerce_development: "website_redesign",
  seo: "digital_marketing",
  digital_marketing: "digital_marketing",
  content_marketing: "digital_marketing",
  paid_media: "digital_marketing",
  mobile_development: "software_development",
  software_development: "software_development",
  qa_testing: "software_development",
  ai_ml: "software_development",
  data_analytics: "software_development",
  cloud_devops: "it_services",
  cybersecurity: "it_services",
  it_managed_services: "it_services",
  crm_implementation: "it_services",
  erp_implementation: "it_services",
  customer_support_outsourcing: "bpo",
  back_office_outsourcing: "bpo",
  appointment_setting: "bpo",
  consulting: "consulting",
};
const RFP_SIGNAL_TYPES = new Set(["rfp_tender", "rfq"]);

const daysBetween = (from: Date, to: Date) => Math.max(0, (to.getTime() - from.getTime()) / DAY_MS);
/** Recency multiplier for a signal of this age, from the PRD's step table. */
export const recencyMultiplier = (days: number) =>
  RECENCY_STEPS.find(([maxDays]) => Math.floor(days) <= maxDays)?.[1] ?? OLD_SIGNAL_MULTIPLIER;
const clamp = (value: number) => Math.round(Math.min(100, Math.max(0, value)));
const dateLabel = (date: Date) =>
  date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Scores one company. Returns null when it has no positive signal, i.e. no opportunity. */
/**
 * Registry events: a company was registered, got its healthcare provider id, opened a site. They are
 * facts about the company, not evidence that it needs anything, so on their own they never make an
 * opportunity (the company is only being watched). With real evidence they still add context.
 */
export const CONTEXT_SIGNAL_TYPES = new Set(["company_formation", "new_startup", "new_location"]);

export function scoreCompany(input: EngineInput): ScoreResult | null {
  const { signals, now, labels } = input;
  const positives = signals.filter((s) => s.category !== "negative");
  const negatives = signals.filter((s) => s.category === "negative");
  // An opportunity needs evidence of need: hiring, a tender, a request, a problem found on its site.
  if (!positives.some((s) => !CONTEXT_SIGNAL_TYPES.has(s.signalType))) return null;

  // The strongest positive signal leads: intent strength, discounted by age.
  const strength = (s: EngineSignal) => INTENT_BASE[s.intentLevel] * recencyMultiplier(daysBetween(s.occurredAt, now));
  const ranked = [...positives].sort((a, b) => strength(b) - strength(a) || b.occurredAt.getTime() - a.occurredAt.getTime());
  const lead = ranked[0];
  const latestSignalAt = new Date(Math.max(...positives.map((s) => s.occurredAt.getTime())));

  const rejectedServices = new Set(input.rejected?.serviceIds);
  const rejectedPeople = new Set(input.rejected?.personIds);
  const candidates = input.services.filter((s) => !rejectedServices.has(s.id));
  const skipped = input.services
    .filter((s) => rejectedServices.has(s.id))
    .map((s) => `Not matched to ${s.name}: your team flagged it as the wrong service`);

  const best = pickService(candidates, positives, labels, input.company.industry);
  const service = best?.service ?? null;
  // Never suggest someone the team flagged, or isn't sure is the right person.
  const person = pickPerson(
    input.people.filter((p) => p.suggestable && !rejectedPeople.has(p.id)),
    lead,
    service,
  );

  const raw: Record<ScoreFactor, { score: number; reasons: string[] }> = {
    intent: intentFactor(ranked, negatives, now, labels),
    icpFit: icpFactor(input.company, input.people, service, best?.fit ?? 0, labels),
    recency: recencyFactor(latestSignalAt, now),
    identity: identityFactor(input.company, person),
    serviceFit: best
      ? { score: best.fit, reasons: [...best.reasons, ...skipped] }
      : {
          score: 0,
          // Explain both the flagged services and why none of the others fit.
          reasons: [...skipped, ...(candidates.length > 0 || skipped.length === 0 ? noServiceReason(candidates, positives, labels) : [])],
        },
  };

  const factors = Object.fromEntries(
    (Object.keys(raw) as ScoreFactor[]).map((key) => {
      const weight = input.weights[key];
      const score = clamp(raw[key].score);
      return [key, { score, weight, contribution: Math.round((score * weight) / 10) / 10, reasons: raw[key].reasons }];
    }),
  ) as Record<ScoreFactor, FactorResult>;
  const opportunityScore = clamp(Object.values(factors).reduce((sum, f) => sum + (f.score * f.weight) / 100, 0));

  const recentNegative = negatives.find((s) => daysBetween(s.occurredAt, now) <= NEGATIVE_WINDOW_DAYS);

  return {
    opportunityScore,
    factors,
    serviceId: service?.id ?? null,
    type: opportunityType(lead, service),
    urgency: urgencyOf(positives, now),
    problem: lead.summary,
    suggestedAction: suggestAction(lead, person?.name ?? null, service, recentNegative, input.company.name, labels),
    primaryPersonId: person?.id ?? null,
    latestSignalAt,
    signalRoles: [
      ...ranked.map((s, index) => ({
        signalId: s.id,
        role: index === 0 ? ("primary" as const) : ("corroborating" as const),
        weight: Math.round(strength(s)),
      })),
      ...negatives.map((s) => ({ signalId: s.id, role: "negative" as const, weight: -NEGATIVE_PENALTY })),
    ],
  };
}

/**
 * Intent: the PRD's seven weighted components, each 0-1, from the recent positive signals
 * (`ranked` is strongest first, so ranked[0] is the lead signal). Recent negative signals then
 * subtract a fixed penalty each.
 */
function intentFactor(ranked: EngineSignal[], negatives: EngineSignal[], now: Date, labels: EngineLabels) {
  const recent = ranked.filter((s) => daysBetween(s.occurredAt, now) <= INTENT_WINDOW_DAYS);
  if (recent.length === 0) {
    return { score: 0, reasons: [`No positive signal in the last ${INTENT_WINDOW_DAYS} days`] };
  }
  const lead = recent[0];
  const max = (value: (s: EngineSignal) => number) => Math.max(...recent.map(value));
  const explicit = recent.find((s) => s.intentLevel === "explicit" || s.category === "explicit_buying");
  const evaluating = recent.find((s) => EVALUATION_TYPES.has(s.signalType));
  const latestDays = Math.min(...recent.map((s) => daysBetween(s.occurredAt, now)));
  const topUrgency = recent.reduce<UrgencyLevel>((top, s) => (URGENCY_RANK[s.urgency] > URGENCY_RANK[top] ? s.urgency : top), "unknown");
  const corroborating = recent.length - 1;

  const components: Record<keyof typeof INTENT_WEIGHTS, number> = {
    explicitRequest: explicit ? 1 : max((s) => EXPLICITNESS[s.intentLevel]),
    problemSeverity: max((s) => INTENT_BASE[s.intentLevel] / 100),
    evaluationActivity: evaluating ? 1 : 0,
    recency: recencyMultiplier(latestDays),
    urgency: URGENCY_VALUE[topUrgency],
    corroboration: Math.min(1, corroborating / 2),
    sourceReliability: lead.evidenceLabel === "observed" && lead.hasSourceUrl ? 1 : SOURCE_RELIABILITY[lead.evidenceLabel],
  };
  let score = (Object.keys(INTENT_WEIGHTS) as (keyof typeof INTENT_WEIGHTS)[]).reduce(
    (sum, key) => sum + INTENT_WEIGHTS[key] * components[key],
    0,
  );

  const reasons = [
    explicit
      ? `Explicit buying request: ${labels.signalType(explicit.signalType)} (${dateLabel(explicit.occurredAt)})`
      : `${INTENT_LABEL[lead.intentLevel]} intent: ${labels.signalType(lead.signalType)} (${dateLabel(lead.occurredAt)})`,
  ];
  if (evaluating && evaluating !== explicit) reasons.push(`Evaluating vendors: ${labels.signalType(evaluating.signalType)}`);
  else if (evaluating) reasons.push("Actively evaluating vendors");
  if (topUrgency !== "unknown") reasons.push(`${topUrgency[0].toUpperCase()}${topUrgency.slice(1)} urgency`);
  if (corroborating > 0) reasons.push(`${plural(corroborating, "corroborating signal")}`);
  reasons.push(lead.evidenceLabel === "observed" ? `Observed in a source${lead.hasSourceUrl ? ", with link" : ""}` : `Evidence ${lead.evidenceLabel}`);

  for (const negative of negatives.filter((s) => daysBetween(s.occurredAt, now) <= NEGATIVE_WINDOW_DAYS)) {
    score -= NEGATIVE_PENALTY;
    reasons.push(`-${NEGATIVE_PENALTY} from ${labels.signalType(negative.signalType).toLowerCase()} (${dateLabel(negative.occurredAt)})`);
  }
  return { score, reasons };
}

const INTENT_LABEL: Record<IntentLevel, string> = {
  explicit: "Explicit",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unclear",
};

function recencyFactor(latest: Date, now: Date) {
  const days = Math.floor(daysBetween(latest, now));
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return { score: 100 * recencyMultiplier(days), reasons: [`Latest signal ${when}`] };
}

/**
 * How well the signals' needs match a service; the best-matching service is chosen. A service
 * with no overlap at all is never chosen, so the opportunity shows "No matching service" instead
 * of a match that isn't one.
 */
function pickService(services: EngineService[], positives: EngineSignal[], labels: EngineLabels, industry: string | null = null) {
  const categorised = positives.filter((s) => s.serviceCategories.length > 0);
  let best: { service: EngineService; fit: number; rank: number; reasons: string[] } | null = null;

  for (const service of services) {
    const offered = new Set(service.categories);
    let weighted = 0;
    let total = 0;
    const matched = new Set<string>();
    for (const signal of categorised) {
      const weight = INTENT_BASE[signal.intentLevel];
      const overlap = signal.serviceCategories.filter((c) => offered.has(c));
      overlap.forEach((c) => matched.add(c));
      // Any overlap is a real match (0.6); covering more of what the signal asks for adds up to 0.4.
      const match = overlap.length === 0 ? 0 : 0.6 + 0.4 * (overlap.length / signal.serviceCategories.length);
      weighted += weight * match;
      total += weight;
    }
    const fit = total === 0 ? 0 : (weighted / total) * 100;
    // A service aimed at other industries (a dental service for a care provider) only wins when
    // nothing aimed at this company fits as well. Ranking only: the fit itself is unchanged.
    const elsewhere = industry !== null && service.targetIndustries.length > 0 && !service.targetIndustries.includes(industry);
    const rank = elsewhere ? fit * 0.5 : fit;
    if (fit > 0 && (!best || rank > best.rank)) {
      best = { service, fit, rank, reasons: [`Matches ${service.name}: ${[...matched].map(labels.category).join(", ")}`] };
    }
  }
  return best;
}

/** Why no service was matched, so the score breakdown says what to change. */
function noServiceReason(services: EngineService[], positives: EngineSignal[], labels: EngineLabels): string[] {
  if (services.length === 0) return ["Add your services in Services & ICP to measure fit"];
  const needed = [...new Set(positives.flatMap((s) => s.serviceCategories))];
  if (needed.length === 0) return ["Signals don't point to any service category yet"];
  return [`None of your services offer what the signals point to: ${needed.map(labels.category).join(", ")}`];
}

/**
 * Company vs the chosen service's ideal customer, with the PRD's ICP sub-weights. Only criteria
 * the service defines count (plus service compatibility, which always does); unknown company data
 * scores half, so missing information neither hides nor promotes an account.
 */
function icpFactor(
  company: EngineCompany,
  people: EnginePerson[],
  service: EngineService | null,
  serviceFit: number,
  labels: EngineLabels,
) {
  if (!service) return { score: 50, reasons: ["No matching service to compare against"] };
  const checks: { weight: number; value: number; reason: string }[] = [];
  const check = (weight: number, value: number, reason: string) => checks.push({ weight, value, reason });

  if (service.targetIndustries.length > 0) {
    if (!company.industry) check(ICP_WEIGHTS.industry, 0.5, "Industry unknown");
    else if (service.targetIndustries.includes(company.industry))
      check(ICP_WEIGHTS.industry, 1, `${labels.industry(company.industry)} is a target industry`);
    else check(ICP_WEIGHTS.industry, 0, `${labels.industry(company.industry)} isn't a target industry`);
  }
  if (service.targetCountries.length > 0) {
    if (!company.hqCountry) check(ICP_WEIGHTS.geography, 0.5, "Country unknown");
    else if (service.targetCountries.includes(company.hqCountry))
      check(ICP_WEIGHTS.geography, 1, `Based in a target country (${company.hqCountry})`);
    else check(ICP_WEIGHTS.geography, 0, `${company.hqCountry} isn't a target country`);
  }
  if (service.companySizeMin !== null || service.companySizeMax !== null) {
    const size = company.employeeCount;
    const min = service.companySizeMin ?? 1;
    const max = service.companySizeMax ?? Number.POSITIVE_INFINITY;
    if (size === null) check(ICP_WEIGHTS.size, 0.5, "Company size unknown");
    else if (size >= min && size <= max) check(ICP_WEIGHTS.size, 1, `${size.toLocaleString("en")} employees is within the target size`);
    else check(ICP_WEIGHTS.size, 0, `${size.toLocaleString("en")} employees is outside the target size`);
  }
  if (service.targetJobFunctions.length > 0) {
    const buyer = people.find((p) => p.jobFunction && service.targetJobFunctions.includes(p.jobFunction));
    if (buyer) check(ICP_WEIGHTS.buyerRoles, 1, `${buyer.name} is in a buyer role (${labels.jobFunction(buyer.jobFunction!)})`);
    else if (people.length === 0) check(ICP_WEIGHTS.buyerRoles, 0.5, "No people added yet");
    else check(ICP_WEIGHTS.buyerRoles, 0.3, "No one in a target buyer role yet");
  }
  check(
    ICP_WEIGHTS.serviceCompatibility,
    serviceFit / 100,
    serviceFit >= 60 ? `Needs what ${service.name} offers` : `Only a partial need for ${service.name}`,
  );

  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const score = (checks.reduce((sum, c) => sum + c.weight * c.value, 0) / totalWeight) * 100;
  return { score, reasons: checks.map((c) => c.reason) };
}

/** How sure we are about who the company is and who to contact. */
function identityFactor(company: EngineCompany, person: EnginePerson | null) {
  const parts: [boolean, number, string][] = [
    [company.domain !== null, 30, "Website known"],
    [company.hasHeadquarters, 15, "Headquarters known"],
    [company.industry !== null, 10, "Industry known"],
    [company.employeeCount !== null, 5, "Size known"],
    [person !== null, 20, person ? `Contact identified: ${person.name}` : "No contact identified"],
    [
      person !== null && (person.hasEmail || person.hasPhone),
      20,
      person?.verifiedContact ? "Contact has a verified email or phone" : "Contact has email or phone",
    ],
  ];
  const score = parts.reduce((sum, [ok, points]) => sum + (ok ? points : 0), 0);
  const reasons = parts.filter(([ok, , label]) => ok || label === "No contact identified").map(([, , label]) => label);
  return { score, reasons };
}

const SENIORITY_RANK = new Map(SENIORITY_LEVELS.map((level, index) => [level, index]));

/** The person behind the lead signal, else the most senior person in a target buyer role, else the most senior. */
function pickPerson(people: EnginePerson[], lead: EngineSignal, service: EngineService | null): EnginePerson | null {
  const fromSignal = lead.personId ? people.find((p) => p.id === lead.personId) : undefined;
  if (fromSignal) return fromSignal;
  const bySeniority = [...people].sort((a, b) => (SENIORITY_RANK.get(a.seniority) ?? 99) - (SENIORITY_RANK.get(b.seniority) ?? 99));
  const isBuyer = (p: EnginePerson) => Boolean(service && p.jobFunction && service.targetJobFunctions.includes(p.jobFunction));
  // Someone the team can actually email or call beats a name alone (e.g. a director from the register).
  const reachable = (p: EnginePerson) => p.hasEmail || p.hasPhone;
  return (
    bySeniority.find((p) => isBuyer(p) && reachable(p)) ??
    bySeniority.find(reachable) ??
    bySeniority.find(isBuyer) ??
    bySeniority[0] ??
    null
  );
}

function opportunityType(lead: EngineSignal, service: EngineService | null): string {
  if (RFP_SIGNAL_TYPES.has(lead.signalType)) return "rfp";
  const offered = new Set(service?.categories ?? []);
  const candidates = [...lead.serviceCategories.filter((c) => offered.has(c)), ...lead.serviceCategories, ...(service?.categories ?? [])];
  for (const category of candidates) {
    const type = TYPE_BY_CATEGORY[category];
    if (type) return type;
  }
  return "other";
}

function urgencyOf(positives: EngineSignal[], now: Date): UrgencyLevel {
  const recent = positives.filter((s) => daysBetween(s.occurredAt, now) <= URGENCY_WINDOW_DAYS);
  return recent.reduce<UrgencyLevel>((top, s) => (URGENCY_RANK[s.urgency] > URGENCY_RANK[top] ? s.urgency : top), "unknown");
}

function suggestAction(
  lead: EngineSignal,
  personName: string | null,
  service: EngineService | null,
  recentNegative: EngineSignal | undefined,
  companyName: string,
  labels: EngineLabels,
): string {
  const who = personName ?? "the decision maker";
  const offer = service ? `your ${service.name} work` : "a relevant example of your work";
  if (recentNegative) {
    return `Hold off for now: ${companyName} recently reported a ${labels.signalType(recentNegative.signalType).toLowerCase()}. Revisit when that changes.`;
  }
  // A request in the explicit-buying group (e.g. an RFP or partner search) is a direct ask,
  // whatever intent level the signal was given; this matches the intent factor.
  const level = lead.category === "explicit_buying" ? "explicit" : lead.intentLevel;
  switch (level) {
    case "explicit":
      return `Reach out now to ${who}: they asked for help directly. Lead with ${offer}.`;
    case "high":
      return `Contact ${who} this week with ${offer}, tied to their ${labels.signalType(lead.signalType).toLowerCase()}.`;
    case "medium":
      return `Warm up first: share a useful insight or case study about ${offer} with ${who}.`;
    default:
      return "Keep watching. Wait for a stronger signal before reaching out.";
  }
}
