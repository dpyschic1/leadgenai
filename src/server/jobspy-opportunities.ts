import "server-only";
import { and, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Actor } from "@/server/auth/actor";
import type { AuthContext } from "@/server/auth/session";
import { isJobHost } from "@/server/collection/collectors/html-jobs";
import { domainOf } from "@/server/collection/normalize";
import { enqueue } from "@/server/ingestion/queue";
import { resolveCompany, saveSourceRecord } from "@/server/ingestion/resolve";
import { categorizeJob, ruleJobSignal } from "@/server/jobs/job-categories";
import { MAX_JOB_AGE_DAYS, roleKey } from "@/server/jobs/job-signal";
import { rescoreAfterCompanyChange } from "@/server/scoring/rescore";
import { deleteCompany } from "@/server/services/companies.service";
import { loadServices } from "@/server/services/services.service";
import { insertDetectedSignal } from "@/server/services/signals.service";
import { jobInCountries } from "@/server/sources/board-directory";

/**
 * JobSpy import → Opportunities, per workspace and only when its switch is on (off by default).
 * Works like the own web collection's matching (`matchCollectedJobs`), from `jobspy_jobs`: jobs in
 * the workspace's service categories (title rules, no AI) and countries become companies (by their
 * own website) and rule-based signals; scoring then decides what is an opportunity. Everything is
 * tagged with the `jobspy` source, so switching off removes it again (`removeJobspyLeads`).
 */

const { jobspyJobs: jobs, jobspyWorkspaces: switches, sourceRecords, signals, companies } = schema;

const SOURCE = "jobspy" as const;
/** Jobs looked at per run, newest first. */
const CANDIDATES = 500;
const MAX_ROLES_PER_COMPANY = 3;
const TIME_BUDGET_MS = 20_000;

export async function jobspyEnabled(workspaceId: string): Promise<boolean> {
  const [row] = await db.select({ on: switches.sendToOpportunities }).from(switches).where(eq(switches.workspaceId, workspaceId));
  return row?.on ?? false;
}

export async function enabledWorkspaces(): Promise<string[]> {
  const rows = await db.select({ id: switches.workspaceId }).from(switches).where(eq(switches.sendToOpportunities, true));
  return rows.map((r) => r.id);
}

export type JobspyMatch = { companies: number; newCompanies: number; signals: number; skippedNoWebsite: number; more: boolean };

/** Matches the stored JobSpy jobs this workspace hasn't taken yet to its services. */
export async function matchJobspyJobs(actor: Actor, deadline = Date.now() + TIME_BUDGET_MS): Promise<JobspyMatch> {
  const result: JobspyMatch = { companies: 0, newCompanies: 0, signals: 0, skippedNoWebsite: 0, more: false };
  const services = await loadServices(actor.workspaceId);
  const sold = [...new Set(services.flatMap((s) => s.categories))];
  if (sold.length === 0) return result;
  const countries = [...new Set(services.flatMap((s) => s.targetCountries))];

  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        sql`coalesce(${jobs.datePosted}::timestamptz, ${jobs.firstSeenAt}) > now() - make_interval(days => ${MAX_JOB_AGE_DAYS})`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(sourceRecords)
            .where(
              and(
                eq(sourceRecords.workspaceId, actor.workspaceId),
                eq(sourceRecords.sourceSlug, SOURCE),
                sql`${sourceRecords.externalId} = 'job:' || ${jobs.id}`,
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(jobs.datePosted), desc(jobs.firstSeenAt))
    .limit(CANDIDATES);

  // Matching jobs, grouped by the company's own website. Jobs with no website are left for later
  // (a name alone could merge different companies); they are tried again on the next run.
  const byDomain = new Map<string, { job: (typeof rows)[number]; categories: string[] }[]>();
  for (const job of rows) {
    const categories = categorizeJob({ title: job.title, department: null }).filter((c) => sold.includes(c));
    if (categories.length === 0 || !jobInCountries(job.location, countries)) continue;
    const domain = domainOf(job.companyUrl);
    if (!domain || isJobHost(domain)) {
      result.skippedNoWebsite++;
      continue;
    }
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), { job, categories }]);
  }

  for (const [domain, matched] of byDomain) {
    if (Date.now() > deadline) {
      result.more = true;
      break;
    }
    const record = ({ job, categories }: (typeof matched)[number]) => ({
      sourceSlug: SOURCE,
      externalId: `job:${job.id}`,
      url: job.jobUrl,
      recordType: "job_post",
      publishedAt: job.datePosted ? new Date(job.datePosted) : null,
      data: { title: job.title, location: job.location, board: job.board, relevant: true, categories },
    });
    const companyName = matched.find((m) => m.job.company)?.job.company ?? domain.split(".")[0];
    const outcome = await db.transaction(async (tx) => {
      const [lead, ...rest] = matched;
      const resolved = await resolveCompany(tx, actor, {
        name: companyName,
        domain,
        industry: null,
        hq: null,
        identifiers: [],
        identity: "partial",
        foundedOn: null,
        record: record(lead),
      });
      const [{ name }] = await tx.select({ name: companies.canonicalName }).from(companies).where(eq(companies.id, resolved.companyId));
      const recordIds = new Map([[lead.job.id, resolved.recordId]]);
      for (const m of rest) recordIds.set(m.job.id, (await saveSourceRecord(tx, actor.workspaceId, record(m), resolved.companyId)).id);

      // One signal per role (the same role in several places counts once).
      const byRole = new Map<string, typeof matched>();
      for (const m of matched) byRole.set(roleKey(m.job.title), [...(byRole.get(roleKey(m.job.title)) ?? []), m]);
      let created = 0;
      for (const roleJobs of [...byRole.values()].slice(0, MAX_ROLES_PER_COMPANY)) {
        const [{ job, categories }] = roleJobs;
        const facts = {
          title: job.title,
          department: null,
          location: job.location,
          url: job.jobUrlDirect ?? job.jobUrl,
          postedAt: job.datePosted ? new Date(job.datePosted) : null,
          firstSeenAt: job.firstSeenAt,
        };
        const signal = await insertDetectedSignal(tx, actor, resolved.companyId, ruleJobSignal(name, facts, roleJobs.length, categories), recordIds.get(job.id) ?? null);
        if (signal.created) created++;
      }
      return { companyId: resolved.companyId, created: resolved.created, signals: created };
    });
    result.companies++;
    result.signals += outcome.signals;
    if (outcome.created) {
      result.newCompanies++;
      // Its website, contacts and team, like any company found automatically.
      await enqueue(db, { workspaceId: actor.workspaceId, kind: "enrich_company", entityId: outcome.companyId });
    }
    await rescoreAfterCompanyChange(actor.workspaceId, outcome.companyId);
  }
  return result;
}

/**
 * After a JobSpy run: match the new jobs in every workspace that has the switch on, until the
 * deadline (what is left is matched after the next run). Errors are logged, never thrown.
 */
export async function matchJobspyForEnabledWorkspaces(deadline: number): Promise<void> {
  for (const workspaceId of await enabledWorkspaces()) {
    if (Date.now() > deadline) break;
    try {
      await matchJobspyJobs({ workspaceId, userId: null }, deadline);
    } catch (error) {
      console.error(`[jobspy] matching failed for workspace ${workspaceId}`, error);
    }
  }
}

/**
 * Removes what JobSpy added to this workspace: its signals, the companies it found that have
 * nothing else (no signal from another source), and its source records; then re-scores the rest.
 */
export async function removeJobspyLeads(auth: AuthContext): Promise<{ signals: number; companies: number }> {
  const records = db
    .select({ id: sourceRecords.id })
    .from(sourceRecords)
    .where(and(eq(sourceRecords.workspaceId, auth.workspaceId), eq(sourceRecords.sourceSlug, SOURCE)));
  const removed = await db
    .delete(signals)
    .where(and(eq(signals.workspaceId, auth.workspaceId), inArray(signals.sourceRecordId, records)))
    .returning({ companyId: signals.companyId });

  const found = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.workspaceId, auth.workspaceId),
        eq(companies.sourceSlug, SOURCE),
        notExists(db.select({ one: sql`1` }).from(signals).where(eq(signals.companyId, companies.id))),
      ),
    );
  for (const { id } of found) await deleteCompany(auth, id);
  await db.delete(sourceRecords).where(and(eq(sourceRecords.workspaceId, auth.workspaceId), eq(sourceRecords.sourceSlug, SOURCE)));

  const deleted = new Set(found.map((c) => c.id));
  for (const companyId of new Set(removed.map((r) => r.companyId))) {
    if (!deleted.has(companyId)) await rescoreAfterCompanyChange(auth.workspaceId, companyId);
  }
  return { signals: removed.length, companies: found.length };
}

/** Turns the switch on (and matches the stored jobs now) or off (and removes what JobSpy added). */
export async function setJobspyEnabled(auth: AuthContext, on: boolean) {
  await db
    .insert(switches)
    .values({ workspaceId: auth.workspaceId, sendToOpportunities: on })
    .onConflictDoUpdate({ target: switches.workspaceId, set: { sendToOpportunities: on, updatedAt: new Date() } });
  if (on) return { matched: await matchJobspyJobs(auth), removed: null };
  return { matched: null, removed: await removeJobspyLeads(auth) };
}
