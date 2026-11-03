import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { isForeignKeyViolation } from "@/db/errors";
import {
  auditLogs,
  serviceServiceCategories,
  serviceTargetCountries,
  serviceTargetIndustries,
  serviceTargetJobFunctions,
  services,
} from "@/db/schema";
import type { Service } from "@/lib/api/types";
import { FIRST_PAGE, offsetOf, type Page, type Pagination } from "@/lib/validation/pagination";
import type { ServiceValues } from "@/lib/validation/services";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";

type ServiceRow = typeof services.$inferSelect;

/** One page of the workspace's services, oldest first (scoring always uses all of them: `loadServices`). */
export async function listServices(auth: AuthContext, page: Pagination = FIRST_PAGE): Promise<Page<Service>> {
  const mine = eq(services.workspaceId, auth.workspaceId);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(services).where(mine).orderBy(asc(services.createdAt), asc(services.id)).limit(page.pageSize).offset(offsetOf(page)),
    db.select({ total: sql<number>`count(*)::int` }).from(services).where(mine),
  ]);
  return { items: await withTargeting(db, rows), total, ...page };
}

/** A workspace's services with targeting; also used by background re-scoring (no request user). */
export async function loadServices(workspaceId: string): Promise<Service[]> {
  const rows = await db
    .select()
    .from(services)
    .where(eq(services.workspaceId, workspaceId))
    .orderBy(asc(services.createdAt));
  return withTargeting(db, rows);
}

export async function createService(auth: AuthContext, input: ServiceValues): Promise<Service> {
  return translateErrors(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(services)
        .values({ workspaceId: auth.workspaceId, ...serviceColumns(input) })
        .returning();
      await writeTargeting(tx, row.id, input);
      await audit(tx, auth, "service.created", row.id);
      const [service] = await withTargeting(tx, [row]);
      return service;
    }),
  );
}

export async function updateService(
  auth: AuthContext,
  serviceId: string,
  input: ServiceValues,
): Promise<Service> {
  return translateErrors(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .update(services)
        .set(serviceColumns(input))
        .where(and(eq(services.id, serviceId), eq(services.workspaceId, auth.workspaceId)))
        .returning();
      if (!row) throw notFound();
      await clearTargeting(tx, row.id);
      await writeTargeting(tx, row.id, input);
      await audit(tx, auth, "service.updated", row.id);
      const [service] = await withTargeting(tx, [row]);
      return service;
    }),
  );
}

export async function deleteService(auth: AuthContext, serviceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(services)
      .where(and(eq(services.id, serviceId), eq(services.workspaceId, auth.workspaceId)))
      .returning({ id: services.id });
    if (!row) throw notFound();
    await audit(tx, auth, "service.deleted", row.id);
  });
}

function serviceColumns(input: ServiceValues) {
  return {
    name: input.name,
    description: input.description || null,
    targetCompanySizeMin: input.companySizeMin,
    targetCompanySizeMax: input.companySizeMax,
  };
}

async function writeTargeting(tx: Tx, serviceId: string, input: ServiceValues): Promise<void> {
  const rows = <T>(values: string[], toRow: (value: string) => T) => values.map(toRow);
  await Promise.all([
    insertIfAny(tx, serviceServiceCategories, rows(input.categories, (categorySlug) => ({ serviceId, categorySlug }))),
    insertIfAny(tx, serviceTargetIndustries, rows(input.targetIndustries, (industrySlug) => ({ serviceId, industrySlug }))),
    insertIfAny(
      tx,
      serviceTargetJobFunctions,
      rows(input.targetJobFunctions, (jobFunctionSlug) => ({ serviceId, jobFunctionSlug })),
    ),
    insertIfAny(tx, serviceTargetCountries, rows(input.targetCountries, (countryCode) => ({ serviceId, countryCode }))),
  ]);
}

async function insertIfAny<T extends Parameters<Tx["insert"]>[0]>(
  tx: Tx,
  table: T,
  values: T["$inferInsert"][],
): Promise<void> {
  if (values.length > 0) await tx.insert(table).values(values);
}

async function clearTargeting(tx: Tx, serviceId: string): Promise<void> {
  await Promise.all([
    tx.delete(serviceServiceCategories).where(eq(serviceServiceCategories.serviceId, serviceId)),
    tx.delete(serviceTargetIndustries).where(eq(serviceTargetIndustries.serviceId, serviceId)),
    tx.delete(serviceTargetJobFunctions).where(eq(serviceTargetJobFunctions.serviceId, serviceId)),
    tx.delete(serviceTargetCountries).where(eq(serviceTargetCountries.serviceId, serviceId)),
  ]);
}

/** Loads the targeting join rows for a set of services and assembles the DTOs. */
async function withTargeting(conn: Tx | typeof db, rows: ServiceRow[]): Promise<Service[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [categories, industries, jobFunctions, countries] = await Promise.all([
    conn.select().from(serviceServiceCategories).where(inArray(serviceServiceCategories.serviceId, ids)),
    conn.select().from(serviceTargetIndustries).where(inArray(serviceTargetIndustries.serviceId, ids)),
    conn.select().from(serviceTargetJobFunctions).where(inArray(serviceTargetJobFunctions.serviceId, ids)),
    conn.select().from(serviceTargetCountries).where(inArray(serviceTargetCountries.serviceId, ids)),
  ]);

  const pick = <R extends { serviceId: string }>(list: R[], id: string, value: (row: R) => string) =>
    list.filter((row) => row.serviceId === id).map(value);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    categories: pick(categories, row.id, (r) => r.categorySlug),
    targetIndustries: pick(industries, row.id, (r) => r.industrySlug),
    targetJobFunctions: pick(jobFunctions, row.id, (r) => r.jobFunctionSlug),
    targetCountries: pick(countries, row.id, (r) => r.countryCode),
    companySizeMin: row.targetCompanySizeMin,
    companySizeMax: row.targetCompanySizeMax,
  }));
}

async function audit(tx: Tx, auth: AuthContext, action: string, serviceId: string): Promise<void> {
  await tx.insert(auditLogs).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    action,
    entityType: "service",
    entityId: serviceId,
  });
}

/** An unknown category/industry/job-function slug fails the lookup FK; report it as bad input. */
async function translateErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new AppError("VALIDATION_FAILED", "One of the selected options no longer exists. Refresh and try again.");
    }
    throw error;
  }
}

function notFound(): AppError {
  return new AppError("NOT_FOUND", "Service not found.");
}
