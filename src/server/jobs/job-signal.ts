import type { SignalAnalysis } from "@/lib/api/types";
import { isFaithfulQuote } from "@/server/ai/finalize-analysis";
import { MAX_SOURCE_TEXT, signalSchema, type SignalValues } from "@/lib/validation/signals";

/** Pure helpers that turn a fetched job and its AI analysis into a signal. Unit-tested. */

/** Analyses below this confidence aren't recorded automatically; the job is shown as skipped. */
export const MIN_AUTO_CONFIDENCE = 50;

/** Set on a job whose signal the team deleted, so later fetches leave the role alone. */
export const SIGNAL_DELETED_REASON = "Signal deleted by your team";

/**
 * Description characters sent to the AI per job. The opening of a posting carries the role and the
 * need; keeping it short leaves room for more jobs in the free plan's per-minute token limit.
 */
export const MAX_JOB_TEXT = 3000;

/**
 * Groups the same role posted for several places ("Design Engineer - UK", "Design Engineer - EU",
 * "Design Engineer (Remote)") under one key, so it is analysed once and becomes one signal.
 * A trailing " - …", " – …", " | …" or "(…)" part of up to three words is treated as the place.
 */
export function roleKey(title: string): string {
  let key = title.trim().toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i < 2; i++) {
    const stripped = key.replace(/\s*(?:\s[-–—|]\s|\()\s*([^-–—|()]+?)\)?$/, (match, tail: string) =>
      tail.trim().split(" ").length <= 3 ? "" : match,
    );
    if (stripped === key || stripped.length < 3) break;
    key = stripped;
  }
  return key;
}

const DAY_MS = 86_400_000;

type JobFacts = {
  title: string;
  department: string | null;
  location: string | null;
  url: string;
  description: string | null;
  postedAt: Date | null;
  firstSeenAt: Date;
  closedAt?: Date | null;
};

/** When the job went up: the published date, or when we first saw it if the board doesn't say. */
export const openedAt = (job: Pick<JobFacts, "postedAt" | "firstSeenAt">) => job.postedAt ?? job.firstSeenAt;

/** Whole days the job has been (or was) open. */
export function openDays(job: Pick<JobFacts, "postedAt" | "firstSeenAt" | "closedAt">, now = new Date()): number {
  const end = job.closedAt ?? now;
  return Math.max(0, Math.floor((end.getTime() - openedAt(job).getTime()) / DAY_MS));
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The text the AI analyses: the facts first (so how long the role has been open is visible, which
 * marks a long-running vacancy, and how many openings share the role), then the description.
 * `maxDescription` trims the description; the default keeps all of it (within the analysis limit).
 */
export function jobSourceText(
  job: JobFacts,
  { now = new Date(), openings = [], maxDescription = MAX_SOURCE_TEXT }: { now?: Date; openings?: string[]; maxDescription?: number } = {},
): string {
  const days = openDays(job, now);
  const header = [
    `Job posting: ${job.title}`,
    job.department && `Department: ${job.department}`,
    job.location && `Location: ${job.location}`,
    `Posted: ${isoDate(openedAt(job))} (open for ${days} ${days === 1 ? "day" : "days"})`,
    openings.length > 1 && `The company has ${openings.length} open postings for this role: ${openings.join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  const description = job.description?.slice(0, maxDescription);
  const text = description ? `${header}\n\n${description}` : header;
  return text.slice(0, MAX_SOURCE_TEXT);
}

/**
 * The signal to record for a job, or null when the analysis doesn't support one (no signal, too
 * unsure, or fields that don't validate). The event date is when the job was posted.
 */
export function jobSignalValues(analysis: SignalAnalysis, job: JobFacts): SignalValues | null {
  if (!analysis.isSignal || !analysis.signalType || analysis.confidence < MIN_AUTO_CONFIDENCE) return null;
  // Evidence must be the company's own words: a quote of the facts we put above the description
  // (dates, number of postings) is dropped, and the signal then counts as inferred.
  const excerpt = analysis.excerpt && job.description && isFaithfulQuote(analysis.excerpt, job.description) ? analysis.excerpt : null;
  const result = signalSchema.safeParse({
    signalType: analysis.signalType,
    intentLevel: analysis.intentLevel,
    urgency: analysis.urgency,
    serviceCategories: analysis.serviceCategories,
    summary: analysis.summary,
    personId: null,
    occurredOn: isoDate(openedAt(job)),
    sourceUrl: job.url,
    excerpt,
    evidenceLabel: analysis.evidenceLabel === "observed" && !excerpt ? "inferred" : analysis.evidenceLabel,
    source: "ai",
    confidence: analysis.confidence,
  });
  return result.success ? result.data : null;
}

/** The reason shown on a job the full analysis decided not to record. */
export function rejectionReason(analysis: SignalAnalysis): string {
  return analysis.isSignal
    ? `Too unclear to record automatically (${analysis.confidence}% confident)`
    : "Not a buying signal on a closer read";
}
