import { describe, expect, it } from "vitest";
import {
  NO_OVERRIDE,
  isDue,
  nextRunAt,
  parseCapabilityConfig,
  resolveTargeting,
  fundedConfigSchema,
  type FreelanceConfig,
} from "./engine";

const workspace = { countries: ["US", "GB"], industries: ["fintech"], serviceIds: ["s1", "s2"] };

describe("resolveTargeting", () => {
  it("inherits every dimension when there is no override", () => {
    expect(resolveTargeting(workspace, NO_OVERRIDE)).toEqual(workspace);
  });

  it("replaces, never adds to, an overridden dimension (spec §2: US+UK overridden to Canada = Canada only)", () => {
    const result = resolveTargeting(workspace, { ...NO_OVERRIDE, countries: ["CA"] });
    expect(result.countries).toEqual(["CA"]);
    expect(result.industries).toEqual(["fintech"]);
  });

  it("treats an empty override as a real override, not as inherit", () => {
    expect(resolveTargeting(workspace, { ...NO_OVERRIDE, industries: [] }).industries).toEqual([]);
  });
});

describe("parseCapabilityConfig", () => {
  it("defaults freelance to a $5,000 minimum with no upper limit", () => {
    const c = parseCapabilityConfig("freelance", {}) as FreelanceConfig;
    expect(c.minBudgetUsd).toBe(5000);
    expect(c.clientTypes).toEqual(["company", "individual"]);
    expect("maxBudgetUsd" in c).toBe(false);
  });

  it("falls back to defaults for malformed stored config", () => {
    const c = parseCapabilityConfig("freelance", { minBudgetUsd: "lots", postedWithinDays: 5 }) as FreelanceConfig;
    expect(c.minBudgetUsd).toBe(5000);
    expect(c.postedWithinDays).toBe(30);
  });

  it("rejects a funding window that ends before it starts", () => {
    expect(fundedConfigSchema.safeParse({ fundedFrom: "2026-06-01", fundedTo: "2026-01-01" }).success).toBe(false);
    expect(fundedConfigSchema.safeParse({ fundedFrom: "2026-01-01", fundedTo: "2026-06-01" }).success).toBe(true);
  });
});

describe("scheduling", () => {
  const now = new Date("2026-11-11T12:00:00Z");

  it("runs immediately when it has never run", () => {
    expect(nextRunAt(null, 60, now)).toEqual(now);
  });

  it("is due once the frequency has elapsed and not before", () => {
    const c = { enabled: true, frequencyMinutes: 60, lastRunAt: new Date("2026-11-11T11:30:00Z") };
    expect(isDue(c, true, now)).toBe(false);
    expect(isDue({ ...c, lastRunAt: new Date("2026-11-11T10:59:00Z") }, true, now)).toBe(true);
  });

  it("is never due when the capability or the master switch is off", () => {
    const c = { enabled: true, frequencyMinutes: 60, lastRunAt: null };
    expect(isDue({ ...c, enabled: false }, true, now)).toBe(false);
    expect(isDue(c, false, now)).toBe(false);
  });
});
