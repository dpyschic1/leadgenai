import "server-only";

/**
 * HTTP for official / documented APIs and feeds (Hacker News, Reddit RSS, Freelancer.com, SEC EDGAR).
 * Not for scraping pages: those go through the polite-fetch layer in `sources/http.ts`.
 * SEC requires a User-Agent that identifies the requester with contact details.
 */

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 4 * 1024 * 1024;

export const ENGINE_USER_AGENT = process.env.ENGINE_USER_AGENT || "LeadGenAI/1.0 (opportunity research; contact: sharjeel@q8tly.com)";

export class SourceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function fetchText(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<string> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, {
    headers: { "user-agent": ENGINE_USER_AGENT, accept: "*/*", ...init.headers },
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  if (!response.ok) throw new SourceHttpError(`${new URL(url).host} answered ${response.status}`, response.status);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new SourceHttpError(`${new URL(url).host} sent more than ${MAX_BYTES} bytes`, 413);
  return text;
}

export async function fetchJson<T>(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  return JSON.parse(await fetchText(url, { ...init, headers: { accept: "application/json", ...init.headers } })) as T;
}
