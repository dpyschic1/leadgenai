import "server-only";
import {
  ERROR_STATUS,
  type ApiErrorBody,
  type ErrorCode,
  type FieldErrors,
} from "@/lib/api/errors";

/** An expected failure that maps to an API error response. Anything else becomes a 500. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly fieldErrors?: FieldErrors;

  constructor(code: ErrorCode, message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

/** Converts any thrown value into an error-contract response. Unexpected errors are logged, never leaked. */
export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof AppError) {
    const body: ApiErrorBody = {
      error: {
        code: error.code,
        message: error.message,
        request_id: requestId,
        ...(error.fieldErrors && { field_errors: error.fieldErrors }),
      },
    };
    return Response.json(body, { status: error.status });
  }

  console.error(`[${requestId}] Unhandled error`, error);
  const body: ApiErrorBody = {
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
      request_id: requestId,
    },
  };
  return Response.json(body, { status: ERROR_STATUS.INTERNAL_ERROR });
}
