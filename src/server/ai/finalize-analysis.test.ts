import { describe, expect, it } from "vitest";
import { finalizeAnalysis, type RawAnalysis } from "./finalize-analysis";

const source = "We’re looking for an agency to redesign our website before our Leeds office opens in March.";
const ref = { serviceCategories: [{ slug: "web_development", name: "Website development" }, { slug: "seo", name: "SEO" }] };

const raw: RawAnalysis = {
  isSignal: true,
  signalType: "service_request",
  intentLevel: "explicit",
  urgency: "medium",
  serviceCategories: ["web_development", "seo", "web_development"],
  summary: "  Wants an agency to redesign the website.  ",
  excerpt: "We're looking for an agency to redesign   our website",
  evidenceLabel: "observed",
  confidence: 92.4,
  occurredOn: "2026-10-20",
};

const run = (overrides: Partial<RawAnalysis> = {}) => finalizeAnalysis({ ...raw, ...overrides }, source, ref, "2026-10-29");

describe("finalizeAnalysis", () => {
  it("keeps a quote that appears in the source, ignoring quote style and spacing", () => {
    const result = run();
    expect(result.excerpt).toBe("We're looking for an agency to redesign   our website");
    expect(result.evidenceLabel).toBe("observed");
  });

  it("matches a quote whose dashes or ellipsis differ from the source", () => {
    const text = "Our site isn't mobile-friendly... clients complain.";
    const result = finalizeAnalysis({ ...raw, excerpt: "isn’t mobile‑friendly… clients" }, text, ref, "2026-10-29");
    expect(result.excerpt).not.toBeNull();
    expect(result.evidenceLabel).toBe("observed");
  });

  it("accepts an elided quote whose parts all appear in order", () => {
    const quote = "We’re looking for an agency... before our Leeds office opens";
    expect(run({ excerpt: quote }).excerpt).toBe(quote);
  });

  it("rejects an elided quote whose parts are out of order or invented", () => {
    expect(run({ excerpt: "before our Leeds office opens... We’re looking for an agency" }).excerpt).toBeNull();
    expect(run({ excerpt: "We’re looking for an agency... with a £50k budget" }).excerpt).toBeNull();
  });

  it("passes through a null signal type when there is no signal", () => {
    expect(run({ isSignal: false, signalType: null }).signalType).toBeNull();
  });

  it("drops an invented quote and downgrades 'observed' to 'inferred'", () => {
    const result = run({ excerpt: "We have a budget of £50k for the project" });
    expect(result.excerpt).toBeNull();
    expect(result.evidenceLabel).toBe("inferred");
  });

  it("de-duplicates categories and drops unknown slugs", () => {
    expect(run({ serviceCategories: ["seo", "made_up", "seo"] }).serviceCategories).toEqual(["seo"]);
  });

  it("clamps and rounds confidence", () => {
    expect(run().confidence).toBe(92);
    expect(run({ confidence: 140 }).confidence).toBe(100);
    expect(run({ confidence: -5 }).confidence).toBe(0);
  });

  it("rejects future or malformed dates", () => {
    expect(run().occurredOn).toBe("2026-10-20");
    expect(run({ occurredOn: "2027-01-01" }).occurredOn).toBeNull();
    expect(run({ occurredOn: "March" }).occurredOn).toBeNull();
  });

  it("trims the summary", () => {
    expect(run().summary).toBe("Wants an agency to redesign the website.");
  });
});
