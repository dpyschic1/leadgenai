import "server-only";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, opportunities, opportunityFeedback, people, services, users } from "@/db/schema";
import type { OpportunityFeedback } from "@/lib/api/types";
import { CORRECTING_VERDICTS, type FeedbackVerdict } from "@/lib/domain/feedback";
import type { FeedbackValues } from "@/lib/validation/feedback";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";

/**
 * Quality feedback on opportunities (launch checklist). "Wrong contact" and "wrong service"
 * correct the match: re-scoring stops suggesting what was flagged (see rescore.ts).
 */

export type FeedbackChange = {
  /** Null for an opportunity with no identified company (nothing to re-score). */
  companyId: string | null;
  /** True when the change affects matching, so the company should be re-scored. */
  correctsMatch: boolean;
};

const corrects = (verdict: FeedbackVerdict) => (CORRECTING_VERDICTS as readonly string[]).includes(verdict);

export async function listFeedback(auth: AuthContext, opportunityId: string): Promise<OpportunityFeedback[]> {
  const rows = await db
    .select({
      feedback: opportunityFeedback,
      authorName: users.name,
      authorEmail: users.email,
      personName: people.name,
      serviceName: services.name,
    })
    .from(opportunityFeedback)
    .leftJoin(users, eq(users.id, opportunityFeedback.userId))
    .leftJoin(people, eq(people.id, opportunityFeedback.personId))
    .leftJoin(services, eq(services.id, opportunityFeedback.serviceId))
    .where(and(eq(opportunityFeedback.opportunityId, opportunityId), eq(opportunityFeedback.workspaceId, auth.workspaceId)))
    .orderBy(desc(opportunityFeedback.updatedAt));

  return rows.map(({ feedback, authorName, authorEmail, personName, serviceName }) => ({
    id: feedback.id,
    verdict: feedback.verdict,
    reason: feedback.reason,
    author: feedback.userId ? { id: feedback.userId, name: authorName ?? authorEmail ?? "A teammate" } : null,
    isMine: feedback.userId === auth.userId,
    personName,
    serviceName,
    scoreAtFeedback: feedback.scoreAtFeedback,
    updatedAt: feedback.updatedAt.toISOString(),
  }));
}

/**
 * Records the signed-in user's verdict on what the opportunity shows right now. A person keeps
 * one opinion (good fit / not relevant) and one wrong-company flag, plus one flag per contact or
 * service they rejected; giving the same kind again updates it.
 */
export async function giveFeedback(auth: AuthContext, opportunityId: string, input: FeedbackValues): Promise<FeedbackChange> {
  return db.transaction(async (tx) => {
    // Two quick clicks from the same person must not create two rows.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`feedback:${opportunityId}:${auth.userId}`}))`);

    const [opportunity] = await tx
      .select({
        companyId: opportunities.companyId,
        personId: opportunities.primaryPersonId,
        serviceId: opportunities.serviceId,
        score: opportunities.opportunityScore,
        scored: sql<boolean>`${opportunities.scoreFactors} ? 'intent'`,
      })
      .from(opportunities)
      .where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!opportunity) throw new AppError("NOT_FOUND", "Opportunity not found.");

    if (input.verdict === "wrong_company" && !opportunity.companyId) {
      throw invalid("This opportunity has no identified company to flag.");
    }
    if (input.verdict === "wrong_person" && !opportunity.personId) {
      throw invalid("There's no suggested contact to flag. Add people on the company page.");
    }
    if (input.verdict === "wrong_service" && !opportunity.serviceId) {
      throw invalid("This opportunity isn't matched to a service, so there's nothing to flag.");
    }

    const values = {
      verdict: input.verdict,
      reason: input.reason,
      personId: opportunity.personId,
      serviceId: opportunity.serviceId,
      scoreAtFeedback: opportunity.scored ? opportunity.score : null,
    };
    const [existing] = await tx
      .select({ id: opportunityFeedback.id })
      .from(opportunityFeedback)
      .where(
        and(
          eq(opportunityFeedback.opportunityId, opportunityId),
          eq(opportunityFeedback.userId, auth.userId),
          sameKind(input.verdict, opportunity.personId, opportunity.serviceId),
        ),
      )
      .limit(1);

    const [saved] = existing
      ? await tx
          .update(opportunityFeedback)
          .set(values)
          .where(eq(opportunityFeedback.id, existing.id))
          .returning({ id: opportunityFeedback.id })
      : await tx
          .insert(opportunityFeedback)
          .values({ workspaceId: auth.workspaceId, opportunityId, userId: auth.userId, ...values })
          .returning({ id: opportunityFeedback.id });

    await tx.insert(auditLogs).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: "opportunity.feedback_given",
      entityType: "opportunity",
      entityId: opportunityId,
      metadata: { feedbackId: saved.id, verdict: input.verdict, personId: values.personId, serviceId: values.serviceId },
    });
    return { companyId: opportunity.companyId, correctsMatch: opportunity.companyId !== null && corrects(input.verdict) };
  });
}

/** Removes one of the signed-in user's own verdicts; removing a flag lets that match be suggested again. */
export async function removeFeedback(auth: AuthContext, opportunityId: string, feedbackId: string): Promise<FeedbackChange> {
  return db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(opportunityFeedback)
      .where(
        and(
          eq(opportunityFeedback.id, feedbackId),
          eq(opportunityFeedback.opportunityId, opportunityId),
          eq(opportunityFeedback.workspaceId, auth.workspaceId),
          eq(opportunityFeedback.userId, auth.userId),
        ),
      )
      .returning({ verdict: opportunityFeedback.verdict });
    if (!removed) throw new AppError("NOT_FOUND", "Feedback not found.");

    const [opportunity] = await tx
      .select({ companyId: opportunities.companyId })
      .from(opportunities)
      .where(eq(opportunities.id, opportunityId))
      .limit(1);
    await tx.insert(auditLogs).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: "opportunity.feedback_removed",
      entityType: "opportunity",
      entityId: opportunityId,
      metadata: { feedbackId, verdict: removed.verdict },
    });
    return { companyId: opportunity.companyId, correctsMatch: corrects(removed.verdict) };
  });
}

/** Which earlier verdict of the same person a new one replaces. */
function sameKind(verdict: FeedbackVerdict, personId: string | null, serviceId: string | null): SQL | undefined {
  switch (verdict) {
    case "good_fit":
    case "not_relevant":
      return inArray(opportunityFeedback.verdict, ["good_fit", "not_relevant"]);
    case "wrong_company":
      return eq(opportunityFeedback.verdict, "wrong_company");
    case "wrong_person":
      return and(eq(opportunityFeedback.verdict, "wrong_person"), eq(opportunityFeedback.personId, personId!));
    case "wrong_service":
      return and(eq(opportunityFeedback.verdict, "wrong_service"), eq(opportunityFeedback.serviceId, serviceId!));
  }
}

function invalid(message: string): AppError {
  return new AppError("VALIDATION_FAILED", message, { verdict: [message] });
}
