const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

type PgError = Error & { code?: string; constraint_name?: string };

/** Finds the Postgres error with `code`. Drizzle wraps driver errors, so it may be the `cause`. */
function findPgError(error: unknown, code: string): PgError | undefined {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if ((e as PgError).code === code) return e as PgError;
  }
  return undefined;
}

/** True when `error` is a unique-constraint violation, optionally on a specific constraint/index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = findPgError(error, UNIQUE_VIOLATION);
  return pg !== undefined && (constraint === undefined || pg.constraint_name === constraint);
}

/** True when `error` is a foreign-key violation, e.g. an unknown lookup slug. */
export function isForeignKeyViolation(error: unknown): boolean {
  return findPgError(error, FOREIGN_KEY_VIOLATION) !== undefined;
}
