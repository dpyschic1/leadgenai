import "server-only";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  boardJobs,
  collectedItems,
  companies,
  companyContactPoints,
  companyLocations,
  jobPostings,
  opportunities,
  opportunityEvidence,
  opportunitySignals,
  signalEvidence,
  signals,
} from "@/db/schema";
import { QUALIFY_MIN_SCORE } from "@/lib/domain/opportunities";
import { CLIENT_TYPE_LABELS, SIZE_PRESETS } from "@/lib/validation/services";
import { qualifyLead, type QualifyInput } from "@/server/ai/qualify-lead";
import { withAiSlot } from "@/server/ingestion/handlers";
import { AppError } from "@/server/http/errors";
import { getReferenceData } from "@/server/services/reference-data.service";
import { loadServices } from "@/server/services/services.service";
import { isJobHost } from "@/server/collection/collectors/html-jobs";
import { htmlToText } from "@/server/jobs/html-to-text";
import { emailsFrom } from "@/server/sources/company-website";
import { politeGet } from "@/server/sources/http";

/**
 * Turning opportunities into leads (as lead tools such as Buska do): everything found is an
 * opportunity; the AI then reads each one's evidence, strongest first, and judges it hot, warm or
 * not a fit. Hot and warm are leads. Only opportunities the rules already score `QUALIFY_MIN_SCORE`
 * or more are sent, so the AI's daily allowance goes to the likeliest ones. Checked again when new
 * evidence arrives; a team decision is never overwritten.
 */

/** A failed check is tried again after this long. */
const RETRY_AFTER_HOURS = 6;
/** Evidence sent to the AI, at most (about 2,000 tokens). */
const MAX_EVIDENCE_CHARS = 7_000;
const MAX_JOB_CHARS = 1_800;
const MAX_SIGNALS = 4;
/** Open roles listed in one line each, so the AI judges all of them. */
const MAX_ROLES_LISTED = 25;

/** Opportunities due a check: unchecked (or failed a while ago), or checked by the AI before newer evidence arrived. */
const due = sql`(
  ${opportunities.opportunityScore} >= ${QUALIFY_MIN_SCORE}
  and ${opportunities.hiddenReason} is null
  and ${opportunities.archivedAt} is null
  and (${opportunities.qualifiedBy} is null or ${opportunities.qualifiedBy} = 'ai')
  and (
    (${opportunities.qualification} is null
      and (${opportunities.qualifiedAt} is null or ${opportunities.qualifiedAt} < now() - make_interval(hours => ${RETRY_AFTER_HOURS})))
    or (${opportunities.qualification} is not null and ${opportunities.latestSignalAt} > ${opportunities.qualifiedAt})
  )
)`;

/**
 * Checks up to `limit` opportunities, strongest first, before `deadline`. Stops early when the AI
 * is busy (its per-minute or daily limit): the rest wait for the next tick. Returns how many were checked.
 */
export async function qualifyLeads({ workspaceId, limit, deadline }: { workspaceId?: string; limit: number; deadline: number }): Promise<number> {
  const rows = await db
    .select({ id: opportunities.id, workspaceId: opportunities.workspaceId })
    .from(opportunities)
    .where(and(due, workspaceId ? eq(opportunities.workspaceId, workspaceId) : undefined))
    .orderBy(desc(opportunities.opportunityScore))
    .limit(limit);

  let checked = 0;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    try {
      const input = await gatherInput(row.workspaceId, row.id);
      if (!input) {
        // Nothing to read yet: looked at again after RETRY_AFTER_HOURS.
        await db.update(opportunities).set({ qualifiedAt: new Date() }).where(eq(opportunities.id, row.id));
        continue;
      }
      const result = await withAiSlot(() => qualifyLead(input));
      await db
        .update(opportunities)
        .set({
          qualification: result.qualification,
          qualificationScore: result.score,
          qualificationReason: result.reason,
          qualificationQuote: result.quote,
          qualificationHints: result.hints,
          qualifiedBy: "ai",
          qualifiedAt: new Date(),
        })
        // Someone on the team may have decided while the AI was reading.
        .where(and(eq(opportunities.id, row.id), sql`${opportunities.qualifiedBy} is distinct from 'team'`));
      checked++;
    } catch (error) {
      if (error instanceof AppError && (error.code === "AI_BUSY" || error.code === "RATE_LIMITED" || error.code === "AI_UNAVAILABLE")) break;
      console.error(`[leads] qualifying ${row.id} failed`, error);
      // Tried again after RETRY_AFTER_HOURS, so one bad item never blocks the rest.
      await db.update(opportunities).set({ qualifiedAt: new Date() }).where(and(eq(opportunities.id, row.id), sql`${opportunities.qualification} is null`));
    }
  }
  return checked;
}

/** Job pages read per opportunity when no text is stored (each one a polite request to the employer's site). */
const MAX_PAGES_READ = 2;

/**
 * Whether a job link may be read: the employer's own website, or the job board it posts on (an ATS
 * such as Greenhouse or Ashby). Never LinkedIn, Indeed or a job aggregator: we don't read those
 * sites. Pure.
 */
export function readablePosting(url: string, companyDomain: string | null): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  if (/(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|monster|simplyhired)\.[a-z.]+$/.test(host)) return false;
  if (companyDomain && (host === companyDomain || host.endsWith(`.${companyDomain}`))) return true;
  return isJobHost(host);
}

/** A job's text as the careers-page collector already stored it, by its link. */
async function collectedText(url: string): Promise<string | null> {
  const [row] = await db
    .select({ body: collectedItems.body })
    .from(collectedItems)
    .where(and(eq(collectedItems.url, url), sql`${collectedItems.body} is not null and length(${collectedItems.body}) > 200`))
    .limit(1);
  return row?.body ?? null;
}

/** The job page's text, read once and politely (robots.txt respected); null when it can't be read. */
async function readPosting(url: string): Promise<string | null> {
  try {
    const page = await politeGet(url, { timeoutMs: 10_000 });
    if (page.status >= 400 || !/html/i.test(page.contentType)) return null;
    const text = htmlToText(page.body);
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

/** Saves the emails on the company's own domain that its job posts publish, as company contacts. */
async function saveOwnEmails(companyId: string, domain: string, postings: { text: string; url: string | null }[]): Promise<void> {
  const own = (email: string) => email.endsWith(`@${domain}`) || email.endsWith(`.${domain}`);
  // Each address once, with the job post it was published in.
  const found = new Map<string, string | null>();
  for (const posting of postings) for (const email of emailsFrom(posting.text, domain).filter(own)) if (!found.has(email)) found.set(email, posting.url);
  const emails = [...found].slice(0, 3);
  if (emails.length === 0) return;
  await db
    .insert(companyContactPoints)
    .values(emails.map(([value, sourceUrl]) => ({ companyId, type: "email" as const, value, sourceSlug: "job_board", sourceUrl })))
    .onConflictDoNothing();
}

/** What the AI reads about one opportunity: the matched service, the buyer and the evidence. Null when it's gone. */
async function gatherInput(workspaceId: string, opportunityId: string): Promise<QualifyInput | null> {
  const [opp] = await db.select().from(opportunities).where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, workspaceId)));
  if (!opp) return null;
  const [services, ref] = await Promise.all([loadServices(workspaceId), getReferenceData()]);
  const category = new Map(ref.serviceCategories.map((c) => [c.slug, c.name]));
  const industry = new Map(ref.industries.map((c) => [c.slug, c.name]));
  const matched = services.find((s) => s.id === opp.serviceId) ?? null;
  const size = matched
    ? (SIZE_PRESETS.find((p) => p.min === matched.companySizeMin && p.max === matched.companySizeMax && p.value !== "any")?.label ??
      (matched.companySizeMin !== null || matched.companySizeMax !== null ? `${matched.companySizeMin ?? 1}-${matched.companySizeMax ?? "any"} employees` : null))
    : null;

  const parts: string[] = [];
  const add = (text: string | null | undefined) => {
    const clean = text?.replace(/\s+/g, " ").trim();
    if (clean && parts.join("\n").length < MAX_EVIDENCE_CHARS) parts.push(clean);
  };
  let buyer: string;

  if (opp.companyId) {
    const [company] = await db
      .select({
        name: companies.canonicalName,
        domain: companies.domain,
        industry: companies.industry,
        employees: companies.employeeCount,
        description: companies.description,
        country: companyLocations.country,
      })
      .from(companies)
      .leftJoin(companyLocations, and(eq(companyLocations.companyId, companies.id), eq(companyLocations.type, "headquarters")))
      .where(eq(companies.id, opp.companyId))
      .limit(1);
    buyer = [
      `Company: ${company?.name ?? "unknown"}${company?.domain ? ` (${company.domain})` : ""}`,
      company?.industry && `Industry: ${industry.get(company.industry) ?? company.industry}`,
      company?.employees && `Employees: ${company.employees.toLocaleString("en")}`,
      company?.country && `Headquarters: ${company.country}`,
      company?.description && `About: ${company.description.slice(0, 400)}`,
    ]
      .filter(Boolean)
      .join("\n");

    // Every open role first, in one line each, so the verdict covers all of them (not just the strongest few).
    const everyRole = await db
      .select({ summary: signals.summary })
      .from(opportunitySignals)
      .innerJoin(signals, eq(signals.id, opportunitySignals.signalId))
      .where(and(eq(opportunitySignals.opportunityId, opp.id), ne(opportunitySignals.role, "negative")))
      .orderBy(desc(opportunitySignals.weight))
      .limit(MAX_ROLES_LISTED);
    if (everyRole.length > 1) add(`All ${everyRole.length} signals (open roles):\n${everyRole.map((r) => `- ${r.summary}`).join("\n")}`);

    // The strongest signals in detail, with their excerpts and the job posts behind them.
    const linked = await db
      .select({ id: signals.id, summary: signals.summary, occurredAt: signals.occurredAt })
      .from(opportunitySignals)
      .innerJoin(signals, eq(signals.id, opportunitySignals.signalId))
      .where(and(eq(opportunitySignals.opportunityId, opp.id), ne(opportunitySignals.role, "negative")))
      .orderBy(desc(opportunitySignals.weight))
      .limit(MAX_SIGNALS);
    const ids = linked.map((s) => s.id);
    const [excerpts, jobs] = ids.length
      ? await Promise.all([
          db.select({ signalId: signalEvidence.signalId, excerpt: signalEvidence.excerpt, url: signalEvidence.sourceUrl }).from(signalEvidence).where(inArray(signalEvidence.signalId, ids)),
          db
            .select({
              signalId: jobPostings.signalId,
              title: jobPostings.title,
              location: jobPostings.location,
              description: sql<string | null>`coalesce(${boardJobs.description}, ${jobPostings.description})`,
            })
            .from(jobPostings)
            .leftJoin(boardJobs, eq(boardJobs.id, jobPostings.boardJobId))
            .where(inArray(jobPostings.signalId, ids))
            .limit(MAX_SIGNALS * 2),
        ])
      : [[], []];
    // The posting itself is the real evidence: its stored text, else the page read once (only the
    // employer's own site or its job board, never LinkedIn, Indeed or a job aggregator).
    const postings: { text: string; url: string | null }[] = [];
    let fetched = 0;
    for (const signal of linked) {
      add(`Signal (${signal.occurredAt.toISOString().slice(0, 10)}): ${signal.summary}`);
      const evidence = excerpts.filter((x) => x.signalId === signal.id);
      for (const e of evidence) add(e.excerpt && `Excerpt: ${e.excerpt}`);
      const stored = jobs.filter((j) => j.signalId === signal.id && j.description);
      for (const job of jobs.filter((j) => j.signalId === signal.id)) add(`Job post: ${job.title}${job.location ? ` (${job.location})` : ""}`);
      let text = stored[0]?.description ?? null;
      const link = evidence.find((e) => e.url)?.url ?? null;
      if (!text && link) text = await collectedText(link);
      if (!text && link && fetched < MAX_PAGES_READ && readablePosting(link, company?.domain ?? null)) {
        fetched++;
        text = await readPosting(link);
      }
      if (text) {
        postings.push({ text, url: link });
        add(`Job post text: ${text.slice(0, MAX_JOB_CHARS)}`);
      }
    }
    // An address the employer publishes in its own job post (jobs@its-domain) is a way in too.
    if (company?.domain && postings.length > 0) await saveOwnEmails(opp.companyId, company.domain, postings);
  } else {
    buyer = [
      opp.buyerName ? `Posted by: ${opp.buyerName}` : "Posted by: unknown",
      opp.country && `Country: ${opp.country}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Discovered posts, projects and funding rounds (and anything else stored with the opportunity).
  add(opp.title && `Title: ${opp.title}`);
  add(opp.problem && `Summary: ${opp.problem}`);
  if (opp.budgetUsd) add(`Stated budget: about $${opp.budgetUsd.toLocaleString("en")}`);
  if (opp.fundingAmountUsd) add(`Funding: $${opp.fundingAmountUsd.toLocaleString("en")}${opp.fundingStage ? ` (${opp.fundingStage})` : ""}${opp.fundingDate ? ` on ${opp.fundingDate}` : ""}`);
  const snippets = await db.select({ platform: opportunityEvidence.platform, snippet: opportunityEvidence.snippet }).from(opportunityEvidence).where(eq(opportunityEvidence.opportunityId, opp.id)).limit(3);
  for (const s of snippets) add(s.snippet && `From ${s.platform}: ${s.snippet}`);

  if (parts.length === 0) return null;
  return {
    service: matched && {
      name: matched.name,
      description: matched.description,
      categories: matched.categories.map((c) => category.get(c) ?? c),
      clientTypes: matched.clientTypes.map((t) => CLIENT_TYPE_LABELS[t]),
      workType: matched.workType,
      size,
    },
    otherServices: services.filter((s) => s.id !== matched?.id).map((s) => s.name),
    buyer,
    evidence: parts.join("\n").slice(0, MAX_EVIDENCE_CHARS),
  };
}
