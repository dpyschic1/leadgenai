import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  collectedItemCategories,
  collectedItems,
  collectionRuns,
  collectionTargets,
  companies,
  companyJobBoards,
  signals,
  sourceRecords,
  sources,
  users,
  workspaces,
  ycCompanies,
} from "@/db/schema";
import { companySchema } from "@/lib/validation/companies";
import { serviceSchema } from "@/lib/validation/services";
import { systemActor } from "@/server/auth/actor";
import type { AuthContext } from "@/server/auth/session";
import { ycBatches } from "@/server/engine/providers/yc-batches";
import { matchCollectedJobs } from "@/server/ingestion/shared-jobs";
import { registerOwner } from "@/server/services/auth.service";
import { createCompany } from "@/server/services/companies.service";
import { createService } from "@/server/services/services.service";
import { COLLECTORS } from "@/server/collection/collectors";
import { claimTarget, MAX_ACTIVE_RUNS, runDueTargets, runTarget } from "@/server/collection/runner";
import { closeMissing, expireItems, pruneCollection, storeItems } from "@/server/collection/store";
import { searchCollected } from "@/server/collection/search";
import type { CollectedItemInput, CollectResult, Collector } from "@/server/collection/types";

/**
 * The Web Scraping & Discovery Engine against the real database (`npm run test:integration`), with
 * a fake collector in place of the network: items are stored once and refreshed on later visits,
 * changes and duplicates are detected, a complete run closes what is gone, failures back off, runs
 * are logged, targets are never collected twice at once, and restricted sources never run. And what
 * was collected feeds both engines: Company Discovery's companies and signals, LeadGen's YC roles.
 */

const SOURCE = "collection_test";
const OTHER = "collection_test_other";
const TEST_SOURCES = [SOURCE, OTHER];

const POSTED = new Date(Date.now() - 86_400_000);

const job = (overrides: Partial<CollectedItemInput> = {}): CollectedItemInput => ({
  externalId: "acme.test:1",
  kind: "job",
  url: "https://acme.test/careers/frontend-engineer?utm_source=x",
  extraction: "json_ld",
  fetchedUrl: "https://acme.test/careers",
  title: "Senior Frontend Engineer",
  text: "Build our React web app.",
  companyName: "Acme",
  companyDomain: "acme.test",
  location: "Austin, TX, US",
  country: "US",
  remote: null,
  postedAt: POSTED,
  validThrough: null,
  data: {},
  ...overrides,
});

/** What the fake collector returns next, or throws. */
let next: CollectResult | Error = { items: [], cursor: {}, complete: true };
const fake: Collector = {
  slug: SOURCE as Collector["slug"],
  access: "api",
  defaultIntervalMinutes: 1440,
  async collect() {
    if (next instanceof Error) throw next;
    return next;
  },
};

async function cleanUp() {
  await db.delete(collectedItems).where(inArray(collectedItems.sourceSlug, TEST_SOURCES));
  await db.delete(collectionTargets).where(inArray(collectionTargets.sourceSlug, [...TEST_SOURCES, "linkedin"]));
}

async function addTarget(sourceSlug = SOURCE, key = `acme-${crypto.randomUUID()}.test`) {
  const [target] = await db.insert(collectionTargets).values({ sourceSlug, targetKey: key, intervalMinutes: 1440 }).returning();
  return target;
}

beforeAll(async () => {
  await db
    .insert(sources)
    .values(TEST_SOURCES.map((slug) => ({ slug, name: slug, type: "test", authorizationStatus: "approved" as const })))
    .onConflictDoNothing();
  COLLECTORS[SOURCE] = fake;
});

beforeEach(cleanUp);

afterAll(async () => {
  await cleanUp();
  delete COLLECTORS[SOURCE];
  await db.delete(sources).where(inArray(sources.slug, TEST_SOURCES));
});

describe("storing collected items", () => {
  it("adds an item once, refreshes it when seen again and notes when it changed", async () => {
    const first = await storeItems(SOURCE, null, [job(), job()]);
    expect(first).toEqual({ created: 1, updated: 0, unchanged: 0, duplicates: 0 });
    const [stored] = await db.select().from(collectedItems).where(eq(collectedItems.sourceSlug, SOURCE));
    expect(stored).toMatchObject({ canonicalUrl: "https://acme.test/careers/frontend-engineer", fetchedUrl: "https://acme.test/careers", country: "US" });
    const categories = await db.select().from(collectedItemCategories).where(eq(collectedItemCategories.itemId, stored.id));
    expect(categories.map((c) => c.categorySlug)).toContain("software_development");

    const later = new Date(Date.now() + 60_000);
    expect(await storeItems(SOURCE, null, [job()], later)).toMatchObject({ created: 0, unchanged: 1 });
    const [seen] = await db.select().from(collectedItems).where(eq(collectedItems.id, stored.id));
    expect(seen.lastSeenAt.getTime()).toBe(later.getTime());
    expect(seen.lastChangedAt.getTime()).toBe(stored.lastChangedAt.getTime());

    const changedAt = new Date(Date.now() + 120_000);
    expect(await storeItems(SOURCE, null, [job({ title: "Staff Frontend Engineer" })], changedAt)).toMatchObject({ updated: 1 });
    const [changed] = await db.select().from(collectedItems).where(eq(collectedItems.id, stored.id));
    expect(changed.title).toBe("Staff Frontend Engineer");
    expect(changed.lastChangedAt.getTime()).toBe(changedAt.getTime());
    expect(changed.firstSeenAt.getTime()).toBe(stored.firstSeenAt.getTime());
  });

  it("links the same job from another source to the one seen first", async () => {
    await storeItems(SOURCE, null, [job()]);
    const counts = await storeItems(OTHER, null, [job({ externalId: "other-id", url: "https://jobs.example/acme/42", title: "senior frontend engineer" })]);
    expect(counts.duplicates).toBe(1);
    const [original] = await db.select().from(collectedItems).where(eq(collectedItems.sourceSlug, SOURCE));
    const [repeat] = await db.select().from(collectedItems).where(eq(collectedItems.sourceSlug, OTHER));
    expect(repeat.duplicateOf).toBe(original.id);
    expect(original.duplicateOf).toBeNull();
  });

  it("keeps one open original per group as copies change, close, reopen and are pruned", async () => {
    const target = await addTarget();
    const original = (key: string) => db.select().from(collectedItems).where(and(eq(collectedItems.sourceSlug, OTHER), eq(collectedItems.externalId, key)));
    const ofSource = async () =>
      Object.fromEntries((await db.select().from(collectedItems).where(inArray(collectedItems.sourceSlug, TEST_SOURCES))).map((r) => [r.externalId, r]));
    const t0 = new Date(Date.now() - 3 * 60_000);
    await storeItems(OTHER, target.id, [job({ externalId: "a" })], t0);
    await storeItems(SOURCE, null, [job({ externalId: "b" })], new Date(t0.getTime() + 60_000));
    let items = await ofSource();
    expect(items.b.duplicateOf).toBe(items.a.id);

    // The original closes: the open copy becomes the original, and the closed one points at it.
    expect(await closeMissing(target.id, new Date())).toBe(1);
    items = await ofSource();
    expect(items.b.duplicateOf).toBeNull();
    expect(items.a.duplicateOf).toBe(items.b.id);

    // A new copy joins the open original, not the closed one.
    await storeItems(SOURCE, null, [job({ externalId: "c" })]);
    items = await ofSource();
    expect(items.c.duplicateOf).toBe(items.b.id);

    // The first one reopens: it is the original again for the whole group.
    await storeItems(OTHER, target.id, [job({ externalId: "a" })]);
    items = await ofSource();
    expect([items.a.duplicateOf, items.b.duplicateOf, items.c.duplicateOf]).toEqual([null, items.a.id, items.a.id]);

    // The original changes title (a new key): it leaves the group, which gets a new original.
    await storeItems(OTHER, target.id, [job({ externalId: "a", title: "Principal Frontend Engineer" })]);
    items = await ofSource();
    expect([items.a.duplicateOf, items.b.duplicateOf, items.c.duplicateOf]).toEqual([null, null, items.b.id]);

    // The original is pruned: its copy takes over.
    await db.update(collectedItems).set({ closedAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(collectedItems.id, items.b.id));
    await pruneCollection();
    items = await ofSource();
    expect(items.b).toBeUndefined();
    expect(items.c.duplicateOf).toBeNull();
    expect((await original("a"))[0].duplicateOf).toBeNull();
  });

  it("re-reads what an item is when its source says so (a post first taken for a job)", async () => {
    await storeItems(SOURCE, null, [job()]);
    await storeItems(SOURCE, null, [job({ kind: "post", companyName: null })]);
    const [row] = await db.select().from(collectedItems).where(eq(collectedItems.sourceSlug, SOURCE));
    expect(row.kind).toBe("post");
  });

  it("keeps a stored description when the job comes back without its text", async () => {
    await storeItems(SOURCE, null, [job({ text: "Build our React web app with TypeScript." })]);
    const counts = await storeItems(SOURCE, null, [job({ text: null })], new Date(Date.now() + 60_000));
    expect(counts).toMatchObject({ unchanged: 1, updated: 0 });
    const [row] = await db.select().from(collectedItems).where(eq(collectedItems.sourceSlug, SOURCE));
    expect(row.body).toContain("React web app");
  });

  it("closes an item as soon as its stated expiry passes", async () => {
    await storeItems(SOURCE, null, [job({ validThrough: new Date(Date.now() + 1_000) }), job({ externalId: "acme.test:2", title: "Designer", validThrough: new Date(Date.now() + 86_400_000) })]);
    expect(await expireItems(new Date(Date.now() + 60_000))).toBe(1);
    const rows = await db.select().from(collectedItems).where(eq(collectedItems.sourceSlug, SOURCE));
    expect(rows.find((r) => r.externalId === "acme.test:1")?.closedAt).not.toBeNull();
    expect(rows.find((r) => r.externalId === "acme.test:2")?.closedAt).toBeNull();
  });

  it("closes what a complete run no longer finds, and reopens it when it comes back", async () => {
    const target = await addTarget();
    const start = new Date();
    await storeItems(SOURCE, target.id, [job(), job({ externalId: "acme.test:2", title: "Designer" })], start);
    const runAt = new Date(start.getTime() + 60_000);
    await storeItems(SOURCE, target.id, [job()], runAt);
    expect(await closeMissing(target.id, runAt)).toBe(1);
    const [gone] = await db.select().from(collectedItems).where(and(eq(collectedItems.sourceSlug, SOURCE), eq(collectedItems.externalId, "acme.test:2")));
    expect(gone.closedAt).not.toBeNull();

    await storeItems(SOURCE, target.id, [job({ externalId: "acme.test:2", title: "Designer" })]);
    const [back] = await db.select().from(collectedItems).where(eq(collectedItems.id, gone.id));
    expect(back.closedAt).toBeNull();
  });

  it("prunes items closed long ago and items too old to be current", async () => {
    await storeItems(SOURCE, null, [job(), job({ externalId: "acme.test:old", title: "Old role" }), job({ externalId: "acme.test:closed", title: "Closed role" })]);
    await db.update(collectedItems).set({ postedAt: new Date(Date.now() - 90 * 86_400_000) }).where(eq(collectedItems.externalId, "acme.test:old"));
    await db.update(collectedItems).set({ closedAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(collectedItems.externalId, "acme.test:closed"));
    await pruneCollection();
    const left = await db.select({ externalId: collectedItems.externalId }).from(collectedItems).where(eq(collectedItems.sourceSlug, SOURCE));
    expect(left.map((r) => r.externalId)).toEqual(["acme.test:1"]);
  });
});

describe("running targets", () => {
  it("runs a due target, stores its items, logs the run and schedules the next", async () => {
    const target = await addTarget();
    next = { items: [job()], cursor: { careersUrl: "https://acme.test/careers" }, complete: true };
    const summary = await runDueTargets({ deadline: Date.now() + 30_000, only: [SOURCE] });
    expect(summary).toMatchObject({ runs: 1, failed: 0, created: 1 });

    const [run] = await db.select().from(collectionRuns).where(eq(collectionRuns.targetId, target.id));
    expect(run).toMatchObject({ status: "success", complete: true, fetched: 1, created: 1, error: null });
    const [after] = await db.select().from(collectionTargets).where(eq(collectionTargets.id, target.id));
    expect(after.cursor).toEqual({ careersUrl: "https://acme.test/careers" });
    expect(after.leasedUntil).toBeNull();
    expect(after.intervalMinutes).toBe(720); // something new: looked at again sooner
    expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 11 * 3_600_000);
  });

  it("backs off a failing target and logs the error", async () => {
    const target = await addTarget();
    next = new Error("Home page answered 503");
    await runTarget({ ...target }, Date.now() + 30_000);
    await runTarget({ ...target }, Date.now() + 30_000);
    const [after] = await db.select().from(collectionTargets).where(eq(collectionTargets.id, target.id));
    expect(after).toMatchObject({ consecutiveFailures: 2, lastError: "Home page answered 503", leasedUntil: null });
    // The second failure waits 4 minutes.
    expect(after.nextRunAt.getTime() - Date.now()).toBeGreaterThan(3 * 60_000);
    expect(after.nextRunAt.getTime() - Date.now()).toBeLessThan(5 * 60_000);
    const runs = await db.select().from(collectionRuns).where(eq(collectionRuns.targetId, target.id));
    expect(runs.map((r) => r.status)).toEqual(["failed", "failed"]);
  });

  it("an incomplete run closes nothing", async () => {
    const target = await addTarget();
    next = { items: [job(), job({ externalId: "acme.test:2", title: "Designer" })], cursor: {}, complete: true };
    await runTarget(target, Date.now() + 30_000);
    next = { items: [job()], cursor: {}, complete: false };
    await runTarget(target, Date.now() + 30_000);
    const open = await db.select().from(collectedItems).where(and(eq(collectedItems.sourceSlug, SOURCE), sql`${collectedItems.closedAt} is null`));
    expect(open).toHaveLength(2);
    const runs = await db.select({ status: collectionRuns.status }).from(collectionRuns).where(eq(collectionRuns.targetId, target.id));
    expect(runs.map((r) => r.status).sort()).toEqual(["partial", "success"]);
  });

  it("never gives one target to two runs at once", async () => {
    await addTarget();
    const claims = await Promise.all([claimTarget([SOURCE]), claimTarget([SOURCE]), claimTarget([SOURCE])]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("a website that moved: the old target keeps its history and switches off, the new domain is added once", async () => {
    const newDomain = `moved-${crypto.randomUUID()}.test`;
    const old = await addTarget();
    const moves = [{ from: `https://${old.targetKey}/`, to: `https://www.${newDomain}/`, hops: [`https://${old.targetKey}/`], domain: newDomain }];
    next = { items: [], cursor: { movedTo: newDomain, redirects: moves }, complete: true, movedTo: { domain: newDomain, moves } };
    expect((await runTarget(old, Date.now() + 30_000)).ok).toBe(true);

    const [after] = await db.select().from(collectionTargets).where(eq(collectionTargets.id, old.id));
    expect(after).toMatchObject({ enabled: false, targetKey: old.targetKey, cursor: { movedTo: newDomain, redirects: moves } });
    const added = await db.select().from(collectionTargets).where(and(eq(collectionTargets.sourceSlug, SOURCE), eq(collectionTargets.targetKey, newDomain)));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ enabled: true, params: { movedFrom: old.targetKey } });

    // Another old domain moving to the same new one adds no second target.
    const other = await addTarget();
    expect((await runTarget(other, Date.now() + 30_000)).ok).toBe(true);
    expect(await db.select().from(collectionTargets).where(and(eq(collectionTargets.sourceSlug, SOURCE), eq(collectionTargets.targetKey, newDomain)))).toHaveLength(1);
  });

  it("two websites redirecting to each other across runs are refused as a loop", async () => {
    const a = await addTarget();
    const b = await addTarget();
    await db.update(collectionTargets).set({ enabled: false, cursor: { movedTo: b.targetKey } }).where(eq(collectionTargets.id, a.id));
    next = { items: [], cursor: {}, complete: true, movedTo: { domain: a.targetKey, moves: [] } };
    expect((await runTarget(b, Date.now() + 30_000)).ok).toBe(false);
    const [after] = await db.select().from(collectionTargets).where(eq(collectionTargets.id, b.id));
    expect(after.enabled).toBe(true);
    expect(after.lastError).toBe(`Redirect loop: ${b.targetKey} and ${a.targetKey} redirect to each other`);
  });

  it("never runs more than the platform-wide limit of targets at once", async () => {
    const [{ active }] = await db.execute<{ active: number }>(sql`select count(*)::int as active from collection_targets where leased_until > now()`);
    const busy = await Promise.all(Array.from({ length: Math.max(0, MAX_ACTIVE_RUNS - active) }, () => addTarget()));
    await db
      .update(collectionTargets)
      .set({ leasedUntil: new Date(Date.now() + 120_000) })
      .where(inArray(collectionTargets.id, busy.map((t) => t.id)));
    const waiting = await addTarget();
    // Claims from several "instances" at once: none gets past the limit.
    expect((await Promise.all([claimTarget([SOURCE]), claimTarget([SOURCE]), claimTarget([SOURCE])])).filter(Boolean)).toHaveLength(0);

    await db.update(collectionTargets).set({ leasedUntil: null }).where(eq(collectionTargets.id, busy[0].id));
    const claimed = await Promise.all([claimTarget([SOURCE]), claimTarget([SOURCE])]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect([busy[0].id, waiting.id]).toContain(claimed.find(Boolean)!.id);
  });

  it("adds the targets a run found for other collectors once, with its priority", async () => {
    COLLECTORS[OTHER] = { ...fake, slug: OTHER as Collector["slug"] };
    try {
      const finder = await addTarget();
      await db.update(collectionTargets).set({ priority: 1 }).where(eq(collectionTargets.id, finder.id));
      const board = `board-${crypto.randomUUID()}`;
      const discovered = [
        { sourceSlug: OTHER, targetKey: board, params: { company: finder.targetKey } },
        { sourceSlug: "no_such_collector", targetKey: board, params: {} },
      ];
      next = { items: [], cursor: {}, complete: true, discovered };
      await runTarget({ ...finder, priority: 1 } as never, Date.now() + 30_000);
      await runTarget({ ...finder, priority: 1 } as never, Date.now() + 30_000);
      const added = await db.select().from(collectionTargets).where(eq(collectionTargets.targetKey, board));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ sourceSlug: OTHER, priority: 1, params: { company: finder.targetKey } });
    } finally {
      delete COLLECTORS[OTHER];
    }
  });

  it("closes the jobs a run handed to another collector, even when the run is partial", async () => {
    const target = await addTarget();
    next = { items: [job(), job({ externalId: "gem-card", title: "Designer", url: "https://jobs.gem.com/acme/AAA" })], cursor: {}, complete: true };
    await runTarget(target, Date.now() + 30_000);
    next = { items: [job()], cursor: {}, complete: false, handedOver: ["https://jobs.gem.com/acme/AAA"] };
    await runTarget(target, Date.now() + 30_000);
    const rows = await db.select().from(collectedItems).where(eq(collectedItems.sourceSlug, SOURCE));
    expect(rows.find((r) => r.externalId === "gem-card")?.closedAt).not.toBeNull();
    expect(rows.find((r) => r.externalId === "acme.test:1")?.closedAt).toBeNull();
  });

  it("leaves the targets of a collector missing its key waiting, never failed", async () => {
    COLLECTORS[SOURCE] = { ...fake, configured: () => false };
    try {
      const target = await addTarget();
      const summary = await runDueTargets({ deadline: Date.now() + 30_000, only: [SOURCE] });
      expect(summary.runs).toBe(0);
      const [after] = await db.select().from(collectionTargets).where(eq(collectionTargets.id, target.id));
      expect(after).toMatchObject({ consecutiveFailures: 0, lastRunAt: null, leasedUntil: null });
    } finally {
      COLLECTORS[SOURCE] = fake;
    }
  });

  it("never runs a restricted source", async () => {
    await addTarget("linkedin", "linkedin.com");
    expect(await claimTarget(["linkedin"])).toBeNull();
  });
});

describe("searching what was collected", () => {
  // A made-up word, so only this test's items match whatever else the database holds.
  const WORD = "zorblaxian";
  const ids = async () => Object.fromEntries((await db.select().from(collectedItems).where(inArray(collectedItems.sourceSlug, TEST_SOURCES))).map((r) => [r.externalId, r.id]));

  it("finds items by their title, company and text, best match first, with the words around a match", async () => {
    await storeItems(SOURCE, null, [
      job({ externalId: "in-text", title: "Backend Engineer", text: `Build ${WORD} services for clinics.`, location: "Denver, CO, US" }),
      job({ externalId: "in-title", title: `${WORD} Frontend Engineer`, text: "Build our React web app.", location: "Remote" }),
    ]);
    const hits = await searchCollected({ query: WORD });
    expect(hits.map((h) => h.title)).toEqual([`${WORD} Frontend Engineer`, "Backend Engineer"]);
    expect(hits[1].snippet).toContain(`«${WORD}»`);
    expect(hits[0].snippet).toBeNull();
    expect(hits[0].categories).toContain("software_development");
    expect(await searchCollected({ query: `${WORD} -react` })).toHaveLength(1);
    expect(await searchCollected({ query: `"${WORD} services"` })).toHaveLength(1);
  });

  it("ranks a fresh match above an older one that matches as well", async () => {
    await storeItems(SOURCE, null, [
      job({ externalId: "old", title: `${WORD} Engineer`, location: "Austin", postedAt: new Date(Date.now() - 50 * 86_400_000) }),
      job({ externalId: "new", title: `${WORD} Engineer`, location: "Boston", postedAt: new Date(Date.now() - 86_400_000) }),
    ]);
    expect((await searchCollected({ query: WORD })).map((h) => h.location)).toEqual(["Boston", "Austin"]);
  });

  it("filters by kind, category, country and remote, and leaves out closed items and copies unless asked", async () => {
    await storeItems(SOURCE, null, [
      job({ externalId: "us", title: `${WORD} Engineer`, location: "Austin", country: "US", remote: false, categories: ["software_development"] }),
      job({ externalId: "gb", title: `${WORD} Designer`, location: "London", country: "GB", remote: true, categories: ["ui_ux_design"] }),
      job({ externalId: "post", kind: "post", title: `Looking for a ${WORD} agency`, location: null, country: null }),
      job({ externalId: "closed", title: `${WORD} Analyst`, location: "Reno", country: "US" }),
    ]);
    await storeItems(OTHER, null, [job({ externalId: "copy", url: "https://jobs.example/1", title: `${WORD} Engineer`, location: "Austin", country: "US", remote: false })]);
    const { closed } = await ids();
    await db.update(collectedItems).set({ closedAt: new Date() }).where(eq(collectedItems.id, closed));

    const titles = async (search: Parameters<typeof searchCollected>[0]) => (await searchCollected({ query: WORD, ...search })).map((h) => h.title).sort();
    expect(await titles({})).toEqual([`Looking for a ${WORD} agency`, `${WORD} Designer`, `${WORD} Engineer`]);
    expect(await titles({ kinds: ["post"] })).toEqual([`Looking for a ${WORD} agency`]);
    expect(await titles({ country: "us" })).toEqual([`${WORD} Engineer`]);
    expect(await titles({ remote: true })).toEqual([`${WORD} Designer`]);
    expect(await titles({ categories: ["software_development"] })).toEqual([`${WORD} Engineer`]);
    expect(await titles({ includeClosed: true, country: "US" })).toEqual([`${WORD} Analyst`, `${WORD} Engineer`]);
    expect(await titles({ includeDuplicates: true, country: "US" })).toEqual([`${WORD} Engineer`, `${WORD} Engineer`]);
  });
});

describe("feeding the engines", () => {
  const run = crypto.randomUUID().slice(0, 8);
  const hiring = `hiring-${run}.test`;
  const boarded = `boarded-${run}.test`;
  const elsewhere = `elsewhere-${run}.test`;
  const named = `named-${run}.test`;
  const DOMAINS = [hiring, boarded, elsewhere, named];
  const ycId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  let auth: AuthContext;

  const webJob = (externalId: string, title: string, companyDomain: string, location = "Austin, TX, US", country: string | null = "US") =>
    job({ externalId, title, companyDomain, companyName: null, location, country, url: `https://${companyDomain}/careers/${externalId}`, categories: ["web_development"] });
  const signalsOf = (companyId: string) => db.select().from(signals).where(and(eq(signals.workspaceId, auth.workspaceId), eq(signals.companyId, companyId)));

  beforeAll(async () => {
    const me = await registerOwner({ name: "Collection feed", email: `collection-feed-${run}@jobs.test`, password: "Feed-test-1", workspaceName: `Collection feed ${run}` });
    auth = { userId: me.user.id, workspaceId: me.workspace.id, role: "owner" };
    await createService(
      auth,
      serviceSchema.parse({
        name: "Web development",
        description: "",
        categories: ["web_development"],
        targetIndustries: [],
        targetJobFunctions: [],
        targetCountries: ["US"],
        companySizeMin: null,
        companySizeMax: null,
      }),
    );
  });

  afterAll(async () => {
    if (auth) {
      await db.delete(workspaces).where(eq(workspaces.id, auth.workspaceId));
      await db.delete(users).where(eq(users.id, auth.userId));
    }
    await db.delete(ycCompanies).where(eq(ycCompanies.id, ycId));
  });

  it("turns a company hiring for the work into a company found by its own website, with one signal per role, once", async () => {
    await storeItems(SOURCE, null, [
      webJob("h1", "Senior Frontend Engineer", hiring),
      webJob("h2", "Senior Frontend Engineer", hiring, "Denver, CO, US"),
      webJob("h3", "Web Developer", hiring),
      webJob("e1", "Senior Frontend Engineer", elsewhere, "Berlin, Germany", "DE"),
    ]);
    const actor = systemActor(auth.workspaceId);
    const result = await matchCollectedJobs(actor, { domains: DOMAINS });
    expect(result).toMatchObject({ newCompanies: [expect.any(String)], signalsCreated: 2, more: false });

    // Found by its website (the pages gave no name, so the domain names it); Berlin is not a target country.
    const found = await db.select().from(companies).where(eq(companies.workspaceId, auth.workspaceId));
    expect(found).toEqual([expect.objectContaining({ domain: hiring, canonicalName: "Hiring " + run.replace(/^./, (c) => c.toUpperCase()), sourceSlug: "web_collection", identityStatus: "partial" })]);
    const [frontend, web] = (await signalsOf(found[0].id)).sort((a, b) => a.summary.localeCompare(b.summary));
    expect(frontend.summary).toContain("Senior Frontend Engineer");
    expect(frontend.summary).toContain("2 open postings");
    expect(web.summary).toContain("Web Developer");
    // Every job is recorded as looked at, with where it came from.
    const records = await db.select().from(sourceRecords).where(and(eq(sourceRecords.workspaceId, auth.workspaceId), eq(sourceRecords.sourceSlug, "web_collection")));
    expect(records).toHaveLength(3);
    expect(records.every((r) => r.companyId === found[0].id && r.data.collector === SOURCE)).toBe(true);

    // Looked at once: the next run finds nothing new.
    expect(await matchCollectedJobs(actor, { domains: DOMAINS })).toMatchObject({ companies: [], signalsCreated: 0 });
  });

  it("leaves out a company the workspace follows through its job board", async () => {
    const company = await createCompany(
      auth,
      companySchema.parse({ name: "Boarded", domain: boarded, industry: null, employeeCount: null, description: null, hqCity: null, hqRegion: null, hqCountry: null }),
    );
    await db.insert(companyJobBoards).values({ companyId: company.id, workspaceId: auth.workspaceId, provider: "greenhouse", boardToken: `boarded-${run}` });
    await storeItems(SOURCE, null, [webJob("b1", "Senior Frontend Engineer", boarded)]);
    expect(await matchCollectedJobs(systemActor(auth.workspaceId), { domains: DOMAINS })).toMatchObject({ companies: [] });
    expect(await signalsOf(company.id)).toEqual([]);
  });

  it("adds signals to a company already in the workspace under its own name", async () => {
    const company = await createCompany(
      auth,
      companySchema.parse({ name: "Named Co", domain: named, industry: null, employeeCount: null, description: null, hqCity: null, hqRegion: null, hqCountry: null }),
    );
    await storeItems(SOURCE, null, [webJob("n1", "Senior Frontend Engineer", named)]);
    expect(await matchCollectedJobs(systemActor(auth.workspaceId), { domains: DOMAINS })).toMatchObject({ newCompanies: [], companies: [company.id], signalsCreated: 1 });
    const [signal] = await signalsOf(company.id);
    expect(signal.summary).toMatch(/^Named Co is hiring a Senior Frontend Engineer/);
  });

  it("gives a recent YC startup the roles its own careers page lists (LeadGen's funded companies)", async () => {
    await db.insert(ycCompanies).values({ id: ycId, slug: `hiring-${run}`, name: "Hiring", domain: hiring, status: "Active", isHiring: true, batch: "S26", country: "US", launchedAt: new Date() });
    await storeItems(SOURCE, null, [webJob("y1", "Senior Frontend Engineer", hiring)]);
    const items = await ycBatches.discover({ targeting: { countries: ["US"], industries: [], serviceIds: [] }, serviceTerms: [], config: {}, now: new Date() });
    const item = items.find((i) => i.externalId === `yc-${ycId}`);
    expect(item?.metadata).toMatchObject({ roles: ["Senior Frontend Engineer"], jobCategories: ["web_development"] });
  });
});
