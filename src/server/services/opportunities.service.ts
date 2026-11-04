import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLogs,
  companies,
  companyContactPoints,
  companyLocations,
  companyPeople,
  contactPoints,
  opportunities,
  opportunityFeedback,
  opportunitySignals,
  osmMatches,
  osmPlaces,
  people,
  savedOpportunities,
  signalEvidence,
  services,
  signals,
  signalTypes,
  users,
} from "@/db/schema";
import type { CompanyContact, FeedbackVote, LeadList, OpportunityDetail, OpportunityFactor, OpportunityList, OpportunitySummary } from "@/lib/api/types";
import { LEAD_STATUSES, LEAD_TABS, STATUS_GROUPS, type ContactReach, type LeadTab, type StatusGroup } from "@/lib/domain/opportunities";
import type { SourceSlug } from "@/lib/domain/sources";
import { EMPTY_FILTERS, type LeadListQuery, type OpportunityFilters, type OpportunityListQuery, type UpdateOpportunityValues } from "@/lib/validation/opportunities";
import { offsetOf } from "@/lib/validation/pagination";
import type { ScoreFactor } from "@/lib/validation/scoring";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { refreshStaleScores } from "@/server/scoring/rescore";
import { listFeedback } from "./feedback.service";
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
  serviceName: services.name,
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
  companyName: string;
  companyDomain: string | null;
  serviceName: string | null;
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
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
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

  const [rows, countRows] = await Promise.all([
    summaryQuery()
      .where(feedFilter(auth.workspaceId, query.group, query))
      .orderBy(...priorityOrder())
      .limit(pageSize)
      .offset(offsetOf({ page, pageSize })),
    // Tab counts follow the same filters, so each tab says how many it would show.
    db
      .select({ status: opportunities.status, count: sql<number>`count(*)::int` })
      .from(opportunities)
      .innerJoin(companies, eq(companies.id, opportunities.companyId))
      .where(matchesFilters(auth.workspaceId, query))
      .groupBy(opportunities.status),
  ]);

  const counts = Object.fromEntries(
    (Object.keys(STATUS_GROUPS) as StatusGroup[]).map((key) => [
      key,
      countRows.filter((r) => (STATUS_GROUPS[key] as readonly string[]).includes(r.status)).reduce((sum, r) => sum + r.count, 0),
    ]),
  ) as Record<StatusGroup, number>;

  // The tab counts use the same filters, so the selected tab's count is this list's total.
  return { items: rows.map(toSummary), counts, total: counts[query.group], page, pageSize };
}

/**
 * The Leads page: every lead still being worked (new or in progress), in priority order, one tab
 * per way it can be reached. Each tab's count follows the search, so every tab says what it holds.
 */
export async function listLeads(auth: AuthContext, query: LeadListQuery): Promise<LeadList> {
  await refreshStaleScores(auth.workspaceId);
  const { page, pageSize } = query;
  const base = and(matchesFilters(auth.workspaceId, { ...EMPTY_FILTERS, q: query.q }), inArray(opportunities.status, LEAD_STATUSES));
  const tabFilter = (tab: LeadTab) => (tab === "all" ? undefined : contactReach(tab));

  const [rows, [countRow]] = await Promise.all([
    summaryQuery().where(and(base, tabFilter(query.tab))).orderBy(...priorityOrder()).limit(pageSize).offset(offsetOf({ page, pageSize })),
    db
      .select(
        Object.fromEntries(
          LEAD_TABS.map((tab) => [tab, tab === "all" ? sql<number>`count(*)::int` : sql<number>`(count(*) filter (where ${contactReach(tab)}))::int`]),
        ) as Record<LeadTab, SQL<number>>,
      )
      .from(opportunities)
      .innerJoin(companies, eq(companies.id, opportunities.companyId))
      .where(base),
  ]);
  const counts = countRow as Record<LeadTab, number>;
  return { items: rows.map(toSummary), counts, total: counts[query.tab], page, pageSize };
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
  return and(matchesFilters(workspaceId, filters), inArray(opportunities.status, [...STATUS_GROUPS[group]]));
}

/** Every filter except status. Empty filters add no condition. Expects `companies` to be joined. */
function matchesFilters(workspaceId: string, filters: OpportunityFilters): SQL | undefined {
  const any = <T>(values: T[], condition: (values: T[]) => SQL) => (values.length > 0 ? condition(values) : undefined);
  return and(
    eq(opportunities.workspaceId, workspaceId),
    companySearch(filters.q),
    any(filters.types, (types) => inArray(opportunities.type, types)),
    any(filters.services, (ids) => inArray(opportunities.serviceId, ids)),
    any(filters.urgency, (levels) => inArray(opportunities.urgency, levels)),
    any(filters.industries, (slugs) => inArray(companies.industry, slugs)),
    any(
      filters.countries,
      (codes) => sql`exists (
        select 1 from ${companyLocations}
        where ${companyLocations.companyId} = ${companies.id} and ${companyLocations.type} = 'headquarters'
          and ${inArray(companyLocations.country, codes)}
      )`,
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
      : gte(opportunities.latestSignalAt, sql`now() - make_interval(days => ${filters.withinDays})`),
    filters.contact === null ? undefined : contactReach(filters.contact),
  );
}

function companySearch(q: string): SQL | undefined {
  if (!q) return undefined;
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return or(ilike(companies.canonicalName, pattern), ilike(companies.domain, pattern));
}

export async function getOpportunity(auth: AuthContext, opportunityId: string): Promise<OpportunityDetail> {
  const row = await findRow(auth, opportunityId);
  const { opportunity } = row;

  const [links, companySignals, companyPeople, saved, feedback] = await Promise.all([
    db
      .select({ signalId: opportunitySignals.signalId, role: opportunitySignals.role })
      .from(opportunitySignals)
      .where(eq(opportunitySignals.opportunityId, opportunity.id)),
    listCompanySignals(auth, opportunity.companyId),
    loadCompanyPeople(auth.workspaceId, opportunity.companyId),
    db
      .select({ listId: savedOpportunities.listId })
      .from(savedOpportunities)
      .where(and(eq(savedOpportunities.opportunityId, opportunity.id), eq(savedOpportunities.workspaceId, auth.workspaceId))),
    listFeedback(auth, opportunity.id),
  ]);
  const companyContacts = await loadCompanyContacts(opportunity.companyId);
  const roleOf = new Map(links.map((l) => [l.signalId, l.role]));
  const roleOrder = { primary: 0, corroborating: 1, negative: 2 } as const;

  return {
    ...toSummary(row),
    suggestedAction: opportunity.suggestedAction,
    notes: opportunity.notes,
    factors: hasFactors(opportunity.scoreFactors) ? opportunity.scoreFactors : null,
    signals: companySignals
      .filter((s) => roleOf.has(s.id))
      .map((s) => ({ ...s, role: roleOf.get(s.id)! }))
      .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || b.occurredOn.localeCompare(a.occurredOn)),
    contactDetails: companyPeople.find((p) => p.id === opportunity.primaryPersonId) ?? null,
    companyContacts,
    scoredAt: opportunity.scoredAt.toISOString(),
    listIds: saved.map((s) => s.listId),
    feedback,
  };
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

/** Changes status and/or notes. Scores are owned by the scoring engine and can't be edited. */
export async function updateOpportunity(
  auth: AuthContext,
  opportunityId: string,
  input: UpdateOpportunityValues,
): Promise<OpportunityDetail> {
  const { opportunity } = await findRow(auth, opportunityId);
  await db.transaction(async (tx) => {
    await tx
      .update(opportunities)
      .set({
        ...(input.status !== undefined && { status: input.status }),
        ...(input.notes !== undefined && { notes: input.notes }),
      })
      .where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, auth.workspaceId)));
    if (input.status !== undefined && input.status !== opportunity.status) {
      await tx.insert(auditLogs).values({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "opportunity.status_changed",
        entityType: "opportunity",
        entityId: opportunityId,
        metadata: { from: opportunity.status, to: input.status },
      });
    }
  });
  return getOpportunity(auth, opportunityId);
}

async function findRow(auth: AuthContext, opportunityId: string): Promise<SummaryRow> {
  const [row] = await summaryQuery()
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Opportunity not found.");
  return row;
}

export function hasFactors(value: unknown): value is Record<ScoreFactor, OpportunityFactor> {
  return typeof value === "object" && value !== null && "intent" in value;
}

export function toSummary(row: SummaryRow): OpportunitySummary {
  const { opportunity } = row;
  const factors = hasFactors(opportunity.scoreFactors) ? opportunity.scoreFactors : null;
  return {
    id: opportunity.id,
    company: { id: opportunity.companyId, name: row.companyName, domain: row.companyDomain },
    service: opportunity.serviceId && row.serviceName ? { id: opportunity.serviceId, name: row.serviceName } : null,
    type: opportunity.type,
    score: factors ? opportunity.opportunityScore : null,
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
    status: opportunity.status,
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
