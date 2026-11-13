import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { boardJobs, companies, companyJobBoards, jobBoardDirectory, jobPostings, theirstackJobs, users, workspaces } from "@/db/schema";
import type { SignalAnalysis } from "@/lib/api/types";
import { companySchema } from "@/lib/validation/companies";
import { serviceSchema } from "@/lib/validation/services";
import { analyzeSignal } from "@/server/ai/signal-analysis";
import { systemActor } from "@/server/auth/actor";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { HANDLERS, jobContext } from "@/server/ingestion/handlers";
import type { JobRow } from "@/server/ingestion/queue";
import { analyzeSharedJobs, categorizeBoardJobs, matchWorkspaceJobs } from "@/server/ingestion/shared-jobs";
import { fetchBoardJobs } from "@/server/jobs/fetch-jobs";
import { rescoreCompany } from "@/server/scoring/rescore";
import { getCompany } from "@/server/services/companies.service";
import { refreshBoard } from "@/server/sources/board-directory";
import { readWebsite } from "@/server/sources/company-website";
import { politeGet } from "@/server/sources/http";
import { searchJobs, type TheirStackJob } from "@/server/sources/theirstack";
import type { NormalizedJob } from "@/server/jobs/types";
import { registerOwner } from "@/server/services/auth.service";
import { createCompany } from "@/server/services/companies.service";
import { connectDetectedBoard, syncCompanyJobs } from "@/server/services/job-boards.service";
import { createService } from "@/server/services/services.service";
import { deleteSignal, listCompanySignals } from "@/server/services/signals.service";

/**
 * The automatic job-board sync and shared job matching against the real database
 * (`npm run test:integration`), with the job board and the AI replaced by fakes: jobs are sorted by
 * their service categories with no AI, relevant ones become signals at once, the shared AI reading
 * of a job (made once) upgrades every workspace's signal, deleted signals stay deleted, and other
 * workspaces can't reach any of it.
 */

vi.mock("@/server/jobs/fetch-jobs", () => ({ fetchBoardJobs: vi.fn(), MAX_JOBS_PER_BOARD: 500 }));
vi.mock("@/server/ai/signal-analysis", () => ({ analyzeSignal: vi.fn() }));
// A fake TheirStack: configured, with credits, and posts from `searchJobs` (never the real API).
vi.mock("@/server/sources/theirstack", async (original) => {
  const real = await original<typeof import("@/server/sources/theirstack")>();
  return {
    ...real,
    theirStack: { ...real.theirStack, isConfigured: () => true },
    searchJobs: vi.fn(async () => []),
    creditsLeft: vi.fn(async () => 10),
    theirStackJobsPerRun: () => 10,
  };
});
// No real network: board pages (names) answer 404, company websites can't be found.
vi.mock("@/server/sources/http", async (original) => ({
  ...(await original<typeof import("@/server/sources/http")>()),
  politeGet: vi.fn(async (url: string) => ({ url, status: 404, contentType: "text/html", body: "", bytes: Buffer.alloc(0) })),
  hostResolves: vi.fn(async () => false),
}));
vi.mock("@/server/sources/company-website", async (original) => ({
  ...(await original<typeof import("@/server/sources/company-website")>()),
  findWebsite: vi.fn(async () => null),
  readWebsite: vi.fn(async () => null),
}));

const board = vi.mocked(fetchBoardJobs);
const analyze = vi.mocked(analyzeSignal);

const run = randomUUID().slice(0, 8);
let owner: AuthContext;
let other: AuthContext;
let companyId: string;

/** Posted 10 days ago: fresh, whenever the tests run (older than 60 days isn't kept). */
const POSTED = new Date(Date.now() - 10 * 86_400_000);
const job = (externalId: string, title: string): NormalizedJob => ({
  externalId,
  title,
  department: null,
  location: "London",
  url: `https://jobs.lever.co/acme-${run}/${externalId}`,
  description: `${title}: we are growing the team.`,
  postedAt: POSTED,
});

/** Fake AI: a "Data Engineer" post turns out not to be a signal on a closer read. */
function analysis(text: string): SignalAnalysis {
  const isSignal = !text.includes("Data Engineer");
  return {
    isSignal,
    signalType: isSignal ? "engineering_hiring" : null,
    intentLevel: "high",
    urgency: "medium",
    serviceCategories: ["staff_augmentation"],
    summary: "Growing the engineering team.",
    excerpt: null,
    evidenceLabel: "inferred",
    confidence: isSignal ? 80 : 20,
    occurredOn: null,
    model: "fake",
  };
}

async function signUp(who: string): Promise<AuthContext> {
  const me = await registerOwner({
    name: `Jobs ${who}`,
    email: `jobs-${who}-${run}@jobs.test`,
    password: "Jobs-test-1",
    workspaceName: `Jobs ${who} ${run}`,
  });
  return { userId: me.user.id, workspaceId: me.workspace.id, role: "owner" };
}

const developers = (targetCountries: string[]) =>
  serviceSchema.parse({
    name: "Dedicated developers",
    description: "",
    categories: ["staff_augmentation"],
    targetIndustries: [],
    targetJobFunctions: [],
    targetCountries,
    companySizeMin: null,
    companySizeMax: null,
  });

/** What the background job does for the company. */
async function fetchNow(jobs: NormalizedJob[]) {
  board.mockResolvedValueOnce(jobs);
  // Each step simulates a later visit, so the shared cache must not answer with the previous jobs.
  return syncCompanyJobs(systemActor(owner.workspaceId), companyId, { freshWithinMs: 0 });
}

/** The company's connected board and the jobs seen on it. */
async function boardAndJobs(workspaceId: string) {
  const [saved] = await db.select().from(companyJobBoards).where(and(eq(companyJobBoards.companyId, companyId), eq(companyJobBoards.workspaceId, workspaceId)));
  const jobs = await db.select().from(jobPostings).where(and(eq(jobPostings.companyId, companyId), eq(jobPostings.workspaceId, workspaceId)));
  return { board: saved ?? null, jobs };
}

async function expectCode(promise: Promise<unknown>, code: AppError["code"]) {
  await expect(promise).rejects.toSatisfy((error) => error instanceof AppError && error.code === code);
}

const soon = () => Date.now() + 60_000;

beforeAll(async () => {
  owner = await signUp("owner");
  other = await signUp("other");
  await createService(owner, developers([]));
  companyId = (
    await createCompany(
      owner,
      companySchema.parse({
        name: "Acme Jobs",
        domain: `acme-${run}.example`,
        industry: null,
        employeeCount: null,
        description: null,
        hqCity: null,
        hqRegion: null,
        hqCountry: null,
      }),
    )
  ).id;
});

beforeEach(() => {
  analyze.mockReset().mockImplementation(async (input) => analysis(input.text));
});

afterAll(async () => {
  await db.delete(workspaces).where(inArray(workspaces.id, [owner, other].filter(Boolean).map((c) => c.workspaceId)));
  await db.delete(users).where(inArray(users.id, [owner, other].filter(Boolean).map((c) => c.userId)));
  // The shared board directory isn't workspace data: remove this run's board too.
  await db.delete(jobBoardDirectory).where(eq(jobBoardDirectory.boardToken, `acme-${run}`));
});

describe("job-board sync", () => {
  it("needs a connected board", async () => {
    await expectCode(syncCompanyJobs(systemActor(owner.workspaceId), companyId), "NOT_FOUND");
  });

  it("records relevant jobs as signals at once, with no AI, and doesn't store the others", async () => {
    expect(await connectDetectedBoard(systemActor(owner.workspaceId), companyId, { provider: "lever", boardToken: `acme-${run}` })).toBe(true);
    // A board already set is never replaced by a later detection.
    expect(await connectDetectedBoard(systemActor(owner.workspaceId), companyId, { provider: "ashby", boardToken: "other" })).toBe(false);
    const result = await fetchNow([job("1", "React Engineer"), job("2", "Office Manager"), job("3", "QA Engineer")]);

    expect(result).toMatchObject({ open: 3, added: 3, closed: 0, signalsCreated: 2, skipped: 1, pending: 0, stoppedReason: null });
    expect(analyze).not.toHaveBeenCalled();

    const { board: saved, jobs } = await boardAndJobs(owner.workspaceId);
    expect(saved).toMatchObject({ provider: "lever", boardToken: `acme-${run}`, lastError: null, autoDetected: true });
    const byTitle = new Map(jobs.map((j) => [j.title, j]));
    expect(byTitle.get("React Engineer")).toMatchObject({ triage: "relevant", triageReason: "Matches your Staff augmentation services" });
    expect(byTitle.get("React Engineer")?.signalId).not.toBeNull();
    // A job that fits none of the workspace's services stays only in the shared pool.
    expect(byTitle.has("Office Manager")).toBe(false);
    // Its text is read from the shared job, not copied.
    expect(byTitle.get("React Engineer")?.description).toBeNull();

    const react = (await listCompanySignals(owner, companyId)).find((s) => s.evidence?.sourceUrl === `https://jobs.lever.co/acme-${run}/1`);
    expect(react).toMatchObject({ signalType: "engineering_hiring", source: "provider", occurredOn: POSTED.toISOString().slice(0, 10), serviceCategories: ["staff_augmentation"] });
  });

  it("closes jobs that left the board and records new ones", async () => {
    const result = await fetchNow([job("1", "React Engineer"), job("2", "Office Manager"), job("4", "Data Engineer")]);
    expect(result).toMatchObject({ open: 3, added: 1, closed: 1, signalsCreated: 1 });
    const { jobs } = await boardAndJobs(owner.workspaceId);
    expect(jobs.find((j) => j.title === "QA Engineer")?.closedAt).not.toBeNull();
    expect(await listCompanySignals(owner, companyId)).toHaveLength(3);
  });

  it("does nothing new when the board hasn't changed", async () => {
    const result = await fetchNow([job("1", "React Engineer"), job("2", "Office Manager"), job("4", "Data Engineer")]);
    expect(result).toMatchObject({ added: 0, closed: 0, signalsCreated: 0 });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("reads each job with the AI once, upgrading its signal, or removing it when it isn't one", async () => {
    const { jobs } = await boardAndJobs(owner.workspaceId);
    const ids = jobs.flatMap((j) => (j.boardJobId ? [j.boardJobId] : []));
    const read = await analyzeSharedJobs({ deadline: soon(), boardJobIds: ids });
    expect(read).toBeGreaterThanOrEqual(2); // the open jobs behind signals (a closed one may have left the cache)
    expect(analyze).toHaveBeenCalledTimes(read);

    const after = (await boardAndJobs(owner.workspaceId)).jobs;
    const react = after.find((j) => j.title === "React Engineer")!;
    const signal = (await listCompanySignals(owner, companyId)).find((s) => s.id === react.signalId);
    expect(signal).toMatchObject({ source: "ai", summary: "Growing the engineering team.", intentLevel: "high" });
    expect(after.find((j) => j.title === "Data Engineer")).toMatchObject({ signalId: null, triage: "skipped", triageReason: "Not a buying signal on a closer read" });

    // Read once: a second pass has nothing left to read.
    analyze.mockClear();
    expect(await analyzeSharedJobs({ deadline: soon(), boardJobIds: ids })).toBe(0);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("doesn't bring back a signal the team deleted", async () => {
    const { jobs } = await boardAndJobs(owner.workspaceId);
    const react = jobs.find((j) => j.title === "React Engineer")!;
    await deleteSignal(owner, react.signalId!);

    const result = await fetchNow([job("1", "React Engineer"), job("2", "Office Manager"), job("4", "Data Engineer")]);
    expect(result.signalsCreated).toBe(0);
    const after = (await boardAndJobs(owner.workspaceId)).jobs.find((j) => j.title === "React Engineer");
    expect(after).toMatchObject({ signalId: null, triage: "skipped", triageReason: "Signal deleted by your team" });
  });

  it("records a role posted for several places once, as one signal", async () => {
    const current = [job("1", "React Engineer"), job("2", "Office Manager"), job("4", "Data Engineer")];
    const result = await fetchNow([...current, job("5", "Backend Engineer - UK"), job("6", "Backend Engineer - EU")]);

    expect(result).toMatchObject({ added: 2, signalsCreated: 1 });
    const { jobs } = await boardAndJobs(owner.workspaceId);
    const design = jobs.filter((j) => j.title.startsWith("Backend Engineer"));
    expect(new Set(design.map((j) => j.signalId)).size).toBe(1);
    expect(design[0].signalId).not.toBeNull();
    const signal = (await listCompanySignals(owner, companyId)).find((s) => s.id === design[0].signalId);
    expect(signal?.summary).toContain("with 2 open postings for this role");

    // A later posting of the same role joins that signal.
    const later = await fetchNow([...current, job("5", "Backend Engineer - UK"), job("6", "Backend Engineer - EU"), job("7", "Backend Engineer - Canada")]);
    expect(later).toMatchObject({ added: 1, signalsCreated: 0 });
    const canada = (await boardAndJobs(owner.workspaceId)).jobs.find((j) => j.title === "Backend Engineer - Canada");
    expect(canada?.signalId).toBe(design[0].signalId);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("records the error when the board can't be fetched", async () => {
    board.mockRejectedValueOnce(new AppError("JOB_BOARD_FAILED", "Lever didn't respond."));
    await expectCode(syncCompanyJobs(systemActor(owner.workspaceId), companyId, { freshWithinMs: 0 }), "JOB_BOARD_FAILED");
    expect((await boardAndJobs(owner.workspaceId)).board?.lastError).toBe("Lever didn't respond.");
  });

  it("is unreachable from another workspace", async () => {
    await expectCode(syncCompanyJobs(systemActor(other.workspaceId), companyId), "NOT_FOUND");
    expect(await boardAndJobs(other.workspaceId)).toEqual({ board: null, jobs: [] });
  });
});

describe("matching shared jobs to workspaces", () => {
  let uk: AuthContext;
  const token = (name: string) => `${name}-${run}`;
  const ukJob = (externalId: string, title: string, location = "London, United Kingdom"): NormalizedJob => ({
    ...job(externalId, title),
    location,
    url: `https://job-boards.greenhouse.io/x/jobs/${externalId}-${run}`,
  });

  const context = (auth: AuthContext, kind: JobRow["kind"], entityId: string) =>
    jobContext({ id: randomUUID(), workspaceId: auth.workspaceId, kind, entityId, status: "running", attempts: 1 } as JobRow);
  /** This run's boards only: the shared tables also hold real jobs from live discovery. */
  const ours = () =>
    [token("relevant"), token("irrelevant"), token("workable")].flatMap((boardToken) => [
      { provider: "greenhouse" as const, boardToken },
      { provider: "workable" as const, boardToken },
    ]);

  /** What the scheduler does for a workspace: sort new jobs, match them, score, then sync the new companies' boards. */
  async function evaluate(auth: AuthContext) {
    await categorizeBoardJobs();
    const result = await matchWorkspaceJobs(systemActor(auth.workspaceId), { boards: ours() });
    for (const id of result.companies) await rescoreCompany(auth.workspaceId, id);
    for (const id of result.newCompanies) await HANDLERS.scan_job_board(context(auth, "scan_job_board", id));
    return result;
  }
  const companiesOf = (auth: AuthContext) =>
    db.select().from(companies).where(and(eq(companies.workspaceId, auth.workspaceId), eq(companies.sourceSlug, "board_directory")));

  beforeAll(async () => {
    uk = await signUp("uk");
    await createService(uk, developers(["GB"]));
  });

  afterAll(async () => {
    if (uk) {
      await db.delete(workspaces).where(eq(workspaces.id, uk.workspaceId));
      await db.delete(users).where(eq(users.id, uk.userId));
    }
    await db.delete(jobBoardDirectory).where(inArray(jobBoardDirectory.boardToken, [token("relevant"), token("irrelevant"), token("missing"), token("workable")]));
  });

  it("rejects a board its provider doesn't know", async () => {
    board.mockRejectedValueOnce(new AppError("NOT_FOUND", "Greenhouse has no job board called that."));
    expect(await refreshBoard("greenhouse", token("missing"))).toBe("invalid");
    const [row] = await db.select().from(jobBoardDirectory).where(eq(jobBoardDirectory.boardToken, token("missing")));
    expect(row.validationStatus).toBe("invalid");
  });

  it("turns a relevant board into a provisional company with an opportunity at once, with no AI and no register match", async () => {
    board.mockResolvedValueOnce([ukJob("r1", "React Engineer"), ukJob("r2", "Office Manager"), ukJob("r3", "Platform Engineer", "Austin, US")]);
    expect(await refreshBoard("greenhouse", token("relevant"))).toBe("valid");

    await evaluate(uk);
    const [company] = await companiesOf(uk);
    expect(company).toMatchObject({ identityStatus: "provisional", domain: null });
    // The board gave no name of its own here, so the board address names the company.
    expect(company.canonicalName.toLowerCase()).toBe(token("relevant").replace(/-/g, " "));
    expect(analyze).not.toHaveBeenCalled();

    // Only the UK engineering job matched, and only it is stored for the workspace: the office job
    // (no service) and the US one (outside its countries) stay in the shared pool.
    const postings = await db.select().from(jobPostings).where(eq(jobPostings.companyId, company.id));
    expect(postings.map((p) => [p.title, p.triage])).toEqual([["React Engineer", "relevant"]]);
    expect(postings.every((p) => p.boardJobId !== null)).toBe(true);

    const [signal] = await listCompanySignals(uk, company.id);
    expect(signal).toMatchObject({ signalType: "engineering_hiring", source: "provider", evidence: { sourceUrl: `https://job-boards.greenhouse.io/x/jobs/r1-${run}` } });
    expect((await getCompany(uk, company.id)).opportunity).not.toBeNull();
  });

  it("creates nothing for a board with no relevant jobs", async () => {
    board.mockResolvedValueOnce([ukJob("i1", "Office Manager"), ukJob("i2", "Receptionist")]);
    await refreshBoard("greenhouse", token("irrelevant"));
    const result = await evaluate(uk);
    expect(result.companies).toEqual([]);
    expect((await companiesOf(uk)).map((c) => c.canonicalName.toLowerCase())).not.toContain(token("irrelevant").replace(/-/g, " "));
  });

  it("keeps the job and its signal when the company's website can't be checked", async () => {
    vi.mocked(readWebsite).mockRejectedValueOnce(new Error("Site is down"));
    const [company] = await companiesOf(uk);
    await HANDLERS.enrich_company(context(uk, "enrich_company", company.id)).catch(() => undefined);
    expect(await db.select().from(jobPostings).where(eq(jobPostings.companyId, company.id))).toHaveLength(3);
    expect(await listCompanySignals(uk, company.id)).toHaveLength(1);
  });

  it("gives each workspace its own company and opportunity from the same shared job, read by the AI once", async () => {
    // The shared reading of the job, made once (for the UK workspace's signal)…
    const [sharedJob] = await db.select().from(boardJobs).where(and(eq(boardJobs.boardToken, token("relevant")), eq(boardJobs.externalId, "r1")));
    expect(await analyzeSharedJobs({ deadline: soon(), boardJobIds: [sharedJob.id] })).toBe(1);
    const [ukCompany] = await companiesOf(uk);
    expect(await listCompanySignals(uk, ukCompany.id)).toEqual([expect.objectContaining({ source: "ai" })]);
    analyze.mockClear();

    // …gives another workspace the AI's signal straight away, with no new AI call.
    await evaluate(owner); // the owner workspace targets any country
    const ownCompany = (await companiesOf(owner)).find((c) => c.canonicalName.toLowerCase() === token("relevant").replace(/-/g, " "))!;
    expect(ownCompany.id).not.toBe(ukCompany.id);
    expect((await getCompany(owner, ownCompany.id)).opportunity).not.toBeNull();
    expect(analyze).not.toHaveBeenCalled();
    // (It targets every country, so the Austin job matched too, with its own rule-based signal.)
    expect(await listCompanySignals(owner, ownCompany.id)).toEqual(expect.arrayContaining([expect.objectContaining({ source: "ai", summary: "Growing the engineering team." })]));
    // One shared copy of the job, evaluated separately by each workspace.
    expect(await db.select().from(jobPostings).where(eq(jobPostings.boardJobId, sharedJob.id))).toHaveLength(2);
    // Neither workspace can reach the other's company.
    await expectCode(getCompany(uk, ownCompany.id), "NOT_FOUND");
  });

  it("adds nothing on repeated matching and worker runs", async () => {
    const count = async () => ({
      companies: (await companiesOf(uk)).length,
      postings: (await db.select().from(jobPostings).where(eq(jobPostings.workspaceId, uk.workspaceId))).length,
    });
    const before = await count();
    board.mockResolvedValueOnce([ukJob("r1", "React Engineer"), ukJob("r2", "Office Manager"), ukJob("r3", "Platform Engineer", "Austin, US")]);
    await refreshBoard("greenhouse", token("relevant"));
    await evaluate(uk);
    await evaluate(uk);
    expect(await count()).toEqual(before);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("treats a Workable board like any other: provisional company, opportunity, and its stated website once confirmed", async () => {
    const slug = token("workable");
    const site = `brightway-${run}.example`;
    const usual = vi.mocked(politeGet).getMockImplementation()!;
    // Workable's account record names the company and its own website.
    vi.mocked(politeGet).mockImplementation(async (url: string) =>
      url === `https://apply.workable.com/api/v1/accounts/${slug}`
        ? { url, status: 200, contentType: "application/json", body: JSON.stringify({ name: "Brightway Careers", url: `https://www.${site}/` }), bytes: Buffer.alloc(0) }
        : usual(url),
    );
    board.mockResolvedValueOnce([{ ...ukJob("w1", "React Engineer"), url: `https://apply.workable.com/j/W1${run}` }]);
    expect(await refreshBoard("workable", slug)).toBe("valid");
    vi.mocked(politeGet).mockImplementation(usual);
    const [listed] = await db.select().from(jobBoardDirectory).where(and(eq(jobBoardDirectory.provider, "workable"), eq(jobBoardDirectory.boardToken, slug)));
    expect(listed).toMatchObject({ validationStatus: "valid", boardName: "Brightway", statedWebsite: site });

    await evaluate(uk);
    const company = (await companiesOf(uk)).find((c) => c.canonicalName === "Brightway")!;
    expect(company).toMatchObject({ identityStatus: "provisional", domain: null });
    expect(await listCompanySignals(uk, company.id)).toEqual([expect.objectContaining({ signalType: "engineering_hiring", source: "provider" })]);
    expect((await getCompany(uk, company.id)).opportunity).not.toBeNull();

    // The stated site becomes the company's only once it links back to the same board.
    vi.mocked(readWebsite).mockReset().mockResolvedValue(null);
    vi.mocked(readWebsite).mockImplementationOnce(async (domain) => ({ domain, jobBoard: { provider: "workable", boardToken: slug } }) as Awaited<ReturnType<typeof readWebsite>>);
    await HANDLERS.enrich_company(context(uk, "enrich_company", company.id));
    const [after] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(after).toMatchObject({ domain: site, identityStatus: "partial" });
  });
});

describe("TheirStack posts shared by every workspace", () => {
  const nz: AuthContext[] = [];
  // Ids far from TheirStack's real ones, unique to this run.
  const base = 9_000_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
  const post = (n: number, title: string): TheirStackJob => ({
    id: base + n,
    title,
    url: `https://example.com/jobs/${run}/${n}`,
    foundOn: "linkedin.com",
    postedOn: new Date().toISOString().slice(0, 10),
    description: `${title}: we are growing the team in Auckland.`,
    location: "Auckland, New Zealand",
    company: { name: `Kiwi Labs ${run}`, domain: `kiwi-${run}.example`, industry: null, employeeCount: 40, country: "NZ", city: "Auckland", linkedinUrl: null },
    hiringTeam: [],
  });
  const context = (auth: AuthContext) =>
    jobContext({ id: randomUUID(), workspaceId: auth.workspaceId, kind: "discover_theirstack", entityId: auth.workspaceId, status: "running", attempts: 1 } as JobRow);
  const kiwiOf = (auth: AuthContext) =>
    db.select().from(companies).where(and(eq(companies.workspaceId, auth.workspaceId), eq(companies.domain, `kiwi-${run}.example`)));

  beforeAll(async () => {
    // New Zealand only, so real posts already in the shared table don't reach these workspaces.
    for (const who of ["nz-a", "nz-b"]) {
      const auth = await signUp(who);
      await createService(auth, developers(["NZ"]));
      nz.push(auth);
    }
  });

  afterAll(async () => {
    await db.delete(workspaces).where(inArray(workspaces.id, nz.map((a) => a.workspaceId)));
    await db.delete(users).where(inArray(users.id, nz.map((a) => a.userId)));
    await db.delete(theirstackJobs).where(inArray(theirstackJobs.id, [base + 1, base + 2]));
  });

  it("buys a post once and reads it once, for every workspace", async () => {
    vi.mocked(searchJobs).mockResolvedValueOnce([post(1, "Senior Backend Engineer"), post(2, "Office Manager")]);
    await HANDLERS.discover_theirstack(context(nz[0]));
    expect(searchJobs).toHaveBeenCalledTimes(1);
    // Only the post that fits the services by its title went to the AI.
    expect(analyze).toHaveBeenCalledTimes(1);
    const [first] = await kiwiOf(nz[0]);
    expect(first).toBeDefined();
    expect(await listCompanySignals(nz[0], first.id)).toEqual([expect.objectContaining({ source: "ai", signalType: "engineering_hiring" })]);
    const [shared] = await db.select().from(theirstackJobs).where(eq(theirstackJobs.id, base + 1));
    expect(shared.analysis).toMatchObject({ isSignal: true });

    // The second workspace gets the same post: no purchase, no AI.
    vi.mocked(searchJobs).mockClear();
    analyze.mockClear();
    await HANDLERS.discover_theirstack(context(nz[1]));
    expect(searchJobs).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    const [second] = await kiwiOf(nz[1]);
    expect(second.id).not.toBe(first.id);
    expect(await listCompanySignals(nz[1], second.id)).toEqual([expect.objectContaining({ source: "ai" })]);

    // Looked at once per workspace: running again offers nothing new.
    await HANDLERS.discover_theirstack(context(nz[1]));
    expect(analyze).not.toHaveBeenCalled();
    expect(await kiwiOf(nz[1])).toHaveLength(1);
  });
});
