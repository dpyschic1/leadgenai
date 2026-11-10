import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { isForeignKeyViolation } from "@/db/errors";
import {
  auditLogs,
  companies,
  companyPeople,
  jobPostings,
  signalEvidence,
  sourceRecords,
  signalServiceCategories,
  signals,
} from "@/db/schema";
import type { Signal, SignalAnalysis } from "@/lib/api/types";
import { findDuplicateSignal, normalizeSourceUrl } from "@/lib/signals/duplicates";
import type { SourceSlug } from "@/lib/domain/sources";
import type { AnalyzeSignalValues, DetectedSignalValues, SignalValues } from "@/lib/validation/signals";
import { analyzeSignal } from "@/server/ai/signal-analysis";
import type { Actor } from "@/server/auth/actor";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { SIGNAL_DELETED_REASON } from "@/server/jobs/job-signal";
import { getReferenceData } from "./reference-data.service";

type SignalRow = typeof signals.$inferSelect;

/** Dates are stored at midday UTC, so the calendar day never shifts between timezones. */
const toOccurredAt = (isoDate: string) => new Date(`${isoDate}T12:00:00Z`);
const toOccurredOn = (date: Date) => date.toISOString().slice(0, 10);

/** A company's signals, newest event first. */
export async function listCompanySignals(auth: AuthContext, companyId: string): Promise<Signal[]> {
  await assertCompany(auth, companyId);
  const rows = await db
    .select()
    .from(signals)
    .where(and(eq(signals.companyId, companyId), eq(signals.workspaceId, auth.workspaceId)))
    .orderBy(desc(signals.occurredAt), desc(signals.createdAt));
  return toDtos(db, rows);
}

/** The workspace's most recently recorded signals. */
export async function listRecentSignals(auth: AuthContext, limit: number): Promise<Signal[]> {
  const rows = await db
    .select()
    .from(signals)
    .where(eq(signals.workspaceId, auth.workspaceId))
    .orderBy(desc(signals.createdAt))
    .limit(limit);
  return toDtos(db, rows);
}

/** Runs the AI classification for a company's pasted source. Nothing is saved. */
export async function suggestSignal(auth: AuthContext, input: AnalyzeSignalValues): Promise<SignalAnalysis> {
  const [company] = await db
    .select({ name: companies.canonicalName, domain: companies.domain, industry: companies.industry })
    .from(companies)
    .where(and(eq(companies.id, input.companyId), eq(companies.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!company) throw new AppError("NOT_FOUND", "Company not found.");

  const ref = await getReferenceData();
  const industryName = ref.industries.find((i) => i.slug === company.industry)?.name ?? null;
  return analyzeSignal(input, { ...company, industry: industryName }, ref);
}

export async function createSignal(auth: AuthContext, companyId: string, input: SignalValues): Promise<Signal> {
  await assertCompany(auth, companyId);
  await assertPersonAtCompany(auth, companyId, input.personId);

  return translateErrors(() =>
    db.transaction(async (tx) => {
      await assertNotDuplicate(tx, auth, companyId, input);
      const row = await insertSignal(tx, auth, companyId, input);
      const [signal] = await toDtos(tx, [row]);
      return signal;
    }),
  );
}

/**
 * Records a signal found automatically (job board, website, register, tender) inside the caller's
 * transaction. The company is the caller's to check. When the company already has the same
 * signal (same type and source) nothing is added and that signal's id is returned instead.
 */
export async function insertDetectedSignal(
  tx: Tx,
  actor: Actor,
  companyId: string,
  input: DetectedSignalValues,
  sourceRecordId: string | null = null,
): Promise<{ id: string; created: boolean }> {
  const duplicate = await findDuplicate(tx, actor, companyId, input);
  if (duplicate) return { id: duplicate.id, created: false };
  const row = await insertSignal(tx, actor, companyId, input, sourceRecordId);
  return { id: row.id, created: true };
}

/**
 * Background ingestion: replaces a found signal's content (e.g. a job's rule-based signal upgraded
 * with the shared AI analysis). Its links (opportunities, jobs) stay. The caller re-scores.
 */
export async function replaceDetectedSignal(tx: Tx, actor: Actor, signalId: string, input: DetectedSignalValues): Promise<void> {
  const [row] = await tx
    .update(signals)
    .set(signalColumns(input))
    .where(and(eq(signals.id, signalId), eq(signals.workspaceId, actor.workspaceId)))
    .returning({ companyId: signals.companyId });
  if (!row) return;
  await tx.delete(signalServiceCategories).where(eq(signalServiceCategories.signalId, signalId));
  await tx.delete(signalEvidence).where(eq(signalEvidence.signalId, signalId));
  await writeDetails(tx, signalId, input);
  await audit(tx, actor, "signal.updated", signalId, row.companyId);
}

async function insertSignal(
  tx: Tx,
  auth: Actor,
  companyId: string,
  input: DetectedSignalValues,
  sourceRecordId: string | null = null,
): Promise<SignalRow> {
  const [row] = await tx
    .insert(signals)
    .values({ workspaceId: auth.workspaceId, companyId, createdById: auth.userId, sourceRecordId, ...signalColumns(input) })
    .returning();
  await writeDetails(tx, row.id, input);
  await audit(tx, auth, "signal.created", row.id, companyId);
  return row;
}

export async function updateSignal(auth: AuthContext, signalId: string, input: SignalValues): Promise<Signal> {
  const existing = await findSignal(auth, signalId);
  await assertPersonAtCompany(auth, existing.companyId, input.personId);

  return translateErrors(() =>
    db.transaction(async (tx) => {
      await assertNotDuplicate(tx, auth, existing.companyId, input, signalId);
      const [row] = await tx
        .update(signals)
        .set(signalColumns(input))
        .where(and(eq(signals.id, signalId), eq(signals.workspaceId, auth.workspaceId)))
        .returning();
      await tx.delete(signalServiceCategories).where(eq(signalServiceCategories.signalId, signalId));
      await tx.delete(signalEvidence).where(eq(signalEvidence.signalId, signalId));
      await writeDetails(tx, signalId, input);
      await audit(tx, auth, "signal.updated", signalId, row.companyId);
      const [signal] = await toDtos(tx, [row]);
      return signal;
    }),
  );
}

/** Deletes the signal; returns its company's id so the caller can re-score that company. */
export async function deleteSignal(auth: AuthContext, signalId: string): Promise<string> {
  return db.transaction(async (tx) => {
    // A signal recorded from a job: mark the job skipped, so the next fetch doesn't record it again.
    await tx
      .update(jobPostings)
      .set({ triage: "skipped", triageReason: SIGNAL_DELETED_REASON })
      .where(and(eq(jobPostings.signalId, signalId), eq(jobPostings.workspaceId, auth.workspaceId)));
    const [row] = await tx
      .delete(signals)
      .where(and(eq(signals.id, signalId), eq(signals.workspaceId, auth.workspaceId)))
      .returning({ id: signals.id, companyId: signals.companyId });
    if (!row) throw notFound();
    await audit(tx, auth, "signal.deleted", row.id, row.companyId);
    return row.companyId;
  });
}

function signalColumns(input: DetectedSignalValues) {
  return {
    personId: input.personId,
    signalType: input.signalType,
    intentLevel: input.intentLevel,
    urgency: input.urgency,
    summary: input.summary,
    evidenceLabel: input.evidenceLabel,
    source: input.source,
    // Confidence describes how sure the AI or a source's rule is; it has no meaning for manual entries.
    confidence: input.source === "manual" ? null : input.confidence,
    occurredAt: toOccurredAt(input.occurredOn),
  };
}

async function writeDetails(tx: Tx, signalId: string, input: DetectedSignalValues): Promise<void> {
  if (input.serviceCategories.length > 0) {
    await tx
      .insert(signalServiceCategories)
      .values(input.serviceCategories.map((categorySlug) => ({ signalId, categorySlug })));
  }
  if (input.sourceUrl || input.excerpt) {
    await tx.insert(signalEvidence).values({ signalId, sourceUrl: input.sourceUrl, excerpt: input.excerpt });
  }
}

/** Loads categories and evidence for the given signals and assembles the DTOs. */
async function toDtos(conn: Tx | typeof db, rows: SignalRow[]): Promise<Signal[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const recordIds = rows.flatMap((row) => (row.sourceRecordId ? [row.sourceRecordId] : []));
  const [categories, evidence, records] = await Promise.all([
    conn.select().from(signalServiceCategories).where(inArray(signalServiceCategories.signalId, ids)),
    conn.select().from(signalEvidence).where(inArray(signalEvidence.signalId, ids)),
    recordIds.length
      ? conn
          .select({ id: sourceRecords.id, sourceSlug: sourceRecords.sourceSlug })
          .from(sourceRecords)
          .where(inArray(sourceRecords.id, recordIds))
      : Promise.resolve([]),
  ]);
  const originOf = new Map(records.map((r) => [r.id, r.sourceSlug as SourceSlug]));

  return rows.map((row) => {
    const proof = evidence.find((e) => e.signalId === row.id);
    return {
      id: row.id,
      companyId: row.companyId,
      personId: row.personId,
      signalType: row.signalType,
      intentLevel: row.intentLevel,
      urgency: row.urgency,
      serviceCategories: categories.filter((c) => c.signalId === row.id).map((c) => c.categorySlug),
      summary: row.summary,
      evidenceLabel: row.evidenceLabel,
      source: row.source,
      confidence: row.confidence,
      occurredOn: toOccurredOn(row.occurredAt),
      evidence: proof ? { sourceUrl: proof.sourceUrl, excerpt: proof.excerpt } : null,
      origin: row.sourceRecordId ? (originOf.get(row.sourceRecordId) ?? null) : null,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/**
 * Rejects a signal that repeats one the company already has (same type and same source; see
 * `findDuplicateSignal`). A per-company advisory lock serialises concurrent saves, so two people
 * recording the same post at once can't both get through.
 */
async function assertNotDuplicate(
  tx: Tx,
  auth: AuthContext,
  companyId: string,
  input: SignalValues,
  excludeId?: string,
): Promise<void> {
  const duplicate = await findDuplicate(tx, auth, companyId, input, excludeId);
  if (!duplicate) return;

  const when = new Date(`${duplicate.occurredOn}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const message = `This source is already recorded as the same type of signal (dated ${when}).`;
  const url = normalizeSourceUrl(input.sourceUrl);
  const field = url !== null && url === normalizeSourceUrl(duplicate.sourceUrl) ? "sourceUrl" : "excerpt";
  throw new AppError("ALREADY_EXISTS", message, { [field]: [message] });
}

/** The company's signal that `input` would repeat, if any. Takes the company's signal lock first. */
async function findDuplicate(tx: Tx, auth: Actor, companyId: string, input: DetectedSignalValues, excludeId?: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`signals:${companyId}`}))`);

  const rows = await tx
    .select()
    .from(signals)
    .where(and(eq(signals.companyId, companyId), eq(signals.workspaceId, auth.workspaceId)));
  const existing = (await toDtos(tx, rows)).map((signal) => ({
    ...signal,
    sourceUrl: signal.evidence?.sourceUrl ?? null,
    excerpt: signal.evidence?.excerpt ?? null,
  }));
  return findDuplicateSignal(existing, input, excludeId);
}

async function findSignal(auth: AuthContext, signalId: string): Promise<SignalRow> {
  const [row] = await db
    .select()
    .from(signals)
    .where(and(eq(signals.id, signalId), eq(signals.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

async function assertCompany(auth: AuthContext, companyId: string): Promise<void> {
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!company) throw new AppError("NOT_FOUND", "Company not found.");
}

/** The FK only guarantees the person is in the workspace; they must also work at this company. */
async function assertPersonAtCompany(auth: AuthContext, companyId: string, personId: string | null): Promise<void> {
  if (!personId) return;
  const [link] = await db
    .select({ personId: companyPeople.personId })
    .from(companyPeople)
    .where(
      and(
        eq(companyPeople.companyId, companyId),
        eq(companyPeople.personId, personId),
        eq(companyPeople.workspaceId, auth.workspaceId),
      ),
    )
    .limit(1);
  if (!link) {
    throw new AppError("VALIDATION_FAILED", "Pick someone who works at this company.", {
      personId: ["Pick someone who works at this company."],
    });
  }
}

async function audit(tx: Tx, auth: Actor, action: string, signalId: string, companyId: string) {
  await tx.insert(auditLogs).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    action,
    entityType: "signal",
    entityId: signalId,
    metadata: { companyId },
  });
}

async function translateErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new AppError("VALIDATION_FAILED", "A selected signal type or category no longer exists. Refresh and try again.");
    }
    throw error;
  }
}

function notFound(): AppError {
  return new AppError("NOT_FOUND", "Signal not found.");
}
