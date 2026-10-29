import { describe, expect, it } from "vitest";
import { formatWait, rateLimitKey } from "./rate-limit";

describe("rateLimitKey", () => {
  it("never stores the subject itself", () => {
    const key = rateLimitKey("login", "1.2.3.4|sarah@abcagency.com");
    expect(key).toMatch(/^login:[0-9a-f]{64}$/);
    expect(key).not.toContain("sarah");
  });

  it("ignores letter case, like emails do", () => {
    expect(rateLimitKey("login", "Sarah@ABC.com")).toBe(rateLimitKey("login", "sarah@abc.com"));
  });

  it("keeps rules apart", () => {
    expect(rateLimitKey("login", "x")).not.toBe(rateLimitKey("register", "x"));
  });
});

describe("formatWait", () => {
  it("picks a readable unit", () => {
    expect(formatWait(1)).toBe("1 second");
    expect(formatWait(45)).toBe("45 seconds");
    expect(formatWait(60)).toBe("1 minute");
    expect(formatWait(61)).toBe("2 minutes");
    expect(formatWait(14 * 60)).toBe("14 minutes");
    expect(formatWait(3 * 3600)).toBe("3 hours");
  });
});
