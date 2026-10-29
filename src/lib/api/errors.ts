/**
 * API error contract (SRS §12.3), shared by the route handlers and the client.
 * Every error response has the shape `{ error: ApiErrorPayload }`.
 */

export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  ALREADY_EXISTS: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  AI_FAILED: 502,
  AI_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type FieldErrors = Record<string, string[] | undefined>;

export type ApiErrorPayload = {
  code: ErrorCode;
  message: string;
  request_id: string;
  /** Per-field messages for VALIDATION_FAILED. */
  field_errors?: FieldErrors;
};

export type ApiErrorBody = { error: ApiErrorPayload };
