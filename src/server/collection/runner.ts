import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { collectionRuns, collectionTargets } from "@/db/schema";
import { MAX_COLLECT_INTERVAL_MINUTES, MIN_COLLECT_INTERVAL_MINUTES } from "@/lib/domain/collection";
import { AppError } from "@/server/http/errors";
import { rateLimit } from "@/server/http/rate-limit";
import { FetchBlockedError } from "@/server/sources/http";
import { COLLECTORS } from "./collectors";
import { createFetcher } from "./fetch";
import { closeMissing, expireItems, pruneCollection, storeItems } from "./store";
import type { CollectTarget } from "./types";

/**
 * Runs the Web Scraping & Discovery Engine: claims due targets of approved sources, runs their
 * collectors side by side within a time budget, stores what they find and logs every run. Called
 * by the scheduler (`/api/v1/internal/collect`); independent of the ingestion tick.
 */

/**
 * Targets one call collects side by side, within the platform-wide `MAX_ACTIVE_RUNS`. A site is
 * one target, leased in the database, so it is read by one run at a time on any instance, and that
 * run spaces its requests a second apart (`politeGet`).
 */
const LANES = 4;
/** Requests one run of one target may make. */
const MAX_REQUESTS_PER_RUN = 30;
/** Longest one target's run may take, so a large site never holds a lane for a whole call. */
const MAX_RUN_MS = 30_000;
/** How long a claimed target stays leased; a lease past this (its run died) is claimed again. */
const LEASE_SECONDS = 180;

export type CollectionSummary = { runs: number; failed: number; created: number; updated: number; closed: number; seeded: number; pruned: number };

/**
 * When to try a failing target again: 1, 4, 16, 64 minutes… never later than its normal interval,
 * and a target that keeps failing is still tried at that interval (sites come back). Pure.
 */
export function retryDelayMinutes(consecutiveFailures: number, intervalMinutes: number): number {
  return Math.min(4 ** Math.max(0, consecutiveFailures - 1), intervalMinutes);
}

/**
 * The next interval of a target that ran: halved when something was new or changed (it moves),
 * doubled when nothing was (it doesn't), within the engine's limits. Pure.
 */
export function nextInterval(current: number, changed: boolean): number {
  const next = changed ? Math.floor(current / 2) : current * 2;
  return Math.min(MAX_COLLECT_INTERVAL_MINUTES, Math.max(MIN_COLLECT_INTERVAL_MINUTES, next));
}

/**
 * Most targets collected at once across the whole platform: every call, on every server instance,
 * shares this limit (counted from the leases in the database), so overlapping scheduler calls never
 * add up to more outgoing requests than this many runs make.
 */
export const MAX_ACTIVE_RUNS = 8;

/**
 * Claims the next due target of an approved source (one of `only`), leasing it, unless
 * `MAX_ACTIVE_RUNS` targets are already leased. Claims are taken one at a time platform-wide (a
 * transaction-scoped advisory lock), so the count and the lease can't race between instances.
 */
export async function claimTarget(only: string[]): Promise<CollectTarget | null> {
  if (only.length === 0) return null;
  const id = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('collection_claim'))`);
    const [{ active }] = await tx.execute<{ active: number }>(sql`
      select count(*)::int as active from collection_targets where leased_until > now()`);
    if (active >= MAX_ACTIVE_RUNS) return null;
    const rows = await tx.execute<{ id: string }>(sql`
      update collection_targets set leased_until = now() + make_interval(secs => ${LEASE_SECONDS}), last_run_at = now()
      where id = (
        select c.id from collection_targets c
        join sources s on s.slug = c.source_slug
        where c.enabled and s.authorization_status = 'approved'
          and c.source_slug in (${sql.join(only.map((slug) => sql`${slug}`), sql`, `)})
          and c.next_run_at <= now()
          and (c.leased_until is null or c.leased_until < now())
        order by c.priority desc, c.next_run_at
        limit 1
        for update of c skip locked)
      returning id`);
    return rows[0]?.id ?? null;
  });
  if (!id) return null;
  const [row] = await db.select().from(collectionTargets).where(eq(collectionTargets.id, id));
  return row ?? null;
}

/**
 * A target's website moved to `domain`: the new domain becomes a target of the same source (with
 * the old one's priority), unless it already is one, so a domain change never makes a duplicate.
 * A destination already switched off because it moved itself means the two redirect to each
 * other: that is refused as a loop.
 */
async function recordMove(target: CollectTarget, domain: string, intervalMinutes: number): Promise<void> {
  const [existing] = await db
    .select({ enabled: collectionTargets.enabled })
    .from(collectionTargets)
    .where(and(eq(collectionTargets.sourceSlug, target.sourceSlug), eq(collectionTargets.targetKey, domain)));
  if (existing && !existing.enabled) throw new FetchBlockedError(`Redirect loop: ${target.targetKey} and ${domain} redirect to each other`);
  if (existing) return;
  await db
    .insert(collectionTargets)
    .values({
      sourceSlug: target.sourceSlug,
      targetKey: domain,
      intervalMinutes,
      params: { movedFrom: target.targetKey },
      priority: sql`(select priority from collection_targets where id = ${target.id})`,
    })
    .onConflictDoNothing();
}

/** Collects one claimed target: runs its collector, stores the items, logs the run, schedules the next. */
export async function runTarget(target: CollectTarget, callDeadline: number): Promise<{ ok: boolean; created: number; updated: number; closed: number }> {
  const collector = COLLECTORS[target.sourceSlug];
  const startedAt = new Date();
  const [run] = await db.insert(collectionRuns).values({ targetId: target.id, startedAt }).returning({ id: collectionRuns.id });
  const fetcher = createFetcher({ maxRequests: MAX_REQUESTS_PER_RUN, deadline: Math.min(callDeadline, startedAt.getTime() + MAX_RUN_MS) });

  try {
    if (!collector) throw new Error(`No collector for ${target.sourceSlug}`);
    const result = await collector.collect({ target, now: startedAt, deadline: Math.min(callDeadline, startedAt.getTime() + MAX_RUN_MS), fetcher });
    if (result.movedTo) await recordMove(target, result.movedTo.domain, collector.defaultIntervalMinutes);
    const counts = await storeItems(target.sourceSlug, target.id, result.items, startedAt);
    const closed = result.complete ? await closeMissing(target.id, startedAt) : 0;
    const intervalMinutes = result.intervalMinutes ?? nextInterval(target.intervalMinutes, counts.created + counts.updated + closed > 0);
    const finishedAt = new Date();
    await db
      .update(collectionRuns)
      .set({
        finishedAt,
        status: result.complete ? "success" : "partial",
        complete: result.complete,
        requests: fetcher.requests,
        fetched: result.items.length,
        ...counts,
        closed,
        details: result.note ? { note: result.note } : {},
      })
      .where(eq(collectionRuns.id, run.id));
    await db
      .update(collectionTargets)
      .set({
        cursor: result.cursor,
        // A website that moved is collected under its new domain from now on.
        ...(result.movedTo ? { enabled: false } : {}),
        intervalMinutes,
        nextRunAt: new Date(finishedAt.getTime() + intervalMinutes * 60_000),
        leasedUntil: null,
        lastSuccessAt: finishedAt,
        consecutiveFailures: 0,
        lastError: null,
      })
      .where(eq(collectionTargets.id, target.id));
    return { ok: true, created: counts.created, updated: counts.updated, closed };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const [{ failures }] = await db
      .select({ failures: collectionTargets.consecutiveFailures })
      .from(collectionTargets)
      .where(eq(collectionTargets.id, target.id));
    // robots.txt or the collection policy refuses the site: that won't change soon.
    const delay = error instanceof FetchBlockedError ? target.intervalMinutes * 4 : retryDelayMinutes(failures + 1, target.intervalMinutes);
    await db
      .update(collectionRuns)
      .set({ finishedAt: new Date(), status: "failed", requests: fetcher.requests, error: message })
      .where(eq(collectionRuns.id, run.id));
    await db
      .update(collectionTargets)
      .set({
        nextRunAt: new Date(Date.now() + Math.min(delay, 43_200) * 60_000),
        leasedUntil: null,
        consecutiveFailures: failures + 1,
        lastError: message,
      })
      .where(eq(collectionTargets.id, target.id));
    return { ok: false, created: 0, updated: 0, closed: 0 };
  }
}

/** Runs due targets in parallel lanes until the deadline; `only` limits it to some sources. */
export async function runDueTargets({ deadline, only = Object.keys(COLLECTORS) }: { deadline: number; only?: string[] }): Promise<Omit<CollectionSummary, "seeded" | "pruned">> {
  const summary = { runs: 0, failed: 0, created: 0, updated: 0, closed: 0 };
  const lane = async () => {
    // Don't start a target that has less than ~a third of a run left.
    while (Date.now() < deadline - MAX_RUN_MS / 3) {
      const target = await claimTarget(only);
      if (!target) return;
      const result = await runTarget(target, deadline);
      summary.runs++;
      if (!result.ok) summary.failed++;
      summary.created += result.created;
      summary.updated += result.updated;
      summary.closed += result.closed;
    }
  };
  await Promise.all(Array.from({ length: LANES }, lane));
  return summary;
}

/** At most once an hour: add new targets from what the platform knows, and prune old items and runs. */
async function maintenance(): Promise<{ seeded: number; pruned: number }> {
  try {
    await rateLimit("housekeeping", "collection");
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMITED") return { seeded: 0, pruned: 0 };
    throw error;
  }
  let seeded = 0;
  for (const collector of Object.values(COLLECTORS)) seeded += (await collector.seed?.()) ?? 0;
  const pruned = await pruneCollection();
  return { seeded, pruned: pruned.items };
}

/**
 * One scheduled call: close what has expired (every call, so an expired job is closed within
 * minutes), hourly maintenance, then due targets until the budget is used.
 */
export async function runCollection({ budgetMs }: { budgetMs: number }): Promise<CollectionSummary> {
  const deadline = Date.now() + budgetMs;
  const expired = await expireItems();
  const { seeded, pruned } = await maintenance();
  const summary = await runDueTargets({ deadline });
  return { ...summary, closed: summary.closed + expired, seeded, pruned };
}
