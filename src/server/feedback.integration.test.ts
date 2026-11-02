import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { users, workspaceMembers, workspaces } from "@/db/schema";
import { companySchema, personSchema } from "@/lib/validation/companies";
import { feedbackSchema } from "@/lib/validation/feedback";
import { opportunityListQuerySchema } from "@/lib/validation/opportunities";
import { serviceSchema } from "@/lib/validation/services";
import { signalSchema, todayIso } from "@/lib/validation/signals";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { rescoreCompany } from "@/server/scoring/rescore";
import { registerOwner } from "@/server/services/auth.service";
import { createCompany } from "@/server/services/companies.service";
import { giveFeedback, removeFeedback } from "@/server/services/feedback.service";
import { getOpportunity, listOpportunities } from "@/server/services/opportunities.service";
import { addPerson, listCompanyPeople } from "@/server/services/people.service";
import { createService } from "@/server/services/services.service";
import { createSignal } from "@/server/services/signals.service";

/**
 * Quality feedback (launch checklist) against the real database (`npm run test:integration`):
 * verdicts are recorded per person, and wrong-contact / wrong-service flags re-match the
 * opportunity, as the route does. Removes everything it creates.
 */

const run = randomUUID().slice(0, 8);
let owner: AuthContext;
let teammate: AuthContext;
let other: AuthContext;
let opportunityId: string;
let companyId: string;
const ids: { web?: string; dev?: string; olivia?: string; tom?: string } = {};

async function signUp(who: string): Promise<AuthContext> {
  const me = await registerOwner({
    name: `Feedback ${who}`,
    email: `feedback-${who}-${run}@feedback.test`,
    password: "Feedback-test-1",
    workspaceName: `Feedback ${who} ${run}`,
  });
  return { userId: me.user.id, workspaceId: me.workspace.id, role: "owner" };
}

/** What the feedback route does: record the verdict, re-match when it corrects, return the opportunity. */
async function flag(auth: AuthContext, verdict: string, reason: string | null = null) {
  const change = await giveFeedback(auth, opportunityId, feedbackSchema.parse({ verdict, reason }));
  if (change.correctsMatch) await rescoreCompany(auth.workspaceId, change.companyId);
  return getOpportunity(owner, opportunityId);
}

async function unflag(auth: AuthContext, feedbackId: string) {
  const change = await removeFeedback(auth, opportunityId, feedbackId);
  if (change.correctsMatch) await rescoreCompany(auth.workspaceId, change.companyId);
  return getOpportunity(owner, opportunityId);
}

async function expectCode(promise: Promise<unknown>, code: AppError["code"]) {
  await expect(promise).rejects.toSatisfy((error) => error instanceof AppError && error.code === code);
}

beforeAll(async () => {
  owner = await signUp("owner");
  other = await signUp("other");

  // A teammate in the owner's workspace (their own sign-up gave them a workspace of their own too).
  const mate = await signUp("mate");
  await db.insert(workspaceMembers).values({ workspaceId: owner.workspaceId, userId: mate.userId, role: "member" });
  teammate = { userId: mate.userId, workspaceId: owner.workspaceId, role: "member" };

  const service = (name: string, categories: string[]) =>
    serviceSchema.parse({
      name,
      description: "",
      categories,
      targetIndustries: [],
      targetJobFunctions: [],
      targetCountries: [],
      companySizeMin: null,
      companySizeMax: null,
    });
  ids.web = (await createService(owner, service("Website redesign", ["web_development", "seo"]))).id;
  ids.dev = (await createService(owner, service("Dedicated developers", ["staff_augmentation"]))).id;

  companyId = (
    await createCompany(
      owner,
      companySchema.parse({
        name: "Feedback Corp",
        domain: `feedback-${run}.example`,
        industry: "legal",
        employeeCount: 40,
        description: null,
        hqCity: null,
        hqRegion: null,
        hqCountry: "GB",
      }),
    )
  ).id;
  const person = (name: string, seniority: "owner" | "manager") =>
    personSchema.parse({
      name,
      title: null,
      seniority,
      jobFunction: null,
      relationship: "employee",
      email: null,
      phone: null,
      professionalUrl: null,
      location: null,
    });
  await addPerson(owner, companyId, person("Olivia Owner", "owner"));
  await addPerson(owner, companyId, person("Tom Manager", "manager"));
  const people = await listCompanyPeople(owner, companyId);
  ids.olivia = people.find((p) => p.name === "Olivia Owner")!.id;
  ids.tom = people.find((p) => p.name === "Tom Manager")!.id;

  await createSignal(
    owner,
    companyId,
    signalSchema.parse({
      signalType: "service_request",
      intentLevel: "explicit",
      urgency: "high",
      // Needs a website most, but staff augmentation also fits.
      serviceCategories: ["web_development", "seo", "staff_augmentation"],
      summary: "Wants a new website and extra developers.",
      personId: null,
      occurredOn: todayIso(),
      sourceUrl: null,
      excerpt: null,
      evidenceLabel: "observed",
      source: "manual",
      confidence: null,
    }),
  );
  await rescoreCompany(owner.workspaceId, companyId);
  opportunityId = (await listOpportunities(owner, opportunityListQuerySchema.parse({ group: "open" }))).items[0].id;
});

afterAll(async () => {
  const contexts = [owner, other, teammate].filter(Boolean);
  const workspaceIds = [owner, other].filter(Boolean).map((c) => c.workspaceId);
  await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
  await db.delete(workspaces).where(inArray(workspaces.name, [`Feedback mate ${run}`]));
  await db.delete(users).where(inArray(users.id, contexts.map((c) => c.userId)));
});

describe("quality feedback", () => {
  it("starts from the best match: Website redesign, contact Olivia", async () => {
    const opportunity = await getOpportunity(owner, opportunityId);
    expect(opportunity.service?.id).toBe(ids.web);
    expect(opportunity.contact?.id).toBe(ids.olivia);
    expect(opportunity.feedback).toEqual([]);
  });

  it("keeps one opinion per person: a new one replaces the old", async () => {
    await flag(owner, "good_fit");
    const opportunity = await flag(owner, "not_relevant", "They already have an agency");
    expect(opportunity.feedback).toHaveLength(1);
    expect(opportunity.feedback[0]).toMatchObject({ verdict: "not_relevant", reason: "They already have an agency", isMine: true });
    expect(opportunity.feedbackVotes).toEqual([{ name: "Feedback owner", verdict: "not_relevant" }]);
  });

  it("counts each teammate's opinion separately", async () => {
    await flag(teammate, "good_fit");
    const opportunity = await getOpportunity(owner, opportunityId);
    expect(opportunity.feedbackVotes).toEqual([
      { name: "Feedback mate", verdict: "good_fit" },
      { name: "Feedback owner", verdict: "not_relevant" },
    ]);
    expect(opportunity.feedback.find((f) => f.verdict === "good_fit")).toMatchObject({ isMine: false, author: { name: "Feedback mate" } });
  });

  it("suggests someone else after a wrong-contact flag, and records who was flagged", async () => {
    const before = await getOpportunity(owner, opportunityId);
    const after = await flag(owner, "wrong_person");
    expect(after.contact?.id).toBe(ids.tom);
    expect(after.feedback.find((f) => f.verdict === "wrong_person")).toMatchObject({
      personName: "Olivia Owner",
      scoreAtFeedback: before.score,
    });
  });

  it("keeps earlier wrong-contact flags when flagging the next contact too", async () => {
    const opportunity = await flag(owner, "wrong_person");
    expect(opportunity.contact).toBeNull();
    expect(opportunity.feedback.filter((f) => f.verdict === "wrong_person").map((f) => f.personName).sort()).toEqual([
      "Olivia Owner",
      "Tom Manager",
    ]);
  });

  it("brings a contact back when its flag is removed", async () => {
    const before = await getOpportunity(owner, opportunityId);
    const oliviaFlag = before.feedback.find((f) => f.verdict === "wrong_person" && f.personName === "Olivia Owner")!;
    const after = await unflag(owner, oliviaFlag.id);
    expect(after.contact?.id).toBe(ids.olivia);
  });

  it("refuses a wrong-contact flag when nobody is suggested", async () => {
    await flag(owner, "wrong_person"); // flags Olivia again: nobody left
    await expectCode(giveFeedback(owner, opportunityId, feedbackSchema.parse({ verdict: "wrong_person" })), "VALIDATION_FAILED");
  });

  it("matches another service after a wrong-service flag", async () => {
    const opportunity = await flag(owner, "wrong_service", "We don't build legal sites");
    expect(opportunity.service?.id).toBe(ids.dev);
    expect(opportunity.factors?.serviceFit.reasons).toContain(
      "Not matched to Website redesign: your team flagged it as the wrong service",
    );
  });

  it("lets only the author remove their feedback", async () => {
    const mine = (await getOpportunity(owner, opportunityId)).feedback.find((f) => f.verdict === "wrong_service")!;
    await expectCode(removeFeedback(teammate, opportunityId, mine.id), "NOT_FOUND");
  });

  it("is invisible and untouchable from another workspace", async () => {
    await expectCode(giveFeedback(other, opportunityId, feedbackSchema.parse({ verdict: "good_fit" })), "NOT_FOUND");
    const anyEntry = (await getOpportunity(owner, opportunityId)).feedback[0];
    await expectCode(removeFeedback(other, opportunityId, anyEntry.id), "NOT_FOUND");
  });
});
