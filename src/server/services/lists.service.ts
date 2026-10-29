import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { auditLogs, lists, opportunities, savedOpportunities } from "@/db/schema";
import type { SavedList, SavedListDetail } from "@/lib/api/types";
import type { ListValues } from "@/lib/validation/lists";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { refreshStaleScores } from "@/server/scoring/rescore";
import { priorityOrder, summaryQuery, toSummary } from "./opportunities.service";

/** Saved lists (PRD §8.10): named groups of opportunities, e.g. "Contact today". */

const listColumns = {
  id: lists.id,
  name: lists.name,
  createdAt: lists.createdAt,
  updatedAt: lists.updatedAt,
  opportunityCount: sql<number>`(select count(*)::int from ${savedOpportunities} where ${savedOpportunities.listId} = ${lists.id})`,
};

type ListRow = { id: string; name: string; createdAt: Date; updatedAt: Date; opportunityCount: number };

export async function listLists(auth: AuthContext): Promise<SavedList[]> {
  const rows = await db
    .select(listColumns)
    .from(lists)
    .where(eq(lists.workspaceId, auth.workspaceId))
    .orderBy(asc(sql`lower(${lists.name})`));
  return rows.map(toDto);
}

export async function getList(auth: AuthContext, listId: string): Promise<SavedListDetail> {
  await refreshStaleScores(auth.workspaceId);
  const [list, rows] = await Promise.all([
    findList(auth, listId),
    summaryQuery()
      .innerJoin(savedOpportunities, eq(savedOpportunities.opportunityId, opportunities.id))
      .where(and(eq(savedOpportunities.listId, listId), eq(opportunities.workspaceId, auth.workspaceId)))
      .orderBy(...priorityOrder()),
  ]);
  return { ...toDto(list), items: rows.map(toSummary) };
}

export async function createList(auth: AuthContext, input: ListValues): Promise<SavedList> {
  const id = await translateErrors(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(lists)
        .values({ workspaceId: auth.workspaceId, name: input.name })
        .returning({ id: lists.id });
      await tx.insert(auditLogs).values(auditEntry(auth, "list.created", row.id, { name: input.name }));
      return row.id;
    }),
  );
  return toDto(await findList(auth, id));
}

export async function renameList(auth: AuthContext, listId: string, input: ListValues): Promise<SavedList> {
  const updated = await translateErrors(() =>
    db
      .update(lists)
      .set({ name: input.name })
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, auth.workspaceId)))
      .returning({ id: lists.id }),
  );
  if (updated.length === 0) throw notFound();
  return toDto(await findList(auth, listId));
}

/** Deletes the list only; the opportunities on it are untouched. */
export async function deleteList(auth: AuthContext, listId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(lists)
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, auth.workspaceId)))
      .returning({ name: lists.name });
    if (!deleted) throw notFound();
    await tx.insert(auditLogs).values(auditEntry(auth, "list.deleted", listId, { name: deleted.name }));
  });
}

/** Saves an opportunity to a list. Saving one that's already there is a no-op. */
export async function addToList(auth: AuthContext, listId: string, opportunityId: string): Promise<void> {
  await assertBelongsToWorkspace(auth, listId, opportunityId);
  await db.transaction(async (tx) => {
    await tx
      .insert(savedOpportunities)
      .values({ workspaceId: auth.workspaceId, listId, opportunityId })
      .onConflictDoNothing();
    await touch(tx, listId);
  });
}

/** Removes an opportunity from a list. Removing one that isn't there is a no-op. */
export async function removeFromList(auth: AuthContext, listId: string, opportunityId: string): Promise<void> {
  await assertBelongsToWorkspace(auth, listId, opportunityId);
  await db.transaction(async (tx) => {
    await tx
      .delete(savedOpportunities)
      .where(and(eq(savedOpportunities.listId, listId), eq(savedOpportunities.opportunityId, opportunityId)));
    await touch(tx, listId);
  });
}

/** A list counts as updated when its contents change, not only when it's renamed. */
async function touch(tx: Tx, listId: string): Promise<void> {
  await tx.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, listId));
}

async function assertBelongsToWorkspace(auth: AuthContext, listId: string, opportunityId: string): Promise<void> {
  const [list, opportunity] = await Promise.all([
    db
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, auth.workspaceId)))
      .limit(1),
    db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, auth.workspaceId)))
      .limit(1),
  ]);
  if (list.length === 0) throw notFound();
  if (opportunity.length === 0) throw new AppError("NOT_FOUND", "Opportunity not found.");
}

async function findList(auth: AuthContext, listId: string): Promise<ListRow> {
  const [row] = await db
    .select(listColumns)
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

function auditEntry(auth: AuthContext, action: string, listId: string, metadata: Record<string, unknown>) {
  return { workspaceId: auth.workspaceId, actorId: auth.userId, action, entityType: "list", entityId: listId, metadata };
}

async function translateErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error, "lists_workspace_name_uq")) {
      const message = "You already have a list with this name.";
      throw new AppError("ALREADY_EXISTS", message, { name: [message] });
    }
    throw error;
  }
}

function toDto(row: ListRow): SavedList {
  return {
    id: row.id,
    name: row.name,
    opportunityCount: row.opportunityCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function notFound(): AppError {
  return new AppError("NOT_FOUND", "List not found.");
}
