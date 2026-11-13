import { describe, expect, it } from "vitest";
import type { SignalAnalysis } from "@/lib/api/types";
import { candidateTokens } from "./detect";
import { categorizeJob, isAiTrainingWork, isDataScienceOnly, refineCategories, ruleJobSignal } from "./job-categories";
import {
  contactHints,
  isStaleJob,
  jobDigest,
  jobSignalValues,
  jobSourceText,
  MAX_JOB_TEXT,
  MIN_AUTO_CONFIDENCE,
  openDays,
  rejectionReason,
  repostKey,
  roleKey,
} from "./job-signal";

describe("AI roles that are building it, and roles around it (real titles)", () => {
  const ai = (title: string) => categorizeJob({ title, department: null }).includes("ai_ml");
  it("keeps roles that build AI", () => {
    for (const title of [
      "AI Engineer",
      "Applied AI Engineer",
      "Senior Machine Learning Engineer, Agentic Systems",
      "Senior Growth Data Scientist",
      "AI Enablement Engineer",
      "Software Engineer, AI Data - Anaheim, CA, USA",
      "Forward Deployed AI Engineer",
      "Staff AI Builder",
      "Senior Software Engineer, AI Financial Partner",
      "Associate AI Engineer, Physical AI",
      "Engineering Manager, AI Platform",
      "Head of Applied AI",
      "Director, AI/ML Engineering",
      "AI Automation Specialist",
    ])
      expect(ai(title), title).toBe(true);
  });
  it("drops finance, people, strategy, customer, operations and content roles", () => {
    for (const title of [
      "Chief Financial Officer, The AI Access Initiative",
      "Sr People Business Partner — AI-Powered People Strategy",
      "Strategic Finance Lead, R&D and AI Infrastructure",
      "AI Deployment Strategist",
      "Head of AI Deployment",
      "Customer Success Manager, AI Products",
      "AI Agent Support Specialist",
      "Director, AI Compliance",
      "AI Program Lead",
      "Cloud AI Adoption Manager",
      "Mission Control Specialist, AI Operator",
      "Systems & AI Operations Administrator",
      "ML Storyteller",
      "AI Video Creator",
      "VP of Presales Solutions Architecture - AI Infrastructure",
      "Senior Manager, Sales Engineering — AI / GPU Cloud",
      "Enterprise AI Business Analyst",
      "Generative AI Associate",
      "Generative AI Consultant",
      "Practice Director - Cloud AI, Digital Innovations",
      "Customer Success Manager (AI Success Architect)",
      "Staff Product Designer, Search and Conversational AI",
      "Senior Partner Manager, Data & AI Security",
      "Clinical AI Specialist (Remote)",
    ])
      expect(ai(title), title).toBe(false);
  });
  it("drops rotational trainee programs and mechanical structures work", () => {
    expect(categorizeJob({ title: "Associate Software Engineer - Rotational Program", department: null })).toEqual([]);
    expect(categorizeJob({ title: "Vehicle Structures Engineer II", department: "Engineering" })).toEqual([]);
    expect(refineCategories("Associate Software Engineer (Rotational Program)", ["software_development", "staff_augmentation"])).toEqual([]);
  });
  it("drops language gigs for AI companies", () => {
    expect(categorizeJob({ title: "Generative AI Associate Turkish Speaking - Flexible Hours", department: null })).toEqual([]);
    expect(isAiTrainingWork("Native Emirati Arabic Voice Tester for AI Agent QA")).toBe(true);
    expect(categorizeJob({ title: "Project Perseus | Speech & Voice AI Analyst - English (UK) Speakers", department: null })).toEqual([]);
  });
  it("drops freelance projects that make content with AI rather than build it", () => {
    expect(ai("UGC Presenter Freelancer")).toBe(false);
    expect(ai("Futuristic AI Ad Creation")).toBe(false);
    expect(ai("Internal AI Debugging Assistant")).toBe(true);
    expect(ai("AI-Powered Web and Mobile Platform Development")).toBe(true);
  });
});

describe("jobDigest", () => {
  const posting = [
    "About Acme:",
    "Acme builds payment software for clinics.",
    "What You’ll Do:",
    "•",
    "Build our new patient booking app in React Native.",
    "• Own the API that connects clinics to insurers.",
    "Benefits",
    "• Unlimited PTO",
    "• 401(k) matching",
    "Requirements:",
    "• 5+ years with TypeScript.",
    "Acme is an Equal Opportunity Employer. All applicants are considered without regard to race, color, religion.",
    "Questions? Write to careers@acme.com or see https://www.acme.com/careers and acme.io.",
  ].join("\n");

  it("keeps the company, role, duties and requirements, and drops perks and legal small print", () => {
    const digest = jobDigest(posting, { relevant: true })!;
    expect(digest).toContain("Acme builds payment software for clinics.");
    expect(digest).toContain("• Build our new patient booking app in React Native."); // a lone bullet joined to its line
    expect(digest).toContain("• 5+ years with TypeScript.");
    expect(digest).not.toContain("PTO");
    expect(digest).not.toContain("Equal Opportunity");
  });

  it("keeps the emails and sites a posting names, even from the parts it drops", () => {
    const digest = jobDigest(posting, { relevant: true })!;
    expect(digest).toContain("Questions? Write to careers@acme.com"); // a kept line already carries them
    const legalOnly = "Role: build our app.\nWe are an Equal Opportunity Employer; apply via jobs@acme.com.";
    expect(jobDigest(legalOnly, { relevant: true })).toBe("Role: build our app.\nLinks: jobs@acme.com");
  });

  it("stores only the links of a job that fits no service", () => {
    // acme.com is already named by the email address.
    expect(jobDigest(posting, { relevant: false })).toBe("Links: careers@acme.com · acme.io");
    expect(jobDigest("Drive our delivery van.", { relevant: false })).toBeNull();
    expect(jobDigest(null, { relevant: true })).toBeNull();
  });

  it("stays within what the AI reads, and digesting a digest changes nothing", () => {
    const long = Array.from({ length: 200 }, (_, i) => `• Duty number ${i} described in a full sentence of some length.`).join("\n");
    const digest = jobDigest(`${long}\nApply at hiring@acme.com`, { relevant: true })!;
    expect(digest.length).toBeLessThanOrEqual(MAX_JOB_TEXT);
    expect(digest).toContain("hiring@acme.com");
    expect(jobDigest(digest, { relevant: true })).toBe(digest);
  });
});

describe("contactHints", () => {
  it("finds emails, site addresses and bare domains once each", () => {
    expect(contactHints("Mail jobs@acme.com, visit https://www.acme.com/x or acme.com, try beta.acme.ai.")).toEqual([
      "jobs@acme.com",
      "beta.acme.ai",
    ]);
  });
});

describe("job freshness and reposts", () => {
  const now = new Date("2026-11-13T00:00:00Z");
  it("calls a job stale once posted more than 60 days ago; undated jobs never are", () => {
    expect(isStaleJob(new Date("2026-10-01T00:00:00Z"), now)).toBe(false);
    expect(isStaleJob(new Date("2026-09-01T00:00:00Z"), now)).toBe(true);
    expect(isStaleJob(null, now)).toBe(false);
  });
  it("treats the same title and place as one job, whatever the case or spacing", () => {
    expect(repostKey({ title: "Senior  Backend Engineer", location: "New York, NY" })).toBe(repostKey({ title: "senior backend engineer", location: "new york, ny " }));
    expect(repostKey({ title: "Backend Engineer", location: "Austin" })).not.toBe(repostKey({ title: "Backend Engineer", location: "Boston" }));
  });
});

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
    // A research scientist is AI work only when the title says so.
    expect(cats("Principal Research Scientist I - Biologics Analytical Research")).toEqual([]);
    expect(cats("Research Scientist, Machine Learning")).toEqual(["ai_ml", "staff_augmentation"]);
  });

  it("never makes trainees and academic posts a lead", () => {
    expect(cats("2027 Data Science Intern")).toEqual([]);
    expect(cats("Robotics Research, Embodied AI Intern (Spring & Summer 2027)")).toEqual([]);
    expect(cats("Physics-Informed Machine Learning - Postdoctoral Researcher")).toEqual([]);
    expect(cats("2027 Health AI Scholar, Digital Health Algorithms Team")).toEqual([]);
    expect(cats("Graduate Data Scientist")).toEqual([]);
    expect(cats("AI Fellow")).toEqual([]);
    // A technical fellow is a senior engineer.
    expect(cats("Technical Fellow - AI and Robotics")).toEqual(["ai_ml", "staff_augmentation"]);
  });

  it("doesn't read roles around a technology as building it", () => {
    expect(cats("Sr. Product Manager, AI Products")).toEqual([]);
    expect(cats("Data Journalist, AI & Automation")).toEqual([]);
    expect(cats("Sr. Growth Marketing Manager, AI Discovery")).toEqual(["digital_marketing"]);
    expect(cats("AI Trainer - Coding")).toEqual([]);
    expect(cats("Applied AI Engineer")).toEqual(["ai_ml", "staff_augmentation"]);
    expect(cats("Applied AI Architect, International Policy")).toEqual(["ai_ml", "staff_augmentation"]);
    expect(cats("Senior Product Manager, AI Infrastructure Engineering")).toEqual([]);
    expect(cats("Director of Product Management - AI Security & AI Gateway")).toEqual([]);
    expect(cats("Developer Relations Advocate")).toEqual([]);
    expect(cats("Business Developer")).toEqual([]);
    expect(cats("AI Code Evaluation Specialist")).toEqual([]);
  });

  it("reads a design engineer as UX work only for web and UI design", () => {
    expect(cats("Roadway Design Engineer - Mid-Level")).toEqual([]);
    expect(cats("Staff Photonics Design Engineer")).toEqual([]);
    expect(cats("Web Design Engineer")).toContain("ui_ux_design");
  });

  it("never reads physical engineering as software work", () => {
    expect(cats("R&D Mechanical Engineer - Medium Voltage", "Engineering")).toEqual([]);
    expect(cats("EV Charging Infrastructure Engineer (PE Preferred)")).toEqual([]);
    expect(cats("Senior Electrical Engineer", "Engineering")).toEqual([]);
    expect(cats("Manufacturing Engineer", "R&D")).toEqual([]);
    expect(refineCategories("Hardware Engineer", ["software_development", "staff_augmentation"])).toEqual([]);
    // Software in the title keeps it.
    expect(cats("Embedded Software Engineer, Power Systems")).toContain("software_development");
    expect(cats("Senior Ground Software Engineer")).toContain("software_development");
    expect(cats("Machine Learning Engineer, Predictive Maintenance")).toContain("ai_ml");
    expect(cats("Forward Deployed Engineer, Production", "Engineering")).toContain("software_development");
    // Chip design and technicians are hardware, even for AI; "AI&T" is integration and test.
    expect(cats("Principal Design Verification Engineer (AI Fabric Switches)")).toEqual([]);
    expect(cats("Assembly, Integration & Test (AI&T) Technician")).toEqual([]);
    expect(cats("FPGA Firmware Engineer")).toContain("software_development");
  });

  it("holds the AI's categories to the same title rules", () => {
    expect(refineCategories("Data Science Intern", ["ai_ml", "data_analytics"])).toEqual([]);
    expect(refineCategories("Product Manager, AI", ["ai_ml", "staff_augmentation", "ui_ux_design"])).toEqual(["ui_ux_design"]);
    expect(refineCategories("ML Engineer", ["ai_ml"])).toEqual(["ai_ml"]);
  });

  it("tells data-science-only roles and AI training gigs apart", () => {
    expect(isDataScienceOnly("Senior Data Scientist")).toBe(true);
    expect(isDataScienceOnly("Data Scientist, Machine Learning")).toBe(false);
    expect(isDataScienceOnly("ML Engineer")).toBe(false);
    expect(isAiTrainingWork("Remote AI Training Specialists Needed")).toBe(true);
    expect(isAiTrainingWork("AI-Powered Web Scraping Training Mentor")).toBe(true);
    expect(isAiTrainingWork("Build Local AI Resume Screening")).toBe(false);
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
    // A data scientist is a weaker sign of buying AI work than an ML engineer.
    expect(ruleJobSignal("Acme", { ...lead, title: "Senior Data Scientist" }, 1, ["ai_ml"], now)).toMatchObject({ signalType: "engineering_hiring", intentLevel: "low" });
  });
});
