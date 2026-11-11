import type { IntentLevel } from "@/lib/domain/signals";

/**
 * Rule-based buying-intent reading of a post (spec §3). It separates a real request ("looking for
 * an agency to build my MVP") from a cost question ("how much to build an app like Uber"), and
 * from someone offering their own services. The AI pass, when a key is set, refines this later.
 */

const OFFERING = /\b(for hire|available for (work|hire|projects?)|seeking work|i('| a)?m a (freelance|freelancer|developer|designer)|i offer|hire me|my services|we offer|our agency)\b/i;
const EXPLICIT = /\b(looking for (an? )?(agency|dev shop|development (team|partner)|software house|freelancer|developer|designer|consultant|partner|studio|cto)|need (an? )?(agency|dev shop|development (team|partner)|developer|designer|freelancer|someone)|want to hire|(seeking|searching for) (an? )?(agency|developer|freelancer|vendor)|can anyone (build|develop)|recommend(ations)? for (an? )?(agency|developer|freelancer)|rfp|request for proposal|hiring (an? )?(agency|freelancer|contractor)|budget (of|is|:)? ?\$?\d)/i;
const NEED = /\b(need to (build|redesign|rebuild|outsource|hire)|(want|planning|trying|looking) to (build|redesign|rebuild|launch|outsource) (an? |my |our |the )|redesign(ing)? (our|my|the) (website|site))/i;
const COST_QUESTION = /\b(how much (does|would|will|do|to|for)|what('s| is) the cost|cost (to|of) (build|develop|make)|price (to|of) (build|develop|make))\b/i;

export type IntentRead = { level: IntentLevel; reason: string } | null;

/** `null` means the text is not a buying signal at all (e.g. a freelancer advertising). */
export function readIntent(text: string): IntentRead {
  const t = text.slice(0, 4000);
  if (OFFERING.test(t) && !EXPLICIT.test(t)) return null;
  if (EXPLICIT.test(t)) return { level: "high", reason: "States that they are looking to hire for this work." };
  if (NEED.test(t)) return { level: "medium", reason: "Describes a need for this kind of work." };
  if (COST_QUESTION.test(t)) return { level: "low", reason: "Asks what building this costs; a possible need, no hiring statement." };
  return null;
}

/**
 * Job-ad language: a person or company hiring staff, not buying a service. r/forhire's [Hiring] tag
 * covers both, so these are told apart by wording.
 */
const EMPLOYMENT = /\b(full[- ]?time|part[- ]?time|per (month|hour|year)|\/(hr|hour|month|mo)\b|salary|openings?|payroll|benefits|w-?2|resume|apply (now|here|today)|talent acquisition|recruit(er|ing|ment)|commission|equity only|volunteer|internship|\d+% of every deal)/i;
/** Wording of a one-off piece of work for an outside provider. */
const PROJECT_WORK = /\b(agency|freelanc\w*|contractor|project|one[- ]?(time|off)|fixed[- ]price|quote|proposal|mvp|redesign|rebuild|build (an? |our |my )|website|web ?app|mobile app|app development)\b/i;

/** True for a hiring post that reads as employment rather than a project for an outside provider. */
export function isEmployment(text: string): boolean {
  return EMPLOYMENT.test(text) || !PROJECT_WORK.test(text);
}
