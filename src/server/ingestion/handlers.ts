import "server-only";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import {
  boardJobs,
  companies,
  companyIdentifiers,
  companyJobBoards,
  companyLocations,
  companyPeople,
  contactPoints,
  jobPostings,
  opportunities,
  people,
  signals,
  sourceRecords,
  siteReads,
  theirstackJobs,
} from "@/db/schema";
import type { Service, SignalAnalysis } from "@/lib/api/types";
import type { IngestionJobKind } from "@/lib/domain/sources";
import { CATEGORY_CPV_CODES, INDUSTRY_CQC_SERVICE_TYPES, INDUSTRY_SIC_CODES } from "@/lib/domain/uk-codes";
import { analyzeSignal } from "@/server/ai/signal-analysis";
import { extractWebsiteFacts, type WebsiteFacts } from "@/server/ai/website-extract";
import { systemActor, type Actor } from "@/server/auth/actor";
import { AppError } from "@/server/http/errors";
import { rateLimit, refundRateLimit } from "@/server/http/rate-limit";
import { detectBoard } from "@/server/jobs/detect";
import { rescoreAfterCompanyChange } from "@/server/scoring/rescore";
import { getReferenceData } from "@/server/services/reference-data.service";
import { connectDetectedBoard, jobText, syncCompanyJobs } from "@/server/services/job-boards.service";
import { loadServices } from "@/server/services/services.service";
import { insertDetectedSignal } from "@/server/services/signals.service";
import { hiringEmails, jobInCountries, siteOf, sitesInJobPosts } from "@/server/sources/board-directory";
import { categorizeJob, refineCategories } from "@/server/jobs/job-categories";
import { companiesHouse, findCompanyNumber } from "@/server/sources/companies-house";
import { findWebsite, readWebsite, usableEmails, websiteFindings, type SiteRead } from "@/server/sources/company-website";
import {
  fetchLocationDetail,
  loadDirectory,
  providersFor,
  providerWebsite,
  toFoundCompany as toCqcCompany,
  type CqcLocation,
} from "@/server/sources/cqc";
import { domainReceivesEmail, hostResolves } from "@/server/sources/http";
import { importYcCompanies, pickYcCompanies, toYcCompany, ycImportedAt, YC_REFRESH_MS } from "@/server/sources/yc";
import {
  emailFromPattern,
  emailPatternOf,
  inferEmailPattern,
  jobFunctionFromTitle,
  seniorityFromTitle,
  type EmailPattern,
} from "@/server/sources/names";
import {
  fitsIndustry,
  INDUSTRY_NPI_TAXONOMIES,
  MAX_SKIP,
  NPI_PAGE_SIZE,
  searchOrganizations,
  toFoundCompany as toNpiCompany,
  toLocation as toNpiLocation,
  toPeople as toNpiPeople,
  US_STATES,
  type NpiOrganization,
} from "@/server/sources/nppes";
import { matchWorkspace, osmImported } from "@/server/sources/osm";
import { creditsLeft, employeeRange, searchJobs, theirStackJobsPerRun, theirStackJobText, titlesFor, type TheirStackJob } from "@/server/sources/theirstack";
import { fetchTenderContact, searchTenders, tenderSourceText, type TenderContact } from "@/server/sources/uk-tenders";
import { normalizeDomain } from "@/lib/validation/companies";
import { formationSignal, NEW_COMPANY_DAYS, newLocationSignal, signalFromAnalysis } from "./found-signal";
import { sourceRunnable, type JobRow } from "./queue";
import { matchWorkspaceJobs } from "./shared-jobs";
import { addFoundPeople, knownIdentifiers, replaceCompanyContacts, resolveCompany, saveSourceLocations, saveSourceRecord } from "./resolve";

/**
 * One handler per kind of background job (Spec §11). Each does a small piece of work, records
 * provenance and returns the follow-up jobs to queue. What to look for comes from the workspace's
 * Services & ICP, so nothing has to be set up first.
 */

export type FollowUp = {
  kind: IngestionJobKind;
  entityId: string;
  runAfter?: Date;
};
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
      sourceSlug: companies.sourceSlug,
      city: companyLocations.city,
      postcode: companyLocations.postalCode,
      country: companyLocations.country,
    })
    .from(companies)
    .leftJoin(companyLocations, and(eq(companyLocations.companyId, companies.id), eq(companyLocations.type, "headquarters")))
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, actor.workspaceId)))
    .limit(1);
  if (!row) return null;
  const identifiers = await db
    .select({
      scheme: companyIdentifiers.scheme,
      value: companyIdentifiers.value,
    })
    .from(companyIdentifiers)
    .where(eq(companyIdentifiers.companyId, companyId));
  return {
    ...row,
    identifiers,
    companyNumber: identifiers.find((i) => i.scheme === "gb_company_number")?.value ?? null,
  };
}

/** New companies added per discovery run (the daily run keeps adding more). */
const COMPANIES_PER_RUN = 15;

/**
 * What to look for, from the workspace's services. Only services aimed at the UK (or at any
 * country) count for the UK sources: their target industries the register can be searched by,
 * and their service categories.
 */
async function icpOf(actor: Actor) {
  const ukServices = (await loadServices(actor.workspaceId)).filter((s) => s.targetCountries.length === 0 || s.targetCountries.includes("GB"));
  return {
    industries: [...new Set(ukServices.flatMap((s) => s.targetIndustries))].filter((slug) => INDUSTRY_SIC_CODES[slug]),
    targetsUk: ukServices.length > 0,
    categories: [...new Set(ukServices.flatMap((s) => s.categories))],
  };
}

/** The same for the US sources: services aimed at the US (or at any country). */
async function usIcpOf(actor: Actor) {
  const usServices = (await loadServices(actor.workspaceId)).filter((s) => s.targetCountries.length === 0 || s.targetCountries.includes("US"));
  return {
    industries: [...new Set(usServices.flatMap((s) => s.targetIndustries))],
    categories: [...new Set(usServices.flatMap((s) => s.categories))],
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
  const criteria = {
    industries: icp.industries,
    locations: [],
    limit: COMPANIES_PER_RUN,
    known,
  };
  const found = await companiesHouse.discoverCompanies!({
    ...criteria,
    formedAfter: isoDaysAgo(NEW_COMPANY_DAYS),
  });
  if (found.length < COMPANIES_PER_RUN) {
    for (const company of found) known.add(company.identifiers[0].value);
    found.push(
      ...(await companiesHouse.discoverCompanies!({
        ...criteria,
        formedAfter: null,
        limit: COMPANIES_PER_RUN - found.length,
      })),
    );
  }

  const followUps: FollowUp[] = [];
  for (const company of found) {
    const result = await db.transaction(async (tx) => {
      const resolved = await resolveCompany(tx, actor, company);
      const formation = formationSignal(
        {
          name: company.name,
          foundedOn: company.foundedOn,
          registerUrl: company.record.url,
          industry: company.industry,
        },
        icp.categories,
      );
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
      await saveSourceLocations(tx, resolved.companyId, "cqc", provider.locations.map(toSavedLocation));
      await rememberPractices(tx, actor.workspaceId, resolved.companyId, provider.providerId, directory);
      let signalCreated = false;
      for (const [index, detail] of details.entries()) {
        if (!detail) continue;
        await addFoundPeople(tx, actor, resolved.companyId, detail.managers, "cqc");
        const location = provider.locations[index];
        const signal = newLocationSignal(
          {
            providerName: provider.providerName,
            name: location.name,
            registeredOn: detail.registeredOn,
            url: location.url,
          },
          icp.categories,
        );
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
    {
      sourceSlug: "cqc",
      externalId: `locations:${providerId}`,
      url: `https://www.cqc.org.uk/provider/${providerId}`,
      recordType: "cqc_locations",
      publishedAt: null,
      data: { locationIds },
    },
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
    .select({
      providerId: companyIdentifiers.value,
      companyId: companyIdentifiers.companyId,
      data: sourceRecords.data,
    })
    .from(companyIdentifiers)
    .leftJoin(
      sourceRecords,
      and(
        eq(sourceRecords.workspaceId, actor.workspaceId),
        eq(sourceRecords.sourceSlug, "cqc"),
        eq(sourceRecords.externalId, sql`'locations:' || ${companyIdentifiers.value}`),
      ),
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
        {
          providerName: location.providerName,
          name: location.name,
          registeredOn: details[index]?.registeredOn ?? null,
          firstListedOn: today,
          url: location.url,
        },
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

// --- discover_npi: US healthcare organizations from the NPI Registry ----------------------------

/** Registry pages read per run (the registry limits queries per hour). */
const NPI_PAGES_PER_RUN = 3;

/**
 * Every (search, state, page) the ICP's industries call for, in the order runs read them: page 1
 * of every state first, then page 2, so each run brings variety. Pure.
 */
export function npiSteps(industries: string[]): { industry: string; taxonomy: string; state: string; skip: number }[] {
  const searches = industries.flatMap((industry) =>
    (INDUSTRY_NPI_TAXONOMIES[industry]?.searches ?? []).map((taxonomy) => ({
      industry,
      taxonomy,
    })),
  );
  const steps = [];
  for (let skip = 0; skip <= MAX_SKIP; skip += NPI_PAGE_SIZE) {
    for (const state of US_STATES) for (const search of searches) steps.push({ ...search, state, skip });
  }
  return steps;
}

async function discoverNpi({ actor }: JobContext): Promise<JobResult> {
  const icp = await usIcpOf(actor);
  const steps = npiSteps(icp.industries);
  if (steps.length === 0 || !(await sourceRunnable(actor.workspaceId, "us_npi"))) return { followUps: [], skipped: true };

  // Where the last run stopped, per workspace.
  const cursorId = "cursor:npi";
  const [cursor] = await db
    .select({ data: sourceRecords.data })
    .from(sourceRecords)
    .where(and(eq(sourceRecords.workspaceId, actor.workspaceId), eq(sourceRecords.sourceSlug, "us_npi"), eq(sourceRecords.externalId, cursorId)))
    .limit(1);
  let step = Number((cursor?.data as { step?: number } | undefined)?.step ?? 0) % steps.length;

  const known = await knownIdentifiers(db, actor.workspaceId, "us_npi");
  const picked: { org: NpiOrganization; industry: string }[] = [];
  for (let page = 0; page < NPI_PAGES_PER_RUN && picked.length < COMPANIES_PER_RUN; page++) {
    const { industry, taxonomy, state, skip } = steps[step];
    step = (step + 1) % steps.length;
    const orgs = await searchOrganizations({ taxonomy, state, skip });
    // Newest practices first: being new is itself a signal.
    const fresh = orgs
      .filter((org) => !known.has(org.number) && fitsIndustry(org, industry))
      .sort((a, b) => (b.basic.enumeration_date ?? "").localeCompare(a.basic.enumeration_date ?? ""));
    for (const org of fresh.slice(0, COMPANIES_PER_RUN - picked.length)) {
      known.add(org.number);
      picked.push({ org, industry });
    }
  }

  const followUps: FollowUp[] = [];
  for (const { org, industry } of picked) {
    const found = toNpiCompany(org, industry);
    const result = await db.transaction(async (tx) => {
      const resolved = await resolveCompany(tx, actor, found);
      const location = toNpiLocation(org);
      if (location) await saveSourceLocations(tx, resolved.companyId, "us_npi", [location], "US");
      await addFoundPeople(tx, actor, resolved.companyId, toNpiPeople(org), "us_npi");
      const formation = formationSignal(
        {
          name: found.name,
          foundedOn: found.foundedOn,
          registerUrl: found.record.url,
          register: "with the US NPI Registry (CMS)",
          industry,
        },
        icp.categories,
      );
      const signal = formation ? await insertDetectedSignal(tx, actor, resolved.companyId, formation, resolved.recordId) : null;
      return { ...resolved, signalCreated: signal?.created ?? false };
    });
    if (result.signalCreated) await rescoreAfterCompanyChange(actor.workspaceId, result.companyId);
    followUps.push({ kind: "enrich_company", entityId: result.companyId });
  }

  await db.transaction((tx) =>
    saveSourceRecord(
      tx,
      actor.workspaceId,
      {
        sourceSlug: "us_npi",
        externalId: cursorId,
        url: null,
        recordType: "discovery_cursor",
        publishedAt: null,
        data: { step },
      },
      null,
    ),
  );
  return { followUps };
}

// --- discover_yc: Y Combinator startups in the ICP's countries and industries --------------------

/** Countries a service with no target country is taken to mean, for YC companies. */
const YC_ANY_COUNTRY = ["US", "GB"];

async function discoverYc({ actor }: JobContext): Promise<JobResult> {
  if (!(await sourceRunnable(actor.workspaceId, "yc_directory"))) return { followUps: [], skipped: true };
  const services = await loadServices(actor.workspaceId);
  if (services.length === 0) return { followUps: [], skipped: true };
  const countries = [...new Set(services.flatMap((s) => (s.targetCountries.length > 0 ? s.targetCountries : YC_ANY_COUNTRY)))];
  // A service with no target industry takes any industry.
  const industries = services.some((s) => s.targetIndustries.length === 0) ? [] : [...new Set(services.flatMap((s) => s.targetIndustries))];

  // The whole dataset is shared by every workspace: whichever run finds it a week old refreshes it.
  const importedAt = await ycImportedAt();
  if (!importedAt || Date.now() - importedAt.getTime() > YC_REFRESH_MS) await importYcCompanies();

  const known = await knownIdentifiers(db, actor.workspaceId, "yc_company");
  const picked = await pickYcCompanies({ countries, industries, exclude: [...known], limit: COMPANIES_PER_RUN });

  const followUps: FollowUp[] = [];
  for (const row of picked) {
    const { companyId } = await db.transaction((tx) => resolveCompany(tx, actor, toYcCompany(row)));
    // The website is the company's own listing: read it (and its job board) straight away.
    followUps.push({ kind: row.domain ? "scan_website" : "enrich_company", entityId: companyId });
  }
  return { followUps };
}

// --- evaluate_boards: the shared jobs matched to this workspace's services, no AI ---------------

/**
 * Matches the shared, already categorised jobs to the workspace's services and countries
 * (`matchWorkspaceJobs`): each matching company is created or found, its jobs and signals recorded
 * at once, and scored. New companies' websites are looked up next. More matches continue a minute
 * later, so a new workspace fills up in a few minutes without waiting for the AI.
 */
async function evaluateBoards({ actor }: JobContext): Promise<JobResult> {
  if (!(await sourceRunnable(actor.workspaceId, "board_directory"))) return { followUps: [], skipped: true };
  // Each company is scored as soon as it is matched (inside), so a run cut short keeps its work.
  const result = await matchWorkspaceJobs(actor);
  const followUps: FollowUp[] = result.newCompanies.flatMap((entityId) => [
    { kind: "enrich_company" as const, entityId },
    // The board's other jobs, sorted against the services the same way (no AI), a little later.
    { kind: "scan_job_board" as const, entityId, runAfter: later(10 * 60_000) },
  ]);
  if (result.more) followUps.push({ kind: "evaluate_boards", entityId: actor.workspaceId, runAfter: later(60_000) });
  return { followUps };
}

// --- enrich_company: directors from the register, and the company's website --------------------

async function enrichCompany({ job, actor }: JobContext): Promise<JobResult> {
  const company = await loadCompany(actor, job.entityId);
  if (!company) return { followUps: [], skipped: true };

  if (company.companyNumber && (await sourceRunnable(actor.workspaceId, "companies_house"))) {
    const officers = await companiesHouse.findPeople!({
      identifiers: company.identifiers,
    });
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
    site ??= await candidateFromBoard(actor, company);
    if (!site) {
      const found = await findWebsite({
        name: company.name,
        companyNumber: company.companyNumber,
        city: company.city,
        postcode: company.postcode,
        suggested: await suggestedWebsites(actor, company.id),
      });
      site = found
        ? {
            ...found,
            matchedBy: found.confidence >= 95 ? "company_number" : found.confidence >= 85 ? "registered_address" : "name",
          }
        : null;
    }
    if (site && (await confirmWebsite(actor, company, site))) domain = site.domain;
  }

  return {
    followUps: domain ? [{ kind: "scan_website", entityId: company.id }] : [],
  };
}

type WebsiteEvidence = {
  domain: string;
  confidence: number;
  matchedBy: "company_number" | "registered_address" | "name" | "job_board_link" | "job_post_links" | "name_links_board" | "regulator_listing";
};

/**
 * Websites other sources suggest for the company, e.g. an Overture Maps place at its postcode with
 * the same name (`scripts/overture.ts`). Only suggestions: `findWebsite` still needs evidence on the site.
 */
async function suggestedWebsites(actor: Actor, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ data: sourceRecords.data })
    .from(sourceRecords)
    .where(and(eq(sourceRecords.workspaceId, actor.workspaceId), eq(sourceRecords.companyId, companyId), eq(sourceRecords.sourceSlug, "overture")));
  return rows.flatMap((r) => {
    const site = (r.data as { candidateWebsite?: unknown }).candidateWebsite;
    return typeof site === "string" && site ? [site] : [];
  });
}

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
        .set({
          domain: site.domain,
          ...(company.identity === "provisional" ? { identityStatus: "partial" as const } : {}),
        })
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
          data: {
            domain: site.domain,
            confidence: site.confidence,
            matchedBy: site.matchedBy,
          },
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
async function candidateFromBoard(actor: Actor, company: { id: string; name: string }): Promise<WebsiteEvidence | null> {
  const [[record], posts, boards] = await Promise.all([
    db
      .select({ data: sourceRecords.data })
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.workspaceId, actor.workspaceId),
          eq(sourceRecords.companyId, company.id),
          eq(sourceRecords.sourceSlug, "board_directory"),
        ),
      )
      .limit(1),
    db
      .select({ description: jobText })
      .from(jobPostings)
      .leftJoin(boardJobs, eq(boardJobs.id, jobPostings.boardJobId))
      .where(eq(jobPostings.companyId, company.id))
      .limit(50),
    db
      .select({
        provider: companyJobBoards.provider,
        boardToken: companyJobBoards.boardToken,
      })
      .from(companyJobBoards)
      .where(eq(companyJobBoards.companyId, company.id)),
  ]);
  const data = record?.data as { candidateWebsite?: string } | undefined;
  const linksBack = (site: Awaited<ReturnType<typeof readWebsite>>) =>
    Boolean(
      site?.jobBoard &&
      boards.some((b) => b.provider === site.jobBoard!.provider && b.boardToken.toLowerCase() === site.jobBoard!.boardToken.toLowerCase()),
    );

  // Where the board's jobs link to (a careers page on the company's own site).
  if (data?.candidateWebsite) {
    const site = await readWebsite(data.candidateWebsite);
    if (site && linksBack(site))
      return {
        domain: site.domain,
        confidence: 90,
        matchedBy: "job_board_link",
      };
  }
  // The site its own job posts link to or give addresses at (careers.toasttab.com → toasttab.com).
  // Confirmed when the site links back to the board, or when it carries the company's name and
  // its posts keep pointing to it.
  const nameWords = company.name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
  const enoughPosts = Math.min(2, posts.filter((p) => p.description).length);
  for (const { site: candidate, posts: mentions } of sitesInJobPosts(posts.map((p) => p.description)).slice(0, 2)) {
    const site = await readWebsite(candidate);
    if (!site) continue;
    if (linksBack(site))
      return {
        domain: site.domain,
        confidence: 90,
        matchedBy: "job_board_link",
      };
    const label = candidate.split(".")[0];
    // The company's own domain, even when its home page lives on a subdomain (pos.toasttab.com).
    if (mentions >= enoughPosts && nameWords.some((w) => label.includes(w)))
      return { domain: candidate, confidence: 80, matchedBy: "job_post_links" };
  }
  // The obvious domains for its name or board (Tripadvisor → tripadvisor.com), accepted only when
  // that site links to this same board: a name alone never decides it.
  const guesses = boardDomainGuesses(company.name, boards.map((b) => b.boardToken));
  const resolving = guesses.slice(0, 12);
  const exists = await Promise.all(resolving.map(hostResolves));
  for (const candidate of resolving.filter((_, i) => exists[i]).slice(0, MAX_BOARD_GUESSES)) {
    const site = await readWebsite(candidate);
    if (site && linksBack(site)) return { domain: site.domain, confidence: 85, matchedBy: "name_links_board" };
  }
  return null;
}

/** Guessed sites read per company before giving up (each is a full site read). */
const MAX_BOARD_GUESSES = 2;

/**
 * The domains a company is most likely to use, from its name and its board's name: "Trade
 * Republic" with board "traderepublicbank" → traderepublic.com, traderepublicbank.com, … Pure.
 */
export function boardDomainGuesses(name: string, boardTokens: string[]): string[] {
  const words = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !GENERIC_NAME_WORDS.has(w));
  const stems = [words.join(""), words.join("-"), ...boardTokens.map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, ""))].filter(
    (s) => s.length >= 3 && s.length <= 40,
  );
  return [...new Set(stems.flatMap((s) => [`${s}.com`, `${s}.io`, `${s}.ai`, `${s}.co.uk`, `${s}.co`]))];
}

const GENERIC_NAME_WORDS = new Set([
  "the",
  "inc",
  "ltd",
  "llc",
  "limited",
  "group",
  "company",
  "corp",
  "corporation",
  "careers",
  "jobs",
  "and",
  "plc",
  "gmbh",
  "holdings",
]);

// --- scan_website: facts, people, contacts, job board and signals from the company's site -------

/** A site read for any workspace is reused by the others for this long. */
const SITE_FRESH_MS = 7 * DAY;

/**
 * The company's website, read once for every workspace (`site_reads`): the shared copy while it is
 * fresh, else a new read that replaces it. Each workspace still saves its own pages, contacts and people.
 */
async function sharedSiteRead(domain: string): Promise<SiteRead | null> {
  const [cached] = await db.select({ read: siteReads.read, readAt: siteReads.readAt }).from(siteReads).where(eq(siteReads.domain, domain));
  if (cached && Date.now() - cached.readAt.getTime() < SITE_FRESH_MS) return cached.read as unknown as SiteRead;
  const site = await readWebsite(domain);
  if (site) {
    const read = site as unknown as Record<string, unknown>;
    await db
      .insert(siteReads)
      .values({ domain, read })
      .onConflictDoUpdate({ target: siteReads.domain, set: { read, readAt: sql`now()` } });
  }
  return site;
}

/**
 * The AI's reading of the site's profile pages (description, team), made once per version of those
 * pages for every workspace: reused while their content is unchanged, else asked again and stored.
 */
async function sharedSiteFacts(domain: string, pages: { contentHash: string | null }[], ask: () => Promise<WebsiteFacts>): Promise<WebsiteFacts> {
  const from = pages
    .map((p) => p.contentHash ?? "")
    .sort()
    .join(",");
  const [cached] = await db.select({ facts: siteReads.facts, factsFrom: siteReads.factsFrom }).from(siteReads).where(eq(siteReads.domain, domain));
  if (cached?.facts && cached.factsFrom === from) return cached.facts as unknown as WebsiteFacts;
  const facts = await ask();
  await db
    .update(siteReads)
    .set({ facts: facts as unknown as Record<string, unknown>, factsFrom: from, factsAt: sql`now()` })
    .where(eq(siteReads.domain, domain));
  return facts;
}

/**
 * Sources that only find technology companies (startups hiring engineers): a healthcare one there
 * sells software to clinics, it is not a clinic patients book.
 */
const SOFTWARE_SOURCES = new Set(["yc_directory", "board_directory", "theirstack"]);

async function scanWebsite({ job, actor, ai }: JobContext): Promise<JobResult> {
  const company = await loadCompany(actor, job.entityId);
  if (!company?.domain || !(await sourceRunnable(actor.workspaceId, "company_website"))) return { followUps: [], skipped: true };
  const recheck: FollowUp = {
    kind: "scan_website",
    entityId: company.id,
    runAfter: later(RECHECK.website),
  };

  const site = await sharedSiteRead(company.domain);
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
        {
          sourceSlug: "company_website",
          externalId: `page:${page.url}`,
          url: page.url,
          recordType: `web_page:${page.kind}`,
          publishedAt: null,
          contentHash: page.contentHash,
          data: { kind: page.kind },
        },
        company.id,
      );
      records.push({ ...page, ...record });
    }
    await replaceCompanyContacts(
      tx,
      company.id,
      { emails, phones },
      {
        slug: "company_website",
        url: site.pages.find((p) => p.kind === "contact")?.url ?? site.pages[0].url,
      },
    );
    return records;
  });
  const followUps: FollowUp[] = [recheck];

  // The job board the site links to (or one found under its name), unless a person set one.
  const [board] = await db
    .select({ companyId: companyJobBoards.companyId })
    .from(companyJobBoards)
    .where(eq(companyJobBoards.companyId, company.id))
    .limit(1);
  if (!board && (await sourceRunnable(actor.workspaceId, "job_board"))) {
    const detected = site.jobBoard ?? (await detectBoard({ name: company.name, domain: company.domain }));
    if (detected && (await connectDetectedBoard(actor, company.id, detected))) followUps.push({ kind: "scan_job_board", entityId: company.id });
  }

  // Who works there, and what the company does: only when those pages changed since last time.
  let peopleAdded = 0;
  const profilePages = saved.filter((p) => ["home", "about", "team", "contact"].includes(p.kind));
  if (profilePages.some((p) => p.changed)) {
    const facts = await sharedSiteFacts(company.domain, profilePages, () => ai(() => extractWebsiteFacts({ name: company.name, domain: site.domain }, profilePages)));
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

  await attachEmails(actor, company.id, site.domain, emails, company.country);

  // Possible website problems, by fixed rules: recorded only for workspaces selling a fix.
  let signalsCreated = 0;
  const sold = new Set((await loadServices(actor.workspaceId)).flatMap((s) => s.categories));
  const findings = websiteFindings(company.name, site.checks, company.industry, { software: SOFTWARE_SOURCES.has(company.sourceSlug ?? "") });
  // A finding this read no longer makes (e.g. booking now found) is withdrawn: an automatic
  // check's claim must stay true. Only the check's own signals go; nothing a person entered.
  const gone = (["outdated_website", "insecure_website", "no_online_booking"] as const).filter((t) => !findings.some((f) => f.signalType === t));
  const withdrawn =
    gone.length === 0
      ? []
      : await db
          .delete(signals)
          .where(
            and(
              eq(signals.companyId, company.id),
              eq(signals.workspaceId, actor.workspaceId),
              eq(signals.source, "provider"),
              inArray(signals.signalType, [...gone]),
            ),
          )
          .returning({ id: signals.id });
  if (withdrawn.length > 0) signalsCreated++;
  for (const finding of findings) {
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
    const values = signalFromAnalysis(analysis, {
      url: page.url,
      occurredOn: analysis.occurredOn ?? new Date().toISOString().slice(0, 10),
      evidenceText: page.text,
    });
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
 * Where a person's work email may be inferred from the company's pattern. Elsewhere (the EU, or a
 * company whose country we don't know) only published addresses are kept: EU regulators treat a
 * guessed named address as personal data needing a lawful basis, and Germany needs prior consent
 * for any marketing email. The UK needs a documented legitimate-interest assessment.
 */
export const INFERRED_EMAIL_COUNTRIES = new Set(["GB", "US"]);

/**
 * Gives the company's people their email addresses, keeping how each was obtained separate:
 * - **published**: an address on the company's own site that is clearly that person's;
 * - **inferred**: built from the company's address pattern, only when at least two people's
 *   published addresses agree on it and the domain receives email (MX). An MX record shows the
 *   domain takes mail, not that the mailbox exists, so inferred addresses stay unverified.
 * Nobody's existing address is replaced.
 */
async function attachEmails(actor: Actor, companyId: string, domain: string, published: string[], country: string | null): Promise<void> {
  const team = await db
    .select({ personId: companyPeople.personId, name: people.name })
    .from(companyPeople)
    .innerJoin(people, eq(people.id, companyPeople.personId))
    .where(and(eq(companyPeople.companyId, companyId), eq(companyPeople.workspaceId, actor.workspaceId)));
  if (team.length === 0) return;
  const withEmail = new Set(
    (
      await db
        .select({ personId: contactPoints.personId })
        .from(contactPoints)
        .where(
          and(
            inArray(
              contactPoints.personId,
              team.map((t) => t.personId),
            ),
            eq(contactPoints.type, "email"),
          ),
        )
    ).map((r) => r.personId),
  );

  const own = published.filter((email) => email.endsWith(`@${domain}`));
  const examples: { pattern: EmailPattern; name: string }[] = [];
  const rows: (typeof contactPoints.$inferInsert)[] = [];
  for (const member of team) {
    const email = own.find((address) => emailPatternOf(address, member.name));
    if (!email) continue;
    examples.push({
      pattern: emailPatternOf(email, member.name)!,
      name: member.name,
    });
    if (!withEmail.has(member.personId)) {
      rows.push({
        personId: member.personId,
        type: "email",
        value: email,
        isPrimary: true,
        verification: "unknown",
        source: PUBLISHED_EMAIL,
      });
      withEmail.add(member.personId);
    }
  }

  const pattern = inferEmailPattern(examples);
  if (pattern && country && INFERRED_EMAIL_COUNTRIES.has(country) && (await domainReceivesEmail(domain))) {
    for (const member of team) {
      if (withEmail.has(member.personId)) continue;
      const email = emailFromPattern(pattern, member.name, domain);
      if (email)
        rows.push({
          personId: member.personId,
          type: "email",
          value: email,
          isPrimary: true,
          verification: "unknown",
          source: INFERRED_EMAIL,
        });
    }
  }
  if (rows.length > 0) await db.insert(contactPoints).values(rows).onConflictDoNothing();
}

// --- scan_job_board: the existing job-board sync, run on a schedule ---------------------------

async function scanJobBoard({ job, actor }: JobContext): Promise<JobResult> {
  const company = await loadCompany(actor, job.entityId);
  if (!company || !(await sourceRunnable(actor.workspaceId, "job_board"))) return { followUps: [], skipped: true };
  // A workspace with no services has nothing to judge jobs against: skip quietly, check next week.
  if ((await loadServices(actor.workspaceId)).length === 0) {
    return { followUps: [{ kind: "scan_job_board", entityId: company.id, runAfter: later(RECHECK.jobBoard) }], skipped: true };
  }
  const result = await syncCompanyJobs(actor, company.id);
  await saveHiringEmails(company);
  if (result.signalsCreated > 0) await rescoreAfterCompanyChange(actor.workspaceId, company.id);
  // Jobs still waiting for the AI are picked up a few minutes later; otherwise check weekly.
  const followUps: FollowUp[] = [
    {
      kind: "scan_job_board",
      entityId: company.id,
      runAfter: later(result.pending > 0 ? 3 * 60_000 : RECHECK.jobBoard),
    },
  ];
  // A company known only from its board: its new posts may now point to its own website.
  if (!company.domain && result.pending === 0) followUps.push({ kind: "enrich_company", entityId: company.id });
  return { followUps };
}

/**
 * The inbox the company's own job posts ask applicants to write to (careers@, jobs@), read from the
 * posts themselves. Only at the company's own site: its known website, or else the site its posts
 * point to most that carries its name. Accessibility, privacy and similar inboxes are never kept.
 */
async function saveHiringEmails(company: { id: string; name: string; domain: string | null }): Promise<void> {
  const posts = await db
    .select({ url: jobPostings.url, description: jobText })
    .from(jobPostings)
    .leftJoin(boardJobs, eq(boardJobs.id, jobPostings.boardJobId))
    .where(eq(jobPostings.companyId, company.id))
    .limit(100);
  const descriptions = posts.map((p) => p.description);
  const nameWords = company.name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
  const site = company.domain
    ? siteOf(company.domain)
    : sitesInJobPosts(descriptions).find((s) => nameWords.some((w) => s.site.split(".")[0].includes(w)))?.site;
  if (!site) return;
  const emails = hiringEmails(descriptions, site);
  if (emails.length === 0) return;
  const shownIn = posts.find((p) => emails.some((e) => p.description?.toLowerCase().includes(e)));
  await db.transaction((tx) => replaceCompanyContacts(tx, company.id, { emails, phones: [] }, { slug: "job_board", url: shownIn?.url ?? null }));
}

// --- scan_tenders: public contracts matching the workspace's services ------------------------

// Tender portals and shared government hosts: not the buyer's own website.
const PORTAL_HOSTS =
  /(^|\.)(gov\.uk|mytenders\.co\.uk|delta-esourcing\.com|bravosolution\.co\.uk|in-tendhost\.co\.uk|proactisplaza\.com|due-north\.com|eu-supply\.com|jaggaer\.com|atamis\.co\.uk|supplyingthesouthwest\.org\.uk|contractsfinder\.service\.gov\.uk)$/i;
const NOT_A_PERSON =
  /\b(team|department|dept|procurement|purchasing|commercial|contracts?|tenders?|services?|council|office|unit|admin|enquiries|support|finance)\b/i;

/** The buyer's own domain from the notice's web address, unless it's a portal or shared host. */
function tenderBuyerDomain(contact: TenderContact | null): string | null {
  const domain = contact?.website ? normalizeDomain(contact.website) : "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) && !PORTAL_HOSTS.test(domain) ? domain : null;
}

/**
 * Saves the buyer contact a notice publishes: a named person becomes the company's contact (with
 * their email and phone); a team name or none keeps the email and phone on the company itself.
 */
async function saveTenderContact(tx: Tx, actor: Actor, companyId: string, contact: TenderContact, url: string): Promise<void> {
  const name = contact.name?.replace(/\s+/g, " ").trim() ?? "";
  const words = name.split(" ");
  const isPerson = words.length >= 2 && words.length <= 4 && /^[\p{L}' .-]+$/u.test(name) && !NOT_A_PERSON.test(name);
  if (isPerson) {
    await addFoundPeople(
      tx,
      actor,
      companyId,
      [
        {
          name,
          title: "Buyer contact (public tender)",
          seniority: "unknown",
          jobFunction: "procurement",
          relationship: "employee",
          confidence: 90,
          phone: contact.phone,
          email: contact.email,
        },
      ],
      "uk_tenders",
    );
    return;
  }
  await replaceCompanyContacts(
    tx,
    companyId,
    {
      emails: contact.email ? [contact.email] : [],
      phones: contact.phone ? [contact.phone] : [],
    },
    { slug: "uk_tenders", url },
  );
}

/** Tenders kept before contacts were read: reads each one's buyer contact once. */
async function backfillTenderContacts(actor: Actor): Promise<void> {
  const rows = await db
    .select({
      id: sourceRecords.id,
      externalId: sourceRecords.externalId,
      url: sourceRecords.url,
      companyId: sourceRecords.companyId,
      data: sourceRecords.data,
    })
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.workspaceId, actor.workspaceId),
        eq(sourceRecords.sourceSlug, "uk_tenders"),
        sql`${sourceRecords.companyId} is not null and ${sourceRecords.data}->>'relevant' = 'true' and ${sourceRecords.data}->>'contactRead' is null`,
      ),
    )
    .limit(TENDER_ANALYSES_PER_JOB * 2);
  for (const row of rows) {
    const contact = await fetchTenderContact(row.externalId.replace(/^notice:/, ""));
    await db.transaction(async (tx) => {
      if (contact) await saveTenderContact(tx, actor, row.companyId!, contact, row.url ?? "");
      await tx
        .update(sourceRecords)
        .set({ data: { ...row.data, contactRead: true } })
        .where(eq(sourceRecords.id, row.id));
    });
    if (contact) await rescoreAfterCompanyChange(actor.workspaceId, row.companyId!);
  }
}

async function scanTenders({ job, actor, ai }: JobContext): Promise<JobResult> {
  if (!(await sourceRunnable(actor.workspaceId, "uk_tenders"))) return { followUps: [], skipped: true };
  const { categories } = await icpOf(actor);
  const cpvCodes = [...new Set(categories.flatMap((c) => CATEGORY_CPV_CODES[c] ?? []))];
  // No services, or none that public bodies buy: nothing to look for.
  if (cpvCodes.length === 0) return { followUps: [], skipped: true };
  await backfillTenderContacts(actor);
  const tenders = await searchTenders({
    cpvCodes,
    from: isoDaysAgo(30),
    size: 40,
  });

  // Each tender is analysed once: its record remembers it (`data.analysed`).
  const waiting = [];
  for (const tender of tenders) {
    const [seen] = await db
      .select({ data: sourceRecords.data })
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.workspaceId, actor.workspaceId),
          eq(sourceRecords.sourceSlug, "uk_tenders"),
          eq(sourceRecords.externalId, tender.record.externalId),
        ),
      )
      .limit(1);
    if (!seen?.data?.analysed) waiting.push(tender);
  }

  const ref = await getReferenceData();
  for (const tender of waiting.slice(0, TENDER_ANALYSES_PER_JOB)) {
    const text = tenderSourceText(tender);
    const analysis = await ai(() =>
      analyzeSignal({ companyId: job.entityId, text, sourceUrl: tender.url }, { name: tender.buyer, domain: null, industry: null }, ref),
    );
    const found = signalFromAnalysis(analysis, {
      url: tender.url,
      occurredOn: (tender.publishedAt ?? new Date()).toISOString().slice(0, 10),
      evidenceText: tender.description,
    });
    // Procurement codes are broad: keep a tender only if the AI ties it to something the workspace sells.
    const values = found && found.serviceCategories.some((c) => categories.includes(c)) ? found : null;
    // Only a kept tender's buyer contact is read (the search hits don't carry it).
    const contact = values ? await fetchTenderContact(tender.id) : null;
    const scoredCompany = await db.transaction(async (tx) => {
      const record = {
        ...tender.record,
        data: {
          ...tender.record.data,
          analysed: true,
          relevant: values !== null,
          ...(values ? { contactRead: true } : {}),
        },
      };
      if (!values) {
        await saveSourceRecord(tx, actor.workspaceId, record, null);
        return null;
      }
      // Only a buyer with a relevant tender becomes a company in the workspace.
      const resolved = await resolveCompany(tx, actor, {
        name: tender.buyer,
        domain: tenderBuyerDomain(contact),
        industry: "government",
        hq: tender.region ? { city: null, region: tender.region, country: "GB" } : { city: null, region: null, country: "GB" },
        identifiers: [],
        foundedOn: null,
        record,
      });
      if (contact) await saveTenderContact(tx, actor, resolved.companyId, contact, tender.url);
      const signal = await insertDetectedSignal(tx, actor, resolved.companyId, values, resolved.recordId);
      return signal.created ? resolved.companyId : null;
    });
    // Scored after the commit, so the new signal counts.
    if (scoredCompany) await rescoreAfterCompanyChange(actor.workspaceId, scoredCompany);
  }
  // More waiting than one job may analyse: continue in a few minutes.
  return {
    followUps:
      waiting.length > TENDER_ANALYSES_PER_JOB
        ? [
            {
              kind: "scan_tenders",
              entityId: actor.workspaceId,
              runAfter: later(3 * 60_000),
            },
          ]
        : [],
  };
}

// --- match_osm: link companies and practices to the business they are on OpenStreetMap ---------

async function matchOsm({ actor }: JobContext): Promise<JobResult> {
  // Nothing to match against until the weekly import has run (`npm run osm:import`).
  if (!(await sourceRunnable(actor.workspaceId, "openstreetmap")) || !(await osmImported())) return { followUps: [], skipped: true };
  await matchWorkspace(actor.workspaceId);
  return { followUps: [] };
}

// --- discover_theirstack: recent job posts (Indeed, LinkedIn, career sites) via TheirStack -------

/** New AI readings per run; the rest wait a few minutes (the free AI checks only a few a minute). */
const THEIRSTACK_ANALYSES_PER_JOB = 3;
/** Posts already read by the AI (for another workspace) recorded per run: no AI, no credit. */
const THEIRSTACK_POSTS_PER_JOB = 20;
/** Shared posts offered to a workspace only while this recent. */
const THEIRSTACK_MAX_AGE_DAYS = 21;

type SharedPost = { id: number; title: string; country: string | null; data: TheirStackJob; analysis: SignalAnalysis | null };

/**
 * Job posts from TheirStack, shared by the whole platform (`theirstack_jobs`): each post is bought
 * once (one credit) and read by the AI once, whichever workspace it was bought for. A workspace first
 * takes the shared posts it hasn't looked at that fit its services (by title) and countries; only
 * when none are left does it buy new ones, within the platform's daily cap, for the roles its
 * services fill. A post becomes a company and signal only when the AI ties it to something the
 * workspace sells.
 */
async function discoverTheirStack({ actor, ai }: JobContext): Promise<JobResult> {
  if (!(await sourceRunnable(actor.workspaceId, "theirstack"))) return { followUps: [], skipped: true };
  const services = await loadServices(actor.workspaceId);
  const sold = [...new Set(services.flatMap((s) => s.categories))];
  const titles = titlesFor(sold);
  if (titles.length === 0) return { followUps: [], skipped: true };
  // The countries the services name (a service without countries doesn't widen it to the world:
  // a credit spent on a market the workspace doesn't sell to is wasted). Worldwide only when none do.
  const countries = [...new Set(services.flatMap((s) => s.targetCountries))];

  let posts = await sharedPostsFor(actor, sold, countries);
  if (posts.length === 0) {
    await buyTheirStackPosts(actor, services, titles, countries);
    posts = await sharedPostsFor(actor, sold, countries);
  }

  const ref = await getReferenceData();
  let aiReadings = 0;
  let handled = 0;
  for (const post of posts) {
    if (handled >= THEIRSTACK_POSTS_PER_JOB || (!post.analysis && aiReadings >= THEIRSTACK_ANALYSES_PER_JOB)) continue;
    handled++;
    const j = post.data;
    let analysis = post.analysis;
    if (!analysis) {
      aiReadings++;
      const industry = ref.industries.find((i) => i.slug === j.company.industry)?.name ?? null;
      analysis = await ai(() =>
        analyzeSignal({ companyId: actor.workspaceId, text: theirStackJobText(j), sourceUrl: j.url }, { name: j.company.name, domain: j.company.domain, industry }, ref),
      );
      // Read once, for every workspace.
      await db
        .update(theirstackJobs)
        .set({ analysis: analysis as unknown as Record<string, unknown>, analyzedAt: sql`now()` })
        .where(eq(theirstackJobs.id, post.id));
    }
    const found = signalFromAnalysis(analysis, { url: j.url, occurredOn: j.postedOn, evidenceText: j.description });
    // Kept only when the AI ties the job to something the workspace sells, after the title rules
    // (a trainee or rotational post, or a role around the work, is never a lead).
    const refined = found ? refineCategories(j.title, found.serviceCategories) : [];
    const values = found && refined.some((c) => sold.includes(c)) ? { ...found, serviceCategories: refined } : null;
    const scoredCompany = await db.transaction(async (tx) => {
      // The workspace's own record of the post: provenance, and "looked at" so it isn't offered again.
      const record = {
        sourceSlug: "theirstack" as const,
        externalId: `job:${j.id}`,
        url: j.url,
        recordType: "job_post",
        publishedAt: new Date(`${j.postedOn}T00:00:00Z`),
        data: { title: j.title, company: j.company.name, postedOn: j.postedOn, location: j.location, foundOn: j.foundOn, analysed: true, relevant: values !== null },
      };
      if (!values) {
        await saveSourceRecord(tx, actor.workspaceId, record, null);
        return null;
      }
      // Only a company with a relevant job joins the workspace, matched by its website.
      const resolved = await resolveCompany(tx, actor, {
        name: j.company.name,
        domain: j.company.domain,
        industry: j.company.industry,
        hq: { city: j.company.city, region: null, country: j.company.country },
        identifiers: [],
        identity: j.company.domain ? "partial" : "provisional",
        foundedOn: null,
        record,
      });
      if (j.company.employeeCount) {
        await tx
          .update(companies)
          .set({ employeeCount: j.company.employeeCount })
          .where(and(eq(companies.id, resolved.companyId), sql`${companies.employeeCount} is null`));
      }
      if (j.hiringTeam.length > 0) await addFoundPeople(tx, actor, resolved.companyId, j.hiringTeam, "theirstack");
      const signal = await insertDetectedSignal(tx, actor, resolved.companyId, values, resolved.recordId);
      return signal.created ? resolved.companyId : null;
    });
    if (scoredCompany) await rescoreAfterCompanyChange(actor.workspaceId, scoredCompany);
  }

  const followUps: FollowUp[] = [];
  // New companies: their website for contacts and team.
  const added = await db
    .select({ companyId: sourceRecords.companyId })
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.workspaceId, actor.workspaceId),
        eq(sourceRecords.sourceSlug, "theirstack"),
        isNotNull(sourceRecords.companyId),
        sql`${sourceRecords.observedAt} > now() - interval '10 minutes'`,
      ),
    );
  for (const { companyId } of added) followUps.push({ kind: "enrich_company", entityId: companyId! });
  if (posts.length > handled) followUps.push({ kind: "discover_theirstack", entityId: actor.workspaceId, runAfter: later(3 * 60_000) });
  return { followUps };
}

/**
 * Shared posts this workspace hasn't looked at yet, newest first, that fit its services (the AI's
 * categories once read, else the title's) and its countries.
 */
async function sharedPostsFor(actor: Actor, sold: string[], countries: string[]): Promise<SharedPost[]> {
  const rows = await db
    .select({ id: theirstackJobs.id, title: theirstackJobs.title, country: theirstackJobs.country, data: theirstackJobs.data, analysis: theirstackJobs.analysis })
    .from(theirstackJobs)
    .where(
      and(
        sql`${theirstackJobs.postedOn} >= to_char(now() - make_interval(days => ${THEIRSTACK_MAX_AGE_DAYS}), 'YYYY-MM-DD')`,
        sql`not exists (
          select 1 from source_records r
          where r.workspace_id = ${actor.workspaceId} and r.source_slug = 'theirstack'
            and r.external_id = 'job:' || ${theirstackJobs.id} and r.data->>'analysed' is not null)`,
      ),
    )
    .orderBy(desc(theirstackJobs.postedOn), theirstackJobs.id)
    .limit(300);
  return rows
    .map((r) => ({ ...r, data: r.data as unknown as TheirStackJob, analysis: r.analysis as unknown as SignalAnalysis | null }))
    .filter((post) => {
      if (countries.length > 0 && !(post.country ? countries.includes(post.country) : jobInCountries(post.data.location, countries))) return false;
      // The AI's categories, held to the same title rules as every job (no trainees, no roles around the work).
      if (post.analysis) return post.analysis.isSignal && refineCategories(post.title, post.analysis.serviceCategories).some((c) => sold.includes(c));
      return categorizeJob({ title: post.title, department: null }).some((c) => sold.includes(c));
    });
}

/**
 * Buys new posts for the roles the workspace's services fill, within the platform's daily cap and
 * the credits left, skipping every post the platform already has and companies already in this
 * workspace's opportunities, and stores them in the shared table.
 */
async function buyTheirStackPosts(actor: Actor, services: Service[], titles: string[], countries: string[]): Promise<void> {
  // One key and one allowance for the whole platform: the daily cap is shared by all workspaces.
  const [{ boughtToday }] = await db
    .select({ boughtToday: sql<number>`count(*)::int` })
    .from(theirstackJobs)
    .where(sql`${theirstackJobs.fetchedAt} >= date_trunc('day', now())`);
  const limit = Math.min(theirStackJobsPerRun() - boughtToday, await creditsLeft());
  if (limit <= 0) return;
  const size = employeeRange(services);
  const owned = await db.select({ id: theirstackJobs.id }).from(theirstackJobs).orderBy(desc(theirstackJobs.fetchedAt)).limit(2000);
  const opportunityDomains = await db
    .selectDistinct({ domain: companies.domain })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(and(eq(opportunities.workspaceId, actor.workspaceId), isNotNull(companies.domain)));
  const jobs = await searchJobs({
    titles,
    countries,
    maxAgeDays: 7,
    limit,
    seenJobIds: owned.map((r) => r.id),
    skipDomains: opportunityDomains.map((d) => d.domain!),
    minEmployees: size.min,
    maxEmployees: size.max,
  });
  if (jobs.length === 0) return;
  await db
    .insert(theirstackJobs)
    .values(
      jobs.map((j) => ({
        id: j.id,
        title: j.title.slice(0, 300),
        postedOn: j.postedOn,
        country: j.company.country,
        companyDomain: j.company.domain,
        data: { ...j, description: j.description.slice(0, 6000) } as unknown as Record<string, unknown>,
      })),
    )
    .onConflictDoNothing();
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
  discover_npi: discoverNpi,
  discover_theirstack: discoverTheirStack,
  discover_yc: discoverYc,
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
      try {
        const result = await call();
        calls++;
        return result;
      } catch (error) {
        // The provider refused before doing any work: don't spend the workspace's daily budget on it.
        if (error instanceof AppError && error.code === "AI_BUSY") await refundRateLimit("aiWorkspace", job.workspaceId);
        else calls++;
        throw error;
      }
    },
    aiCalls: () => calls,
  };
}
