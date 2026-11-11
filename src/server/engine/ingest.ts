import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { opportunities, opportunityDiscoveries, opportunityEvidence } from "@/db/schema";
import { intakeStageId } from "@/server/services/pipeline.service";
import { changedFields, mergeVerification, suggestedAction, whyNow } from "./describe";
import type { DiscoveredItem, EngineScore } from "./types";

export type IngestOutcome = { id: string; outcome: "created" | "updated"; changed: string[] };

/** Builds the opportunity columns an item determines. Sales progress (`status`) is deliberately absent. */
function columnsFor(item: DiscoveredItem, score: EngineScore, now: Date) {
  return {
    category: item.category,
    title: item.title.slice(0, 300),
    // Person for intent/freelance posts, the company for a funding event.
    buyerName: item.buyerName ?? item.companyName,
    buyerProfileUrl: item.buyerProfileUrl ?? (item.companyDomain ? `https://${item.companyDomain}` : null),
    country: item.country && /^[A-Z]{2}$/.test(item.country) ? item.country : null,
    sourceUrl: item.url,
    problem: item.capability === "funded" ? null : item.text.slice(0, 600) || null,
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
}): Promise<IngestOutcome> {
  const { workspaceId, runId, item, score } = args;
  const now = args.now ?? new Date();
  const cols = columnsFor(item, score, now);

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
