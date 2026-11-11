import { describe, expect, it } from "vitest";
import { isEmployment, readIntent } from "./intent";
import { matchedTerms, matchesCountry, termsOf } from "./match";
import { scoreItem } from "./score-item";
import { projectBudgetPoints, totalScore, DEFAULT_ENGINE_WEIGHTS } from "./scoring";
import type { DiscoveredItem } from "./types";

const now = new Date("2026-11-11T12:00:00Z");

const base: DiscoveredItem = {
  capability: "intent", category: "intent", sourceSlug: "hacker_news", platform: "Hacker News", externalId: "1", url: "https://example.test/1",
  title: "Looking for an agency to build my MVP", text: "We need an agency to build our MVP mobile app. Budget $20k.", postedAt: new Date("2026-11-11T08:00:00Z"),
  buyerName: "jane", buyerProfileUrl: null, companyName: null, companyDomain: null, country: "US", city: null, industry: null, remote: null,
  clientType: null, budget: null, funding: null, intentHint: null, verification: "unverified", metadata: {},
};

describe("readIntent (spec §3 examples)", () => {
  it("rates 'looking for an agency to build my MVP' high", () => {
    expect(readIntent("Looking for an agency to build my MVP")?.level).toBe("high");
  });
  it("rates 'need someone to redesign our website' medium or higher", () => {
    expect(["medium", "high"]).toContain(readIntent("Need someone to redesign our website")?.level);
  });
  it("rates a cost question low, still captured", () => {
    expect(readIntent("How much does it cost to build an app like Uber?")?.level).toBe("low");
  });
  it("ignores people advertising their own services", () => {
    expect(readIntent("Freelance developer available for hire, DM me")).toBeNull();
  });
  it("does not read generic phrasing in an article as a need (seen in live data)", () => {
    expect(readIntent("AI usage generates a fragile codebase. Teams need help keeping up quality when they vibe-code and outsourcing review.")).toBeNull();
  });
  it("does not read 'manufacturers who can develop a product' as a request (seen in live data)", () => {
    expect(readIntent("I often meet manufacturers who can develop a product for me. I am inquiring to see if we are compatible.")).toBeNull();
  });
  it("tells employment ads from project work", () => {
    expect(isEmployment("Talent Acquisition Partner (Remote) - US, full-time, benefits")).toBe(true);
    expect(isEmployment("3 Content Creators - $250/month + performance bonuses")).toBe(true);
    expect(isEmployment("Sales partner for a web dev agency. 50% of every deal you close")).toBe(true);
    expect(isEmployment("Developer for a one-off website redesign project, fixed price")).toBe(false);
  });
  it("ignores unrelated text", () => {
    expect(readIntent("Show HN: my weekend project, a todo list")).toBeNull();
  });
});

describe("matching", () => {
  it("does not match on generic words from a service description (seen in live data)", () => {
    const terms = termsOf("Dedicated developers");
    expect(terms).toEqual(["developers"]);
    expect(matchedTerms(terms, "Licensed electrical engineer: low-voltage cabling for LED lighting, dedicated within weeks")).toEqual([]);
  });
  it("matches plurals but not other word forms (seen in live data: 'Developing the Content' is not a developer)", () => {
    expect(matchedTerms(["developers"], "Zoho Developer needed")).toEqual(["developers"]);
    expect(matchedTerms(["developers"], "HR - Developing the Content")).toEqual([]);
  });
  it("keeps real two-letter service names such as AI and UX", () => {
    expect(termsOf("AI & UX design")).toEqual(["ai", "ux", "design"]);
  });
  it("explains a service match by the terms it found", () => {
    const terms = termsOf("Website redesign & SEO");
    expect(matchedTerms(terms, "Our website needs a redesign")).toEqual(["website", "redesign"]);
  });
  it("treats an empty country list as any country", () => {
    expect(matchesCountry({ countries: [], industries: [], serviceIds: [] }, null)).toBe(true);
    expect(matchesCountry({ countries: ["US"], industries: [], serviceIds: [] }, null)).toBe(false);
  });
});

describe("scoring", () => {
  it("weights sum to 100", () => {
    expect(Object.values(DEFAULT_ENGINE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(totalScore({ serviceFit: 100, intent: 100, icpFit: 100, budget: 100, timing: 100, evidence: 100 })).toBe(100);
  });
  it("uses the provider's intent verdict over re-reading the text", () => {
    const s = scoreItem({ item: { ...base, title: "[Hiring] Developer for our website", text: "Paid project.", intentHint: "high" }, targeting: { countries: [], industries: [], serviceIds: [] }, serviceTerms: ["website"], now });
    expect(s.intentLevel).toBe("high");
  });
  it("never lets a missing budget meet the minimum", () => {
    expect(projectBudgetPoints(null, 5000)).toBeLessThan(projectBudgetPoints(5000, 5000));
  });
  it("scores a fresh explicit request above a stale cost question", () => {
    const terms = termsOf("MVP development mobile app");
    const hot = scoreItem({ item: base, targeting: { countries: ["US"], industries: [], serviceIds: [] }, serviceTerms: terms, now });
    const cold = scoreItem({
      item: { ...base, title: "How much to build an app like Uber", text: "How much does it cost to build an app like Uber?", postedAt: new Date("2026-07-01T00:00:00Z"), url: null },
      targeting: { countries: ["US"], industries: [], serviceIds: [] }, serviceTerms: terms, now,
    });
    expect(hot.total).toBeGreaterThan(cold.total);
    expect(hot.intentLevel).toBe("high");
    expect(cold.intentLevel).toBe("low");
    expect(hot.matchedTerms.length).toBeGreaterThan(0);
  });
  it("low-scoring items still get a score (nothing is discarded)", () => {
    const s = scoreItem({ item: { ...base, text: "unrelated", title: "unrelated", country: "FR" }, targeting: { countries: ["US"], industries: [], serviceIds: [] }, serviceTerms: ["mvp"], now });
    expect(s.total).toBeGreaterThanOrEqual(0);
  });
});

import { whyNow } from "./describe";
import { batchStart } from "./providers/yc-batches";

describe("funding wording and dates", () => {
  const funded = (funding: DiscoveredItem["funding"]): DiscoveredItem => ({ ...base, capability: "funded", category: "funded_company", funding });
  it("does not say 'raised' when the source gave no amount", () => {
    const [line] = whyNow(funded({ amountUsd: null, stage: "Y Combinator Fall 2026", date: "2026-09-01", investors: [] }), now);
    expect(line).toMatch(/amount not disclosed/);
    expect(line).not.toMatch(/^Raised/);
  });
  it("says raised only with an amount", () => {
    expect(whyNow(funded({ amountUsd: 2_000_000, stage: "Seed", date: "2026-10-30", investors: [] }), now)[0]).toBe("Raised $2M Seed on 2026-10-30.");
  });
  it("dates a future YC batch after today so the provider can skip it", () => {
    expect(batchStart("Winter 2027")! > "2026-11-11").toBe(true);
  });
});
