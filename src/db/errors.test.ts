import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./errors";

function pgError(code: string, constraint_name?: string) {
  return Object.assign(new Error("pg"), { code, constraint_name });
}

describe("isUniqueViolation", () => {
  it("detects a violation wrapped as the cause (as Drizzle does)", () => {
    const wrapped = new Error("Failed query", { cause: pgError("23505", "users_email_idx") });
    expect(isUniqueViolation(wrapped, "users_email_idx")).toBe(true);
  });

  it("checks the constraint name when given", () => {
    expect(isUniqueViolation(pgError("23505", "other_idx"), "users_email_idx")).toBe(false);
  });

  it("ignores other Postgres errors", () => {
    expect(isUniqueViolation(pgError("23503"))).toBe(false);
  });
});
