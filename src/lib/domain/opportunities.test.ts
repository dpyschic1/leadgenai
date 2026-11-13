import { describe, expect, it } from "vitest";
import { roleFamiliesOf } from "./opportunities";

describe("roleFamiliesOf", () => {
  it("reads the kind of role from real job titles", () => {
    expect(roleFamiliesOf("Senior Engineer, Backend")).toEqual(["backend"]);
    expect(roleFamiliesOf("Staff Software Engineer - Frontend")).toEqual(["frontend"]);
    expect(roleFamiliesOf("Lead Full Stack Engineer, Vertical Applications")).toEqual(["fullstack"]);
    expect(roleFamiliesOf("Team Lead, Android Core Product - Reno, NV, USA")).toEqual(["mobile"]);
    expect(roleFamiliesOf("Senior Graphic Designer - Laneige")).toEqual(["graphic_design"]);
    expect(roleFamiliesOf("Senior Product Designer, Ads")).toEqual(["product_design"]);
    expect(roleFamiliesOf("Senior Site Reliability Engineer I")).toEqual(["devops"]);
    expect(roleFamiliesOf("Software Development Engineer in Test")).toEqual(["qa"]);
  });

  it("puts a title in every kind it names", () => {
    expect(roleFamiliesOf("Staff Backend Software Engineer - Agent Platform (Python/Go)")).toContain("backend");
    expect(roleFamiliesOf("Software Engineer, AI Data - Seville, Spain")).toEqual(["ai_ml", "data"]);
  });

  it("doesn't match words that only contain a short keyword", () => {
    expect(roleFamiliesOf("Maintenance Technician")).toEqual([]); // "ai" inside a word
    expect(roleFamiliesOf("Contract Specialist")).toEqual([]); // "test"-free, "ios"-free
    expect(roleFamiliesOf("Biostatistician")).toEqual([]);
  });
});
