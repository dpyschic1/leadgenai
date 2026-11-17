import "server-only";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { collectedItemCategories, collectedItems } from "@/db/schema";
import { CLOSED_JOB_RETENTION_DAYS, MAX_JOB_AGE_DAYS } from "@/server/jobs/job-signal";
import { normalizeItem } from "./normalize";
import type { CollectedItemInput } from "./types";

/**
 * Writes collected items to the shared pool: new items are added, items seen again are refreshed
 * (`last_seen_at`; `last_changed_at` only when their content hash changed), items sharing a dedupe
 * key are grouped under one original (`duplicate_of`, see `regroupDuplicates`), and a job's service
 * categories come from its title.
 */

export type StoreCounts = { created: number; updated: number; unchanged: number; duplicates: number };

export async function storeItems(sourceSlug: string, targetId: string | null, found: CollectedItemInput[], now = new Date()): Promise<StoreCounts> {
  const counts: StoreCounts = { created: 0, updated: 0, unchanged: 0, duplicates: 0 };
  // One row per external id: a page listing the same job twice stores it once.
  const items = [...new Map(found.map((item) => [item.externalId, normalizeItem(item)])).values()];
  if (items.length === 0) return counts;

  const known = new Map(
    (
      await db
        .select({ externalId: collectedItems.externalId, contentHash: collectedItems.contentHash, dedupeKey: collectedItems.dedupeKey, closedAt: collectedItems.closedAt })
        .from(collectedItems)
        .where(and(eq(collectedItems.sourceSlug, sourceSlug), inArray(collectedItems.externalId, items.map((i) => i.externalId))))
    ).map((row) => [row.externalId, row]),
  );

  const changedIds: string[] = [];
  const categoriesOf = new Map<string, string[]>();
  // Groups whose original may now be a different item: new or changed items (their old key too)
  // and items that were closed and are open again.
  const regroup = new Set<string>();
  for (const item of items) {
    const previous = known.get(item.externalId);
    const before = previous?.contentHash;
    const changed = before === undefined || before !== item.contentHash;
    if (changed || previous?.closedAt) regroup.add(item.dedupeKey);
    if (previous && previous.dedupeKey !== item.dedupeKey) regroup.add(previous.dedupeKey);
    const [row] = await db
      .insert(collectedItems)
      .values({
        sourceSlug,
        externalId: item.externalId,
        kind: item.kind,
        url: item.url,
        canonicalUrl: item.canonicalUrl,
        extraction: item.extraction,
        fetchedUrl: item.fetchedUrl,
        title: item.title,
        body: item.body,
        companyName: item.companyName,
        companyDomain: item.companyDomain,
        location: item.location,
        country: item.country,
        remote: item.remote,
        postedAt: item.postedAt,
        validThrough: item.validThrough,
        firstSeenAt: now,
        lastSeenAt: now,
        lastChangedAt: now,
        contentHash: item.contentHash,
        dedupeKey: item.dedupeKey,
        lastTargetId: targetId,
        data: item.data,
      })
      .onConflictDoUpdate({
        target: [collectedItems.sourceSlug, collectedItems.externalId],
        set: {
          lastSeenAt: now,
          lastTargetId: targetId,
          // Seen again: open again (a job relisted soon after keeps its first-seen date).
          closedAt: null,
          ...(changed
            ? {
                url: item.url,
                canonicalUrl: item.canonicalUrl,
                extraction: item.extraction,
                fetchedUrl: item.fetchedUrl,
                title: item.title,
                body: item.body,
                companyName: item.companyName,
                companyDomain: item.companyDomain,
                location: item.location,
                country: item.country,
                remote: item.remote,
                postedAt: item.postedAt,
                validThrough: item.validThrough,
                contentHash: item.contentHash,
                dedupeKey: item.dedupeKey,
                data: item.data,
                lastChangedAt: now,
              }
            : {}),
        },
      })
      .returning({ id: collectedItems.id });
    if (before === undefined) counts.created++;
    else if (changed) counts.updated++;
    else counts.unchanged++;
    if (changed) {
      changedIds.push(row.id);
      categoriesOf.set(row.id, item.categories);
    }
  }

  if (changedIds.length > 0) await saveCategories(categoriesOf);
  await regroupDuplicates([...regroup]);
  if (changedIds.length > 0) {
    const [{ duplicates }] = await db.execute<{ duplicates: number }>(sql`
      select count(*)::int as duplicates from collected_items
      where id in (${sql.join(changedIds.map((id) => sql`${id}::uuid`), sql`, `)}) and duplicate_of is not null`);
    counts.duplicates = duplicates;
  }
  return counts;
}

/** Replaces the title-rule categories of these items (AI categories, added later, are kept). */
async function saveCategories(categoriesOf: Map<string, string[]>): Promise<void> {
  const ids = [...categoriesOf.keys()];
  await db.delete(collectedItemCategories).where(and(inArray(collectedItemCategories.itemId, ids), eq(collectedItemCategories.method, "rule")));
  const rows = ids.flatMap((itemId) => categoriesOf.get(itemId)!.map((categorySlug) => ({ itemId, categorySlug, method: "rule" })));
  if (rows.length > 0) await db.insert(collectedItemCategories).values(rows).onConflictDoNothing();
}

/** Dedupe keys regrouped per statement. */
const REGROUP_BATCH = 500;

/**
 * Recomputes the original of each group of items sharing a dedupe key (the same job from several
 * sources or listings): the earliest-seen open item, or the earliest item when all are closed.
 * Every other item of the group points at it; the original points at nothing. Called whenever a
 * group's members change: added, changed, closed, reopened or deleted. So a copy never points at a
 * closed original while an open one exists, nor at an item that no longer has its key.
 */
export async function regroupDuplicates(keys: string[]): Promise<void> {
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += REGROUP_BATCH) {
    const batch = unique.slice(i, i + REGROUP_BATCH);
    await db.execute(sql`
      with ranked as (
        select id, first_value(id) over (partition by dedupe_key order by (closed_at is not null), first_seen_at, id) as original
        from collected_items
        where dedupe_key in (${sql.join(batch.map((key) => sql`${key}`), sql`, `)}))
      update collected_items i set duplicate_of = nullif(r.original, i.id)
      from ranked r
      where r.id = i.id and i.duplicate_of is distinct from nullif(r.original, i.id)`);
  }
}

/**
 * After a complete run of a target: its open items not seen in that run have closed (taken off the
 * careers page). Returns how many closed.
 */
export async function closeMissing(targetId: string, runStartedAt: Date, now = new Date()): Promise<number> {
  const rows = await db
    .update(collectedItems)
    .set({ closedAt: now })
    .where(and(eq(collectedItems.lastTargetId, targetId), isNull(collectedItems.closedAt), lt(collectedItems.lastSeenAt, runStartedAt)))
    .returning({ dedupeKey: collectedItems.dedupeKey });
  await regroupDuplicates(rows.map((r) => r.dedupeKey));
  return rows.length;
}

/**
 * Closes open items whose source said they expire (`valid_through`) once that time has passed,
 * without waiting for their target's next complete run (up to a week away). Returns how many.
 */
export async function expireItems(now = new Date()): Promise<number> {
  const rows = await db
    .update(collectedItems)
    .set({ closedAt: now })
    .where(and(isNull(collectedItems.closedAt), lt(collectedItems.validThrough, now)))
    .returning({ dedupeKey: collectedItems.dedupeKey });
  await regroupDuplicates(rows.map((r) => r.dedupeKey));
  return rows.length;
}

/** Collection runs are kept this long (the newest of each target always stays). */
export const RUN_HISTORY_DAYS = 14;

/**
 * Keeps the pool small (DB size plan): closed items go after `CLOSED_JOB_RETENTION_DAYS`, items
 * posted (or, undated, first seen) more than `MAX_JOB_AGE_DAYS` ago go, and old run logs go.
 */
export async function pruneCollection(): Promise<{ items: number; runs: number }> {
  const items = await db.execute<{ dedupe_key: string }>(sql`
    delete from collected_items
    where (closed_at is not null and closed_at < now() - make_interval(days => ${CLOSED_JOB_RETENTION_DAYS}))
       or coalesce(posted_at, first_seen_at) < now() - make_interval(days => ${MAX_JOB_AGE_DAYS})
    returning dedupe_key`);
  // A deleted original leaves its copies pointing at nothing: their group gets a new original.
  await regroupDuplicates(items.map((r) => r.dedupe_key));
  const runs = await db.execute<{ id: string }>(sql`
    delete from collection_runs r
    where r.started_at < now() - make_interval(days => ${RUN_HISTORY_DAYS})
      and exists (select 1 from collection_runs n where n.target_id = r.target_id and n.started_at > r.started_at)
    returning id`);
  return { items: (items as unknown[]).length, runs: (runs as unknown[]).length };
}
