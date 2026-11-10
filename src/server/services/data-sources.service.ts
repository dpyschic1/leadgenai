import "server-only";
import { and, desc, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLogs,
  companies,
  companyContactPoints,
  companyIdentifiers,
  companyJobBoards,
  companyLocations,
  ingestionJobs,
  signals,
  siteReads,
  sourceRecords,
  sources,
  workspaceSources,
} from "@/db/schema";
import type { CompanySources, DataSource, SourcesRunResult } from "@/lib/api/types";
import { JOB_KIND_SOURCE, SOURCE_DESCRIPTIONS, SOURCE_SLUGS, type IngestionJobKind, type SourceSlug } from "@/lib/domain/sources";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { enqueue } from "@/server/ingestion/queue";
import { queueChecksNow, runTick } from "@/server/ingestion/worker";
import { SOURCE_ADAPTERS } from "@/server/sources";
import { CQC_ATTRIBUTION } from "@/server/sources/cqc";
import { osmPlacesFor } from "@/server/sources/osm";
import { OVERTURE_ATTRIBUTION } from "@/server/sources/overture";

/** Settings → Data sources (FR-SIG-005, PRD §8.12), "Run now", and each company's provenance. */

const kindsOf = (slug: SourceSlug) =>
  (Object.entries(JOB_KIND_SOURCE) as [IngestionJobKind, SourceSlug][]).filter(([, s]) => s === slug).map(([kind]) => kind);

export async function listDataSources(auth: AuthContext): Promise<DataSource[]> {
  const [rows, switches, successes, failures] = await Promise.all([
    db.select().from(sources),
    db.select().from(workspaceSources).where(eq(workspaceSources.workspaceId, auth.workspaceId)),
    db
      .select({ kind: ingestionJobs.kind, at: max(ingestionJobs.finishedAt) })
      .from(ingestionJobs)
      .where(and(eq(ingestionJobs.workspaceId, auth.workspaceId), eq(ingestionJobs.status, "done")))
      .groupBy(ingestionJobs.kind),
    db
      .selectDistinctOn([ingestionJobs.kind], { kind: ingestionJobs.kind, at: ingestionJobs.finishedAt, message: ingestionJobs.lastError })
      .from(ingestionJobs)
      .where(and(eq(ingestionJobs.workspaceId, auth.workspaceId), eq(ingestionJobs.status, "failed")))
      .orderBy(ingestionJobs.kind, desc(ingestionJobs.finishedAt)),
  ]);

  return SOURCE_SLUGS.flatMap((slug) => {
    const row = rows.find((r) => r.slug === slug);
    // Sources we aren't allowed to use (e.g. FCA, restricted by its terms) aren't shown at all.
    if (!row || row.authorizationStatus !== "approved") return [];
    const kinds = kindsOf(slug);
    const lastSuccess = successes.filter((s) => kinds.includes(s.kind) && s.at).map((s) => s.at!.getTime());
    const failure = failures.filter((f) => kinds.includes(f.kind) && f.at).sort((a, b) => b.at!.getTime() - a.at!.getTime())[0];
    const success = lastSuccess.length ? Math.max(...lastSuccess) : null;
    return [
      {
        slug,
        name: row.name,
        description: SOURCE_DESCRIPTIONS[slug],
        authorization: row.authorizationStatus,
        enabled: switches.find((s) => s.sourceSlug === slug)?.enabled ?? true,
        configured: SOURCE_ADAPTERS[slug].isConfigured(),
        termsUrl: row.termsUrl,
        lastSuccessAt: success ? new Date(success).toISOString() : null,
        // A failure older than the last success is history, not a current problem.
        lastFailure: failure && (!success || failure.at!.getTime() > success) ? { at: failure.at!.toISOString(), message: failure.message ?? "Failed" } : null,
      },
    ];
  });
}

export async function setDataSourceEnabled(auth: AuthContext, slug: SourceSlug, enabled: boolean): Promise<DataSource[]> {
  await db.transaction(async (tx) => {
    await tx
      .insert(workspaceSources)
      .values({ workspaceId: auth.workspaceId, sourceSlug: slug, enabled })
      .onConflictDoUpdate({ target: [workspaceSources.workspaceId, workspaceSources.sourceSlug], set: { enabled } });
    await tx.insert(auditLogs).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: enabled ? "source.enabled" : "source.disabled",
      entityType: "source",
      metadata: { source: slug },
    });
  });
  return listDataSources(auth);
}

export async function getCompanySources(auth: AuthContext, companyId: string): Promise<CompanySources> {
  const [company] = await db
    .select({ sourceSlug: companies.sourceSlug, discoveredAt: companies.discoveredAt })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!company) throw new AppError("NOT_FOUND", "Company not found.");

  const [identifiers, contacts, records, [{ pending }]] = await Promise.all([
    db.select().from(companyIdentifiers).where(eq(companyIdentifiers.companyId, companyId)),
    db.select().from(companyContactPoints).where(eq(companyContactPoints.companyId, companyId)).orderBy(companyContactPoints.type),
    db
      .select()
      .from(sourceRecords)
      .where(and(eq(sourceRecords.companyId, companyId), eq(sourceRecords.workspaceId, auth.workspaceId)))
      .orderBy(desc(sourceRecords.observedAt))
      .limit(20),
    db
      .select({ pending: sql<number>`count(*)::int` })
      .from(ingestionJobs)
      .where(
        and(
          eq(ingestionJobs.workspaceId, auth.workspaceId),
          eq(ingestionJobs.entityId, companyId),
          inArray(ingestionJobs.status, ["queued", "running"]),
          sql`${ingestionJobs.runAfter} <= now() + interval '10 minutes'`,
        ),
      ),
  ]);

  const sites = await db
    .select()
    .from(companyLocations)
    .where(and(eq(companyLocations.companyId, companyId), isNotNull(companyLocations.externalId)))
    .orderBy(companyLocations.name);
  const openStreetMap = await osmPlacesFor(companyId);
  const usesCqc = records.some((r) => r.sourceSlug === "cqc") || sites.some((s) => s.sourceSlug === "cqc");
  const match = records.find((r) => r.recordType === "website_match");
  return {
    discoveredBy: (company.sourceSlug as SourceSlug | null) ?? null,
    discoveredAt: company.discoveredAt?.toISOString() ?? null,
    companyNumber: identifiers.find((i) => i.scheme === "gb_company_number")?.value ?? null,
    website: match
      ? { domain: String(match.data.domain), confidence: Number(match.data.confidence), matchedBy: String(match.data.matchedBy) }
      : null,
    contacts: contacts.map((c) => ({ type: c.type, value: c.value, source: (c.sourceSlug as SourceSlug | null) ?? null, observedAt: c.observedAt.toISOString() })),
    records: records
      .filter((r) => r.recordType !== "website_match")
      .map((r) => ({ source: r.sourceSlug as SourceSlug, recordType: r.recordType, url: r.url, observedAt: r.observedAt.toISOString() })),
    sites: sites.map((s) => ({ name: s.name ?? "Location", website: s.website, phone: s.phone, postalCode: s.postalCode, source: (s.sourceSlug as SourceSlug | null) ?? null })),
    openStreetMap,
    // The OpenStreetMap credit is shown with its own section (`openStreetMap`), linked.
    attributions: [
      ...(usesCqc ? [CQC_ATTRIBUTION] : []),
      ...(records.some((r) => r.sourceSlug === "overture") || contacts.some((c) => c.sourceSlug === "overture") ? [OVERTURE_ATTRIBUTION] : []),
    ],
    pendingJobs: pending,
  };
}

/**
 * "Run now": queues the workspace's discovery and tender checks for now, processes ~30 s of work
 * and reports what was added. The rest continues on the scheduler's next ticks.
 */
export async function runSourcesNow(auth: AuthContext): Promise<SourcesRunResult> {
  const counts = async () => {
    const [row] = await db.execute<{ companies: number; signals: number; pending: number }>(sql`
      select
        (select count(*)::int from ${companies} where ${companies.workspaceId} = ${auth.workspaceId} and ${companies.sourceSlug} is not null) as companies,
        (select count(*)::int from ${signals} where ${signals.workspaceId} = ${auth.workspaceId} and ${signals.sourceRecordId} is not null) as signals,
        (select count(*)::int from ${ingestionJobs} where ${ingestionJobs.workspaceId} = ${auth.workspaceId}
           and ${ingestionJobs.status} in ('queued', 'running') and ${ingestionJobs.runAfter} <= now() + interval '10 minutes') as pending`);
    return row;
  };
  const before = await counts();
  await queueChecksNow(auth.workspaceId);
  await runTick({ workspaceId: auth.workspaceId, budgetMs: 20_000 });
  const after = await counts();
  return { companiesAdded: after.companies - before.companies, signalsCreated: after.signals - before.signals, pendingJobs: after.pending };
}

/** "Refresh from sources": queues the company's checks now (register, website, job board). */
export async function refreshCompany(auth: AuthContext, companyId: string): Promise<void> {
  const [company] = await db
    .select({ id: companies.id, domain: companies.domain })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!company) throw new AppError("NOT_FOUND", "Company not found.");
  const [board] = await db.select({ id: companyJobBoards.companyId }).from(companyJobBoards).where(eq(companyJobBoards.companyId, companyId)).limit(1);

  // A routine re-check already queued for later is brought forward instead of duplicated.
  await db
    .update(ingestionJobs)
    .set({ runAfter: new Date() })
    .where(and(eq(ingestionJobs.workspaceId, auth.workspaceId), eq(ingestionJobs.entityId, companyId), eq(ingestionJobs.status, "queued")));
  await enqueue(db, { workspaceId: auth.workspaceId, kind: "enrich_company", entityId: companyId });
  if (company.domain) {
    // A person asked: read the site afresh, not the copy another workspace read this week.
    await db.update(siteReads).set({ readAt: new Date(0) }).where(eq(siteReads.domain, company.domain));
    await enqueue(db, { workspaceId: auth.workspaceId, kind: "scan_website", entityId: companyId });
  }
  if (board) await enqueue(db, { workspaceId: auth.workspaceId, kind: "scan_job_board", entityId: companyId });
}
