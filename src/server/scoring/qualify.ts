import "server-only";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  boardJobs,
  companies,
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

    // The supporting signals, strongest first, with their excerpts and the job posts behind them.
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
          db.select({ signalId: signalEvidence.signalId, excerpt: signalEvidence.excerpt }).from(signalEvidence).where(inArray(signalEvidence.signalId, ids)),
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
    for (const signal of linked) {
      add(`Signal (${signal.occurredAt.toISOString().slice(0, 10)}): ${signal.summary}`);
      for (const e of excerpts.filter((x) => x.signalId === signal.id)) add(e.excerpt && `Excerpt: ${e.excerpt}`);
      for (const job of jobs.filter((j) => j.signalId === signal.id)) {
        add(`Job post: ${job.title}${job.location ? ` (${job.location})` : ""}`);
        add(job.description?.slice(0, MAX_JOB_CHARS));
      }
    }
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
