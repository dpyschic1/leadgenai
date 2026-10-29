import "server-only";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, companies, companyPeople, opportunities, opportunitySignals, people, services } from "@/db/schema";
import type { OpportunityDetail, OpportunityFactor, OpportunityList, OpportunitySummary } from "@/lib/api/types";
import { STATUS_GROUPS, type StatusGroup } from "@/lib/domain/opportunities";
import type { OpportunityListQuery, UpdateOpportunityValues } from "@/lib/validation/opportunities";
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

type SummaryRow = {
  opportunity: typeof opportunities.$inferSelect;
  companyName: string;
  companyDomain: string | null;
  serviceName: string | null;
  contactName: string | null;
  contactTitle: string | null;
  signalCount: number;
};

function baseQuery() {
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

  const group: StatusGroup = query.group ?? "open";
  const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
  const search = pattern ? or(ilike(companies.canonicalName, pattern), ilike(companies.domain, pattern)) : undefined;

  const [rows, countRows] = await Promise.all([
    baseQuery()
      .where(
        and(
          eq(opportunities.workspaceId, auth.workspaceId),
          inArray(opportunities.status, [...STATUS_GROUPS[group]]),
          search,
        ),
      )
      .orderBy(sql`${opportunities.opportunityScore} desc nulls last`, desc(opportunities.latestSignalAt), asc(companies.canonicalName))
      .limit(LIST_LIMIT),
    db
      .select({ status: opportunities.status, count: sql<number>`count(*)::int` })
      .from(opportunities)
      .innerJoin(companies, eq(companies.id, opportunities.companyId))
      .where(and(eq(opportunities.workspaceId, auth.workspaceId), search))
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

export async function getOpportunity(auth: AuthContext, opportunityId: string): Promise<OpportunityDetail> {
  const row = await findRow(auth, opportunityId);
  const { opportunity } = row;

  const [links, companySignals, companyPeople] = await Promise.all([
    db
      .select({ signalId: opportunitySignals.signalId, role: opportunitySignals.role })
      .from(opportunitySignals)
      .where(eq(opportunitySignals.opportunityId, opportunity.id)),
    listCompanySignals(auth, opportunity.companyId),
    loadCompanyPeople(auth.workspaceId, opportunity.companyId),
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

/** Re-scores one opportunity now (e.g. before showing it if its score has aged). */

async function findRow(auth: AuthContext, opportunityId: string): Promise<SummaryRow> {
  const [row] = await baseQuery()
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Opportunity not found.");
  return row;
}

function hasFactors(value: unknown): value is Record<ScoreFactor, OpportunityFactor> {
  return typeof value === "object" && value !== null && "intent" in value;
}

function toSummary(row: SummaryRow): OpportunitySummary {
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
