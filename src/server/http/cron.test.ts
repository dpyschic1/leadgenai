import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as collect } from "@/app/api/v1/internal/collect/route";
import { POST as tick } from "@/app/api/v1/internal/tick/route";
import { assertCron } from "./cron";

/** The scheduler's endpoints accept only the cron secret; the check is shared by tick and collect. */

const request = (authorization?: string) =>
  new Request("http://localhost/api/v1/internal/tick", { method: "POST", headers: authorization ? { authorization } : {} }) as unknown as NextRequest;

afterEach(() => vi.unstubAllEnvs());

describe("cron authentication", () => {
  it("accepts the secret, also when pasted with quotes or spaces", () => {
    vi.stubEnv("CRON_SECRET", "s3cret-value");
    expect(() => assertCron(request("Bearer s3cret-value"), "test")).not.toThrow();
    expect(() => assertCron(request(`Bearer  "s3cret-value" `), "test")).not.toThrow();
  });

  it("refuses a wrong, missing or partial secret, and everything when none is set", () => {
    vi.stubEnv("CRON_SECRET", "s3cret-value");
    for (const header of ["Bearer wrong-value", "Bearer s3cret", undefined]) {
      expect(() => assertCron(request(header), "test")).toThrow("Not allowed.");
    }
    vi.stubEnv("CRON_SECRET", "");
    expect(() => assertCron(request("Bearer "), "test")).toThrow("Not allowed.");
  });

  it("both endpoints answer 401 without the secret, before doing any work", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-value");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const handler of [tick, collect]) {
      const response = await handler(request("Bearer wrong-value"), undefined);
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
    }
  });
});
