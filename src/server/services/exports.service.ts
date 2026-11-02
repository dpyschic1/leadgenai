import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLogs,
  companies,
  companyPeople,
  contactPoints,
  lists,
  opportunities,
  opportunitySignals,
  opportunityTypes,
  people,
  savedOpportunities,
  services,
  signalEvidence,
  signals,
} from "@/db/schema";
import { toCsv, type CsvValue } from "@/lib/csv";
import type { OpportunityExportQuery } from "@/lib/validation/opportunities";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { refreshStaleScores } from "@/server/scoring/rescore";
import { feedFilter, priorityOrder } from "./opportunities.service";

/** Columns of the CSV export, in order: the PRD §17 field list, then status and matched service. */
export const EXPORT_COLUMNS = [
  "opportunity_id",
  "company_name",
  "domain",
  "person_name",
  "job_title",
  "email",
  "phone",
  "opportunity_type",
  "problem",
  "why_now",
  "intent_score",
  "icp_score",
  "identity_confidence",
  "service_fit",
  "opportunity_score",
  "latest_signal_date",
  "source_url",
  "status",
  "matched_service",
] as const;

type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], CsvValue>;

/** A synchronous export is fine at MVP volumes; past this it should become a background job (SRS §17). */
const EXPORT_LIMIT = 5000;

/** A suppressed person's identity and contact details never leave the workspace (SRS SEC-007). */
const suppressed = sql`${people.identityStatus} = 'suppressed'`;

/** The person's best email/phone: primary first, never one known to be invalid. */
const contact = (type: "email" | "phone") => sql<string | null>`(
  select ${contactPoints.value} from ${contactPoints}
  where ${contactPoints.personId} = ${people.id} and ${contactPoints.type} = ${type} and ${contactPoints.verification} <> 'invalid'
  order by ${contactPoints.isPrimary} desc, ${contactPoints.createdAt}
  limit 1
)`;

const exportColumns = {
  id: opportunities.id,
  companyName: companies.canonicalName,
  domain: companies.domain,
  personName: sql<string | null>`case when ${suppressed} then null else ${people.name} end`,
  jobTitle: sql<string | null>`case when ${suppressed} then null else ${companyPeople.title} end`,
  email: sql<string | null>`case when ${suppressed} then null else ${contact("email")} end`,
  phone: sql<string | null>`case when ${suppressed} then null else ${contact("phone")} end`,
  type: opportunityTypes.name,
  problem: opportunities.problem,
  /** The supporting signals' summaries, newest first. */
  whyNow: sql<string | null>`(
    select string_agg(${signals.summary}, ' | ' order by ${signals.occurredAt} desc)
    from ${opportunitySignals} join ${signals} on ${signals.id} = ${opportunitySignals.signalId}
    where ${opportunitySignals.opportunityId} = ${opportunities.id} and ${opportunitySignals.role} <> 'negative'
  )`,
  /** Unscored opportunities (no positive signal left) export blank scores, not zeros. */
  scored: sql<boolean>`${opportunities.scoreFactors} ? 'intent'`,
  intentScore: opportunities.intentScore,
  icpScore: opportunities.icpScore,
  identityConfidence: opportunities.identityConfidence,
  serviceFit: opportunities.serviceFit,
  opportunityScore: opportunities.opportunityScore,
  latestSignalAt: opportunities.latestSignalAt,
  /** Evidence link of the primary signal, else of the newest supporting one. */
  sourceUrl: sql<string | null>`(
    select ${signalEvidence.sourceUrl}
    from ${opportunitySignals} join ${signalEvidence} on ${signalEvidence.signalId} = ${opportunitySignals.signalId}
    where ${opportunitySignals.opportunityId} = ${opportunities.id} and ${opportunitySignals.role} <> 'negative'
      and ${signalEvidence.sourceUrl} is not null
    order by (${opportunitySignals.role} = 'primary') desc, ${signalEvidence.capturedAt} desc
    limit 1
  )`,
  status: opportunities.status,
  serviceName: services.name,
};

export type OpportunityExport = { filename: string; csv: string; count: number };

/** Exports a saved list (every status), or the feed as filtered on screen, to CSV. */
export async function exportOpportunities(auth: AuthContext, query: OpportunityExportQuery): Promise<OpportunityExport> {
  await refreshStaleScores(auth.workspaceId);

  const { listId, group, ...filters } = query;
  const list = listId ? await findList(auth, listId) : null;

  const base = db
    .select(exportColumns)
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .innerJoin(opportunityTypes, eq(opportunityTypes.slug, opportunities.type))
    .leftJoin(services, eq(services.id, opportunities.serviceId))
    .leftJoin(people, eq(people.id, opportunities.primaryPersonId))
    .leftJoin(
      companyPeople,
      and(eq(companyPeople.companyId, opportunities.companyId), eq(companyPeople.personId, opportunities.primaryPersonId)),
    );

  const rows = await (list
    ? base
        .innerJoin(savedOpportunities, eq(savedOpportunities.opportunityId, opportunities.id))
        .where(and(eq(savedOpportunities.listId, list.id), eq(opportunities.workspaceId, auth.workspaceId)))
    : base.where(feedFilter(auth.workspaceId, group, filters))
  )
    .orderBy(...priorityOrder())
    .limit(EXPORT_LIMIT);

  await db.insert(auditLogs).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    action: "opportunities.exported",
    entityType: list ? "list" : "opportunity",
    entityId: list?.id,
    metadata: { format: "csv", count: rows.length, ...(list ? { listId: list.id } : { group, filters }) },
  });

  const csv = toCsv(
    EXPORT_COLUMNS,
    rows.map(
      (row): ExportRow => ({
        opportunity_id: row.id,
        company_name: row.companyName,
        domain: row.domain,
        person_name: row.personName,
        job_title: row.jobTitle,
        email: row.email,
        phone: row.phone,
        opportunity_type: row.type,
        problem: row.problem,
        why_now: row.whyNow,
        intent_score: row.scored ? row.intentScore : null,
        icp_score: row.scored ? row.icpScore : null,
        identity_confidence: row.scored ? row.identityConfidence : null,
        service_fit: row.scored ? row.serviceFit : null,
        opportunity_score: row.scored ? row.opportunityScore : null,
        latest_signal_date: row.latestSignalAt?.toISOString().slice(0, 10),
        source_url: row.sourceUrl,
        status: row.status,
        matched_service: row.serviceName,
      }),
    ),
  );

  return { filename: exportFilename(list?.name ?? group), csv, count: rows.length };
}

async function findList(auth: AuthContext, listId: string) {
  const [list] = await db
    .select({ id: lists.id, name: lists.name })
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!list) throw new AppError("NOT_FOUND", "List not found.");
  return list;
}

/** e.g. "opportunities-contact-today-2026-10-29.csv": ASCII only, safe in a Content-Disposition header. */
function exportFilename(label: string): string {
  const slug = label
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `opportunities-${slug ? `${slug}-` : ""}${new Date().toISOString().slice(0, 10)}.csv`;
}
