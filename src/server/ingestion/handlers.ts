import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import {
  companies,
  companyIdentifiers,
  companyJobBoards,
  companyLocations,
  companyPeople,
  contactPoints,
  jobPostings,
  people,
  sourceRecords,
} from "@/db/schema";
import type { JobBoardProvider } from "@/lib/domain/job-boards";
import type { IngestionJobKind } from "@/lib/domain/sources";
import { CATEGORY_CPV_CODES, INDUSTRY_CQC_SERVICE_TYPES, INDUSTRY_SIC_CODES } from "@/lib/domain/uk-codes";
import { TRIAGE_BATCH_SIZE, triageJobs } from "@/server/ai/job-triage";
import { analyzeSignal } from "@/server/ai/signal-analysis";
import { extractWebsiteFacts } from "@/server/ai/website-extract";
import { systemActor, type Actor } from "@/server/auth/actor";
import { rateLimit } from "@/server/http/rate-limit";
import { detectBoard } from "@/server/jobs/detect";
import { JOB_BOARD_ADAPTERS } from "@/server/jobs/providers";
import { rescoreAfterCompanyChange } from "@/server/scoring/rescore";
import { getReferenceData } from "@/server/services/reference-data.service";
import { connectDetectedBoard, syncCompanyJobs } from "@/server/services/job-boards.service";
import { loadServices } from "@/server/services/services.service";
import { insertDetectedSignal } from "@/server/services/signals.service";
import { boardJobsFor, cleanBoardName, jobInCountries } from "@/server/sources/board-directory";
import { companiesHouse, findCompanyNumber } from "@/server/sources/companies-house";
import { findWebsite, readWebsite, usableEmails, websiteFindings } from "@/server/sources/company-website";
import { fetchLocationDetail, loadDirectory, providersFor, providerWebsite, toFoundCompany as toCqcCompany, type CqcLocation } from "@/server/sources/cqc";
import { domainReceivesEmail } from "@/server/sources/http";
import { emailFromPattern, emailPatternOf, inferEmailPattern, jobFunctionFromTitle, seniorityFromTitle, type EmailPattern } from "@/server/sources/names";
import { matchWorkspace, osmImported } from "@/server/sources/osm";
import { searchTenders, tenderSourceText } from "@/server/sources/uk-tenders";
import { formationSignal, NEW_COMPANY_DAYS, newLocationSignal, signalFromAnalysis } from "./found-signal";
import { sourceRunnable, type JobRow } from "./queue";
import { addFoundPeople, knownIdentifiers, replaceCompanyContacts, resolveCompany, saveSourceLocations, saveSourceRecord } from "./resolve";

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
    .select({
      id: companies.id,
      name: companies.canonicalName,
      domain: companies.domain,
      industry: companies.industry,
      identity: companies.identityStatus,
      city: companyLocations.city,
    })
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

// --- discover_cqc: providers of the ICP's health and care services, with each practice --------

/** New CQC providers added per run; the API (when configured) is asked about this many locations each. */
const CQC_PROVIDERS_PER_RUN = 15;
const CQC_API_LOCATIONS_PER_PROVIDER = 3;

async function discoverCqc({ actor }: JobContext): Promise<JobResult> {
  const icp = await icpOf(actor);
  const industries = icp.industries.filter((slug) => INDUSTRY_CQC_SERVICE_TYPES[slug]);
  if (!icp.targetsUk || industries.length === 0 || !(await sourceRunnable(actor.workspaceId, "cqc"))) {
    return { followUps: [], skipped: true };
  }

  const directory = await loadDirectory();
  const known = await knownIdentifiers(db, actor.workspaceId, "gb_cqc_provider");
  await newPracticesOfKnownProviders(actor, directory, industries, icp.categories);
  // Providers that list a website first: they can be read and checked further.
  const providers = providersFor(directory, industries)
    .filter((p) => !known.has(p.providerId))
    .sort((a, b) => Number(b.locations.some((l) => l.website)) - Number(a.locations.some((l) => l.website)))
    .slice(0, CQC_PROVIDERS_PER_RUN);

  const followUps: FollowUp[] = [];
  for (const provider of providers) {
    const postcodes = provider.locations.map((l) => l.postcode).filter((p): p is string => p !== null);
    const companyNumber = await findCompanyNumber(provider.providerName, postcodes);
    const details = await Promise.all(provider.locations.slice(0, CQC_API_LOCATIONS_PER_PROVIDER).map(fetchLocationDetail));

    const result = await db.transaction(async (tx) => {
      const resolved = await resolveCompany(tx, actor, toCqcCompany(provider, industries, companyNumber));
      await saveSourceLocations(
        tx,
        resolved.companyId,
        "cqc",
        provider.locations.map(toSavedLocation),
      );
      await rememberPractices(tx, actor.workspaceId, resolved.companyId, provider.providerId, directory);
      let signalCreated = false;
      for (const [index, detail] of details.entries()) {
        if (!detail) continue;
        await addFoundPeople(tx, actor, resolved.companyId, detail.managers, "cqc");
        const location = provider.locations[index];
        const signal = newLocationSignal({ providerName: provider.providerName, name: location.name, registeredOn: detail.registeredOn, url: location.url }, icp.categories);
        if (signal) signalCreated = (await insertDetectedSignal(tx, actor, resolved.companyId, signal, resolved.recordId)).created || signalCreated;
      }
      return { ...resolved, signalCreated };
    });
    if (result.signalCreated) await rescoreAfterCompanyChange(actor.workspaceId, result.companyId);
    followUps.push({ kind: "enrich_company", entityId: result.companyId });
  }
  return { followUps };
}

/** Practices of one provider seen in the directory, kept so next week's new ones stand out. */
async function rememberPractices(tx: Tx, workspaceId: string, companyId: string, providerId: string, directory: CqcLocation[]) {
  const locationIds = directory.filter((l) => l.providerId === providerId).map((l) => l.locationId);
  await saveSourceRecord(
    tx,
    workspaceId,
    { sourceSlug: "cqc", externalId: `locations:${providerId}`, url: `https://www.cqc.org.uk/provider/${providerId}`, recordType: "cqc_locations", publishedAt: null, data: { locationIds } },
    companyId,
  );
}

/**
 * Providers the workspace already follows that opened a practice since the last directory: the
 * new practice is saved with its phone and recorded as a "new location" signal, dated when it
 * first appeared. Every practice of the provider is remembered (not only the ICP's service types),
 * so widening the ICP later never makes old practices look new. The first run for a provider only
 * remembers its practices.
 */
async function newPracticesOfKnownProviders(actor: Actor, directory: CqcLocation[], industries: string[], categories: string[]): Promise<void> {
  const followed = await db
    .select({ providerId: companyIdentifiers.value, companyId: companyIdentifiers.companyId, data: sourceRecords.data })
    .from(companyIdentifiers)
    .leftJoin(
      sourceRecords,
      and(eq(sourceRecords.workspaceId, actor.workspaceId), eq(sourceRecords.sourceSlug, "cqc"), eq(sourceRecords.externalId, sql`'locations:' || ${companyIdentifiers.value}`)),
    )
    .where(and(eq(companyIdentifiers.workspaceId, actor.workspaceId), eq(companyIdentifiers.scheme, "gb_cqc_provider")));
  if (followed.length === 0) return;

  const ids = new Set(followed.map((f) => f.providerId));
  const ofFollowed = directory.filter((l) => ids.has(l.providerId));
  const wanted = new Map(providersFor(ofFollowed, industries).map((p) => [p.providerId, p]));
  const today = new Date().toISOString().slice(0, 10);
  for (const { providerId, companyId, data } of followed) {
    const before = new Set((data as { locationIds?: string[] } | null)?.locationIds ?? []);
    const isFirstLook = !data;
    const current = ofFollowed.filter((l) => l.providerId === providerId);
    if (!isFirstLook && current.every((l) => before.has(l.locationId))) continue;
    const opened = isFirstLook ? [] : (wanted.get(providerId)?.locations ?? []).filter((l) => !before.has(l.locationId));

    // The API (when configured) gives the real registration date; otherwise it's the day first seen.
    const details = await Promise.all(opened.slice(0, CQC_API_LOCATIONS_PER_PROVIDER).map(fetchLocationDetail));
    const signals = opened.slice(0, CQC_API_LOCATIONS_PER_PROVIDER).flatMap((location, index) => {
      const signal = newLocationSignal(
        { providerName: location.providerName, name: location.name, registeredOn: details[index]?.registeredOn ?? null, firstListedOn: today, url: location.url },
        categories,
      );
      return signal ? [signal] : [];
    });

    const signalCreated = await db.transaction(async (tx) => {
      await rememberPractices(tx, actor.workspaceId, companyId, providerId, current);
      if (opened.length > 0) await saveSourceLocations(tx, companyId, "cqc", opened.map(toSavedLocation));
      let created = false;
      for (const signal of signals) created = (await insertDetectedSignal(tx, actor, companyId, signal)).created || created;
      return created;
    });
    if (signalCreated) await rescoreAfterCompanyChange(actor.workspaceId, companyId);
  }
}

function toSavedLocation(l: CqcLocation) {
  return {
    externalId: l.locationId,
    name: l.name,
    address: l.address,
    city: l.address?.split(",").at(-1)?.trim() ?? null,
    region: l.region,
    postalCode: l.postcode,
    website: l.website,
    phone: l.phone,
  };
}

// --- evaluate_boards: shared job boards judged against this workspace's ICP and services --------

/** Boards judged per run; more wait for the next run a few minutes later. */
const BOARDS_PER_EVALUATION = 10;
const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com)$/i;

/** The site a board's job links point to when it isn't the board itself (Greenhouse lets companies host jobs on their own careers page). */
function candidateWebsite(jobs: { url: string }[]): string | null {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    try {
      const host = new URL(job.url).hostname.toLowerCase().replace(/^www\./, "");
      if (!ATS_HOSTS.test(host)) counts.set(host, (counts.get(host) ?? 0) + 1);
    } catch {
      // Not a URL.
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const titleFromToken = (token: string) => token.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Judges validated public boards for this workspace: only open jobs in its target countries, then a
 * cheap AI title check against its services. A board with relevant jobs becomes a company (matched
 * by evidence, or created as provisional under the board's own name) with the board connected and
 * the verdicts stored; the job-board sync then analyses the relevant jobs into signals. Company
 * matching is never required: a relevant job always lands on a company. Irrelevant boards create
 * nothing; each board's outcome is remembered per workspace, so it is judged again only when its
 * jobs change.
 */
async function evaluateBoards({ actor, ai }: JobContext): Promise<JobResult> {
  if (!(await sourceRunnable(actor.workspaceId, "board_directory"))) return { followUps: [], skipped: true };
  const services = await loadServices(actor.workspaceId);
  if (services.length === 0) return { followUps: [], skipped: true };
  const countries = [...new Set(services.flatMap((s) => s.targetCountries))];
  const ref = await getReferenceData();

  const boards = await db.execute<{ provider: JobBoardProvider; board_token: string; board_name: string | null; stated_website: string | null; last_fetched_at: string }>(sql`
    select d.provider, d.board_token, d.board_name, d.stated_website, d.last_fetched_at
    from job_board_directory d
    where d.validation_status = 'valid' and d.last_fetched_at is not null
      and exists (select 1 from board_jobs j where j.provider = d.provider and j.board_token = d.board_token and j.closed_at is null)
      and not exists (
        select 1 from source_records r
        where r.workspace_id = ${actor.workspaceId} and r.source_slug = 'board_directory'
          and r.external_id = 'board:' || d.provider || ':' || d.board_token
          and (r.data->>'evaluatedAt')::timestamptz >= d.last_fetched_at)
    order by d.last_fetched_at desc
    limit ${BOARDS_PER_EVALUATION + 1}`);

  const followUps: FollowUp[] = [];
  for (const board of boards.slice(0, BOARDS_PER_EVALUATION)) {
    const provider = board.provider;
    const token = board.board_token;
    const externalId = `board:${provider}:${token}`;
    const outcome = (data: Record<string, unknown>) => ({
      sourceSlug: "board_directory" as const,
      externalId,
      url: JOB_BOARD_ADAPTERS[provider].boardUrl(token),
      recordType: "job_board",
      publishedAt: null,
      data: { provider, boardToken: token, evaluatedAt: board.last_fetched_at, ...data },
    });

    // A board this workspace already follows is synced by its company's own job.
    const [connected] = await db
      .select({ companyId: companyJobBoards.companyId })
      .from(companyJobBoards)
      .where(and(eq(companyJobBoards.workspaceId, actor.workspaceId), eq(companyJobBoards.provider, provider), eq(companyJobBoards.boardToken, token)))
      .limit(1);
    if (connected) {
      await db.transaction((tx) => saveSourceRecord(tx, actor.workspaceId, outcome({ relevant: true }), connected.companyId));
      followUps.push({ kind: "scan_job_board", entityId: connected.companyId });
      continue;
    }

    const jobs = (await boardJobsFor(provider, token, Number.MAX_SAFE_INTEGER)).filter((j) => jobInCountries(j.location, countries)).slice(0, TRIAGE_BATCH_SIZE);
    if (jobs.length === 0) {
      await db.transaction((tx) => saveSourceRecord(tx, actor.workspaceId, outcome({ relevant: false, reason: "No open jobs in your target countries" }), null));
      continue;
    }
    const verdicts = await ai(() => triageJobs(jobs, services, ref));
    if (!verdicts.some((v) => v?.relevant)) {
      await db.transaction((tx) => saveSourceRecord(tx, actor.workspaceId, outcome({ relevant: false, reason: "No job matches your services" }), null));
      continue;
    }

    // The board's own name for the company ("TPG Careers Page" → "TPG"); only the board address
    // when the provider gives none.
    const boardName = cleanBoardName(board.board_name);
    const companyId = await db.transaction(async (tx) => {
      const resolved = await resolveCompany(tx, actor, {
        name: boardName ?? titleFromToken(token),
        domain: null,
        industry: null,
        hq: null,
        identifiers: [],
        identity: "provisional",
        foundedOn: null,
        record: outcome({ relevant: true, nameFrom: boardName ? "board" : "board_address", candidateWebsite: board.stated_website ?? candidateWebsite(jobs) }),
      });
      await tx
        .insert(companyJobBoards)
        .values({ companyId: resolved.companyId, workspaceId: actor.workspaceId, provider, boardToken: token, autoDetected: true })
        .onConflictDoNothing();
      // The title check is stored, so the sync analyses the relevant jobs without asking again.
      await tx
        .insert(jobPostings)
        .values(
          jobs.map((job, index) => ({
            workspaceId: actor.workspaceId,
            companyId: resolved.companyId,
            provider,
            externalId: job.externalId,
            title: job.title,
            department: job.department,
            location: job.location,
            url: job.url,
            description: job.description,
            postedAt: job.postedAt,
            boardJobId: job.boardJobId,
            triage: verdicts[index] ? (verdicts[index]!.relevant ? ("relevant" as const) : ("skipped" as const)) : ("pending" as const),
            triageReason: verdicts[index]?.reason ?? null,
          })),
        )
        .onConflictDoNothing();
      return resolved.companyId;
    });
    followUps.push({ kind: "scan_job_board", entityId: companyId }, { kind: "enrich_company", entityId: companyId });
  }
  // More boards waiting: continue shortly.
  if (boards.length > BOARDS_PER_EVALUATION) followUps.push({ kind: "evaluate_boards", entityId: actor.workspaceId, runAfter: later(5 * 60_000) });
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
    // The site most of its practices gave the regulator first, then a job board's own candidate
    // site (only accepted if that site links back to the board), then the official-name search,
    // which needs the company number or the name plus its town.
    let site: WebsiteEvidence | null = await websiteFromRegister(company.id);
    site ??= await candidateFromBoard(actor, company.id);
    if (!site) {
      const found = await findWebsite({ name: company.name, companyNumber: company.companyNumber, city: company.city });
      site = found ? { ...found, matchedBy: found.confidence >= 95 ? "company_number" : "name" } : null;
    }
    if (site && (await confirmWebsite(actor, company, site))) domain = site.domain;
  }

  return { followUps: domain ? [{ kind: "scan_website", entityId: company.id }] : [] };
}

type WebsiteEvidence = { domain: string; confidence: number; matchedBy: "company_number" | "name" | "job_board_link" | "regulator_listing" };

/** The provider's own site, from the websites its CQC locations list (see `providerWebsite`). */
async function websiteFromRegister(companyId: string): Promise<WebsiteEvidence | null> {
  const sites = await db
    .select({ website: companyLocations.website })
    .from(companyLocations)
    .where(and(eq(companyLocations.companyId, companyId), eq(companyLocations.sourceSlug, "cqc")));
  const domain = providerWebsite(sites.map((s) => s.website));
  // Given to the regulator by the provider for its own practices.
  return domain ? { domain, confidence: 90, matchedBy: "regulator_listing" } : null;
}

/**
 * Sets a company's website from evidence and records why. A provisional company becomes partly
 * verified: its website is now confirmed, though no registry number is known. Returns false when
 * another company in the workspace already has that website.
 */
async function confirmWebsite(actor: Actor, company: { id: string; identity: string }, site: WebsiteEvidence): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(companies)
        .set({ domain: site.domain, ...(company.identity === "provisional" ? { identityStatus: "partial" as const } : {}) })
        .where(and(eq(companies.id, company.id), eq(companies.workspaceId, actor.workspaceId)));
      await saveSourceRecord(
        tx,
        actor.workspaceId,
        {
          sourceSlug: "company_website",
          externalId: `website:${site.domain}`,
          url: `https://${site.domain}/`,
          recordType: "website_match",
          publishedAt: null,
          data: { domain: site.domain, confidence: site.confidence, matchedBy: site.matchedBy },
        },
        company.id,
      );
    });
    return true;
  } catch (error) {
    // Another company in the workspace already has this domain: leave this one without.
    if (!isUniqueViolation(error)) throw error;
    return false;
  }
}

/**
 * The website a job board points to (e.g. the careers page its Greenhouse jobs link to), confirmed
 * only when that site in turn links to the same board. Never taken from the job board's own address.
 */
async function candidateFromBoard(actor: Actor, companyId: string): Promise<WebsiteEvidence | null> {
  const [record] = await db
    .select({ data: sourceRecords.data })
    .from(sourceRecords)
    .where(and(eq(sourceRecords.workspaceId, actor.workspaceId), eq(sourceRecords.companyId, companyId), eq(sourceRecords.sourceSlug, "board_directory")))
    .limit(1);
  const data = record?.data as { candidateWebsite?: string; provider?: string; boardToken?: string } | undefined;
  if (!data?.candidateWebsite || !data.provider || !data.boardToken) return null;
  const site = await readWebsite(data.candidateWebsite);
  const links = site?.jobBoard;
  return site && links && links.provider === data.provider && links.boardToken.toLowerCase() === data.boardToken.toLowerCase()
    ? { domain: site.domain, confidence: 90, matchedBy: "job_board_link" }
    : null;
}

// --- scan_website: facts, people, contacts, job board and signals from the company's site -------

async function scanWebsite({ job, actor, ai }: JobContext): Promise<JobResult> {
  const company = await loadCompany(actor, job.entityId);
  if (!company?.domain || !(await sourceRunnable(actor.workspaceId, "company_website"))) return { followUps: [], skipped: true };
  const recheck: FollowUp = { kind: "scan_website", entityId: company.id, runAfter: later(RECHECK.website) };

  const site = await readWebsite(company.domain);
  if (!site) return { followUps: [recheck] };
  // What the site publishes now, from its pages and its structured data. It replaces what an
  // earlier read found, so an address the site dropped (or a placeholder) doesn't linger.
  const structured = site.structured;
  const emails = usableEmails([...site.emails, ...(structured.email ? [structured.email] : [])], site.domain);
  const phones = [...new Set([...site.phones, ...(structured.telephone ? [structured.telephone.replace(/[^\d+]/g, "")] : [])])];

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
    await replaceCompanyContacts(tx, company.id, { emails, phones }, { slug: "company_website", url: site.pages.find((p) => p.kind === "contact")?.url ?? site.pages[0].url });
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

  // What the site states about itself in structured data: no AI needed.
  if (structured.people.length > 0 || structured.employees) {
    peopleAdded += await db.transaction(async (tx) => {
      if (structured.employees) {
        await tx
          .update(companies)
          .set({ employeeCount: structured.employees })
          .where(and(eq(companies.id, company.id), sql`${companies.employeeCount} is null`));
      }
      return addFoundPeople(
        tx,
        actor,
        company.id,
        structured.people.map((p) => ({
          name: p.name,
          title: p.title,
          seniority: seniorityFromTitle(p.title),
          jobFunction: jobFunctionFromTitle(p.title),
          relationship: "employee" as const,
          // Declared by the company in its own structured data.
          confidence: 80,
        })),
        "company_website",
      );
    });
  }

  await attachEmails(actor, company.id, site.domain, emails);

  // Possible website problems, by fixed rules: recorded only for workspaces selling a fix.
  let signalsCreated = 0;
  const sold = new Set((await loadServices(actor.workspaceId)).flatMap((s) => s.categories));
  for (const finding of websiteFindings(company.name, site.checks, company.industry)) {
    const categories = finding.categories.filter((c) => sold.has(c));
    if (categories.length === 0) continue;
    const signal = await db.transaction((tx) =>
      insertDetectedSignal(
        tx,
        actor,
        company.id,
        {
          signalType: finding.signalType,
          // A possible problem, not a stated wish to buy.
          intentLevel: "low",
          urgency: "unknown",
          serviceCategories: categories,
          summary: finding.summary,
          personId: null,
          occurredOn: new Date().toISOString().slice(0, 10),
          sourceUrl: finding.url,
          excerpt: finding.excerpt,
          evidenceLabel: finding.evidenceLabel,
          source: "provider",
          confidence: finding.confidence,
        },
        // Linked to the page the finding is about, or the first page read.
        (saved.find((p) => p.url === finding.url) ?? saved[0])?.id ?? null,
      ),
    );
    if (signal.created) signalsCreated++;
  }

  // News and careers pages can carry signals (expansion, launch, hiring, a request for help).
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

/** Contact sources: published on the company's site, or inferred from its address pattern (never verified). */
export const PUBLISHED_EMAIL = "company_website";
export const INFERRED_EMAIL = "pattern_inferred";

/**
 * Gives the company's people their email addresses, keeping how each was obtained separate:
 * - **published**: an address on the company's own site that is clearly that person's;
 * - **inferred**: built from the company's address pattern, only when at least two people's
 *   published addresses agree on it and the domain receives email (MX). An MX record shows the
 *   domain takes mail, not that the mailbox exists, so inferred addresses stay unverified.
 * Nobody's existing address is replaced.
 */
async function attachEmails(actor: Actor, companyId: string, domain: string, published: string[]): Promise<void> {
  const team = await db
    .select({ personId: companyPeople.personId, name: people.name })
    .from(companyPeople)
    .innerJoin(people, eq(people.id, companyPeople.personId))
    .where(and(eq(companyPeople.companyId, companyId), eq(companyPeople.workspaceId, actor.workspaceId)));
  if (team.length === 0) return;
  const withEmail = new Set(
    (await db.select({ personId: contactPoints.personId }).from(contactPoints).where(and(inArray(contactPoints.personId, team.map((t) => t.personId)), eq(contactPoints.type, "email")))).map((r) => r.personId),
  );

  const own = published.filter((email) => email.endsWith(`@${domain}`));
  const examples: { pattern: EmailPattern; name: string }[] = [];
  const rows: (typeof contactPoints.$inferInsert)[] = [];
  for (const member of team) {
    const email = own.find((address) => emailPatternOf(address, member.name));
    if (!email) continue;
    examples.push({ pattern: emailPatternOf(email, member.name)!, name: member.name });
    if (!withEmail.has(member.personId)) {
      rows.push({ personId: member.personId, type: "email", value: email, isPrimary: true, verification: "unknown", source: PUBLISHED_EMAIL });
      withEmail.add(member.personId);
    }
  }

  const pattern = inferEmailPattern(examples);
  if (pattern && (await domainReceivesEmail(domain))) {
    for (const member of team) {
      if (withEmail.has(member.personId)) continue;
      const email = emailFromPattern(pattern, member.name, domain);
      if (email) rows.push({ personId: member.personId, type: "email", value: email, isPrimary: true, verification: "unknown", source: INFERRED_EMAIL });
    }
  }
  if (rows.length > 0) await db.insert(contactPoints).values(rows).onConflictDoNothing();
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

// --- match_osm: link companies and practices to the business they are on OpenStreetMap ---------

async function matchOsm({ actor }: JobContext): Promise<JobResult> {
  // Nothing to match against until the weekly import has run (`npm run osm:import`).
  if (!(await sourceRunnable(actor.workspaceId, "openstreetmap")) || !(await osmImported())) return { followUps: [], skipped: true };
  await matchWorkspace(actor.workspaceId);
  return { followUps: [] };
}

export const HANDLERS: Record<IngestionJobKind, (context: JobContext) => Promise<JobResult>> = {
  discover_companies: discoverCompanies,
  discover_cqc: discoverCqc,
  evaluate_boards: evaluateBoards,
  enrich_company: enrichCompany,
  scan_website: scanWebsite,
  scan_job_board: scanJobBoard,
  scan_tenders: scanTenders,
  match_osm: matchOsm,
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
