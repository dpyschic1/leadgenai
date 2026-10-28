import type { FieldValues, Path, UseFormSetError } from "react-hook-form";
import { ApiError } from "@/lib/api/client";

/**
 * Shows a failed request on a react-hook-form form: per-field server errors go on their
 * fields, everything else becomes a form-level (`root`) error.
 */
export function applyApiError<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[],
): void {
  if (error instanceof ApiError && error.fieldErrors) {
    let matched = false;
    for (const field of fields) {
      const message = error.fieldErrors[field]?.[0];
      if (message) {
        setError(field, { type: "server", message });
        matched = true;
      }
    }
    if (matched) return;
  }

  const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
  setError("root", { type: "server", message });
}
