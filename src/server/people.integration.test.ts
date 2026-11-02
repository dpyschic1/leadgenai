import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { users, workspaces } from "@/db/schema";
import { companySchema, personSchema } from "@/lib/validation/companies";
import { opportunityExportQuerySchema, opportunityListQuerySchema } from "@/lib/validation/opportunities";
import { serviceSchema } from "@/lib/validation/services";
import { signalSchema, todayIso } from "@/lib/validation/signals";
import type { AuthContext } from "@/server/auth/session";
import { rescoreCompany } from "@/server/scoring/rescore";
import { registerOwner } from "@/server/services/auth.service";
import { createCompany } from "@/server/services/companies.service";
import { exportOpportunities } from "@/server/services/exports.service";
import { getOpportunity, listOpportunities } from "@/server/services/opportunities.service";
import { addPerson, listCompanyPeople, updatePerson } from "@/server/services/people.service";
import { createService } from "@/server/services/services.service";
import { createSignal } from "@/server/services/signals.service";

/**
 * Identity confidence and contact verification (PRD §22) against the real database
 * (`npm run test:integration`): what's stored, what's suggested, what's exported.
 */

const run = randomUUID().slice(0, 8);
let auth: AuthContext;
let companyId: string;

const person = (name: string, overrides: Record<string, unknown> = {}) =>
  personSchema.parse({
    name,
    title: null,
    seniority: "owner",
    jobFunction: null,
    relationship: "employee",
    email: `${name.split(" ")[0].toLowerCase()}-${run}@people.example`,
    phone: null,
    professionalUrl: null,
    location: null,
    ...overrides,
  });

const findPerson = async (name: string) => (await listCompanyPeople(auth, companyId)).find((p) => p.name === name)!;

async function opportunity() {
  await rescoreCompany(auth.workspaceId, companyId);
  const id = (await listOpportunities(auth, opportunityListQuerySchema.parse({ group: "open" }))).items[0].id;
  return getOpportunity(auth, id);
}

beforeAll(async () => {
  const me = await registerOwner({
    name: "People Owner",
    email: `people-${run}@people.test`,
    password: "People-test-1",
    workspaceName: `People ${run}`,
  });
  auth = { userId: me.user.id, workspaceId: me.workspace.id, role: "owner" };
  await createService(
    auth,
    serviceSchema.parse({
      name: "Websites",
      description: "",
      categories: ["web_development"],
      targetIndustries: [],
      targetJobFunctions: [],
      targetCountries: [],
      companySizeMin: null,
      companySizeMax: null,
    }),
  );
  companyId = (
    await createCompany(
      auth,
      companySchema.parse({
        name: "People Corp",
        domain: `people-${run}.example`,
        industry: null,
        employeeCount: 20,
        description: null,
        hqCity: null,
        hqRegion: null,
        hqCountry: "GB",
      }),
    )
  ).id;
  await createSignal(
    auth,
    companyId,
    signalSchema.parse({
      signalType: "service_request",
      intentLevel: "explicit",
      urgency: "high",
      serviceCategories: ["web_development"],
      summary: "Wants a new website.",
      personId: null,
      occurredOn: todayIso(),
      sourceUrl: null,
      excerpt: null,
      evidenceLabel: "observed",
      source: "manual",
      confidence: null,
    }),
  );
});

afterAll(async () => {
  if (!auth) return;
  await db.delete(workspaces).where(inArray(workspaces.id, [auth.workspaceId]));
  await db.delete(users).where(inArray(users.id, [auth.userId]));
});

describe("identity confidence", () => {
  it("never suggests someone the team is unsure about", async () => {
    await addPerson(auth, companyId, person("Uma Unsure", { identity: "unsure" }));
    expect((await findPerson("Uma Unsure")).identity).toBe("unsure");
    expect((await opportunity()).contact).toBeNull();
  });

  it("suggests a likely person, and records the confidence behind the level", async () => {
    await addPerson(auth, companyId, person("Liam Likely", { seniority: "manager" }));
    const liam = await findPerson("Liam Likely");
    expect(liam).toMatchObject({ identity: "likely", identityConfidence: 75 });
    expect((await opportunity()).contact?.name).toBe("Liam Likely");
  });

  it("drops a do-not-contact person as the contact and from exports", async () => {
    const liam = await findPerson("Liam Likely");
    await updatePerson(auth, companyId, liam.id, person("Liam Likely", { seniority: "manager", identity: "do_not_contact" }));
    expect((await opportunity()).contact).toBeNull();
    const { csv } = await exportOpportunities(auth, opportunityExportQuerySchema.parse({ group: "open" }));
    expect(csv).not.toContain("Liam Likely");
  });
});

describe("contact verification", () => {
  it("dates a verdict and keeps that date when the person is saved again unchanged", async () => {
    await addPerson(auth, companyId, person("Vera Verified", { identity: "confirmed", emailVerification: "valid" }));
    const first = (await findPerson("Vera Verified")).emailVerification!;
    expect(first.state).toBe("valid");
    expect(first.checkedAt).not.toBeNull();

    const vera = await findPerson("Vera Verified");
    await updatePerson(auth, companyId, vera.id, person("Vera Verified", { identity: "confirmed", emailVerification: "valid", title: "CEO" }));
    expect((await findPerson("Vera Verified")).emailVerification).toEqual(first);
  });

  it("credits a verified email in the identity score", async () => {
    const result = await opportunity();
    expect(result.contact?.name).toBe("Vera Verified");
    expect(result.factors?.identity.reasons).toContain("Contact has a verified email or phone");
  });

  it("doesn't count an email marked invalid as a way to reach someone", async () => {
    const vera = await findPerson("Vera Verified");
    await updatePerson(auth, companyId, vera.id, person("Vera Verified", { identity: "confirmed", emailVerification: "invalid" }));
    expect((await findPerson("Vera Verified")).emailVerification?.state).toBe("invalid");
    const reasons = (await opportunity()).factors?.identity.reasons ?? [];
    expect(reasons.some((r) => r.startsWith("Contact has"))).toBe(false);
  });
});
