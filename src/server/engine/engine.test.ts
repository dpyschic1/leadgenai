import { describe, expect, it } from "vitest";
import { isEmployment, readIntent } from "./intent";
import { matchedTerms, matchesCountry, termsOf } from "./match";
import { bestService, fitsServiceCategories } from "./runner";
import { onlyElsewhere } from "./filters";
import { discoveredInput, needsOf, scoreDiscovered, signalTypeOf } from "./our-score";
import { DEFAULT_SCORE_WEIGHTS } from "@/lib/validation/scoring";
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

describe("bestService", () => {
  const services = [
    { id: "web", terms: termsOf("Website redesign") },
    { id: "ai", terms: termsOf("AI Automation & Agents") },
  ];
  it("picks the service whose own name the lead matched most", () => {
    expect(bestService(services, ["ai", "automation"])).toBe("ai");
    expect(bestService(services, ["website"])).toBe("web");
  });
  it("is null when no service matched", () => {
    expect(bestService(services, [])).toBeNull();
    expect(bestService([], ["ai"])).toBeNull();
  });
});

describe("onlyElsewhere", () => {
  const us = { countries: ["US"] };
  const post = (title: string, text = "") => ({ title, text });

  it("drops a post that names only other countries", () => {
    expect(onlyElsewhere(post("Team Leader: Recruit Contributors in India, $20-$30 Per Person (India Only)"), us)).toBe(true);
    expect(onlyElsewhere(post("Team Leader: Recruit Contributors in South Africa"), us)).toBe(true);
    expect(onlyElsewhere(post("Recruit contributors in the Philippines"), us)).toBe(true);
  });

  it("keeps a post that names no country, or names the US", () => {
    expect(onlyElsewhere(post("Modern Logo for Sologik"), us)).toBe(false);
    expect(onlyElsewhere(post("AI automation for our team", "We are based in Austin, Texas."), us)).toBe(false);
    expect(onlyElsewhere(post("Developer needed", "Clients in the USA and Canada"), us)).toBe(false);
    expect(onlyElsewhere(post("Website for our Atlanta, Georgia office"), us)).toBe(false);
    expect(onlyElsewhere(post("Ask Jordan or Chad for the brief"), us)).toBe(false);
  });

  it("never filters when the workspace targets every country", () => {
    expect(onlyElsewhere(post("India only"), { countries: [] })).toBe(false);
  });
});

describe("fitsServiceCategories", () => {
  const software = ["software_development", "staff_augmentation", "mvp_development", "mobile_development"];
  const project = (title: string, skills: string[] = []) => ({ title, metadata: { skills } });

  it("keeps projects whose role is the work the services deliver", () => {
    expect(fitsServiceCategories(project("Laravel Developer Needed for Some Inventory management work"), software)).toBe(true);
    expect(fitsServiceCategories(project("U.S.-Based AI Chatbot MVP Developer"), software)).toBe(true);
    expect(fitsServiceCategories(project("Build AI Operations Intelligence SaaS"), software)).toBe(true);
    // The listed skills count too.
    expect(fitsServiceCategories(project("Inventory app for our warehouse", ["PHP", "Laravel", "React"]), software)).toBe(true);
  });

  it("drops projects that only share a word with a service name", () => {
    expect(fitsServiceCategories(project("LPG Pipeline Process Design Support", ["Process Engineering"]), software)).toBe(false);
    expect(fitsServiceCategories(project("Edit Foto Estetik Media Sosial", ["Photo Editing"]), software)).toBe(false);
    expect(fitsServiceCategories(project("Beachwear Design & Manufacturing Partner"), software)).toBe(false);
    expect(fitsServiceCategories(project("Recruiter for Engineering Talent"), software)).toBe(false);
  });

  it("drops AI training and data-labelling gigs", () => {
    const ai = ["ai_ml", "staff_augmentation"];
    expect(fitsServiceCategories(project("Remote AI Training Specialists Needed"), ai)).toBe(false);
    expect(fitsServiceCategories(project("AI Politeness Training for Support"), ai)).toBe(false);
    expect(fitsServiceCategories(project("Build Local AI Resume Screening"), ai)).toBe(true);
  });
});

describe("discovered items scored by the company-opportunity rules", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const item = {
    capability: "freelance" as const,
    category: "freelance_project" as const,
    sourceSlug: "freelancer",
    platform: "Freelancer.com",
    externalId: "1",
    url: "https://www.freelancer.com/projects/1",
    title: "Laravel Developer Needed for Inventory Management",
    text: "We need a Laravel developer to extend our inventory system.",
    postedAt: new Date("2026-11-11T10:00:00Z"),
    buyerName: null,
    buyerProfileUrl: null,
    companyName: null,
    companyDomain: null,
    country: "US",
    city: null,
    industry: null,
    remote: true,
    clientType: null,
    budget: { min: 3000, max: 5000, currency: "USD", usd: 5000 },
    funding: null,
    intentHint: null,
    verification: "verified" as const,
    metadata: { skills: ["PHP", "Laravel"] },
  };
  const engineScore = { total: 0, factors: { serviceFit: 0, intent: 0, icpFit: 0, budget: 0, timing: 0, evidence: 0 }, weights: { serviceFit: 25, intent: 25, icpFit: 20, budget: 15, timing: 10, evidence: 5 }, intentLevel: "high" as const, matchedTerms: [] };
  const context = {
    services: [{ id: "s1", name: "Software Engineers", categories: ["software_development", "staff_augmentation"], targetIndustries: [], targetJobFunctions: [], targetCountries: ["US"], companySizeMin: null, companySizeMax: null }],
    weights: DEFAULT_SCORE_WEIGHTS,
    labels: { signalType: (s: string) => s, category: (s: string) => s, industry: (s: string) => s, jobFunction: (s: string) => s },
  };

  it("turns a post into a signal of the shared taxonomy", () => {
    expect(signalTypeOf(item)).toBe("project_request");
    expect(signalTypeOf({ ...item, capability: "intent", title: "Looking for an agency to build our MVP" })).toBe("mvp_request");
    expect(signalTypeOf({ ...item, capability: "funded" })).toBe("funding");
    expect(needsOf(item, [])).toEqual(expect.arrayContaining(["software_development"]));
    expect(needsOf({ ...item, title: "Something vague", text: "", metadata: {} }, ["ai_ml"])).toEqual(["ai_ml"]);
  });

  it("scores it with the same factors and weights as a company opportunity, matching the service by its needs", () => {
    const input = discoveredInput(item, engineScore, [], now);
    expect(input.signal).toMatchObject({ intentLevel: "explicit", evidenceLabel: "observed", hasSourceUrl: true });
    const result = scoreDiscovered(input, context, now)!;
    expect(result.serviceId).toBe("s1");
    expect(Object.keys(result.factors).sort()).toEqual(["icpFit", "identity", "intent", "recency", "serviceFit"]);
    expect(result.opportunityScore).toBeGreaterThan(50);
    // Older evidence counts less, as for company signals.
    const later = scoreDiscovered(input, context, new Date("2027-02-01T12:00:00Z"))!;
    expect(later.opportunityScore).toBeLessThan(result.opportunityScore);
  });
});
