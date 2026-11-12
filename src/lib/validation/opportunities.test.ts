import { describe, expect, it } from "vitest";
import { setFilterParams } from "@/lib/api/opportunities";
import { bulkOpportunitiesSchema, EMPTY_FILTERS, opportunityFiltersSchema, opportunityListQuerySchema } from "./opportunities";
import { FIRST_PAGE } from "./pagination";

const SERVICE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

describe("opportunityFiltersSchema", () => {
  it("treats missing filters as no filter", () => {
    expect(opportunityFiltersSchema.parse({})).toEqual(EMPTY_FILTERS);
    expect(opportunityListQuerySchema.parse({})).toEqual({ ...EMPTY_FILTERS, group: "open", sort: "best", ...FIRST_PAGE });
  });

  it("reads comma-separated lists and numbers from a URL", () => {
    const parsed = opportunityFiltersSchema.parse({
      types: "mvp_startup, website_redesign",
      countries: "GB,US,GB",
      urgency: "high",
      minScore: "70",
      withinDays: "30",
      services: SERVICE_ID,
    });
    expect(parsed).toMatchObject({
      types: ["mvp_startup", "website_redesign"],
      countries: ["GB", "US"],
      urgency: ["high"],
      minScore: 70,
      withinDays: 30,
      services: [SERVICE_ID],
    });
  });

  it("rejects values outside the allowed sets and ranges", () => {
    expect(opportunityFiltersSchema.safeParse({ countries: "UK" }).success).toBe(false);
    expect(opportunityFiltersSchema.safeParse({ urgency: "unknown" }).success).toBe(false);
    expect(opportunityFiltersSchema.safeParse({ minScore: "101" }).success).toBe(false);
    expect(opportunityFiltersSchema.safeParse({ withinDays: "0" }).success).toBe(false);
    expect(opportunityFiltersSchema.safeParse({ services: "not-a-uuid" }).success).toBe(false);
  });
});

describe("setFilterParams", () => {
  it("writes only active filters, and the server reads back exactly the same", () => {
    const filters = { ...EMPTY_FILTERS, q: "north", types: ["rfp"], countries: ["GB", "IE"], minScore: 60 };
    const params = setFilterParams(new URLSearchParams({ group: "open" }), filters);
    expect(params.toString()).toBe("group=open&q=north&types=rfp&countries=GB%2CIE&minScore=60");
    expect(opportunityListQuerySchema.parse(Object.fromEntries(params))).toEqual({ ...filters, group: "open", sort: "best", ...FIRST_PAGE });
  });
});

describe("sort, hiring for and new this week", () => {
  it("reads them from a URL", () => {
    const parsed = opportunityListQuerySchema.parse({ sort: "newest", needs: "ui_ux_design,ai_ml", foundWithinDays: "7" });
    expect(parsed).toMatchObject({ sort: "newest", needs: ["ui_ux_design", "ai_ml"], foundWithinDays: 7 });
    expect(() => opportunityListQuerySchema.parse({ sort: "random" })).toThrow();
  });
});

describe("bulkOpportunitiesSchema", () => {
  it("takes exactly one action for 1-100 opportunities", () => {
    expect(bulkOpportunitiesSchema.safeParse({ ids: [SERVICE_ID], archived: true }).success).toBe(true);
    expect(bulkOpportunitiesSchema.safeParse({ ids: [SERVICE_ID], stageId: SERVICE_ID }).success).toBe(true);
    // No action, two actions, or nothing selected.
    expect(bulkOpportunitiesSchema.safeParse({ ids: [SERVICE_ID] }).success).toBe(false);
    expect(bulkOpportunitiesSchema.safeParse({ ids: [SERVICE_ID], archived: true, listId: SERVICE_ID }).success).toBe(false);
    expect(bulkOpportunitiesSchema.safeParse({ ids: [], archived: true }).success).toBe(false);
    expect(bulkOpportunitiesSchema.safeParse({ ids: Array(101).fill(SERVICE_ID), archived: true }).success).toBe(false);
  });
});
