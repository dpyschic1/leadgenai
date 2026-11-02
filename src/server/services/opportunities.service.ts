import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLogs,
  companies,
  companyLocations,
  companyPeople,
  opportunities,
  opportunitySignals,
  people,
  savedOpportunities,
  services,
  signals,
  signalTypes,
} from "@/db/schema";
import type { OpportunityDetail, OpportunityFactor, OpportunityList, OpportunitySummary } from "@/lib/api/types";
import { STATUS_GROUPS, type StatusGroup } from "@/lib/domain/opportunities";
import type { OpportunityFilters, OpportunityListQuery, UpdateOpportunityValues } from "@/lib/validation/opportunities";
import type { ScoreFactor } from "@/lib/validation/scoring";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { refreshStaleScores } from "@/server/scoring/rescore";
import { loadCompanyPeople } from "./people.service";
import { listCompanySignals } from "./signals.service";

/** Upper bound for the feed until it gets pagination. */
const LIST_LIMIT = 500;

const summaryColumns = {
  opportunity: opportunities,
  companyName: companies.canonicalName,
  companyDomain: companies.domain,
  serviceName: services.name,
  contactName: people.name,
  contactTitle: companyPeople.title,
  signalCount: sql<number>`(select count(*)::int from ${opportunitySignals} where ${opportunitySignals.opportunityId} = ${opportunities.id} and ${opportunitySignals.role} <> 'negative')`,
};

export type SummaryRow = {
  opportunity: typeof opportunities.$inferSelect;
  companyName: string;
  companyDomain: string | null;
  serviceName: string | null;
  contactName: string | null;
  contactTitle: string | null;
  signalCount: number;
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

/** The feed: highest priority first. Aged scores are refreshed before reading. */
export async function listOpportunities(auth: AuthContext, query: OpportunityListQuery): Promise<OpportunityList> {
  await refreshStaleScores(auth.workspaceId);

  const [rows, countRows] = await Promise.all([
    summaryQuery()
      .where(feedFilter(auth.workspaceId, query.group, query))
      .orderBy(...priorityOrder())
      .limit(LIST_LIMIT),
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

  return { items: rows.map(toSummary), counts };
}

/** Feed order: highest priority first, unscored last, then freshest evidence, then by name. */
export function priorityOrder() {
  return [
    sql`${opportunities.opportunityScore} desc nulls last`,
    desc(opportunities.latestSignalAt),
    asc(companies.canonicalName),
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

  const [links, companySignals, companyPeople, saved] = await Promise.all([
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
  ]);
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
    scoredAt: opportunity.scoredAt.toISOString(),
    listIds: saved.map((s) => s.listId),
  };
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
        ? { id: opportunity.primaryPersonId, name: row.contactName, title: row.contactTitle }
        : null,
    updatedAt: opportunity.updatedAt.toISOString(),
  };
}
