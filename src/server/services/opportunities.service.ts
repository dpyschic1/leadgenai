import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLogs,
  companies,
  companyContactPoints,
  companyLocations,
  companyPeople,
  contactPoints,
  jobPostings,
  opportunities,
  opportunityDiscoveries,
  opportunityEvidence,
  opportunityFeedback,
  opportunitySignals,
  osmMatches,
  osmPlaces,
  people,
  pipelineStages,
  lists,
  savedOpportunities,
  signalEvidence,
  signalServiceCategories,
  services,
  signals,
  signalTypes,
  sourceRecords,
  users,
} from "@/db/schema";
import type {
  CompanyContact,
  FeedbackVote,
  LeadContacts,
  LeadList,
  OpportunityDetail,
  OpportunityFactor,
  OpportunityList,
  OpportunitySummary,
} from "@/lib/api/types";
import { ENGINE_FACTOR_LABELS } from "@/lib/domain/engine";
import {
  LEAD_TABS,
  ROLE_FAMILIES,
  ROLE_FAMILY_PATTERNS,
  roleFamiliesOf,
  STATUS_GROUP_KEYS,
  type ContactReach,
  type LeadTab,
  type RoleFamily,
  type StatusGroup,
} from "@/lib/domain/opportunities";
import type { SourceSlug } from "@/lib/domain/sources";
import {
  EMPTY_FILTERS,
  type BulkOpportunitiesValues,
  type LeadContactsQuery,
  type LeadListQuery,
  type OpportunityFilters,
  type OpportunityListQuery,
  type OpportunitySort,
  type UpdateOpportunityValues,
} from "@/lib/validation/opportunities";
import { offsetOf } from "@/lib/validation/pagination";
import type { ScoreFactor } from "@/lib/validation/scoring";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { refreshStaleScores } from "@/server/scoring/rescore";
import { listFeedback } from "./feedback.service";
import { loadStage } from "./pipeline.service";
import { loadCompanyPeople } from "./people.service";
import { listCompanySignals } from "./signals.service";
import { osmContactsFor } from "@/server/sources/osm";

/** The company's own phone: its published switchboard first, else a registered site's phone (CQC practice). */
const ownPhone = sql`coalesce(
    (select ${companyContactPoints.value} from ${companyContactPoints}
      where ${companyContactPoints.companyId} = ${opportunities.companyId} and ${companyContactPoints.type} = 'phone'
      order by (${companyContactPoints.sourceSlug} = 'company_website') desc, ${companyContactPoints.observedAt} desc limit 1),
    (select ${companyLocations.phone} from ${companyLocations}
      where ${companyLocations.companyId} = ${opportunities.companyId} and ${companyLocations.phone} is not null
      order by ${companyLocations.name} limit 1))`;

/** A phone or email the company's matched OpenStreetMap place publishes (its strongest match first). */
const osmContact = (field: "phone" | "email") => sql`(select p.${sql.raw(field)} from ${osmMatches} m
    join ${osmPlaces} p on p.osm_type = m.osm_type and p.osm_id = m.osm_id and p.removed_at is null
    where m.company_id = ${opportunities.companyId} and p.${sql.raw(field)} is not null
    order by m.confidence desc, p.osm_id limit 1)`;

/** The company's phone: its own first; OpenStreetMap's only when it has none (`companyContactFromOsm` says so). */
export const companyPhone = sql<string | null>`coalesce(${ownPhone}, ${osmContact("phone")})`;

/**
 * Best company contact first: the website's own, then a shared inbox (info@, reception@) over a
 * named person's address, then the newest. The same order on the card, the export and the page.
 */
const contactPriority = sql`(${companyContactPoints.sourceSlug} = 'company_website') desc,
    (split_part(${companyContactPoints.value}, '@', 1) ~ '^(info|enquir|inquir|hello|contact|reception|office|admin|team|bookings?|appointments?|general|mail|sales|support|practice|surgery|clinic)') desc,
    ${companyContactPoints.observedAt} desc`;

const ownEmail = sql`(select ${companyContactPoints.value} from ${companyContactPoints}
    where ${companyContactPoints.companyId} = ${opportunities.companyId} and ${companyContactPoints.type} = 'email'
    order by ${contactPriority} limit 1)`;

/** The company's published email (info@, reception@): its own first, OpenStreetMap's only when it has none. */
export const companyEmail = sql<string | null>`coalesce(${ownEmail}, ${osmContact("email")})`;

/**
 * The suggested person's own email or phone: primary first, never one known to be invalid, and
 * never for a suppressed person (SRS SEC-007).
 */
const personContact = (type: "email" | "phone") => sql<string | null>`(
    select cp.value from ${contactPoints} cp join ${people} p on p.id = cp.person_id
    where cp.person_id = ${opportunities.primaryPersonId} and cp.type = ${type} and cp.verification <> 'invalid'
      and p.identity_status <> 'suppressed'
    order by cp.is_primary desc, cp.created_at limit 1)`;
export const personEmail = personContact("email");
export const personPhone = personContact("phone");

/** How the lead can be reached (`CONTACT_REACH`): through its person, only its company line, or not yet. */
const reachesPerson = sql`(${personEmail} is not null or ${personPhone} is not null)`;
const reachesCompany = sql`(${companyPhone} is not null or ${companyEmail} is not null)`;
export function contactReach(reach: ContactReach): SQL {
  switch (reach) {
    case "any":
      return sql`(${reachesPerson} or ${reachesCompany})`;
    case "person":
      return reachesPerson;
    case "company":
      return sql`(not ${reachesPerson} and ${reachesCompany})`;
    case "none":
      return sql`(not ${reachesPerson} and not ${reachesCompany})`;
  }
}

/**
 * Where the opportunity's evidence can be read: the source link of its primary signal, else of
 * its newest supporting one that has a link (a job posting, a tender, a register entry, a news
 * page), with that signal's summary. Null when no signal links anywhere.
 */
export const signalEvidenceLink = sql<{ url: string; summary: string } | null>`(
    select json_build_object('url', ${signalEvidence.sourceUrl}, 'summary', ${signals.summary})
    from ${opportunitySignals}
    join ${signalEvidence} on ${signalEvidence.signalId} = ${opportunitySignals.signalId}
    join ${signals} on ${signals.id} = ${opportunitySignals.signalId}
    where ${opportunitySignals.opportunityId} = ${opportunities.id} and ${opportunitySignals.role} <> 'negative'
      and ${signalEvidence.sourceUrl} is not null
    order by (${opportunitySignals.role} = 'primary') desc, ${signalEvidence.capturedAt} desc
    limit 1)`;

/** True when the phone or email shown comes from OpenStreetMap, which must then be credited (ODbL). */
export const companyContactFromOsm = sql<boolean>`((${ownPhone}) is null and ${osmContact("phone")} is not null)
    or ((${ownEmail}) is null and ${osmContact("email")} is not null)`;

const summaryColumns = {
  opportunity: opportunities,
  companyName: companies.canonicalName,
  companyDomain: companies.domain,
  /** The platform of the newest evidence ("Reddit" for a Google result), for engine opportunities. */
  platform: sql<string | null>`(select e.platform from ${opportunityEvidence} e where e.opportunity_id = ${opportunities.id} order by e.captured_at desc limit 1)`,
  serviceName: services.name,
  stageName: pipelineStages.name,
  stageKind: pipelineStages.kind,
  contactName: people.name,
  contactTitle: companyPeople.title,
  signalCount: sql<number>`(select count(*)::int from ${opportunitySignals} where ${opportunitySignals.opportunityId} = ${opportunities.id} and ${opportunitySignals.role} <> 'negative')`,
  companyPhone,
  companyEmail,
  companyContactFromOsm,
  personEmail,
  personPhone,
  signalEvidenceLink,
  feedbackVotes: sql<FeedbackVote[]>`(
    select coalesce(json_agg(json_build_object('name', coalesce(${users.name}, ${users.email}, 'A former teammate'), 'verdict', ${opportunityFeedback.verdict}) order by ${opportunityFeedback.updatedAt} desc), '[]')
    from ${opportunityFeedback} left join ${users} on ${users.id} = ${opportunityFeedback.userId}
    where ${opportunityFeedback.opportunityId} = ${opportunities.id}
  )`,
};

export type SummaryRow = {
  opportunity: typeof opportunities.$inferSelect;
  companyName: string | null;
  companyDomain: string | null;
  platform: string | null;
  serviceName: string | null;
  stageName: string;
  stageKind: "open" | "won" | "lost";
  contactName: string | null;
  contactTitle: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  companyContactFromOsm: boolean;
  personEmail: string | null;
  personPhone: string | null;
  signalEvidenceLink: { url: string; summary: string } | null;
  signalCount: number;
  feedbackVotes: FeedbackVote[];
};

/** Opportunities joined to what a summary shows (company, service, contact). Callers add where/order. */
export function summaryQuery() {
  return db
    .select(summaryColumns)
    .from(opportunities)
    // Engine opportunities (intent, funded, freelance) may have no identified company.
    .leftJoin(companies, eq(companies.id, opportunities.companyId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .leftJoin(services, eq(services.id, opportunities.serviceId))
    .leftJoin(people, eq(people.id, opportunities.primaryPersonId))
    .leftJoin(
      companyPeople,
      and(eq(companyPeople.companyId, opportunities.companyId), eq(companyPeople.personId, opportunities.primaryPersonId)),
    );
}

/** One page of the feed: highest priority first. Aged scores are refreshed before reading. */
export async function listOpportunities(auth: AuthContext, query: OpportunityListQuery): Promise<OpportunityList> {
  await refreshStaleScores(auth.workspaceId);
  const { page, pageSize } = query;

  const [rows, countRows, [fresh]] = await Promise.all([
    summaryQuery()
      .where(feedFilter(auth.workspaceId, query.group, query))
      .orderBy(...feedOrder(query.sort))
      .limit(pageSize)
      .offset(offsetOf({ page, pageSize })),
    // Tab counts follow the same filters, so each tab says how many it would show.
    db
      .select(Object.fromEntries(STATUS_GROUP_KEYS.map((g) => [g, sql<number>`(count(*) filter (where ${groupCondition(g)}))::int`])) as Record<StatusGroup, SQL<number>>)
      .from(opportunities)
      .leftJoin(companies, eq(companies.id, opportunities.companyId))
      .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
      .where(matchesFilters(auth.workspaceId, query)),
    // "New this week" on the selected tab, with every other filter applied (whether or not it's switched on).
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(opportunities)
      .leftJoin(companies, eq(companies.id, opportunities.companyId))
      .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
      .where(and(feedFilter(auth.workspaceId, query.group, { ...query, foundWithinDays: NEW_DAYS }))),
  ]);

  const counts = countRows[0] as Record<StatusGroup, number>;

  // The tab counts use the same filters, so the selected tab's count is this list's total.
  return { items: rows.map(toSummary), counts, newThisWeek: fresh?.n ?? 0, total: counts[query.group], page, pageSize };
}

/** What "new" means in the feed: found in the last 7 days. */
export const NEW_DAYS = 7;

/** Open supporting signals: how many roles or reasons back the opportunity. */
const supportingSignals = sql`(select count(*) from ${opportunitySignals} where ${opportunitySignals.opportunityId} = ${opportunities.id} and ${opportunitySignals.role} <> 'negative')`;

/** Feed order for each sort; every order ends in the priority order, so ties and pages stay stable. */
export function feedOrder(sort: OpportunitySort = "best") {
  switch (sort) {
    case "newest":
      return [desc(opportunities.createdAt), ...priorityOrder()] as const;
    case "latest":
      return [sql`coalesce(${opportunities.latestSignalAt}, ${opportunities.sourcePostedAt}, ${opportunities.discoveredAt}) desc nulls last`, ...priorityOrder()] as const;
    case "roles":
      return [sql`${supportingSignals} desc`, ...priorityOrder()] as const;
    default:
      return priorityOrder();
  }
}

/**
 * The Leads page: every lead still being worked (any open stage, not archived), in priority order, one tab
 * per way it can be reached. Each tab's count follows the search, so every tab says what it holds.
 */
export async function listLeads(auth: AuthContext, query: LeadListQuery): Promise<LeadList> {
  await refreshStaleScores(auth.workspaceId);
  const { page, pageSize } = query;
  const base = leadBase(auth.workspaceId, query.q);
  const tab = leadTab(query.tab);
  const index = await roleIndex(base);
  const role = query.role ? hiringFor(index, query.role) : undefined;
  const [rows, [tabRow], tabIds] = await Promise.all([
    summaryQuery().where(and(base, role, tab)).orderBy(...priorityOrder()).limit(pageSize).offset(offsetOf({ page, pageSize })),
    // Each tab's count has the role type applied, and each role type's count the tab: what a click would show.
    db
      .select(
        Object.fromEntries(
          LEAD_TABS.map((t) => {
            const condition = leadTab(t);
            return [t, condition ? sql<number>`(count(*) filter (where ${condition}))::int` : sql<number>`count(*)::int`];
          }),
        ) as Record<LeadTab, SQL<number>>,
      )
      .from(opportunities)
      .leftJoin(companies, eq(companies.id, opportunities.companyId))
      .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
      .where(and(base, role)),
    tab
      ? db
          .select({ id: opportunities.id })
          .from(opportunities)
          .leftJoin(companies, eq(companies.id, opportunities.companyId))
          .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
          .where(and(base, tab))
          .then((found) => new Set(found.map((r) => r.id)))
      : null,
  ]);

  const roleCounts = Object.fromEntries(ROLE_FAMILIES.map((f) => [f, 0])) as Record<RoleFamily, number>;
  for (const [id, lead] of index) {
    if (tabIds && !tabIds.has(id)) continue;
    for (const family of lead.families) roleCounts[family]++;
  }
  const counts = tabRow as Record<LeadTab, number>;
  return {
    items: rows.map((row) => {
      const titles = index.get(row.opportunity.id)?.titles ?? [];
      // With a role type picked, its titles come first: the reason the lead is in the list.
      const ordered = query.role ? [...titles].sort((a, b) => Number(ROLE_FAMILY_PATTERNS[query.role!].test(b)) - Number(ROLE_FAMILY_PATTERNS[query.role!].test(a))) : titles;
      return { ...toSummary(row), roles: ordered.slice(0, MAX_ROLE_TITLES), roleCount: titles.length };
    }),
    counts,
    roleCounts,
    total: counts[query.tab],
    page,
    pageSize,
  };
}

/** Role titles a lead row lists before "+N more". */
const MAX_ROLE_TITLES = 6;
/** Leads one "copy all" holds. */
const MAX_LEAD_CONTACTS = 2000;

type RoleIndex = Map<string, { titles: string[]; families: Set<RoleFamily> }>;

/**
 * What every lead matching `base` is hiring for: its distinct job titles (newest first) and their
 * role types. A discovered project or post has no job postings; its own title gives its role type.
 * Titles are classified here rather than in SQL: a dozen patterns over thousands of titles is
 * fast in JavaScript and slow as Postgres regular expressions.
 */
async function roleIndex(base: SQL | undefined): Promise<RoleIndex> {
  const leads = () =>
    db
      .select({ id: opportunities.id, title: sql<string>`${jobPostings.title}` })
      .from(opportunities)
      .leftJoin(companies, eq(companies.id, opportunities.companyId))
      .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId));
  const [jobs, engine] = await Promise.all([
    leads()
      .innerJoin(opportunitySignals, and(eq(opportunitySignals.opportunityId, opportunities.id), sql`${opportunitySignals.role} <> 'negative'`))
      .innerJoin(jobPostings, eq(jobPostings.signalId, opportunitySignals.signalId))
      .where(base)
      .orderBy(sql`coalesce(${jobPostings.postedAt}, ${jobPostings.firstSeenAt}) desc`),
    db
      .select({ id: opportunities.id, title: sql<string>`${opportunities.title}` })
      .from(opportunities)
      .leftJoin(companies, eq(companies.id, opportunities.companyId))
      .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
      .where(and(base, isNotNull(opportunities.category), isNotNull(opportunities.title))),
  ]);

  const index: RoleIndex = new Map();
  const entry = (id: string) => index.get(id) ?? index.set(id, { titles: [], families: new Set() }).get(id)!;
  for (const { id, title } of jobs) {
    const lead = entry(id);
    if (lead.titles.some((t) => t.toLowerCase() === title.toLowerCase())) continue;
    lead.titles.push(title);
    for (const family of roleFamiliesOf(title)) lead.families.add(family);
  }
  for (const { id, title } of engine) for (const family of roleFamiliesOf(title)) entry(id).families.add(family);
  return index;
}

/** Leads in `index` hiring for this role type, as a condition. */
function hiringFor(index: RoleIndex, family: RoleFamily): SQL {
  const ids = [...index].filter(([, lead]) => lead.families.has(family)).map(([id]) => id);
  return ids.length > 0 ? inArray(opportunities.id, ids) : sql`false`;
}

/** Every lead still being worked (open or in progress, not archived), narrowed by a search. Expects `companies` and `pipeline_stages` joined. */
function leadBase(workspaceId: string, q: string): SQL | undefined {
  return and(matchesFilters(workspaceId, { ...EMPTY_FILTERS, q }), or(groupCondition("open"), groupCondition("inProgress")));
}

const leadEmail = sql`coalesce(${personEmail}, ${companyEmail})`;
const leadPhone = sql`coalesce(${personPhone}, ${companyPhone})`;

/** One contact tab of the Leads page. */
function leadTab(tab: LeadTab): SQL | undefined {
  switch (tab) {
    case "all":
      return undefined;
    case "email":
      return sql`(${leadEmail} is not null)`;
    case "phone":
      return sql`(${leadPhone} is not null)`;
    default:
      return contactReach(tab);
  }
}

/** Every lead the Leads page's tab, role type and search match (best first), with the email and phone to use. */
export async function listLeadContacts(auth: AuthContext, query: LeadContactsQuery): Promise<LeadContacts> {
  const base = leadBase(auth.workspaceId, query.q);
  const role = query.role ? hiringFor(await roleIndex(base), query.role) : undefined;
  const where = and(base, role, leadTab(query.tab));
  const rows = await db
    .select({
      id: opportunities.id,
      companyName: companies.canonicalName,
      title: opportunities.title,
      contact: people.name,
      email: sql<string | null>`${leadEmail}`,
      phone: sql<string | null>`${leadPhone}`,
    })
    .from(opportunities)
    .leftJoin(companies, eq(companies.id, opportunities.companyId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .leftJoin(people, eq(people.id, opportunities.primaryPersonId))
    .where(where)
    .orderBy(...priorityOrder())
    .limit(MAX_LEAD_CONTACTS + 1);
  const items = rows.slice(0, MAX_LEAD_CONTACTS).map((r) => ({
    id: r.id,
    name: r.companyName ?? r.title ?? "Untitled opportunity",
    contact: r.contact,
    email: r.email,
    phone: r.phone,
  }));
  return { total: items.length, truncated: rows.length > MAX_LEAD_CONTACTS, items };
}

/** Feed order: highest priority first, unscored last, then freshest evidence, then by name (id breaks ties, so pages never overlap). */
export function priorityOrder() {
  return [
    sql`${opportunities.opportunityScore} desc nulls last`,
    desc(opportunities.latestSignalAt),
    asc(companies.canonicalName),
    asc(opportunities.id),
  ] as const;
}

/** One status tab of the feed, narrowed by `filters`. Expects `companies` to be joined. */
export function feedFilter(workspaceId: string, group: StatusGroup, filters: OpportunityFilters): SQL | undefined {
  return and(matchesFilters(workspaceId, filters), groupCondition(group));
}

/**
 * One feed tab, from stage kind (spec section 12). Open = the first open stage, where discoveries land;
 * In progress = every other open stage; Won; Closed = lost stages plus archived. Expects `pipeline_stages` joined.
 */
export function groupCondition(group: StatusGroup): SQL {
  const live = isNull(opportunities.archivedAt);
  const intake = sql`(select min(s.position) from ${pipelineStages} s where s.workspace_id = ${opportunities.workspaceId} and s.kind = 'open')`;
  switch (group) {
    case "open":
      return sql`(${live} and ${pipelineStages.kind} = 'open' and ${pipelineStages.position} = ${intake})`;
    case "inProgress":
      return sql`(${live} and ${pipelineStages.kind} = 'open' and ${pipelineStages.position} > ${intake})`;
    case "won":
      return sql`(${live} and ${pipelineStages.kind} = 'won')`;
    case "closed":
      return sql`(${opportunities.archivedAt} is not null or ${pipelineStages.kind} = 'lost')`;
  }
}

/** Every filter except status. Empty filters add no condition. Expects `companies` to be left-joined. */
function matchesFilters(workspaceId: string, filters: OpportunityFilters): SQL | undefined {
  const any = <T>(values: T[], condition: (values: T[]) => SQL | undefined) => (values.length > 0 ? condition(values) : undefined);
  return and(
    eq(opportunities.workspaceId, workspaceId),
    companySearch(filters.q),
    any(filters.types, (types) => inArray(opportunities.type, types)),
    any(filters.services, (ids) => inArray(opportunities.serviceId, ids)),
    any(filters.urgency, (levels) => inArray(opportunities.urgency, levels)),
    any(filters.industries, (slugs) => inArray(companies.industry, slugs)),
    any(filters.categories, (cats) => {
      const engine = cats.filter((c): c is Exclude<typeof c, "signal"> => c !== "signal");
      return or(cats.includes("signal") ? isNull(opportunities.category) : undefined, engine.length ? inArray(opportunities.category, engine) : undefined);
    }),
    any(filters.sources, (slugs) => inArray(opportunities.sourceSlug, slugs)),
    any(filters.intents, (levels) => inArray(opportunities.intentLevel, levels)),
    // A company's headquarters, or the country an engine opportunity states (a funded company's address, a project's client).
    any(
      filters.countries,
      (codes) => or(
        inArray(opportunities.country, codes),
        sql`exists (
          select 1 from ${companyLocations}
          where ${companyLocations.companyId} = ${companies.id} and ${companyLocations.type} = 'headquarters'
            and ${inArray(companyLocations.country, codes)}
        )`,
      ),
    ),
    // At least one supporting (non-negative) signal in one of the categories.
    any(
      filters.signals,
      (categories) => sql`exists (
        select 1 from ${opportunitySignals}
        join ${signals} on ${signals.id} = ${opportunitySignals.signalId}
        join ${signalTypes} on ${signalTypes.slug} = ${signals.signalType}
        where ${opportunitySignals.opportunityId} = ${opportunities.id} and ${opportunitySignals.role} <> 'negative'
          and ${inArray(signalTypes.categorySlug, categories)}
      )`,
    ),
    filters.minScore === null ? undefined : gte(opportunities.opportunityScore, filters.minScore),
    filters.withinDays === null
      ? undefined
      // Latest signal for company opportunities; the discovery date for engine ones.
      : gte(sql`coalesce(${opportunities.latestSignalAt}, ${opportunities.discoveredAt})`, sql`now() - make_interval(days => ${filters.withinDays})`),
    filters.contact === null ? undefined : contactReach(filters.contact),
    // Hiring for / needs: a supporting signal points to one of these services, or (for a discovered
    // project, post or startup) the item's own needs do.
    any(
      filters.needs,
      (slugs) => or(
        sql`exists (
          select 1 from ${opportunitySignals}
          join ${signalServiceCategories} on ${signalServiceCategories.signalId} = ${opportunitySignals.signalId}
          where ${opportunitySignals.opportunityId} = ${opportunities.id} and ${opportunitySignals.role} <> 'negative'
            and ${inArray(signalServiceCategories.categorySlug, slugs)}
        )`,
        sql`(${opportunities.scoreFactors} -> 'input' -> 'signal' -> 'serviceCategories') ?| ${sql`array[${sql.join(slugs.map((s) => sql`${s}`), sql`, `)}]::text[]`}`,
      ),
    ),
    filters.foundWithinDays === null ? undefined : gte(opportunities.createdAt, sql`now() - make_interval(days => ${filters.foundWithinDays})`),
  );
}

function companySearch(q: string): SQL | undefined {
  if (!q) return undefined;
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return or(ilike(companies.canonicalName, pattern), ilike(companies.domain, pattern), ilike(opportunities.title, pattern), ilike(opportunities.buyerName, pattern));
}

/** People shown besides the suggested contact on an opportunity. */
const MAX_OTHER_PEOPLE = 12;
const reachable = (p: { email: string | null; phone: string | null; professionalUrl: string | null }) => Boolean(p.email || p.phone || p.professionalUrl);

export async function getOpportunity(auth: AuthContext, opportunityId: string): Promise<OpportunityDetail> {
  const row = await findRow(auth, opportunityId);
  const { opportunity } = row;

  const companyId = opportunity.companyId;
  const [links, companySignals, companyPeople, saved, feedback, evidenceRows, discoveryRows] = await Promise.all([
    db
      .select({ signalId: opportunitySignals.signalId, role: opportunitySignals.role })
      .from(opportunitySignals)
      .where(eq(opportunitySignals.opportunityId, opportunity.id)),
    companyId ? listCompanySignals(auth, companyId) : [],
    companyId ? loadCompanyPeople(auth.workspaceId, companyId) : [],
    db
      .select({ listId: savedOpportunities.listId })
      .from(savedOpportunities)
      .where(and(eq(savedOpportunities.opportunityId, opportunity.id), eq(savedOpportunities.workspaceId, auth.workspaceId))),
    listFeedback(auth, opportunity.id),
    db.select().from(opportunityEvidence).where(eq(opportunityEvidence.opportunityId, opportunity.id)).orderBy(desc(opportunityEvidence.capturedAt)),
    db.select().from(opportunityDiscoveries).where(eq(opportunityDiscoveries.opportunityId, opportunity.id)).orderBy(desc(opportunityDiscoveries.seenAt)).limit(50),
  ]);
  const [companyContacts, tender] = await Promise.all([
    companyId ? loadCompanyContacts(companyId) : [],
    opportunity.type === "rfp" ? loadTender(auth.workspaceId, links.map((l) => l.signalId)) : null,
  ]);
  const roleOf = new Map(links.map((l) => [l.signalId, l.role]));
  const roleOrder = { primary: 0, corroborating: 1, negative: 2 } as const;

  return {
    ...toSummary(row),
    suggestedAction: opportunity.suggestedAction,
    notes: opportunity.notes,
    factors: hasFactors(opportunity.scoreFactors) ? opportunity.scoreFactors : null,
    engineFactors: opportunity.category && !hasFactors(opportunity.scoreFactors) ? engineFactorsOf(opportunity.scoreFactors) : null,
    signals: companySignals
      .filter((s) => roleOf.has(s.id))
      .map((s) => ({ ...s, role: roleOf.get(s.id)! }))
      .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || b.occurredOn.localeCompare(a.occurredOn)),
    contactDetails: companyPeople.find((p) => p.id === opportunity.primaryPersonId) ?? null,
    otherPeople: companyPeople
      .filter((p) => p.id !== opportunity.primaryPersonId)
      .sort((a, b) => Number(reachable(b)) - Number(reachable(a)))
      .slice(0, MAX_OTHER_PEOPLE),
    companyContacts,
    tender,
    engineEvidence: evidenceRows.map((e) => ({
      id: e.id,
      platform: e.platform,
      url: e.url,
      snippet: e.snippet,
      verification: e.verification,
      capturedAt: e.capturedAt.toISOString(),
      metadata: e.metadata,
    })),
    discoveries: discoveryRows.map((d) => ({ seenAt: d.seenAt.toISOString(), change: d.change, changedFields: d.changedFields })),
    scoredAt: opportunity.scoredAt.toISOString(),
    listIds: saved.map((s) => s.listId),
    feedback,
  };
}

/** An engine opportunity's stored factors as labelled rows, in the spec's order. */
function engineFactorsOf(stored: Record<string, unknown>): { key: string; label: string; score: number; weight: number }[] {
  const weights = (stored.weights ?? {}) as Record<string, number>;
  return Object.entries(ENGINE_FACTOR_LABELS).flatMap(([key, label]) =>
    typeof stored[key] === "number" ? [{ key, label, score: stored[key] as number, weight: weights[key] ?? 0 }] : [],
  );
}

/** The public tender behind an RFP opportunity: its notice and closing date, latest first. */
async function loadTender(workspaceId: string, signalIds: string[]): Promise<OpportunityDetail["tender"]> {
  if (signalIds.length === 0) return null;
  const [row] = await db
    .select({ url: sourceRecords.url, data: sourceRecords.data })
    .from(signals)
    .innerJoin(sourceRecords, eq(sourceRecords.id, signals.sourceRecordId))
    .where(and(eq(signals.workspaceId, workspaceId), inArray(signals.id, signalIds), eq(sourceRecords.sourceSlug, "uk_tenders")))
    .orderBy(desc(signals.occurredAt))
    .limit(1);
  if (!row) return null;
  const deadline = typeof row.data?.deadline === "string" ? row.data.deadline : null;
  const closesAt = deadline ? new Date(deadline).getTime() : NaN;
  return { url: row.url, closesAt: deadline, closed: closesAt < Date.now() };
}

/** Sites listed per company on the opportunity page; the Sources card on the company page lists them all. */
const SITE_PHONES_SHOWN = 5;

/** The company's published phones and emails, then its registered sites' phones (deduplicated). */
async function loadCompanyContacts(companyId: string): Promise<CompanyContact[]> {
  const [points, sites] = await Promise.all([
    db
      .select()
      .from(companyContactPoints)
      .where(eq(companyContactPoints.companyId, companyId))
      .orderBy(asc(companyContactPoints.type), contactPriority),
    db
      .select({ name: companyLocations.name, phone: companyLocations.phone, website: companyLocations.website, sourceSlug: companyLocations.sourceSlug })
      .from(companyLocations)
      .where(and(eq(companyLocations.companyId, companyId), isNotNull(companyLocations.phone)))
      .orderBy(asc(companyLocations.name))
      .limit(SITE_PHONES_SHOWN * 2),
  ]);
  const contacts: CompanyContact[] = points.map((p) => ({
    type: p.type === "email" ? "email" : "phone",
    value: p.value,
    label: null,
    source: (p.sourceSlug as SourceSlug | null) ?? null,
    url: p.sourceUrl,
  }));
  const digits = (value: string) => value.replace(/\D/g, "");
  const seen = new Set(contacts.filter((c) => c.type === "phone").map((c) => digits(c.value)));
  let shown = 0;
  for (const site of sites) {
    if (shown >= SITE_PHONES_SHOWN || seen.has(digits(site.phone!))) continue;
    seen.add(digits(site.phone!));
    shown++;
    contacts.push({ type: "phone", value: site.phone!, label: site.name, source: (site.sourceSlug as SourceSlug | null) ?? null, url: site.website });
  }
  // Last, and only what the company's own sources don't already give: what OpenStreetMap publishes.
  const known = new Set(contacts.map((c) => (c.type === "phone" ? digits(c.value) : c.value.toLowerCase())));
  for (const osm of await osmContactsFor(companyId)) {
    const key = osm.type === "phone" ? digits(osm.value) : osm.value.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    contacts.push({ type: osm.type, value: osm.value, label: osm.label, source: "openstreetmap", url: osm.url });
  }
  return contacts;
}

/** Moves it to a pipeline stage, archives or restores it, and/or edits notes. Scores are owned by the scoring engine. */
export async function updateOpportunity(
  auth: AuthContext,
  opportunityId: string,
  input: UpdateOpportunityValues,
): Promise<OpportunityDetail> {
  const { opportunity, stageName } = await findRow(auth, opportunityId);
  const target = input.stageId !== undefined ? await loadStage(db, auth.workspaceId, input.stageId) : null;
  await db.transaction(async (tx) => {
    await tx
      .update(opportunities)
      .set({
        ...(target && { stageId: target.id }),
        ...(input.archived !== undefined && { archivedAt: input.archived ? (opportunity.archivedAt ?? new Date()) : null }),
        ...(input.notes !== undefined && { notes: input.notes }),
      })
      .where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, auth.workspaceId)));
    if (target && target.id !== opportunity.stageId) {
      await tx.insert(auditLogs).values({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "opportunity.stage_changed",
        entityType: "opportunity",
        entityId: opportunityId,
        metadata: { from: stageName, to: target.name, kind: target.kind },
      });
    }
    if (input.archived !== undefined && input.archived !== (opportunity.archivedAt !== null)) {
      await tx.insert(auditLogs).values({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: input.archived ? "opportunity.archived" : "opportunity.restored",
        entityType: "opportunity",
        entityId: opportunityId,
      });
    }
  });
  return getOpportunity(auth, opportunityId);
}

/**
 * One action on several opportunities at once: move to a stage, archive/restore, or add to a list.
 * All of them must be this workspace's; it's all or nothing, with an audit entry per changed one.
 * Returns how many changed (one already in that stage, state or list doesn't count).
 */
export async function bulkUpdateOpportunities(auth: AuthContext, input: BulkOpportunitiesValues): Promise<{ changed: number }> {
  const ids = [...new Set(input.ids)];
  const rows = await db
    .select({ id: opportunities.id, stageId: opportunities.stageId, archivedAt: opportunities.archivedAt, stageName: pipelineStages.name })
    .from(opportunities)
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .where(and(eq(opportunities.workspaceId, auth.workspaceId), inArray(opportunities.id, ids)));
  if (rows.length !== ids.length) throw new AppError("NOT_FOUND", "Some of the selected opportunities no longer exist. Refresh and try again.");

  if (input.listId !== undefined) {
    const [list] = await db.select({ id: lists.id }).from(lists).where(and(eq(lists.id, input.listId), eq(lists.workspaceId, auth.workspaceId)));
    if (!list) throw new AppError("NOT_FOUND", "List not found.");
    return db.transaction(async (tx) => {
      const added = await tx
        .insert(savedOpportunities)
        .values(ids.map((opportunityId) => ({ workspaceId: auth.workspaceId, listId: list.id, opportunityId })))
        .onConflictDoNothing()
        .returning({ id: savedOpportunities.opportunityId });
      await tx.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, list.id));
      return { changed: added.length };
    });
  }

  if (input.stageId !== undefined) {
    const target = await loadStage(db, auth.workspaceId, input.stageId);
    const moving = rows.filter((r) => r.stageId !== target.id);
    if (moving.length === 0) return { changed: 0 };
    await db.transaction(async (tx) => {
      await tx.update(opportunities).set({ stageId: target.id }).where(and(eq(opportunities.workspaceId, auth.workspaceId), inArray(opportunities.id, moving.map((r) => r.id))));
      await tx.insert(auditLogs).values(
        moving.map((r) => ({
          workspaceId: auth.workspaceId,
          actorId: auth.userId,
          action: "opportunity.stage_changed",
          entityType: "opportunity",
          entityId: r.id,
          metadata: { from: r.stageName, to: target.name, kind: target.kind, bulk: true },
        })),
      );
    });
    return { changed: moving.length };
  }

  const archive = input.archived === true;
  const changing = rows.filter((r) => (r.archivedAt !== null) !== archive);
  if (changing.length === 0) return { changed: 0 };
  await db.transaction(async (tx) => {
    await tx
      .update(opportunities)
      .set({ archivedAt: archive ? new Date() : null })
      .where(and(eq(opportunities.workspaceId, auth.workspaceId), inArray(opportunities.id, changing.map((r) => r.id))));
    await tx.insert(auditLogs).values(
      changing.map((r) => ({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: archive ? "opportunity.archived" : "opportunity.restored",
        entityType: "opportunity",
        entityId: r.id,
        metadata: { bulk: true },
      })),
    );
  });
  return { changed: changing.length };
}

async function findRow(auth: AuthContext, opportunityId: string): Promise<SummaryRow> {
  const [row] = await summaryQuery()
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Opportunity not found.");
  return row;
}

/**
 * The company behind an opportunity in the company-centric views. Engine opportunities with no
 * identified company are not shown there (their feed is built separately), and the feed query
 * inner-joins companies, so this holds for every row these views read.
 */
export function companyIdOf(opportunity: { companyId: string | null }): string {
  if (!opportunity.companyId) throw new AppError("NOT_FOUND", "Opportunity not found.");
  return opportunity.companyId;
}

export function hasFactors(value: unknown): value is Record<ScoreFactor, OpportunityFactor> {
  // The company-signal flow stores { intent: { score, ... } }; engine rows store plain numbers, a different shape.
  return typeof value === "object" && value !== null && typeof (value as { intent?: unknown }).intent === "object";
}

export function toSummary(row: SummaryRow): OpportunitySummary {
  const { opportunity } = row;
  const factors = hasFactors(opportunity.scoreFactors) ? opportunity.scoreFactors : null;
  return {
    id: opportunity.id,
    company: opportunity.companyId && row.companyName ? { id: opportunity.companyId, name: row.companyName, domain: row.companyDomain } : null,
    engine: opportunity.category
      ? {
          category: opportunity.category,
          title: opportunity.title ?? "Untitled",
          buyerName: opportunity.buyerName,
          buyerProfileUrl: opportunity.buyerProfileUrl,
          country: opportunity.country,
          sourceSlug: opportunity.sourceSlug,
          platform: row.platform,
          sourceUrl: opportunity.sourceUrl,
          budgetUsd: opportunity.budgetUsd,
          budgetMin: opportunity.budgetMin,
          budgetMax: opportunity.budgetMax,
          budgetCurrency: opportunity.budgetCurrency,
          fundingAmountUsd: opportunity.fundingAmountUsd,
          fundingStage: opportunity.fundingStage,
          fundingDate: opportunity.fundingDate,
          investors: opportunity.investors ?? [],
          verification: opportunity.verification,
          intentLevel: opportunity.intentLevel,
          discoveredAt: opportunity.discoveredAt?.toISOString() ?? null,
          lastSeenAt: opportunity.lastSeenAt?.toISOString() ?? null,
          whyNow: opportunity.whyNow,
        }
      : null,
    service: opportunity.serviceId && row.serviceName ? { id: opportunity.serviceId, name: row.serviceName } : null,
    type: opportunity.type,
    score: factors || opportunity.category ? opportunity.opportunityScore : null,
    scores: factors
      ? {
          intent: factors.intent.score,
          icpFit: factors.icpFit.score,
          recency: factors.recency.score,
          identity: factors.identity.score,
          serviceFit: factors.serviceFit.score,
        }
      : null,
    urgency: opportunity.urgency,
    stage: { id: opportunity.stageId, name: row.stageName, kind: row.stageKind },
    archived: opportunity.archivedAt !== null,
    problem: opportunity.problem,
    latestSignalOn: opportunity.latestSignalAt?.toISOString().slice(0, 10) ?? null,
    signalCount: row.signalCount,
    contact:
      opportunity.primaryPersonId && row.contactName
        ? { id: opportunity.primaryPersonId, name: row.contactName, title: row.contactTitle, email: row.personEmail, phone: row.personPhone }
        : null,
    companyContact: { phone: row.companyPhone, email: row.companyEmail, fromOpenStreetMap: Boolean(row.companyContactFromOsm) },
    evidence: row.signalEvidenceLink,
    feedbackVotes: row.feedbackVotes,
    updatedAt: opportunity.updatedAt.toISOString(),
  };
}
