import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { isForeignKeyViolation } from "@/db/errors";
import {
  auditLogs,
  companies,
  companyPeople,
  signalEvidence,
  signalServiceCategories,
  signals,
} from "@/db/schema";
import type { Signal, SignalAnalysis } from "@/lib/api/types";
import { findDuplicateSignal, normalizeSourceUrl } from "@/lib/signals/duplicates";
import type { AnalyzeSignalValues, SignalValues } from "@/lib/validation/signals";
import { analyzeSignal } from "@/server/ai/signal-analysis";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
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
      const [row] = await tx
        .insert(signals)
        .values({ workspaceId: auth.workspaceId, companyId, createdById: auth.userId, ...signalColumns(input) })
        .returning();
      await writeDetails(tx, row.id, input);
      await audit(tx, auth, "signal.created", row.id, companyId);
      const [signal] = await toDtos(tx, [row]);
      return signal;
    }),
  );
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

export async function deleteSignal(auth: AuthContext, signalId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(signals)
      .where(and(eq(signals.id, signalId), eq(signals.workspaceId, auth.workspaceId)))
      .returning({ id: signals.id, companyId: signals.companyId });
    if (!row) throw notFound();
    await audit(tx, auth, "signal.deleted", row.id, row.companyId);
  });
}

function signalColumns(input: SignalValues) {
  return {
    personId: input.personId,
    signalType: input.signalType,
    intentLevel: input.intentLevel,
    urgency: input.urgency,
    summary: input.summary,
    evidenceLabel: input.evidenceLabel,
    source: input.source,
    // Confidence describes the model's classification; it has no meaning for manual entries.
    confidence: input.source === "ai" ? input.confidence : null,
    occurredAt: toOccurredAt(input.occurredOn),
  };
}

async function writeDetails(tx: Tx, signalId: string, input: SignalValues): Promise<void> {
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
  const [categories, evidence] = await Promise.all([
    conn.select().from(signalServiceCategories).where(inArray(signalServiceCategories.signalId, ids)),
    conn.select().from(signalEvidence).where(inArray(signalEvidence.signalId, ids)),
  ]);

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

  const duplicate = findDuplicateSignal(existing, input, excludeId);
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

async function audit(tx: Tx, auth: AuthContext, action: string, signalId: string, companyId: string) {
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
