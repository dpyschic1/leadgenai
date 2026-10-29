import "server-only";
import { and, asc, eq, inArray, notExists } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { isForeignKeyViolation } from "@/db/errors";
import { auditLogs, companies, companyPeople, contactPoints, people } from "@/db/schema";
import type { CompanyPerson } from "@/lib/api/types";
import type { PersonValues } from "@/lib/validation/companies";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";

/**
 * People are stored once per workspace (`people`); their role at a company lives on
 * `company_people`, and their email/phone on `contact_points`, each with its own freshness.
 */

export async function listCompanyPeople(auth: AuthContext, companyId: string): Promise<CompanyPerson[]> {
  const rows = await db
    .select({ person: people, role: companyPeople })
    .from(companyPeople)
    .innerJoin(people, eq(people.id, companyPeople.personId))
    .where(and(eq(companyPeople.companyId, companyId), eq(companyPeople.workspaceId, auth.workspaceId)))
    .orderBy(asc(people.name));
  if (rows.length === 0) return [];

  const contacts = await db
    .select({ personId: contactPoints.personId, type: contactPoints.type, value: contactPoints.value })
    .from(contactPoints)
    .where(
      and(
        inArray(
          contactPoints.personId,
          rows.map((r) => r.person.id),
        ),
        eq(contactPoints.isPrimary, true),
      ),
    );
  const primary = (personId: string, type: "email" | "phone") =>
    contacts.find((c) => c.personId === personId && c.type === type)?.value ?? null;

  return rows.map(({ person, role }) => ({
    id: person.id,
    name: person.name,
    title: role.title,
    seniority: role.seniority,
    jobFunction: role.jobFunction,
    relationship: role.relationship,
    email: primary(person.id, "email"),
    phone: primary(person.id, "phone"),
    professionalUrl: person.professionalUrl,
    location: person.location,
  }));
}

export async function addPerson(auth: AuthContext, companyId: string, input: PersonValues): Promise<void> {
  await assertCompany(auth, companyId);
  await translateErrors(() =>
    db.transaction(async (tx) => {
      const [person] = await tx
        .insert(people)
        .values({
          workspaceId: auth.workspaceId,
          ...personColumns(input),
          // Entered by a user who knows them, so the identity is not in doubt.
          identityStatus: "resolved",
        })
        .returning({ id: people.id });
      await tx.insert(companyPeople).values({
        workspaceId: auth.workspaceId,
        companyId,
        personId: person.id,
        ...roleColumns(input),
      });
      await replaceManualContacts(tx, person.id, input);
      await audit(tx, auth, "person.created", person.id, companyId);
    }),
  );
}

export async function updatePerson(
  auth: AuthContext,
  companyId: string,
  personId: string,
  input: PersonValues,
): Promise<void> {
  await translateErrors(() =>
    db.transaction(async (tx) => {
      const [link] = await tx
        .update(companyPeople)
        .set(roleColumns(input))
        .where(linkOf(auth, companyId, personId))
        .returning({ personId: companyPeople.personId });
      if (!link) throw notFound();

      await tx.update(people).set(personColumns(input)).where(eq(people.id, personId));
      await replaceManualContacts(tx, personId, input);
      await audit(tx, auth, "person.updated", personId, companyId);
    }),
  );
}

/** Removes the person from the company, and deletes them if they belong to no other company. */
export async function removePerson(auth: AuthContext, companyId: string, personId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [link] = await tx
      .delete(companyPeople)
      .where(linkOf(auth, companyId, personId))
      .returning({ personId: companyPeople.personId });
    if (!link) throw notFound();
    await deleteOrphanedPeople(tx, [personId]);
    await audit(tx, auth, "person.removed", personId, companyId);
  });
}

function linkOf(auth: AuthContext, companyId: string, personId: string) {
  return and(
    eq(companyPeople.companyId, companyId),
    eq(companyPeople.personId, personId),
    eq(companyPeople.workspaceId, auth.workspaceId),
  );
}

function personColumns(input: PersonValues) {
  return { name: input.name, location: input.location, professionalUrl: input.professionalUrl };
}

function roleColumns(input: PersonValues) {
  return {
    title: input.title,
    seniority: input.seniority,
    jobFunction: input.jobFunction,
    relationship: input.relationship,
  };
}

/** Manually entered email/phone replace the previous manual ones; provider-sourced values are kept. */
async function replaceManualContacts(tx: Tx, personId: string, input: PersonValues): Promise<void> {
  await tx
    .delete(contactPoints)
    .where(and(eq(contactPoints.personId, personId), eq(contactPoints.source, "manual")));

  const values = [
    input.email && { personId, type: "email" as const, value: input.email, isPrimary: true },
    input.phone && { personId, type: "phone" as const, value: input.phone, isPrimary: true },
  ].filter((value) => !!value);
  if (values.length > 0) await tx.insert(contactPoints).values(values);
}

async function assertCompany(auth: AuthContext, companyId: string): Promise<void> {
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!company) throw new AppError("NOT_FOUND", "Company not found.");
}

async function audit(tx: Tx, auth: AuthContext, action: string, personId: string, companyId: string) {
  await tx.insert(auditLogs).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    action,
    entityType: "person",
    entityId: personId,
    metadata: { companyId },
  });
}

async function translateErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new AppError("VALIDATION_FAILED", "The selected job function no longer exists. Refresh and try again.");
    }
    throw error;
  }
}

function notFound(): AppError {
  return new AppError("NOT_FOUND", "Person not found at this company.");
}

/** Removes people who no longer belong to any company. */
export async function deleteOrphanedPeople(tx: Tx, personIds: string[]): Promise<void> {
  if (personIds.length === 0) return;
  await tx
    .delete(people)
    .where(
      and(
        inArray(people.id, personIds),
        notExists(tx.select().from(companyPeople).where(eq(companyPeople.personId, people.id))),
      ),
    );
}
