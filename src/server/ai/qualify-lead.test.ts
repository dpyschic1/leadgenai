import { describe, expect, it } from "vitest";
import { toResult } from "./qualify-lead";

const evidence = "Job post: Senior React Developer (Remote). We are rebuilding our customer portal and need two React developers to start in January.";
const raw = (overrides = {}) => ({
  verdict: "hot" as const,
  fit: 88,
  reason: "Hiring two React developers for a portal rebuild.",
  summary: "",
  roles: [] as { title: string; fits: boolean; covered_by: string; note: string }[],
  quote: "",
  budget: "",
  timeline: "",
  ...overrides,
});

describe("lead qualification result", () => {
  it("keeps a quote copied from the evidence, and drops one the AI made up", () => {
    expect(toResult(raw({ quote: "need two React developers to start in January" }), evidence).quote).toBe("need two React developers to start in January");
    expect(toResult(raw({ quote: "We urgently need an agency." }), evidence).quote).toBeNull();
  });
  it("keeps the fit in range and only the hints the evidence states", () => {
    const result = toResult(raw({ fit: 140, timeline: " January ", budget: "  " }), evidence);
    expect(result.score).toBe(100);
    expect(result.hints).toEqual({ timeline: "January" });
    expect(toResult(raw({ fit: -5 }), evidence).score).toBe(0);
  });
  it("judges each role once, the ones that fit first, with the part of the service that covers them", () => {
    const result = toResult(
      raw({
        summary: "  Rebuilding its portal: two React developers. ",
        roles: [
          { title: "Sales Engineer", fits: false, covered_by: "Software development", note: "A sales role." },
          { title: "Senior React Developer", fits: true, covered_by: "Website development", note: "React, remote." },
          { title: "senior react developer", fits: true, covered_by: "Website development", note: "Posted twice." },
        ],
      }),
      evidence,
    );
    expect(result.hints.roles).toEqual([
      { title: "Senior React Developer", fits: true, coveredBy: "Website development", note: "React, remote." },
      { title: "Sales Engineer", fits: false, coveredBy: null, note: "A sales role." },
    ]);
    expect(result.hints.fittingRoles).toEqual(["Senior React Developer"]);
    expect(result.hints.summary).toBe("Rebuilding its portal: two React developers.");
  });
});
