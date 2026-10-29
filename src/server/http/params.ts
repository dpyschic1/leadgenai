import "server-only";
import { z } from "zod";
import { AppError } from "./errors";

/** Validates a UUID path segment; anything else is reported as the resource not existing. */
export function uuidParam(value: string, resource: string): string {
  if (!z.uuid().safeParse(value).success) throw new AppError("NOT_FOUND", `${resource} not found.`);
  return value;
}
