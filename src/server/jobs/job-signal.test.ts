import { describe, expect, it } from "vitest";
import type { SignalAnalysis } from "@/lib/api/types";
import { candidateTokens } from "./detect";
import { categorizeJob, ruleJobSignal } from "./job-categories";
import { jobSignalValues, jobSourceText, MIN_AUTO_CONFIDENCE, openDays, rejectionReason, roleKey } from "./job-signal";

const now = new Date("2026-11-03T12:00:00Z");
const job = {
  title: "Senior React Engineer",
  department: "Engineering",
  location: "London",
  url: "https://jobs.lever.co/acme/1",
  description: "We are hiring three engineers to rebuild our platform.",
  postedAt: new Date("2026-09-04T09:00:00Z"),
  firstSeenAt: new Date("2026-10-30T09:00:00Z"),
};

const analysis = (overrides: Partial<SignalAnalysis> = {}): SignalAnalysis => ({
  isSignal: true,
  signalType: "engineering_hiring",
  intentLevel: "high",
  urgency: "medium",
  serviceCategories: ["staff_augmentation"],
  summary: "Hiring three React engineers to rebuild the platform.",
  excerpt: "We are hiring three engineers to rebuild our platform.",
  evidenceLabel: "observed",
  confidence: 82,
  occurredOn: null,
  model: "test",
  ...overrides,
});

describe("job source text", () => {
  it("leads with the facts, including how long the job has been open", () => {
    expect(jobSourceText(job, { now })).toBe(
      [
        "Job posting: Senior React Engineer",
        "Department: Engineering",
        "Location: London",
        "Posted: 2026-09-04 (open for 60 days)",
        "",
        "We are hiring three engineers to rebuild our platform.",
      ].join("\n"),
    );
  });

  it("lists every posting of the same role, and trims a long description", () => {
    const text = jobSourceText(job, { now, openings: ["London", "Remote - EU"], maxDescription: 9 });
    expect(text).toContain("The company has 2 open postings for this role: London; Remote - EU");
    expect(text.endsWith("\n\nWe are hi")).toBe(true);
  });

  it("counts from first sight when the board gives no date, and stops at closing", () => {
    expect(openDays({ ...job, postedAt: null }, now)).toBe(4);
    expect(openDays({ ...job, closedAt: new Date("2026-09-14T10:00:00Z") }, now)).toBe(10);
  });
});

describe("jobSignalValues", () => {
  it("records a confident signal, dated when the job was posted, with the job link as evidence", () => {
    expect(jobSignalValues(analysis(), job)).toMatchObject({
      signalType: "engineering_hiring",
      occurredOn: "2026-09-04",
      sourceUrl: "https://jobs.lever.co/acme/1",
      source: "ai",
      confidence: 82,
      personId: null,
    });
  });

  it("keeps only quotes from the company's own description", () => {
    const fromHeader = jobSignalValues(analysis({ excerpt: "The company has 2 open postings for this role" }), job);
    expect(fromHeader).toMatchObject({ excerpt: null, evidenceLabel: "inferred" });
    expect(jobSignalValues(analysis(), job)).toMatchObject({ excerpt: job.description, evidenceLabel: "observed" });
  });

  it("records nothing when the analysis finds no signal or is unsure", () => {
    expect(jobSignalValues(analysis({ isSignal: false }), job)).toBeNull();
    expect(jobSignalValues(analysis({ signalType: null }), job)).toBeNull();
    expect(jobSignalValues(analysis({ confidence: MIN_AUTO_CONFIDENCE - 1 }), job)).toBeNull();
    expect(jobSignalValues(analysis({ summary: "  " }), job)).toBeNull();
  });

  it("explains why a job wasn't recorded", () => {
    expect(rejectionReason(analysis({ isSignal: false }))).toBe("Not a buying signal on a closer read");
    expect(rejectionReason(analysis({ confidence: 40 }))).toContain("40% confident");
  });
});

describe("roleKey", () => {
  it("treats the same role in different places as one", () => {
    const keys = ["Design Engineer - UK", "Design Engineer – Canada", "design engineer (Remote)", "Design Engineer | Remote - EU"].map(roleKey);
    expect(new Set(keys)).toEqual(new Set(["design engineer"]));
    expect(roleKey("Staff Software Engineer, Product Engineering - EU")).toBe("staff software engineer, product engineering");
  });

  it("keeps titles that only look similar apart", () => {
    expect(roleKey("Front-end Developer")).toBe("front-end developer");
    expect(roleKey("Sales Engineer AH")).not.toBe(roleKey("Sales Engineer"));
    expect(roleKey("Engineer - Platform Reliability and Developer Experience")).toBe(
      "engineer - platform reliability and developer experience",
    );
  });
});

describe("board names", () => {
  it("guesses candidates from the domain and the name", () => {
    expect(candidateTokens({ name: "Stripe, Inc.", domain: "www.stripe.com" })).toEqual(["stripe"]);
    expect(candidateTokens({ name: "Harbourside Legal Ltd", domain: "harbourside-legal.co.uk" })).toEqual([
      "harbourside-legal",
      "harboursidelegal",
      "harbourside",
    ]);
    expect(candidateTokens({ name: "Calder & Co", domain: null })).toEqual(["calder"]);
  });
});

describe("categorizeJob", () => {
  const cats = (title: string, department: string | null = null) => categorizeJob({ title, department }).sort();

  it("reads AI, software and data roles, with staff augmentation for tech roles", () => {
    expect(cats("Senior Machine Learning Engineer")).toEqual(["ai_ml", "staff_augmentation"]);
    expect(cats("AI Engineer, Agents")).toEqual(["ai_ml", "staff_augmentation"]);
    expect(cats("Full-Stack Developer (React/Node)")).toEqual(["software_development", "staff_augmentation"]);
    expect(cats("Data Scientist")).toEqual(["ai_ml", "data_analytics", "staff_augmentation"]);
    expect(cats("iOS Engineer")).toEqual(["mobile_development", "staff_augmentation"]);
    expect(cats("Site Reliability Engineer")).toEqual(["cloud_devops", "staff_augmentation"]);
  });

  it("reads design, marketing and support roles without staff augmentation", () => {
    expect(cats("Senior Product Designer")).toEqual(["ui_ux_design"]);
    expect(cats("Performance Marketing Manager")).toEqual(["digital_marketing", "paid_media"]);
    expect(cats("Customer Support Specialist")).toEqual(["customer_support_outsourcing"]);
  });

  it("uses the department for a plain engineer title, and ignores unrelated roles", () => {
    expect(cats("Senior Engineer", "Engineering")).toEqual(["software_development", "staff_augmentation"]);
    expect(cats("Senior Engineer", "Facilities")).toEqual([]);
    expect(cats("Registered Nurse")).toEqual([]);
    expect(cats("Real Estate Agent")).toEqual([]);
    expect(cats("Security Guard")).toEqual([]);
    expect(cats("Vice President of AI & Infrastructure Sales")).toEqual([]);
    expect(cats("Account Executive, Cloud Platform")).toEqual([]);
  });
});

describe("ruleJobSignal", () => {
  const lead = { title: "ML Engineer", department: null, location: "San Francisco, CA", url: "https://jobs.ashbyhq.com/acme/1", postedAt: new Date("2026-11-01T00:00:00Z"), firstSeenAt: now };

  it("states only the facts, as a provider signal with modest confidence", () => {
    const values = ruleJobSignal("Acme", lead, 1, ["ai_ml"], now);
    expect(values).toMatchObject({
      signalType: "engineering_hiring",
      intentLevel: "medium",
      serviceCategories: ["ai_ml"],
      occurredOn: "2026-11-01",
      sourceUrl: lead.url,
      evidenceLabel: "observed",
      source: "provider",
      confidence: 60,
    });
    expect(values.summary).toBe("Acme is hiring a ML Engineer (San Francisco, CA). Posted 2026-11-01.");
  });

  it("picks the type from what the posting shows", () => {
    expect(ruleJobSignal("Acme", { ...lead, title: "ML Engineer (6 month contract)" }, 1, ["ai_ml"], now).signalType).toBe("contractor_hiring");
    expect(ruleJobSignal("Acme", lead, 4, ["ai_ml"], now).signalType).toBe("multiple_same_role_openings");
    expect(ruleJobSignal("Acme", { ...lead, postedAt: new Date("2026-08-01T00:00:00Z") }, 1, ["ai_ml"], now).signalType).toBe("long_running_vacancy");
    expect(ruleJobSignal("Acme", { ...lead, title: "Content Writer" }, 1, ["content_marketing"], now)).toMatchObject({ signalType: "recruiting_pressure", intentLevel: "low" });
  });
});
