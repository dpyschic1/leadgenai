import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema } from "./auth";

const valid = {
  name: "Sarah Williams",
  email: "sarah@example.com",
  password: "long-enough",
  workspaceName: "ABC Agency",
};

describe("registerSchema", () => {
  it("normalizes email to trimmed lowercase", () => {
    const parsed = registerSchema.parse({ ...valid, email: "  Sarah@Example.COM " });
    expect(parsed.email).toBe("sarah@example.com");
  });

  it("trims names", () => {
    expect(registerSchema.parse({ ...valid, name: "  Sarah  " }).name).toBe("Sarah");
  });

  it.each([
    ["short password", { password: "short" }, "password"],
    ["invalid email", { email: "not-an-email" }, "email"],
    ["blank workspace name", { workspaceName: "   " }, "workspaceName"],
  ])("rejects %s", (_label, override, field) => {
    const result = registerSchema.safeParse({ ...valid, ...override });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([field]);
  });
});

describe("loginSchema", () => {
  it("requires a password", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
  });
});
