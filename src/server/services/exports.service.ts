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
  people,
  savedOpportunities,
  services,
  signals,
} from "@/db/schema";
import { toCsv, type CsvValue } from "@/lib/csv";
import type { OpportunityExportQuery } from "@/lib/validation/opportunities";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { refreshStaleScores } from "@/server/scoring/rescore";
import { companyContactFromOsm, companyEmail, companyPhone, feedFilter, priorityOrder, signalEvidenceLink } from "./opportunities.service";
import { STATUS_LABELS } from "@/lib/domain/opportunities";
import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL } from "@/lib/domain/sources";

/**
 * Columns of the CSV export, in order: what a salesperson works from, as on the Leads page. Who to
 * talk to and how (the person's own phone and email first, else the company's line), why now and
 * where it was found, and where it stands. Rows come in priority order; scores stay in the app.
 */
export const EXPORT_COLUMNS = [
  "company",
  "website",
  "contact_name",
  "contact_title",
  "phone",
  "email",
  // Named contact / Company line / No contact yet, with the OpenStreetMap credit (ODbL) when it applies.
  "contact_type",
  "matched_service",
  "signal",
  "signal_link",
  "status",
  "latest_signal_date",
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
  companyName: companies.canonicalName,
  domain: companies.domain,
  personName: sql<string | null>`case when ${suppressed} then null else ${people.name} end`,
  jobTitle: sql<string | null>`case when ${suppressed} then null else ${companyPeople.title} end`,
  email: sql<string | null>`case when ${suppressed} then null else ${contact("email")} end`,
  phone: sql<string | null>`case when ${suppressed} then null else ${contact("phone")} end`,
  /** Why now: the primary signal's summary, else the newest supporting one's. */
  signal: sql<string | null>`(
    select ${signals.summary}
    from ${opportunitySignals} join ${signals} on ${signals.id} = ${opportunitySignals.signalId}
    where ${opportunitySignals.opportunityId} = ${opportunities.id} and ${opportunitySignals.role} <> 'negative'
    order by (${opportunitySignals.role} = 'primary') desc, ${signals.occurredAt} desc
    limit 1
  )`,
  latestSignalAt: opportunities.latestSignalAt,
  /** Evidence link of the primary signal, else of the newest supporting one. */
  sourceUrl: sql<string | null>`(${signalEvidenceLink}) ->> 'url'`,
  status: opportunities.status,
  serviceName: services.name,
  companyPhone,
  companyEmail,
  companyContactFromOsm,
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
      (row): ExportRow => {
        // The person's own line first, else the company's, as on the Leads page.
        const phone = row.phone ?? row.companyPhone;
        const email = row.email ?? row.companyEmail;
        const named = Boolean(row.phone || row.email);
        const companyLine = (!row.phone && row.companyPhone) || (!row.email && row.companyEmail);
        const contactType = named ? "Named contact" : phone || email ? "Company line" : "No contact yet";
        return {
          company: row.companyName,
          website: row.domain,
          contact_name: row.personName,
          contact_title: row.jobTitle,
          phone,
          email,
          contact_type:
            companyLine && row.companyContactFromOsm
              ? `${contactType}; company line from OpenStreetMap (${OSM_ATTRIBUTION}, ${OSM_COPYRIGHT_URL}), not verified`
              : contactType,
          matched_service: row.serviceName,
          signal: row.signal,
          signal_link: row.sourceUrl,
          status: STATUS_LABELS[row.status],
          latest_signal_date: row.latestSignalAt?.toISOString().slice(0, 10),
        };
      },
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
