import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { opportunities, opportunityDiscoveries, opportunityEvidence } from "@/db/schema";
import { intakeStageId } from "@/server/services/pipeline.service";
import { changedFields, mergeVerification, suggestedAction, whyNow } from "./describe";
import type { scoreColumns } from "./our-score";
import type { DiscoveredItem, EngineScore } from "./types";

/**
 * One company, one opportunity: the job-signal side just gave a company this website, so a
 * "recently funded" opportunity the engine made for the same website (no company attached) is
 * superseded by the company's own, which carries hiring evidence and contacts. Only an untouched one
 * goes: still in the intake stage, with no notes, feedback or list. Returns how many were removed.
 */
export async function supersedeFundedOpportunities(tx: Tx | typeof db, workspaceId: string, domain: string): Promise<number> {
  const intake = await intakeStageId(tx, workspaceId);
  const removed = await tx
    .delete(opportunities)
    .where(
      and(
        eq(opportunities.workspaceId, workspaceId),
        isNull(opportunities.companyId),
        eq(opportunities.category, "funded_company"),
        eq(opportunities.buyerProfileUrl, `https://${domain}`),
        eq(opportunities.stageId, intake),
        isNull(opportunities.notes),
        sql`not exists (select 1 from opportunity_feedback f where f.opportunity_id = ${opportunities.id})`,
        sql`not exists (select 1 from saved_opportunities l where l.opportunity_id = ${opportunities.id})`,
      ),
    )
    .returning({ id: opportunities.id });
  return removed.length;
}

export type IngestOutcome = { id: string; outcome: "created" | "updated"; changed: string[] };

/** Builds the opportunity columns an item determines. Sales progress (`status`) is deliberately absent. */
function columnsFor(item: DiscoveredItem, score: EngineScore, now: Date, serviceId: string | null) {
  return {
    category: item.category,
    // Which of the workspace's services the lead fits (shown as "Matches …").
    serviceId,
    title: item.title.slice(0, 300),
    // Person for intent/freelance posts, the company for a funding event.
    buyerName: item.buyerName ?? item.companyName,
    buyerProfileUrl: item.buyerProfileUrl ?? (item.companyDomain ? `https://${item.companyDomain}` : null),
    country: item.country && /^[A-Z]{2}$/.test(item.country) ? item.country : null,
    sourceUrl: item.url,
    // A funded company: what it does (its own one-line description); a request or project: the request.
    problem: item.capability === "funded" ? item.text.split("\n")[0]?.trim().slice(0, 300) || null : item.text.slice(0, 600) || null,
    whyNow: whyNow(item, now),
    suggestedAction: suggestedAction(item, score),
    budgetMin: item.budget?.min ?? null,
    budgetMax: item.budget?.max ?? null,
    budgetCurrency: item.budget?.currency ?? null,
    budgetUsd: item.budget?.usd ?? null,
    fundingAmountUsd: item.funding?.amountUsd ?? null,
    fundingStage: item.funding?.stage ?? null,
    fundingDate: item.funding?.date ?? null,
    investors: item.funding?.investors.length ? item.funding.investors : null,
    intentLevel: score.intentLevel,
    intentScore: score.factors.intent,
    icpScore: score.factors.icpFit,
    serviceFit: score.factors.serviceFit,
    opportunityScore: score.total,
    scoreFactors: { ...score.factors, weights: score.weights, matchedTerms: score.matchedTerms } as Record<string, unknown>,
    scoredAt: now,
    lastSeenAt: now,
    sourcePostedAt: item.postedAt ?? (item.funding?.date ? new Date(item.funding.date) : null),
  };
}

/**
 * Creates the opportunity for a discovered item, or enriches the existing one (spec §9). The key is
 * (workspace, source, source's own ID), so rediscovery never duplicates. Rediscovery refreshes facts
 * and scores but never touches `status`, so a Contacted opportunity stays Contacted.
 */
export async function ingestItem(args: {
  workspaceId: string;
  runId: string | null;
  item: DiscoveredItem;
  score: EngineScore;
  now?: Date;
  /** The workspace's service the item matches best, if any. */
  serviceId?: string | null;
  /** The score by the same rules as company opportunities (`our-score.ts`); replaces the engine's own. */
  ours?: ReturnType<typeof scoreColumns> | null;
}): Promise<IngestOutcome> {
  const { workspaceId, runId, item, score } = args;
  const now = args.now ?? new Date();
  const cols = { ...columnsFor(item, score, now, args.serviceId ?? null), ...(args.ours ?? {}) };

  return db.transaction(async (tx) => {
    const find = async () => {
      const [row] = await tx
        .select()
        .from(opportunities)
        .where(
          and(
            eq(opportunities.workspaceId, workspaceId),
            eq(opportunities.sourceSlug, item.sourceSlug),
            eq(opportunities.sourceExternalId, item.externalId),
          ),
        )
        .limit(1);
      return row;
    };

    let existing = await find();
    let id: string | null = null;
    let outcome: IngestOutcome["outcome"] = "created";
    let changed: string[] = [];

    if (!existing) {
      const [row] = await tx
        .insert(opportunities)
        .values({
          ...cols,
          workspaceId,
          type: "other",
          stageId: await intakeStageId(tx, workspaceId),
          sourceSlug: item.sourceSlug,
          sourceExternalId: item.externalId,
          verification: item.verification,
          discoveredAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: opportunities.id });
      if (row) id = row.id;
      // Another run inserted it between our read and write: enrich that one instead.
      else existing = await find();
    }
    if (existing) {
      const verification = mergeVerification(existing.verification, item.verification) as typeof existing.verification;
      changed = changedFields(existing, { ...cols, verification });
      await tx.update(opportunities).set({ ...cols, verification }).where(eq(opportunities.id, existing.id));
      id = existing.id;
      outcome = "updated";
    }
    if (!id) throw new Error("Opportunity was neither created nor found.");

    // Evidence: one row per (opportunity, source, url); rediscovery refreshes it, never removes it.
    await tx
      .insert(opportunityEvidence)
      .values({
        workspaceId,
        opportunityId: id,
        sourceSlug: item.sourceSlug,
        platform: item.platform,
        url: item.url,
        snippet: item.text.slice(0, 1000) || null,
        verification: item.verification,
        metadata: item.metadata,
        capturedAt: now,
      })
      .onConflictDoUpdate({
        target: [opportunityEvidence.opportunityId, opportunityEvidence.sourceSlug, opportunityEvidence.url],
        set: { snippet: item.text.slice(0, 1000) || null, metadata: item.metadata, capturedAt: now },
      });

    await tx.insert(opportunityDiscoveries).values({ workspaceId, opportunityId: id, runId, seenAt: now, change: outcome, changedFields: changed });
    return { id, outcome, changed };
  });
}
