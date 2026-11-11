import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { users, workspaces } from "@/db/schema";
import { listSchema } from "@/lib/validation/lists";
import { companySchema, personSchema } from "@/lib/validation/companies";
import { serviceSchema } from "@/lib/validation/services";
import { opportunityExportQuerySchema, opportunityListQuerySchema } from "@/lib/validation/opportunities";
import { signalSchema, todayIso } from "@/lib/validation/signals";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { rescoreCompany } from "@/server/scoring/rescore";
import { registerOwner } from "@/server/services/auth.service";
import {
  createCompany,
  deleteCompany,
  getCompany,
  listCompanies,
  updateCompany,
} from "@/server/services/companies.service";
import { exportOpportunities } from "@/server/services/exports.service";
import {
  addToList,
  createList,
  deleteList,
  getList,
  listLists,
  removeFromList,
  renameList,
} from "@/server/services/lists.service";
import { getOpportunity, listOpportunities, updateOpportunity } from "@/server/services/opportunities.service";
import { addPerson, listCompanyPeople, removePerson, updatePerson } from "@/server/services/people.service";
import { createService, deleteService, listServices, updateService } from "@/server/services/services.service";
import {
  createSignal,
  deleteSignal,
  listCompanySignals,
  listRecentSignals,
  suggestSignal,
  updateSignal,
} from "@/server/services/signals.service";

/**
 * Tenant isolation (SRS §14): a signed-in member of workspace B must not be able to read, change
 * or link to anything in workspace A, even knowing A's ids. Runs against the real database
 * (`npm run test:integration`) and removes everything it creates.
 */

const run = randomUUID().slice(0, 8);
/** The open tab with no filters, parsed the way the route parses it. */
const openFeed = opportunityListQuerySchema.parse({ group: "open" });
const service = serviceSchema.parse({
  name: "MVP Development",
  description: "",
  categories: ["web_development"],
  targetIndustries: [],
  targetJobFunctions: [],
  targetCountries: [],
  companySizeMin: null,
  companySizeMax: null,
});
const company = companySchema.parse({
  name: "Isolated Corp",
  domain: `isolated-${run}.example`,
  industry: null,
  employeeCount: 40,
  description: null,
  hqCity: null,
  hqRegion: null,
  hqCountry: "GB",
});
const person = personSchema.parse({
  name: "Private Person",
  title: "CTO",
  seniority: "c_level",
  jobFunction: null,
  relationship: "employee",
  email: `private-${run}@isolated.example`,
  phone: null,
  professionalUrl: null,
  location: null,
});
const signal = (personId: string | null) =>
  signalSchema.parse({
    signalType: "service_request",
    intentLevel: "explicit",
    urgency: "high",
    serviceCategories: ["web_development"],
    summary: "Asked for a development partner to build their MVP.",
    personId,
    occurredOn: todayIso(),
    sourceUrl: "https://isolated.example/post",
    excerpt: null,
    evidenceLabel: "observed",
    source: "manual",
    confidence: null,
  });

/** Workspace A's records, created by A's owner. */
const a = {} as {
  auth: AuthContext;
  serviceId: string;
  companyId: string;
  personId: string;
  signalId: string;
  opportunityId: string;
  listId: string;
};
let b: AuthContext;
let bListId: string;
let bCompanyId: string;

async function signUp(label: string): Promise<AuthContext> {
  const me = await registerOwner({
    name: `Tenant ${label}`,
    email: `tenant-${label.toLowerCase()}-${run}@isolation.test`,
    password: "Isolation-test-1",
    workspaceName: `Isolation ${label} ${run}`,
  });
  return { userId: me.user.id, workspaceId: me.workspace.id, role: "owner" };
}

/** Rejected as if the record didn't exist, so B can't even learn that the id is real. */
async function expectNotFound(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy((error) => error instanceof AppError && error.code === "NOT_FOUND");
}

beforeAll(async () => {
  a.auth = await signUp("A");
  b = await signUp("B");

  a.serviceId = (await createService(a.auth, service)).id;
  a.companyId = (await createCompany(a.auth, company)).id;
  await addPerson(a.auth, a.companyId, person);
  a.personId = (await listCompanyPeople(a.auth, a.companyId))[0].id;
  a.signalId = (await createSignal(a.auth, a.companyId, signal(a.personId))).id;
  await rescoreCompany(a.auth.workspaceId, a.companyId);
  a.opportunityId = (await listOpportunities(a.auth, openFeed)).items[0].id;
  a.listId = (await createList(a.auth, listSchema.parse({ name: "Contact today" }))).id;
  await addToList(a.auth, a.listId, a.opportunityId);

  bListId = (await createList(b, listSchema.parse({ name: "Contact today" }))).id;
  bCompanyId = (await createCompany(b, { ...company, domain: `other-${run}.example` })).id;
});

afterAll(async () => {
  const ids = [a.auth, b].filter(Boolean);
  if (ids.length === 0) return;
  // Deleting a workspace cascades to everything it owns; users are global, so go separately.
  await db.delete(workspaces).where(inArray(workspaces.id, ids.map((auth) => auth.workspaceId)));
  await db.delete(users).where(inArray(users.id, ids.map((auth) => auth.userId)));
});

describe("another workspace's lists show none of A's data", () => {
  it("companies, services, signals, opportunities and lists", async () => {
    expect((await listCompanies(b)).items.map((c) => c.id)).toEqual([bCompanyId]);
    expect((await listServices(b)).items).toEqual([]);
    expect(await listRecentSignals(b, 50)).toEqual([]);
    expect((await listOpportunities(b, openFeed)).items).toEqual([]);
    expect((await listLists(b)).map((l) => l.id)).toEqual([bListId]);
    expect(await listCompanyPeople(b, a.companyId)).toEqual([]);
  });

  it("CSV export", async () => {
    const { csv, count } = await exportOpportunities(b, opportunityExportQuerySchema.parse({ group: "open" }));
    expect(count).toBe(0);
    expect(csv).not.toContain("Isolated Corp");
    expect(csv).not.toContain(person.email!);
  });
});

describe("reading A's records by id", () => {
  it("is refused as not found", async () => {
    await expectNotFound(getCompany(b, a.companyId));
    await expectNotFound(listCompanySignals(b, a.companyId));
    await expectNotFound(getOpportunity(b, a.opportunityId));
    await expectNotFound(getList(b, a.listId));
    await expectNotFound(exportOpportunities(b, opportunityExportQuerySchema.parse({ listId: a.listId })));
  });

  it("includes AI analysis, which never reaches the AI provider", async () => {
    await expectNotFound(suggestSignal(b, { companyId: a.companyId, text: "x".repeat(40), sourceUrl: null }));
  });
});

describe("changing A's records by id", () => {
  it("is refused for companies and people", async () => {
    await expectNotFound(updateCompany(b, a.companyId, { ...company, name: "Hijacked" }));
    await expectNotFound(deleteCompany(b, a.companyId));
    await expectNotFound(addPerson(b, a.companyId, person));
    await expectNotFound(updatePerson(b, a.companyId, a.personId, { ...person, name: "Hijacked" }));
    await expectNotFound(removePerson(b, a.companyId, a.personId));
  });

  it("is refused for signals, services and opportunities", async () => {
    await expectNotFound(createSignal(b, a.companyId, signal(null)));
    await expectNotFound(updateSignal(b, a.signalId, { ...signal(null), summary: "Hijacked" }));
    await expectNotFound(deleteSignal(b, a.signalId));
    await expectNotFound(updateService(b, a.serviceId, { ...service, name: "Hijacked" }));
    await expectNotFound(deleteService(b, a.serviceId));
    await expectNotFound(updateOpportunity(b, a.opportunityId, { archived: true }));
  });

  it("is refused for lists", async () => {
    await expectNotFound(renameList(b, a.listId, { name: "Hijacked" }));
    await expectNotFound(deleteList(b, a.listId));
    await expectNotFound(addToList(b, a.listId, a.opportunityId));
    await expectNotFound(removeFromList(b, a.listId, a.opportunityId));
  });
});

describe("linking B's records to A's", () => {
  it("can't save A's opportunity to B's list", async () => {
    await expectNotFound(addToList(b, bListId, a.opportunityId));
  });

  it("can't attach A's person to a signal on B's company", async () => {
    await expect(createSignal(b, bCompanyId, signal(a.personId))).rejects.toBeInstanceOf(AppError);
  });
});

describe("after all of that, A's data", () => {
  it("is unchanged", async () => {
    const detail = await getCompany(a.auth, a.companyId);
    expect(detail.name).toBe("Isolated Corp");
    expect(detail.people.map((p) => p.name)).toEqual(["Private Person"]);
    expect((await listCompanySignals(a.auth, a.companyId)).map((s) => s.summary)).toEqual([signal(null).summary]);
    expect((await listServices(a.auth)).items.map((s) => s.name)).toEqual(["MVP Development"]);
    const opportunity = await getOpportunity(a.auth, a.opportunityId);
    expect(opportunity.stage.name).toBe("New");
    expect(opportunity.archived).toBe(false);
    expect(opportunity.listIds).toEqual([a.listId]);
    expect((await getList(a.auth, a.listId)).name).toBe("Contact today");
  });
});
