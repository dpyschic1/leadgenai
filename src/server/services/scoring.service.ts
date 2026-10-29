import "server-only";
import { and, eq } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { auditLogs, scoringProfiles } from "@/db/schema";
import type { ScoringProfile } from "@/lib/api/types";
import {
  DEFAULT_SCORE_WEIGHTS,
  scoreWeightsSchema,
  type ScoreWeights,
  type ScoringProfileInput,
} from "@/lib/validation/scoring";
import type { AuthContext } from "@/server/auth/session";

const activeProfile = (workspaceId: string) =>
  and(eq(scoringProfiles.workspaceId, workspaceId), eq(scoringProfiles.active, true));

/** The workspace's active weights, or the PRD defaults when none have been saved yet. */
export async function getScoringProfile(auth: AuthContext): Promise<ScoringProfile> {
  return { weights: await loadWeights(auth.workspaceId) };
}

/** A workspace's active weights; also used by background re-scoring (no request user). */
export async function loadWeights(workspaceId: string): Promise<ScoreWeights> {
  const [row] = await db
    .select({ config: scoringProfiles.config })
    .from(scoringProfiles)
    .where(activeProfile(workspaceId))
    .limit(1);

  // Config is JSONB; re-validate so a malformed row falls back to defaults instead of leaking out.
  const parsed = scoreWeightsSchema.safeParse(row?.config.weights);
  return parsed.success ? parsed.data : DEFAULT_SCORE_WEIGHTS;
}

export async function saveScoringProfile(
  auth: AuthContext,
  input: ScoringProfileInput,
): Promise<ScoringProfile> {
  await db.transaction(async (tx) => {
    await upsertActiveProfile(tx, auth.workspaceId, input.weights);
    await tx.insert(auditLogs).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: "scoring_profile.updated",
      entityType: "scoring_profile",
      metadata: { weights: input.weights },
    });
  });
  return { weights: input.weights };
}

async function upsertActiveProfile(
  tx: Tx,
  workspaceId: string,
  weights: ScoringProfileInput["weights"],
): Promise<void> {
  const updated = await tx
    .update(scoringProfiles)
    .set({ config: { weights } })
    .where(activeProfile(workspaceId))
    .returning({ id: scoringProfiles.id });
  if (updated.length === 0) {
    await tx.insert(scoringProfiles).values({ workspaceId, name: "Default", config: { weights } });
  }
}
