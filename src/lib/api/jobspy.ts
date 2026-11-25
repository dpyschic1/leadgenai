import type { JobspyRunInput } from "@/lib/validation/jobspy";
import { apiRequest } from "./client";

/** JobSpy import (Settings → JobSpy import). Types live here, apart from types.ts, so the feature removes cleanly. */

export type JobspyRunRow = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "interrupted" | "success" | "partial" | "failed";
  searchTerm: string;
  location: string;
  boards: string[];
  resultsPerBoard: number;
  found: number;
  created: number;
  errors: Record<string, string>;
};

export type JobspyJobRow = {
  id: string;
  board: string;
  title: string;
  company: string | null;
  location: string | null;
  jobUrl: string;
  datePosted: string | null;
  firstSeenAt: string;
};

export type JobspyStatus = {
  /** The server has JOBSPY_SERVICE_URL and JOBSPY_SERVICE_KEY. */
  configured: boolean;
  /** This workspace turns JobSpy jobs into companies and signals (off by default). */
  sendToOpportunities: boolean;
  cooldownMinutes: number;
  /** When Run is allowed again; null before the first run. */
  nextRunAt: string | null;
  lastRun: JobspyRunRow | null;
  /** Stored jobs per board. */
  totals: Record<string, number>;
  recent: JobspyJobRow[];
};

export type JobspySwitchResult = {
  status: JobspyStatus;
  matched: { companies: number; newCompanies: number; signals: number; skippedNoWebsite: number; more: boolean } | null;
  removed: { signals: number; companies: number } | null;
};

export const jobspyApi = {
  status: (signal?: AbortSignal) => apiRequest<JobspyStatus>("/jobspy", { signal }),
  run: (input: JobspyRunInput) => apiRequest<JobspyStatus>("/jobspy", { method: "POST", body: input }),
  setSendToOpportunities: (sendToOpportunities: boolean) => apiRequest<JobspySwitchResult>("/jobspy", { method: "PUT", body: { sendToOpportunities } }),
};
