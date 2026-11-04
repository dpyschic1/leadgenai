import { describe, expect, it } from "vitest";
import { DEFAULT_SCORE_WEIGHTS } from "@/lib/validation/scoring";
import { recencyMultiplier, scoreCompany, type EngineInput, type EngineSignal } from "./engine";

const NOW = new Date("2026-10-29T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const identity = (s: string) => s;

const signal = (overrides: Partial<EngineSignal> = {}): EngineSignal => ({
  id: "s1",
  signalType: "vendor_search",
  category: "explicit_buying",
  intentLevel: "explicit",
  urgency: "medium",
  serviceCategories: ["web_development", "seo"],
  summary: "Wants an agency to rebuild the website.",
  occurredAt: daysAgo(3),
  personId: null,
  evidenceLabel: "observed",
  hasSourceUrl: true,
  ...overrides,
});

/** A workforce signal: not explicit, not evaluation activity. */
const hiring = (overrides: Partial<EngineSignal> = {}) =>
  signal({ signalType: "hiring_surge", category: "workforce", intentLevel: "high", serviceCategories: ["staff_augmentation"], ...overrides });

const base: EngineInput = {
  company: { name: "Northbridge Legal", domain: "northbridgelegal.co.uk", industry: "legal", employeeCount: 85, hqCountry: "GB", hasHeadquarters: true },
  people: [{ id: "p1", name: "Olivia Bennett", seniority: "owner", jobFunction: "founder_executive", hasEmail: true, hasPhone: false, suggestable: true, verifiedContact: false }],
  signals: [signal()],
  services: [
    {
      id: "web",
      name: "Website redesign",
      categories: ["web_development", "seo", "ui_ux_design"],
      targetIndustries: ["legal", "accounting"],
      targetJobFunctions: ["founder_executive", "marketing"],
      targetCountries: ["GB"],
      companySizeMin: 10,
      companySizeMax: 200,
    },
    {
      id: "dev",
      name: "Dedicated developers",
      categories: ["staff_augmentation"],
      targetIndustries: [],
      targetJobFunctions: [],
      targetCountries: [],
      companySizeMin: 50,
      companySizeMax: null,
    },
  ],
  weights: DEFAULT_SCORE_WEIGHTS,
  labels: { signalType: identity, category: identity, industry: identity, jobFunction: identity },
  now: NOW,
};

const score = (overrides: Partial<EngineInput> = {}) => scoreCompany({ ...base, ...overrides })!;

describe("recencyMultiplier (PRD §12 table)", () => {
  it.each([
    [0, 1],
    [2, 1],
    [3, 0.85],
    [7, 0.85],
    [14, 0.65],
    [30, 0.4],
    [60, 0.2],
    [61, 0.05],
  ])("%i days -> %f", (days, multiplier) => {
    expect(recencyMultiplier(days)).toBe(multiplier);
  });
});

describe("scoreCompany", () => {
  it("returns null without a positive signal", () => {
    expect(scoreCompany({ ...base, signals: [] })).toBeNull();
    expect(scoreCompany({ ...base, signals: [signal({ category: "negative", signalType: "hiring_freeze" })] })).toBeNull();
  });

  it("makes no opportunity from a registration alone, but counts it alongside real evidence", () => {
    const registered = signal({ id: "s0", signalType: "company_formation", category: "company_event", intentLevel: "low", summary: "Registered at Companies House on 12 August 2026." });
    const newPractice = signal({ id: "s2", signalType: "new_location", category: "company_event", intentLevel: "low" });
    expect(scoreCompany({ ...base, signals: [registered] })).toBeNull();
    expect(scoreCompany({ ...base, signals: [registered, newPractice] })).toBeNull();
    // With a real signal it is an opportunity, and the registration still counts as corroboration.
    const withEvidence = scoreCompany({ ...base, signals: [registered, signal()] });
    expect(withEvidence?.signalRoles.map((r) => [r.signalId, r.role])).toEqual(expect.arrayContaining([["s1", "primary"], ["s0", "corroborating"]]));
  });

  it("scores a 3-day-old explicit request from an ideal customer at 91", () => {
    const result = score();
    // Intent = 30 explicit + 15 severity + 15 evaluating + 15×0.85 recency + 10×0.6 urgency + 0 corroboration + 5 source
    expect(result.factors.intent.score).toBe(84);
    expect(result.factors.icpFit.score).toBe(100);
    expect(result.factors.recency.score).toBe(85);
    expect(result.factors.identity.score).toBe(100);
    expect(result.factors.serviceFit.score).toBe(100);
    // 84×0.40 + 100×0.25 + 85×0.15 + 100×0.10 + 100×0.10 = 91.35
    expect(result.opportunityScore).toBe(91);
    expect(result.serviceId).toBe("web");
    expect(result.type).toBe("website_redesign");
  });

  it("uses the workspace's weights", () => {
    const intentOnly = { intent: 100, icpFit: 0, recency: 0, identity: 0, serviceFit: 0 };
    expect(score({ weights: intentOnly }).opportunityScore).toBe(84);
  });

  it("rewards corroborating signals and penalises recent negative ones", () => {
    // high, not explicit, not evaluating: 15 + 12 + 0 + 12.75 + 6 + 0 + 5 = 50.75
    expect(score({ signals: [hiring()] }).factors.intent.score).toBe(51);
    // a second signal adds 10 × 1/2
    expect(score({ signals: [hiring(), hiring({ id: "s2", intentLevel: "medium" })] }).factors.intent.score).toBe(56);

    const withFreeze = score({
      signals: [hiring(), signal({ id: "n1", signalType: "hiring_freeze", category: "negative", occurredAt: daysAgo(1) })],
    });
    expect(withFreeze.factors.intent.score).toBe(26);
    expect(withFreeze.suggestedAction).toMatch(/^Hold off/);
    expect(withFreeze.signalRoles.find((r) => r.signalId === "n1")?.role).toBe("negative");
  });

  it("values evidence observed with a link above inferred evidence", () => {
    const inferred = score({ signals: [signal({ evidenceLabel: "inferred", hasSourceUrl: false })] });
    expect(inferred.factors.intent.score).toBe(81); // 5 × 0.4 instead of 5 × 1
  });

  it("picks the best-matching service", () => {
    const result = score({ signals: [hiring()] });
    expect(result.serviceId).toBe("dev");
    expect(result.type).toBe("staff_augmentation");
  });

  it("matches no service when none offers what the signals need", () => {
    const result = score({ signals: [signal({ serviceCategories: ["bpo"] })] });
    expect(result.serviceId).toBeNull();
    expect(result.factors.serviceFit.score).toBe(0);
    expect(result.factors.serviceFit.reasons).toEqual(["None of your services offer what the signals point to: bpo"]);
    expect(result.factors.icpFit.reasons).toEqual(["No matching service to compare against"]);
  });

  it("never matches a service the team flagged as wrong, and says so", () => {
    const result = score({ rejected: { personIds: [], serviceIds: ["web"] } });
    expect(result.serviceId).toBeNull();
    expect(result.factors.serviceFit.reasons).toEqual([
      "Not matched to Website redesign: your team flagged it as the wrong service",
      "None of your services offer what the signals point to: web_development, seo",
    ]);

    const fallback = score({ signals: [signal({ serviceCategories: ["web_development", "staff_augmentation"] })], rejected: { personIds: [], serviceIds: ["web"] } });
    expect(fallback.serviceId).toBe("dev");
    expect(fallback.factors.serviceFit.reasons).toContain("Not matched to Website redesign: your team flagged it as the wrong service");
  });

  it("suggests someone else when the team flagged the contact as wrong", () => {
    const people = [
      ...base.people,
      { id: "p2", name: "Tom Reid", seniority: "manager" as const, jobFunction: "marketing", hasEmail: true, hasPhone: true, suggestable: true, verifiedContact: false },
    ];
    expect(score({ people }).primaryPersonId).toBe("p1");
    expect(score({ people, rejected: { personIds: ["p1"], serviceIds: [] } }).primaryPersonId).toBe("p2");
    // Even when the flagged person is named on the lead signal.
    expect(
      score({ people, signals: [signal({ personId: "p1" })], rejected: { personIds: ["p1"], serviceIds: [] } }).primaryPersonId,
    ).toBe("p2");
    expect(score({ rejected: { personIds: ["p1"], serviceIds: [] } }).primaryPersonId).toBeNull();
  });

  it("only suggests people whose identity is confirmed or likely (PRD §22 threshold)", () => {
    const unsure = { ...base.people[0], suggestable: false };
    const result = score({ people: [unsure] });
    expect(result.primaryPersonId).toBeNull();
    expect(result.factors.identity.reasons).toContain("No contact identified");
  });

  it("doesn't count an email or phone known to be invalid, and credits verified ones", () => {
    const bounced = { ...base.people[0], hasEmail: false, hasPhone: false };
    expect(score({ people: [bounced] }).factors.identity.reasons).not.toContain("Contact has email or phone");
    const verified = { ...base.people[0], verifiedContact: true };
    expect(score({ people: [verified] }).factors.identity.reasons).toContain("Contact has a verified email or phone");
  });

  it("matches no service when the signals point to no category", () => {
    const result = score({ signals: [signal({ serviceCategories: [] })] });
    expect(result.serviceId).toBeNull();
    expect(result.factors.serviceFit.reasons).toEqual(["Signals don't point to any service category yet"]);
  });

  it("explains ICP misses, scoring unknown company data as half", () => {
    const result = score({ company: { ...base.company, industry: "retail", hqCountry: null, employeeCount: 500 } });
    expect(result.factors.icpFit.reasons).toContain("retail isn't a target industry");
    expect(result.factors.icpFit.reasons).toContain("Country unknown");
    // (industry 0×15 + country 0.5×10 + size 0×15 + buyer 1×10 + compatibility 1×20) / 70
    expect(result.factors.icpFit.score).toBe(50);
  });

  it("prefers the person behind the lead signal as the contact", () => {
    const people = [...base.people, { id: "p2", name: "James Whitaker", seniority: "manager" as const, jobFunction: "marketing", hasEmail: true, hasPhone: false, suggestable: true, verifiedContact: false }];
    expect(score({ people }).primaryPersonId).toBe("p1");
    expect(score({ people, signals: [signal({ personId: "p2" })] }).primaryPersonId).toBe("p2");
  });

  it("prefers someone the team can reach over a more senior name with no contact details", () => {
    const director = { ...base.people[0], id: "d1", name: "A Director", hasEmail: false, hasPhone: false };
    const manager = { id: "m1", name: "Practice Manager", seniority: "manager" as const, jobFunction: null, hasEmail: false, hasPhone: true, suggestable: true, verifiedContact: false };
    expect(score({ people: [director, manager] }).primaryPersonId).toBe("m1");
    // With no one reachable, the most senior person is still suggested.
    expect(score({ people: [director, { ...manager, hasPhone: false }] }).primaryPersonId).toBe("d1");
  });

  it("labels RFPs and reports the highest recent urgency", () => {
    const rfp = score({ signals: [signal({ signalType: "rfp_tender", urgency: "high" }), signal({ id: "s2", urgency: "low", intentLevel: "low" })] });
    expect(rfp.type).toBe("rfp");
    expect(rfp.urgency).toBe("high");
  });

  it("measures identity from what is known about the company and contact", () => {
    expect(score().factors.identity.score).toBe(100);
    expect(score({ people: [], company: { ...base.company, domain: null } }).factors.identity.score).toBe(30);
  });
});

describe("suggested action", () => {
  it("treats a request in the explicit-buying group as a direct ask", () => {
    const result = score({ signals: [signal({ signalType: "development_partner_request", intentLevel: "high" })] });
    expect(result.suggestedAction).toMatch(/^Reach out now to Olivia Bennett/);
  });
});
