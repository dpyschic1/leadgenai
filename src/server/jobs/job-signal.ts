import type { SignalAnalysis } from "@/lib/api/types";
import { isFaithfulQuote } from "@/server/ai/finalize-analysis";
import { MAX_SOURCE_TEXT, signalSchema, type SignalValues } from "@/lib/validation/signals";

/** Pure helpers that turn a fetched job and its AI analysis into a signal. Unit-tested. */

/** Analyses below this confidence aren't recorded automatically; the job is shown as skipped. */
export const MIN_AUTO_CONFIDENCE = 50;

/** Set on a job whose signal the team deleted, so later fetches leave the role alone. */
export const SIGNAL_DELETED_REASON = "Signal deleted by your team";

/**
 * Description characters sent to the AI per job, and the most stored per job (`jobDigest`). The
 * role and the need sit in a posting's opening and duties; keeping it short leaves room for more
 * jobs in the free plan's per-minute token limit.
 */
export const MAX_JOB_TEXT = 3000;

/**
 * How fresh a job must be to count: posted (or, undated, first seen) within this many days. Older
 * posts are not stored in the shared pool, are dropped from it once they age past this, and are
 * never matched to a workspace.
 */
export const MAX_JOB_AGE_DAYS = 60;

/** Closed jobs stay in the shared pool this long (a job relisted soon after keeps its first-seen date), then are deleted. */
export const CLOSED_JOB_RETENTION_DAYS = 14;

/** Whether a job is too old to keep: posted more than `MAX_JOB_AGE_DAYS` ago. Undated jobs aren't (their age is first-seen). Pure. */
export const isStaleJob = (postedAt: Date | null, now = new Date()) =>
  postedAt !== null && now.getTime() - postedAt.getTime() > MAX_JOB_AGE_DAYS * 86_400_000;

/**
 * The same job listed more than once on a board (reposted, or one post per opening) has the same
 * title and place. Case and spacing are ignored. Pure.
 */
export const repostKey = (job: { title: string; location: string | null }) =>
  `${job.title.trim().toLowerCase().replace(/\s+/g, " ")}|${(job.location ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`;

// --- What is kept of a description ------------------------------------------------------------

/** Lines that are legal or hiring small print: never a buying signal, and repeated on every post. */
const BOILERPLATE =
  /equal (employment )?opportunit|without regard to|race, colou?r|sexual orientation|gender identity|protected (veteran|characteristic|class|status)|reasonable accommodation|e-verify|privacy (notice|policy|statement)|applicant (data|privacy)|background check|drug (screen|test)|fair chance|conviction records|recruit(ment|ing) agenc|unsolicited (resume|cv|application)|pay transparency|consumer privacy act|by applying,? you|we use cookies/i;

/** Section headings whose sections are left out: perks, pay small print, legal and physical demands. */
const SKIP_SECTION =
  /\b(benefits?|perks|what we offer|we offer|what you('|’)ll get|why (join|work)|life at|our values|working conditions|physical (requirements|demands)|equal (employment )?opportunit|eeo|diversity|privacy|accommodations?|disclaimer|legal|pay transparency|compensation|salary|total rewards)\b/i;

/** A short line that names a section ("What You'll Do:", "REQUIREMENTS"), not a sentence or a bullet. */
const isHeading = (line: string) =>
  line.length <= 70 && !line.startsWith("•") && (line.endsWith(":") || (/[a-z]/i.test(line) && line === line.toUpperCase()) || (line.split(" ").length <= 6 && !/[.!?,;]$/.test(line)));

const LINKS_LABEL = "Links: ";
/** Most characters the links line may take. */
const MAX_LINKS_TEXT = 300;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_HOST = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
const BARE_DOMAIN = /(?<![@\w./-])(?:www\.)?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|io|ai|co|net|org|app|dev|tech|health|us))(?![\w-]|\.\w)/gi;

/**
 * The emails, websites and domains a posting names, wherever they are in it: they find the
 * company's own site and hiring inbox, so they are kept even when the text around them isn't. Pure.
 */
export function contactHints(text: string): string[] {
  const found = new Map<string, string>();
  const add = (key: string, value: string) => {
    if (!found.has(key)) found.set(key, value);
  };
  for (const [email] of text.matchAll(EMAIL)) add(email.toLowerCase(), email.toLowerCase());
  const emailHosts = new Set([...found.keys()].map((e) => e.split("@")[1]));
  for (const [, host] of text.matchAll(URL_HOST)) {
    const h = host.toLowerCase().replace(/^www\./, "");
    if (!emailHosts.has(h)) add(h, `https://${h}`);
  }
  for (const [, domain] of text.matchAll(BARE_DOMAIN)) {
    const d = domain.toLowerCase().replace(/^www\./, "");
    if (!emailHosts.has(d)) add(d, d);
  }
  return [...found.values()];
}

/**
 * What is stored of a job's description: only what the AI reads and evidence quotes, not the whole
 * posting.
 * - A job that fits a service (`relevant`): the posting without its perks, pay small print and legal
 *   notices, in its own order (about the company, the role, duties, requirements), up to
 *   `MAX_JOB_TEXT`. Kept as the company's own sentences (not keywords) so an AI quote of it can be
 *   checked word for word as evidence.
 * - Any other job: only the links and emails it names (null when none), since it is never read.
 * Either way the posting's emails and sites are kept on a last "Links:" line when the kept text
 * doesn't already carry them. Pure.
 */
export function jobDigest(description: string | null | undefined, { relevant }: { relevant: boolean }): string | null {
  if (!description?.trim()) return null;
  // Its own output passes through unchanged, so digesting a stored digest again is harmless.
  const lines = description
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .reduce<string[]>((acc, line) => {
      if (!line) return acc;
      // A bullet left on its own line belongs to the next one.
      if (acc.at(-1) === "•") acc[acc.length - 1] = `• ${line.replace(/^•\s*/, "")}`;
      else acc.push(line);
      return acc;
    }, []);
  const hints = contactHints(description);
  const linksLine = (body: string) => {
    let line = "";
    for (const hint of hints) {
      if (body.toLowerCase().includes(hint.replace(/^https:\/\//, ""))) continue;
      const next = line ? `${line} · ${hint}` : `${LINKS_LABEL}${hint}`;
      if (next.length > MAX_LINKS_TEXT) break;
      line = next;
    }
    return line;
  };
  if (!relevant) return linksLine("") || null;

  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith(LINKS_LABEL)) continue;
    if (isHeading(line)) {
      skipping = SKIP_SECTION.test(line);
      if (!skipping) kept.push(line);
      continue;
    }
    if (!skipping && !BOILERPLATE.test(line)) kept.push(line);
  }
  // Everything looked like small print: keep the opening instead of nothing.
  const source = kept.some((l) => !isHeading(l)) ? kept : lines.filter((l) => !l.startsWith(LINKS_LABEL));

  const budget = MAX_JOB_TEXT - MAX_LINKS_TEXT - 1;
  let body = "";
  for (const line of source) {
    const next = body ? `${body}\n${line}` : line;
    if (next.length <= budget) {
      body = next;
      continue;
    }
    // Fill what is left with the start of the next line, cut at a word.
    const room = budget - body.length - 1;
    if (room > 80) body = `${body ? `${body}\n` : ""}${line.slice(0, room).replace(/\s+\S*$/, "")}…`;
    break;
  }
  // Headings left with nothing under them at the end are dropped.
  body = body.replace(/(\n[^\n•]{1,70}:)+$/, "");
  const links = linksLine(body);
  return links ? `${body}\n${links}` : body;
}

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
