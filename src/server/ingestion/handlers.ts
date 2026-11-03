import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { companies, companyIdentifiers, companyJobBoards, companyLocations, sourceRecords } from "@/db/schema";
import type { IngestionJobKind } from "@/lib/domain/sources";
import { CATEGORY_CPV_CODES, INDUSTRY_SIC_CODES } from "@/lib/domain/uk-codes";
import { analyzeSignal } from "@/server/ai/signal-analysis";
import { extractWebsiteFacts } from "@/server/ai/website-extract";
import { systemActor, type Actor } from "@/server/auth/actor";
import { rateLimit } from "@/server/http/rate-limit";
import { detectBoard } from "@/server/jobs/detect";
import { rescoreAfterCompanyChange } from "@/server/scoring/rescore";
import { getReferenceData } from "@/server/services/reference-data.service";
import { connectDetectedBoard, syncCompanyJobs } from "@/server/services/job-boards.service";
import { loadServices } from "@/server/services/services.service";
import { insertDetectedSignal } from "@/server/services/signals.service";
import { companiesHouse } from "@/server/sources/companies-house";
import { findWebsite, readWebsite } from "@/server/sources/company-website";
import { jobFunctionFromTitle, seniorityFromTitle } from "@/server/sources/names";
import { searchTenders, tenderSourceText } from "@/server/sources/uk-tenders";
import { formationSignal, NEW_COMPANY_DAYS, signalFromAnalysis } from "./found-signal";
import { sourceRunnable, type JobRow } from "./queue";
import { addCompanyContacts, addFoundPeople, knownIdentifiers, resolveCompany, saveSourceRecord } from "./resolve";

/**
 * One handler per kind of background job (Spec §11). Each does a small piece of work, records
 * provenance and returns the follow-up jobs to queue. What to look for comes from the workspace's
 * Services & ICP, so nothing has to be set up first.
 */

export type FollowUp = { kind: IngestionJobKind; entityId: string; runAfter?: Date };
export type JobContext = {
  job: JobRow;
  actor: Actor;
  /** Runs one AI call within the workspace's daily AI budget, counting it for cost metering. */
  ai: <T>(call: () => Promise<T>) => Promise<T>;
};
export type JobResult = { followUps: FollowUp[]; skipped?: boolean };

const DAY = 86_400_000;
const later = (ms: number) => new Date(Date.now() + ms);
/** How often found companies are re-checked. */
const RECHECK = { website: 30 * DAY, jobBoard: 7 * DAY } as const;
/** Full analyses per tender scan (the free AI allows a few a minute). */
const TENDER_ANALYSES_PER_JOB = 3;

async function loadCompany(actor: Actor, companyId: string) {
  const [row] = await db
    .select({ id: companies.id, name: companies.canonicalName, domain: companies.domain, industry: companies.industry, city: companyLocations.city })
    .from(companies)
    .leftJoin(companyLocations, and(eq(companyLocations.companyId, companies.id), eq(companyLocations.type, "headquarters")))
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, actor.workspaceId)))
    .limit(1);
  if (!row) return null;
  const identifiers = await db
    .select({ scheme: companyIdentifiers.scheme, value: companyIdentifiers.value })
    .from(companyIdentifiers)
    .where(eq(companyIdentifiers.companyId, companyId));
  return { ...row, identifiers, companyNumber: identifiers.find((i) => i.scheme === "gb_company_number")?.value ?? null };
}

/** New companies added per discovery run (the daily run keeps adding more). */
const COMPANIES_PER_RUN = 15;

/**
 * What to look for, from the workspace's services. Only services aimed at the UK (or at any
 * country) count for the UK sources: their target industries the register can be searched by,
 * and their service categories.
 */
async function icpOf(actor: Actor) {
  const ukServices = (await loadServices(actor.workspaceId)).filter(
    (s) => s.targetCountries.length === 0 || s.targetCountries.includes("GB"),
  );
  return {
    industries: [...new Set(ukServices.flatMap((s) => s.targetIndustries))].filter((slug) => INDUSTRY_SIC_CODES[slug]),
    targetsUk: ukServices.length > 0,
    categories: [...new Set(ukServices.flatMap((s) => s.categories))],
  };
}

const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

// --- discover_companies: new UK companies matching the ICP ------------------------------------

async function discoverCompanies({ actor }: JobContext): Promise<JobResult> {
  const icp = await icpOf(actor);
  if (!icp.targetsUk || icp.industries.length === 0 || !(await sourceRunnable(actor.workspaceId, "companies_house"))) {
    return { followUps: [], skipped: true };
  }
  // Newly formed companies first: being new is itself a signal (a new business needs a website,
  // systems, people). Older companies top the batch up.
  const known = await knownIdentifiers(db, actor.workspaceId);
  const criteria = { industries: icp.industries, locations: [], limit: COMPANIES_PER_RUN, known };
  const found = await companiesHouse.discoverCompanies!({ ...criteria, formedAfter: isoDaysAgo(NEW_COMPANY_DAYS) });
  if (found.length < COMPANIES_PER_RUN) {
    for (const company of found) known.add(company.identifiers[0].value);
    found.push(...(await companiesHouse.discoverCompanies!({ ...criteria, formedAfter: null, limit: COMPANIES_PER_RUN - found.length })));
  }

  const followUps: FollowUp[] = [];
  for (const company of found) {
    const result = await db.transaction(async (tx) => {
      const resolved = await resolveCompany(tx, actor, company);
      const formation = formationSignal({ name: company.name, foundedOn: company.foundedOn, registerUrl: company.record.url }, icp.categories);
      const signal = formation ? await insertDetectedSignal(tx, actor, resolved.companyId, formation, resolved.recordId) : null;
      return { ...resolved, signalCreated: signal?.created ?? false };
    });
    if (result.signalCreated) await rescoreAfterCompanyChange(actor.workspaceId, result.companyId);
    followUps.push({ kind: "enrich_company", entityId: result.companyId });
  }
  return { followUps };
}

// --- enrich_company: directors from the register, and the company's website --------------------

async function enrichCompany({ job, actor }: JobContext): Promise<JobResult> {
  const company = await loadCompany(actor, job.entityId);
  if (!company) return { followUps: [], skipped: true };

  if (company.companyNumber && (await sourceRunnable(actor.workspaceId, "companies_house"))) {
    const officers = await companiesHouse.findPeople!({ identifiers: company.identifiers });
    if (officers) {
      const added = await db.transaction(async (tx) => {
        await saveSourceRecord(tx, actor.workspaceId, officers.record, company.id);
        return addFoundPeople(tx, actor, company.id, officers.people, "companies_house");
      });
      if (added > 0) await rescoreAfterCompanyChange(actor.workspaceId, company.id);
    }
  }

  let domain = company.domain;
  if (!domain && (await sourceRunnable(actor.workspaceId, "company_website"))) {
    const site = await findWebsite({ name: company.name, companyNumber: company.companyNumber, city: company.city });
    if (site) {
      try {
        await db.transaction(async (tx) => {
          await tx.update(companies).set({ domain: site.domain }).where(and(eq(companies.id, company.id), eq(companies.workspaceId, actor.workspaceId)));
          await saveSourceRecord(
            tx,
            actor.workspaceId,
            {
              sourceSlug: "company_website",
              externalId: `website:${site.domain}`,
              url: `https://${site.domain}/`,
              recordType: "website_match",
              publishedAt: null,
              data: { domain: site.domain, confidence: site.confidence, matchedBy: site.confidence >= 95 ? "company_number" : "name" },
            },
            company.id,
          );
        });
        domain = site.domain;
      } catch (error) {
        // Another company in the workspace already has this domain: leave this one without.
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }

  return { followUps: domain ? [{ kind: "scan_website", entityId: company.id }] : [] };
}

// --- scan_website: facts, people, contacts, job board and signals from the company's site -------

async function scanWebsite({ job, actor, ai }: JobContext): Promise<JobResult> {
  const company = await loadCompany(actor, job.entityId);
  if (!company?.domain || !(await sourceRunnable(actor.workspaceId, "company_website"))) return { followUps: [], skipped: true };
  const recheck: FollowUp = { kind: "scan_website", entityId: company.id, runAfter: later(RECHECK.website) };

  const site = await readWebsite(company.domain);
  if (!site) return { followUps: [recheck] };

  const saved = await db.transaction(async (tx) => {
    const records = [];
    for (const page of site.pages) {
      const record = await saveSourceRecord(
        tx,
        actor.workspaceId,
        { sourceSlug: "company_website", externalId: `page:${page.url}`, url: page.url, recordType: `web_page:${page.kind}`, publishedAt: null, contentHash: page.contentHash, data: { kind: page.kind } },
        company.id,
      );
      records.push({ ...page, ...record });
    }
    await addCompanyContacts(tx, company.id, { emails: site.emails, phones: site.phones }, { slug: "company_website", url: site.pages.find((p) => p.kind === "contact")?.url ?? site.pages[0].url });
    return records;
  });
  const followUps: FollowUp[] = [recheck];

  // The job board the site links to (or one found under its name), unless a person set one.
  const [board] = await db.select({ companyId: companyJobBoards.companyId }).from(companyJobBoards).where(eq(companyJobBoards.companyId, company.id)).limit(1);
  if (!board && (await sourceRunnable(actor.workspaceId, "job_board"))) {
    const detected = site.jobBoard ?? (await detectBoard({ name: company.name, domain: company.domain }));
    if (detected && (await connectDetectedBoard(actor, company.id, detected))) followUps.push({ kind: "scan_job_board", entityId: company.id });
  }

  // Who works there, and what the company does: only when those pages changed since last time.
  let peopleAdded = 0;
  const profilePages = saved.filter((p) => ["home", "about", "team", "contact"].includes(p.kind));
  if (profilePages.some((p) => p.changed)) {
    const facts = await ai(() => extractWebsiteFacts({ name: company.name, domain: site.domain }, profilePages));
    peopleAdded = await db.transaction(async (tx) => {
      if (facts.description) {
        await tx
          .update(companies)
          .set({ description: facts.description })
          .where(and(eq(companies.id, company.id), sql`${companies.description} is null`));
      }
      return addFoundPeople(
        tx,
        actor,
        company.id,
        facts.team.map((m) => ({
          name: m.name,
          title: m.title,
          seniority: seniorityFromTitle(m.title),
          jobFunction: jobFunctionFromTitle(m.title),
          relationship: "employee" as const,
          // Named on the company's own site: likely, not confirmed.
          confidence: m.title ? 80 : 60,
        })),
        "company_website",
      );
    });
  }

  // News and careers pages can carry signals (expansion, launch, hiring, a request for help).
  let signalsCreated = 0;
  const ref = await getReferenceData();
  const industry = ref.industries.find((i) => i.slug === company.industry)?.name ?? null;
  for (const page of saved.filter((p) => (p.kind === "news" || p.kind === "careers") && p.changed && p.text.length >= 200)) {
    const analysis = await ai(() =>
      analyzeSignal({ companyId: company.id, text: page.text, sourceUrl: page.url }, { name: company.name, domain: site.domain, industry }, ref),
    );
    const values = signalFromAnalysis(analysis, { url: page.url, occurredOn: analysis.occurredOn ?? new Date().toISOString().slice(0, 10), evidenceText: page.text });
    if (!values) continue;
    const signal = await db.transaction((tx) => insertDetectedSignal(tx, actor, company.id, values, page.id));
    if (signal.created) signalsCreated++;
  }

  if (peopleAdded > 0 || signalsCreated > 0) await rescoreAfterCompanyChange(actor.workspaceId, company.id);
  return { followUps };
}

// --- scan_job_board: the existing job-board sync, run on a schedule ---------------------------

async function scanJobBoard({ job, actor }: JobContext): Promise<JobResult> {
  const company = await loadCompany(actor, job.entityId);
  if (!company || !(await sourceRunnable(actor.workspaceId, "job_board"))) return { followUps: [], skipped: true };
  const result = await syncCompanyJobs(actor, company.id);
  if (result.signalsCreated > 0) await rescoreAfterCompanyChange(actor.workspaceId, company.id);
  // Jobs still waiting for the AI are picked up a few minutes later; otherwise check weekly.
  return { followUps: [{ kind: "scan_job_board", entityId: company.id, runAfter: later(result.pending > 0 ? 3 * 60_000 : RECHECK.jobBoard) }] };
}

// --- scan_tenders: public contracts matching the workspace's services ------------------------

async function scanTenders({ job, actor, ai }: JobContext): Promise<JobResult> {
  if (!(await sourceRunnable(actor.workspaceId, "uk_tenders"))) return { followUps: [], skipped: true };
  const { categories } = await icpOf(actor);
  const cpvCodes = [...new Set(categories.flatMap((c) => CATEGORY_CPV_CODES[c] ?? []))];
  // No services, or none that public bodies buy: nothing to look for.
  if (cpvCodes.length === 0) return { followUps: [], skipped: true };
  const tenders = await searchTenders({ cpvCodes, from: isoDaysAgo(30), size: 40 });

  // Each tender is analysed once: its record remembers it (`data.analysed`).
  const waiting = [];
  for (const tender of tenders) {
    const [seen] = await db
      .select({ data: sourceRecords.data })
      .from(sourceRecords)
      .where(and(eq(sourceRecords.workspaceId, actor.workspaceId), eq(sourceRecords.sourceSlug, "uk_tenders"), eq(sourceRecords.externalId, tender.record.externalId)))
      .limit(1);
    if (!seen?.data?.analysed) waiting.push(tender);
  }

  const ref = await getReferenceData();
  for (const tender of waiting.slice(0, TENDER_ANALYSES_PER_JOB)) {
    const text = tenderSourceText(tender);
    const analysis = await ai(() => analyzeSignal({ companyId: job.entityId, text, sourceUrl: tender.url }, { name: tender.buyer, domain: null, industry: null }, ref));
    const found = signalFromAnalysis(analysis, {
      url: tender.url,
      occurredOn: (tender.publishedAt ?? new Date()).toISOString().slice(0, 10),
      evidenceText: tender.description,
    });
    // Procurement codes are broad: keep a tender only if the AI ties it to something the workspace sells.
    const values = found && found.serviceCategories.some((c) => categories.includes(c)) ? found : null;
    const scoredCompany = await db.transaction(async (tx) => {
      const record = { ...tender.record, data: { ...tender.record.data, analysed: true, relevant: values !== null } };
      if (!values) {
        await saveSourceRecord(tx, actor.workspaceId, record, null);
        return null;
      }
      // Only a buyer with a relevant tender becomes a company in the workspace.
      const resolved = await resolveCompany(tx, actor, {
        name: tender.buyer,
        domain: null,
        industry: "government",
        hq: tender.region ? { city: null, region: tender.region, country: "GB" } : { city: null, region: null, country: "GB" },
        identifiers: [],
        foundedOn: null,
        record,
      });
      const signal = await insertDetectedSignal(tx, actor, resolved.companyId, values, resolved.recordId);
      return signal.created ? resolved.companyId : null;
    });
    // Scored after the commit, so the new signal counts.
    if (scoredCompany) await rescoreAfterCompanyChange(actor.workspaceId, scoredCompany);
  }
  // More waiting than one job may analyse: continue in a few minutes.
  return { followUps: waiting.length > TENDER_ANALYSES_PER_JOB ? [{ kind: "scan_tenders", entityId: actor.workspaceId, runAfter: later(3 * 60_000) }] : [] };
}

export const HANDLERS: Record<IngestionJobKind, (context: JobContext) => Promise<JobResult>> = {
  discover_companies: discoverCompanies,
  enrich_company: enrichCompany,
  scan_website: scanWebsite,
  scan_job_board: scanJobBoard,
  scan_tenders: scanTenders,
};

/** The AI wrapper for a job: counts calls and draws from the workspace's daily AI budget. */
export function jobContext(job: JobRow): JobContext & { aiCalls: () => number } {
  let calls = 0;
  const actor = systemActor(job.workspaceId);
  return {
    job,
    actor,
    ai: async (call) => {
      await rateLimit("aiWorkspace", job.workspaceId);
      calls++;
      return call();
    },
    aiCalls: () => calls,
  };
}
