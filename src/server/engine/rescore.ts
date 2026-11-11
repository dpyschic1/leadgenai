import "server-only";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { engineSettings, opportunities } from "@/db/schema";
import { ENGINE_WEIGHT_KEYS, parseEngineWeights, type EngineWeights } from "@/lib/domain/engine";
import { timingPoints, totalScore } from "./scoring";

/**
 * Keeping engine scores honest as time passes and settings change. A discovered opportunity's timing score
 * decays with the age of the post, so without this an old project would keep the score it earned the day it
 * was found. Only the timing factor and the weighted total are recomputed: the other factors come from the
 * source's text and the workspace's settings at discovery and change only when it is seen again.
 */

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const BATCH = 500;

export async function loadEngineWeights(workspaceId: string): Promise<EngineWeights> {
  const [row] = await db.select({ w: engineSettings.scoringWeights }).from(engineSettings).where(eq(engineSettings.workspaceId, workspaceId));
  return parseEngineWeights(row?.w);
}

/** Recomputes timing and the total for engine opportunities whose score is more than six hours old. */
export async function refreshEngineScores(workspaceId: string, now = new Date()): Promise<number> {
  const weights = await loadEngineWeights(workspaceId);
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

  for (const row of stale) {
    const stored = row.factors as Record<string, unknown>;
    const factors = Object.fromEntries(ENGINE_WEIGHT_KEYS.map((k) => [k, typeof stored[k] === "number" ? (stored[k] as number) : 0])) as Record<(typeof ENGINE_WEIGHT_KEYS)[number], number>;
    factors.timing = timingPoints(row.posted ?? row.discovered, now);
    await db
      .update(opportunities)
      .set({ opportunityScore: totalScore(factors, weights), scoreFactors: { ...stored, ...factors, weights }, scoredAt: now })
      .where(eq(opportunities.id, row.id));
  }
  return stale.length;
}

/** Applies new weights to every engine opportunity's stored factors at once (no source data is re-read). */
export async function reweighWorkspace(workspaceId: string, weights: EngineWeights): Promise<void> {
  const sum = ENGINE_WEIGHT_KEYS.reduce((acc, k) => acc + weights[k], 0);
  if (sum === 0) return;
  const weighted = sql.join(
    ENGINE_WEIGHT_KEYS.map((k) => sql`coalesce((${opportunities.scoreFactors}->>${k})::numeric, 0) * ${weights[k]}`),
    sql` + `,
  );
  await db
    .update(opportunities)
    .set({
      opportunityScore: sql`round((${weighted}) / ${sum})::int`,
      scoreFactors: sql`${opportunities.scoreFactors} || jsonb_build_object('weights', ${JSON.stringify(weights)}::jsonb)`,
    })
    .where(and(eq(opportunities.workspaceId, workspaceId), isNotNull(opportunities.category)));
}
