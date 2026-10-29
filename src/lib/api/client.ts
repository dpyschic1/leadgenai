import type { ApiErrorBody, ErrorCode, FieldErrors } from "./errors";

/** A failed API call, carrying the server's error contract. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly requestId?: string;
  readonly fieldErrors?: FieldErrors;

  constructor(status: number, body: Partial<ApiErrorBody> | null) {
    super(body?.error?.message ?? "Something went wrong. Please try again.");
    this.name = "ApiError";
    this.status = status;
    this.code = body?.error?.code ?? "INTERNAL_ERROR";
    this.requestId = body?.error?.request_id;
    this.fieldErrors = body?.error?.field_errors;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
};

/** Typed fetch for `/api/v1`. Resolves with the JSON body, throws `ApiError` on non-2xx. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal } = options;

  const response = await fetch(`/api/v1${path}`, {
    method,
    signal,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;

  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data as Partial<ApiErrorBody> | null);
  return data as T;
}

export type DownloadedFile = { blob: Blob; filename: string };

/** Fetches a file from `/api/v1` (e.g. a CSV export). Throws `ApiError` on non-2xx like `apiRequest`. */
export async function apiDownload(path: string, fallbackName: string): Promise<DownloadedFile> {
  const response = await fetch(`/api/v1${path}`, { credentials: "same-origin" });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    throw new ApiError(response.status, data as Partial<ApiErrorBody> | null);
  }
  const filename = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  return { blob: await response.blob(), filename };
}
