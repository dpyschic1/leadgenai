import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { companyJobBoards, jobPostings, users, workspaces } from "@/db/schema";
import type { SignalAnalysis } from "@/lib/api/types";
import { companySchema } from "@/lib/validation/companies";
import { serviceSchema } from "@/lib/validation/services";
import { analyzeSignal } from "@/server/ai/signal-analysis";
import { triageJobs, type TriageJob } from "@/server/ai/job-triage";
import { systemActor } from "@/server/auth/actor";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { fetchBoardJobs } from "@/server/jobs/fetch-jobs";
import type { NormalizedJob } from "@/server/jobs/types";
import { registerOwner } from "@/server/services/auth.service";
import { createCompany } from "@/server/services/companies.service";
import { connectDetectedBoard, syncCompanyJobs } from "@/server/services/job-boards.service";
import { createService } from "@/server/services/services.service";
import { deleteSignal, listCompanySignals } from "@/server/services/signals.service";

/**
 * The automatic job-board sync against the real database (`npm run test:integration`), with the
 * job board and the AI replaced by fakes: jobs are stored, closed and never analysed twice, relevant
 * ones become signals, deleted signals stay deleted, and other workspaces can't reach any of it.
 */

vi.mock("@/server/jobs/fetch-jobs", () => ({ fetchBoardJobs: vi.fn(), MAX_JOBS_PER_BOARD: 500 }));
vi.mock("@/server/ai/job-triage", () => ({ TRIAGE_BATCH_SIZE: 60, triageJobs: vi.fn() }));
vi.mock("@/server/ai/signal-analysis", () => ({ analyzeSignal: vi.fn() }));

const board = vi.mocked(fetchBoardJobs);
const triage = vi.mocked(triageJobs);
const analyze = vi.mocked(analyzeSignal);

const run = randomUUID().slice(0, 8);
let owner: AuthContext;
let other: AuthContext;
let companyId: string;

const job = (externalId: string, title: string): NormalizedJob => ({
  externalId,
  title,
  department: null,
  location: "London",
  url: `https://jobs.lever.co/acme-${run}/${externalId}`,
  description: `${title}: we are growing the team.`,
  postedAt: new Date("2026-10-01T09:00:00Z"),
});

/** Fake AI: engineering titles are relevant; "QA" turns out not to be a signal on a closer read. */
const isEngineering = (title: string) => /engineer/i.test(title);

function analysis(text: string): SignalAnalysis {
  const isSignal = !text.includes("QA");
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

/** What the background job does for the company. */
async function fetchNow(jobs: NormalizedJob[]) {
  board.mockResolvedValueOnce(jobs);
  return syncCompanyJobs(systemActor(owner.workspaceId), companyId);
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

beforeAll(async () => {
  owner = await signUp("owner");
  other = await signUp("other");
  await createService(
    owner,
    serviceSchema.parse({
      name: "Dedicated developers",
      description: "",
      categories: ["staff_augmentation"],
      targetIndustries: [],
      targetJobFunctions: [],
      targetCountries: [],
      companySizeMin: null,
      companySizeMax: null,
    }),
  );
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
  triage.mockReset().mockImplementation(async (jobs: TriageJob[]) =>
    jobs.map((j) => ({ relevant: isEngineering(j.title), reason: isEngineering(j.title) ? "Engineering role" : "Not our field" })),
  );
  analyze.mockReset().mockImplementation(async (input) => analysis(input.text));
});

afterAll(async () => {
  await db.delete(workspaces).where(inArray(workspaces.id, [owner, other].filter(Boolean).map((c) => c.workspaceId)));
  await db.delete(users).where(inArray(users.id, [owner, other].filter(Boolean).map((c) => c.userId)));
});

describe("job-board sync", () => {
  it("needs a connected board", async () => {
    await expectCode(syncCompanyJobs(systemActor(owner.workspaceId), companyId), "NOT_FOUND");
  });

  it("records relevant jobs as signals and explains the skipped ones", async () => {
    expect(await connectDetectedBoard(systemActor(owner.workspaceId), companyId, { provider: "lever", boardToken: `acme-${run}` })).toBe(true);
    // A board already set is never replaced by a later detection.
    expect(await connectDetectedBoard(systemActor(owner.workspaceId), companyId, { provider: "ashby", boardToken: "other" })).toBe(false);
    const result = await fetchNow([job("1", "React Engineer"), job("2", "Office Manager"), job("3", "QA Engineer")]);

    expect(result).toMatchObject({ open: 3, added: 3, closed: 0, signalsCreated: 1, skipped: 2, pending: 0, stoppedReason: null });
    expect(analyze).toHaveBeenCalledTimes(2); // only the two engineering jobs get the full analysis

    const { board: saved, jobs } = await boardAndJobs(owner.workspaceId);
    expect(saved).toMatchObject({ provider: "lever", boardToken: `acme-${run}`, lastError: null, autoDetected: true });
    const byTitle = new Map(jobs.map((j) => [j.title, j]));
    expect(byTitle.get("React Engineer")?.signalId).not.toBeNull();
    expect(byTitle.get("Office Manager")).toMatchObject({ triage: "skipped", triageReason: "Not our field", signalId: null });
    expect(byTitle.get("QA Engineer")).toMatchObject({ triage: "skipped", triageReason: "Not a buying signal on a closer read" });

    const [signal] = await listCompanySignals(owner, companyId);
    expect(signal).toMatchObject({ signalType: "engineering_hiring", source: "ai", occurredOn: "2026-10-01" });
    expect(signal.evidence?.sourceUrl).toBe(`https://jobs.lever.co/acme-${run}/1`);
  });

  it("only sends new jobs to the AI, and closes jobs that left the board", async () => {
    const result = await fetchNow([job("1", "React Engineer"), job("2", "Office Manager"), job("4", "Data Engineer")]);

    expect(result).toMatchObject({ open: 3, added: 1, closed: 1, signalsCreated: 1 });
    expect(triage).toHaveBeenCalledTimes(1);
    expect(triage.mock.calls[0][0].map((j) => j.title)).toEqual(["Data Engineer"]);
    expect(analyze).toHaveBeenCalledTimes(1);

    const { jobs } = await boardAndJobs(owner.workspaceId);
    expect(jobs.find((j) => j.title === "QA Engineer")?.closedAt).not.toBeNull();
    expect(await listCompanySignals(owner, companyId)).toHaveLength(2);
  });

  it("does nothing new when the board hasn't changed", async () => {
    const result = await fetchNow([job("1", "React Engineer"), job("2", "Office Manager"), job("4", "Data Engineer")]);
    expect(result).toMatchObject({ added: 0, closed: 0, signalsCreated: 0 });
    expect(triage).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });

  it("doesn't bring back a signal the team deleted", async () => {
    const { jobs } = await boardAndJobs(owner.workspaceId);
    const react = jobs.find((j) => j.title === "React Engineer")!;
    await deleteSignal(owner, react.signalId!);

    const result = await fetchNow([job("1", "React Engineer"), job("2", "Office Manager"), job("4", "Data Engineer")]);
    expect(result.signalsCreated).toBe(0);
    expect(analyze).not.toHaveBeenCalled();
    const after = (await boardAndJobs(owner.workspaceId)).jobs.find((j) => j.title === "React Engineer");
    expect(after).toMatchObject({ signalId: null, triage: "skipped", triageReason: "Signal deleted by your team" });
  });

  it("analyses a role posted for several places once, as one signal", async () => {
    const current = [job("1", "React Engineer"), job("2", "Office Manager"), job("4", "Data Engineer")];
    const result = await fetchNow([...current, job("5", "Design Engineer - UK"), job("6", "Design Engineer - EU")]);

    expect(result).toMatchObject({ added: 2, signalsCreated: 1 });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][0].text).toContain("The company has 2 open postings for this role");
    const { jobs } = await boardAndJobs(owner.workspaceId);
    const design = jobs.filter((j) => j.title.startsWith("Design Engineer"));
    expect(new Set(design.map((j) => j.signalId)).size).toBe(1);
    expect(design[0].signalId).not.toBeNull();

    // A later posting of the same role joins that signal without another AI call.
    analyze.mockClear();
    const later = await fetchNow([...current, job("5", "Design Engineer - UK"), job("6", "Design Engineer - EU"), job("7", "Design Engineer - Canada")]);
    expect(later).toMatchObject({ added: 1, signalsCreated: 0 });
    expect(analyze).not.toHaveBeenCalled();
    const canada = (await boardAndJobs(owner.workspaceId)).jobs.find((j) => j.title === "Design Engineer - Canada");
    expect(canada?.signalId).toBe(design[0].signalId);
  });

  it("records the error when the board can't be fetched", async () => {
    board.mockRejectedValueOnce(new AppError("JOB_BOARD_FAILED", "Lever didn't respond."));
    await expectCode(syncCompanyJobs(systemActor(owner.workspaceId), companyId), "JOB_BOARD_FAILED");
    expect((await boardAndJobs(owner.workspaceId)).board?.lastError).toBe("Lever didn't respond.");
  });

  it("is unreachable from another workspace", async () => {
    await expectCode(syncCompanyJobs(systemActor(other.workspaceId), companyId), "NOT_FOUND");
    expect(await boardAndJobs(other.workspaceId)).toEqual({ board: null, jobs: [] });
  });
});
