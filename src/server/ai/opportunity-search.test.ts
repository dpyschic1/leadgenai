import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS } from "@/lib/validation/opportunities";
import { toFilters } from "./opportunity-search";

const raw = (overrides: Partial<Parameters<typeof toFilters>[0]> = {}): Parameters<typeof toFilters>[0] => ({
  opportunityTypes: [],
  services: [],
  signalCategories: [],
  hiringFor: [],
  urgency: [],
  industries: [],
  countries: [],
  minScore: null,
  withinDays: null,
  companyName: null,
  unmatched: [],
  ...overrides,
});

describe("toFilters", () => {
  it("maps the AI's answer onto the feed filters", () => {
    const result = toFilters(
      raw({ opportunityTypes: ["mvp_startup"], signalCategories: ["company_event"], countries: ["GB"], withinDays: 30 }),
    );
    expect(result.filters).toEqual({
      ...EMPTY_FILTERS,
      types: ["mvp_startup"],
      signals: ["company_event"],
      countries: ["GB"],
      withinDays: 30,
    });
  });

  it("keeps numbers in range, since the model can't be held to one", () => {
    expect(toFilters(raw({ minScore: 140, withinDays: 0 })).filters).toMatchObject({ minScore: 100, withinDays: 1 });
    expect(toFilters(raw({ minScore: 72.6, withinDays: 9000 })).filters).toMatchObject({ minScore: 73, withinDays: 365 });
  });

  it("uses a named company as the company search", () => {
    expect(toFilters(raw({ companyName: "  Medisync " })).filters.q).toBe("Medisync");
  });

  it("reports what it couldn't filter by, briefly", () => {
    const unmatched = ["React", " ", "Series A", "a", "b", "c", "d"];
    expect(toFilters(raw({ unmatched })).unmatched).toEqual(["React", "Series A", "a", "b", "c"]);
  });
});
