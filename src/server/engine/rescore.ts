import "server-only";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { loadScoreContext, scoreColumns, scoreDiscovered, type DiscoveredInput, type ScoreContext } from "./our-score";
import { opportunities } from "@/db/schema";
import { DEFAULT_ENGINE_WEIGHTS, ENGINE_WEIGHT_KEYS } from "@/lib/domain/engine";
import { timingPoints, totalScore } from "./scoring";

/**
 * Keeping engine scores honest as time passes and settings change. A discovered opportunity's timing score
 * decays with the age of the post, so without this an old project would keep the score it earned the day it
 * was found. Only the timing factor and the weighted total are recomputed: the other factors come from the
 * source's text and the workspace's settings at discovery and change only when it is seen again.
 */

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const BATCH = 500;

/** Recomputes timing and the total for engine opportunities whose score is more than six hours old. */
export async function refreshEngineScores(workspaceId: string, now = new Date()): Promise<number> {
  // Items still scored by the engine's own factors (before our scoring) keep its default weights.
  const weights = DEFAULT_ENGINE_WEIGHTS;
  const stale = await db
    .select({ id: opportunities.id, factors: opportunities.scoreFactors, posted: opportunities.sourcePostedAt, discovered: opportunities.discoveredAt })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.workspaceId, workspaceId),
        isNotNull(opportunities.category),
        lt(opportunities.scoredAt, new Date(now.getTime() - STALE_AFTER_MS)),
      ),
    )
    .limit(BATCH);

  let ourContext: ScoreContext | null = null;
  for (const row of stale) {
    const stored = row.factors as Record<string, unknown>;
    // Scored by our rules: rerun them (recency changes intent and the total as the item ages).
    if (stored.input && typeof stored.intent === "object") {
      ourContext ??= await loadScoreContext(workspaceId);
      const input = stored.input as DiscoveredInput;
      const result = scoreDiscovered(input, ourContext, now);
      if (result) await db.update(opportunities).set({ ...scoreColumns(result, input), scoredAt: now }).where(eq(opportunities.id, row.id));
      else await db.update(opportunities).set({ scoredAt: now }).where(eq(opportunities.id, row.id));
      continue;
    }
    const factors = Object.fromEntries(ENGINE_WEIGHT_KEYS.map((k) => [k, typeof stored[k] === "number" ? (stored[k] as number) : 0])) as Record<(typeof ENGINE_WEIGHT_KEYS)[number], number>;
    factors.timing = timingPoints(row.posted ?? row.discovered, now);
    await db
      .update(opportunities)
      .set({ opportunityScore: totalScore(factors, weights), scoreFactors: { ...stored, ...factors, weights }, scoredAt: now })
      .where(eq(opportunities.id, row.id));
  }
  return stale.length;
}
