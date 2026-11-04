import "server-only";
import { BOARD_TOKEN_PATTERN, JOB_BOARD_PROVIDER_LABELS, type JobBoardProvider } from "@/lib/domain/job-boards";
import { AppError } from "@/server/http/errors";
import { JOB_BOARD_ADAPTERS } from "./providers";
import type { NormalizedJob } from "./types";

/**
 * Downloads a company's open jobs from its public job board. The host is fixed per provider and
 * the board name is checked against a strict pattern, so user input can never point the server
 * at another address.
 */

const TIMEOUT_MS = 15_000;
/** Large boards (Stripe publishes ~700 jobs with descriptions) are a few MB; anything far bigger is refused. */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
/** Most jobs kept per board, newest first. */
export const MAX_JOBS_PER_BOARD = 500;

export function assertBoardToken(token: string): void {
  if (!BOARD_TOKEN_PATTERN.test(token)) {
    throw new AppError("VALIDATION_FAILED", "Use the board name from the careers-page address (letters, numbers, - _ .).", {
      boardToken: ["Use the board name from the careers-page address (letters, numbers, - _ .)."],
    });
  }
}

export async function fetchBoardJobs(provider: JobBoardProvider, token: string): Promise<NormalizedJob[]> {
  assertBoardToken(token);
  const adapter = JOB_BOARD_ADAPTERS[provider];
  const raw = await getText(adapter.endpoint(token), provider, token);

  let jobs: NormalizedJob[];
  try {
    jobs = adapter.parse(adapter.format === "xml" ? { xml: raw, token } : JSON.parse(raw));
  } catch (error) {
    console.error(`[jobs] unexpected ${provider} response for ${token}`, error);
    throw new AppError("JOB_BOARD_FAILED", `${JOB_BOARD_PROVIDER_LABELS[provider]} sent a reply we couldn't read. Try again later.`);
  }

  if (jobs.length === 0 && adapter.emptyMeansMissing) {
    throw new AppError("NOT_FOUND", `${JOB_BOARD_PROVIDER_LABELS[provider]} has no open jobs on a board called "${token}".`, {
      boardToken: [`${JOB_BOARD_PROVIDER_LABELS[provider]} has no board called "${token}" with open jobs.`],
    });
  }
  const unique = [...new Map(jobs.map((job) => [job.externalId, job])).values()];
  return unique
    .sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0))
    .slice(0, MAX_JOBS_PER_BOARD);
}

/** True when the board exists. Used to detect a company's board; any failure counts as "no". */
export async function boardExists(provider: JobBoardProvider, token: string): Promise<boolean> {
  if (!BOARD_TOKEN_PATTERN.test(token)) return false;
  const adapter = JOB_BOARD_ADAPTERS[provider];
  try {
    const response = await fetch(adapter.probeEndpoint(token), {
      headers: { accept: adapter.format === "xml" ? "application/xml" : "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Answers 200 for any name: the board exists only if it lists something.
    if (adapter.emptyMeansMissing && response.ok) return adapter.parse(await response.json()).length > 0;
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function getText(url: string, provider: JobBoardProvider, token: string): Promise<string> {
  const label = JOB_BOARD_PROVIDER_LABELS[provider];
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: JOB_BOARD_ADAPTERS[provider].format === "xml" ? "application/xml" : "application/json" },
      // The providers answer directly; a redirect would mean we're no longer talking to them.
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`[jobs] ${provider} request failed`, error);
    throw new AppError("JOB_BOARD_FAILED", `${label} didn't respond. Try again in a few minutes.`);
  }

  if (response.status === 404) {
    await response.body?.cancel();
    throw new AppError("NOT_FOUND", `${label} has no job board called "${token}". Check the name in the careers-page address.`, {
      boardToken: [`${label} has no job board called "${token}".`],
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError("JOB_BOARD_FAILED", `${label} answered with an error (${response.status}). Try again later.`);
  }
  if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new AppError("JOB_BOARD_FAILED", `This ${label} board is too large to fetch.`);
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new AppError("JOB_BOARD_FAILED", `This ${label} board is too large to fetch.`);
  return text;
}
