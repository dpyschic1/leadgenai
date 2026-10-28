const UNIQUE_VIOLATION = "23505";

/**
 * True when `error` is a Postgres unique-constraint violation, optionally on a specific
 * constraint/index. Drizzle wraps driver errors, so the Postgres error may be the `cause`.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const pg = e as Error & { code?: string; constraint_name?: string };
    if (pg.code === UNIQUE_VIOLATION) {
      return constraint === undefined || pg.constraint_name === constraint;
    }
  }
  return false;
}
