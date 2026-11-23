import { describe, expect, it } from "vitest";
import { toResult } from "./qualify-lead";

const evidence = "Job post: Senior React Developer (Remote). We are rebuilding our customer portal and need two React developers to start in January.";
const raw = (overrides = {}) => ({ verdict: "hot" as const, fit: 88, reason: "Hiring two React developers for a portal rebuild.", quote: "", budget: "", timeline: "", ...overrides });

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
});
