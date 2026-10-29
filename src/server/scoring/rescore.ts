import "server-only";
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  companies,
  companyLocations,
  opportunities,
  opportunitySignals,
  signalEvidence,
  signalServiceCategories,
  signals,
  signalTypes,
} from "@/db/schema";
import { getReferenceData } from "@/server/services/reference-data.service";
import { loadCompanyPeople } from "@/server/services/people.service";
import { loadWeights } from "@/server/services/scoring.service";
import { loadServices } from "@/server/services/services.service";
import { scoreCompany, type EngineInput, type EngineLabels } from "./engine";

/**
 * Keeps opportunities in step with their inputs. Called after anything that changes a score
 * (signals, people, company details, services, weights), and for rows scored too long ago, since
 * recency changes with time alone. Scores are recomputed; status and notes are never touched.
 */

/** Rows scored longer ago than this are refreshed when the feed is read. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export async function rescoreCompany(workspaceId: string, companyId: string): Promise<void> {
  const input = await loadInput(workspaceId, companyId);
  if (!input) return; // company deleted; the opportunity went with it (FK cascade)

  const result = scoreCompany(input.engine);
  const [existing] = await db
    .select({ id: opportunities.id, status: opportunities.status })
    .from(opportunities)
    .where(and(eq(opportunities.companyId, companyId), eq(opportunities.workspaceId, workspaceId)))
    .limit(1);

  if (!result) {
    if (!existing) return;
    // Nothing positive left. An untouched opportunity disappears; one someone has worked on is
    // kept for its history, with its scores cleared.
    if (existing.status === "new") {
      await db.delete(opportunities).where(eq(opportunities.id, existing.id));
    } else {
      await db.transaction(async (tx) => {
        await tx
          .update(opportunities)
          .set({ opportunityScore: 0, intentScore: 0, icpScore: 0, identityConfidence: 0, serviceFit: 0, scoreFactors: {}, scoredAt: new Date() })
          .where(eq(opportunities.id, existing.id));
        await tx.delete(opportunitySignals).where(eq(opportunitySignals.opportunityId, existing.id));
      });
    }
    return;
  }

  const scores = {
    serviceId: result.serviceId,
    primaryPersonId: result.primaryPersonId,
    type: result.type,
    problem: result.problem,
    suggestedAction: result.suggestedAction,
    urgency: result.urgency,
    intentScore: result.factors.intent.score,
    icpScore: result.factors.icpFit.score,
    identityConfidence: result.factors.identity.score,
    serviceFit: result.factors.serviceFit.score,
    opportunityScore: result.opportunityScore,
    scoreFactors: result.factors,
    latestSignalAt: result.latestSignalAt,
    scoredAt: new Date(),
  };

  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(opportunities)
      .values({ workspaceId, companyId, ...scores })
      .onConflictDoUpdate({ target: opportunities.companyId, set: scores })
      .returning({ id: opportunities.id });

    await tx.delete(opportunitySignals).where(eq(opportunitySignals.opportunityId, row.id));
    await tx.insert(opportunitySignals).values(
      result.signalRoles.map((link) => ({
        workspaceId,
        opportunityId: row.id,
        signalId: link.signalId,
        role: link.role,
        weight: link.weight,
      })),
    );
  });
}

/** Re-scores every company with signals; used when services or weights change. */
export async function rescoreWorkspace(workspaceId: string): Promise<void> {
  const rows = await db
    .selectDistinct({ companyId: signals.companyId })
    .from(signals)
    .where(eq(signals.workspaceId, workspaceId));
  const withOpportunity = await db
    .select({ companyId: opportunities.companyId })
    .from(opportunities)
    .where(eq(opportunities.workspaceId, workspaceId));

  const companyIds = new Set([...rows, ...withOpportunity].map((r) => r.companyId));
  for (const companyId of companyIds) await rescoreCompany(workspaceId, companyId);
}

/** Refreshes opportunities whose scores have aged (recency moves on even without edits). */
export async function refreshStaleScores(workspaceId: string, now = new Date()): Promise<void> {
  const stale = await db
    .select({ companyId: opportunities.companyId })
    .from(opportunities)
    .where(and(eq(opportunities.workspaceId, workspaceId), lt(opportunities.scoredAt, new Date(now.getTime() - STALE_AFTER_MS))));
  for (const { companyId } of stale) await rescoreCompany(workspaceId, companyId);
}

/**
 * Runs a re-score after a change has been saved. A failure is logged rather than thrown: the
 * user's change succeeded, and the next feed read re-scores anything left stale.
 */
export async function rescoreQuietly(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error("[scoring] re-score failed", error);
  }
}

async function loadInput(workspaceId: string, companyId: string): Promise<{ engine: EngineInput } | null> {
  const [company] = await db
    .select({
      name: companies.canonicalName,
      domain: companies.domain,
      industry: companies.industry,
      employeeCount: companies.employeeCount,
      hqCountry: companyLocations.country,
      hqId: companyLocations.id,
    })
    .from(companies)
    .leftJoin(
      companyLocations,
      and(eq(companyLocations.companyId, companies.id), eq(companyLocations.type, "headquarters")),
    )
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId)))
    .limit(1);
  if (!company) return null;

  const [signalRows, people, services, weights, ref] = await Promise.all([
    db
      .select({ signal: signals, category: signalTypes.categorySlug })
      .from(signals)
      .innerJoin(signalTypes, eq(signalTypes.slug, signals.signalType))
      .where(and(eq(signals.companyId, companyId), eq(signals.workspaceId, workspaceId))),
    loadCompanyPeople(workspaceId, companyId),
    loadServices(workspaceId),
    loadWeights(workspaceId),
    getReferenceData(),
  ]);

  const ids = signalRows.map((r) => r.signal.id);
  const [categories, evidence] = ids.length
    ? await Promise.all([
        db.select().from(signalServiceCategories).where(inArray(signalServiceCategories.signalId, ids)),
        db.select().from(signalEvidence).where(inArray(signalEvidence.signalId, ids)),
      ])
    : [[], []];

  const name = (rows: { slug: string; name: string }[]) => {
    const map = new Map(rows.map((r) => [r.slug, r.name]));
    return (slug: string) => map.get(slug) ?? slug;
  };
  const labels: EngineLabels = {
    signalType: name(ref.signalTypes),
    category: name(ref.serviceCategories),
    industry: name(ref.industries),
    jobFunction: name(ref.jobFunctions),
  };

  return {
    engine: {
      company: {
        name: company.name,
        domain: company.domain,
        industry: company.industry,
        employeeCount: company.employeeCount,
        hqCountry: company.hqCountry,
        hasHeadquarters: company.hqId !== null,
      },
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        seniority: p.seniority,
        jobFunction: p.jobFunction,
        hasEmail: p.email !== null,
        hasPhone: p.phone !== null,
      })),
      signals: signalRows.map(({ signal, category }) => ({
        id: signal.id,
        signalType: signal.signalType,
        category,
        intentLevel: signal.intentLevel,
        urgency: signal.urgency,
        serviceCategories: categories.filter((c) => c.signalId === signal.id).map((c) => c.categorySlug),
        summary: signal.summary,
        occurredAt: signal.occurredAt,
        personId: signal.personId,
        evidenceLabel: signal.evidenceLabel,
        hasSourceUrl: evidence.some((e) => e.signalId === signal.id && e.sourceUrl !== null),
      })),
      services,
      weights,
      labels,
      now: new Date(),
    },
  };
}

/** After a change to one company's signals, people or details. */
export const rescoreAfterCompanyChange = (workspaceId: string, companyId: string) =>
  rescoreQuietly(() => rescoreCompany(workspaceId, companyId));

/** After a change that affects every company: services or score weights. */
export const rescoreAfterWorkspaceChange = (workspaceId: string) => rescoreQuietly(() => rescoreWorkspace(workspaceId));
