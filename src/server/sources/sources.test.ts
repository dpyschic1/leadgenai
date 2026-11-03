import { describe, expect, it } from "vitest";
import { finalizeFacts } from "@/server/ai/website-extract";
import { formationSignal, signalFromAnalysis } from "@/server/ingestion/found-signal";
import type { SignalAnalysis } from "@/lib/api/types";
import { industryForSicCodes } from "@/lib/domain/uk-codes";
import { toFoundCompany, toFoundPeople } from "./companies-house";
import { jobFunctionFromTitle, personNameFromRegister, seniorityFromTitle, titleCaseCompanyName } from "./names";
import { isAllowed, parseRobots } from "./http";
import { tenderSourceText, toTender } from "./uk-tenders";
import {
  candidateDomains,
  emailsFrom,
  extractLinks,
  jobBoardFromHtml,
  phonesFrom,
  pickPages,
  websiteMatchConfidence,
} from "./company-website";

describe("robots.txt", () => {
  const robots = `
User-agent: *
Disallow: /private
Allow: /private/press
Disallow: /*.pdf$

User-agent: BadBot
Disallow: /`;

  it("applies the longest matching rule, with wildcards", () => {
    const rules = parseRobots(robots, "LeadGenAIBot");
    expect(isAllowed(rules, "/about")).toBe(true);
    expect(isAllowed(rules, "/private/team")).toBe(false);
    expect(isAllowed(rules, "/private/press/2026")).toBe(true);
    expect(isAllowed(rules, "/files/report.pdf")).toBe(false);
    expect(isAllowed(rules, "/files/report.pdf?x=1")).toBe(true);
  });

  it("uses a group naming our agent over the * group", () => {
    const rules = parseRobots("User-agent: *\nDisallow:\n\nUser-agent: LeadGenAIBot\nDisallow: /", "LeadGenAIBot");
    expect(isAllowed(rules, "/")).toBe(false);
  });
});

describe("names", () => {
  it("title-cases register names, keeping legal suffixes readable", () => {
    expect(titleCaseCompanyName("BRIGHTSMILE DENTAL GROUP LTD")).toBe("Brightsmile Dental Group Ltd");
    expect(titleCaseCompanyName("SMITH & JONES OF LEEDS LLP")).toBe("Smith & Jones of Leeds LLP");
    expect(titleCaseCompanyName("Already Mixed Ltd")).toBe("Already Mixed Ltd");
  });

  it("turns register order into a normal name", () => {
    expect(personNameFromRegister("SMITH, Sarah Jane")).toBe("Sarah Jane Smith");
    expect(personNameFromRegister("O'NEILL, Dr Patrick")).toBe("Patrick O'Neill");
  });

  it("reads seniority and function from titles", () => {
    expect(seniorityFromTitle("Managing Director")).toBe("owner");
    expect(seniorityFromTitle("Head of Marketing")).toBe("director");
    expect(seniorityFromTitle("Practice Manager")).toBe("manager");
    expect(jobFunctionFromTitle("Head of Marketing")).toBe("marketing");
    expect(jobFunctionFromTitle("Practice Manager")).toBe("operations");
  });
});

describe("Companies House", () => {
  it("maps a search result to a company with its number and industry", () => {
    const company = toFoundCompany({
      company_name: "BRIGHTSMILE DENTAL LTD",
      company_number: "12345678",
      company_status: "active",
      company_type: "ltd",
      date_of_creation: "2026-03-01",
      registered_office_address: { locality: "Leeds", postal_code: "LS1 4AP" },
      sic_codes: ["86230"],
    });
    expect(company).toMatchObject({
      name: "Brightsmile Dental Ltd",
      industry: "dental",
      hq: { city: "Leeds", country: "GB" },
      identifiers: [{ scheme: "gb_company_number", value: "12345678" }],
      foundedOn: "2026-03-01",
      record: { sourceSlug: "companies_house", externalId: "company:12345678" },
    });
  });

  it("skips non-business company types", () => {
    expect(toFoundCompany({ company_name: "X", company_number: "1", company_type: "charitable-incorporated-organisation" })).toBeNull();
  });

  it("keeps serving directors, with their occupation", () => {
    const people = toFoundPeople({
      items: [
        { name: "CLARKE, Sophie", officer_role: "director", occupation: "Dentist" },
        { name: "OLD, Former", officer_role: "director", resigned_on: "2020-01-01" },
        { name: "HOLDCO LTD", officer_role: "corporate-director" },
      ],
    });
    expect(people).toEqual([
      { name: "Sophie Clarke", title: "Director (Dentist)", seniority: "owner", jobFunction: "founder_executive", relationship: "board_member", confidence: 90 },
    ]);
  });

  it("maps SIC codes to our industries", () => {
    expect(industryForSicCodes(["99999", "69201"])).toBe("accounting");
    expect(industryForSicCodes(["99999"])).toBeNull();
  });
});

describe("company websites", () => {
  it("suggests likely UK domains from the name", () => {
    expect(candidateDomains("Brightsmile Dental Ltd")).toEqual([
      "brightsmiledental.co.uk",
      "brightsmiledental.com",
      "brightsmiledental.uk",
      "brightsmile-dental.co.uk",
      "brightsmile-dental.com",
      "brightsmile-dental.uk",
      "brightsmile.co.uk",
      "brightsmile.com",
      "brightsmile.uk",
    ]);
  });

  it("trusts a site that shows the company number, and less one that only names it", () => {
    const company = { name: "Brightsmile Dental Ltd", companyNumber: "12345678" };
    expect(websiteMatchConfidence("Registered in England no. 12345678", company)).toBe(95);
    expect(websiteMatchConfidence("Company number 12 345 678", company)).toBe(95);
    expect(websiteMatchConfidence("Welcome to Brightsmile Dental, Leeds", { ...company, city: "Leeds" })).toBe(70);
    // A shared phrase without the town isn't enough to claim the site.
    expect(websiteMatchConfidence("Welcome to Brightsmile Dental", { ...company, city: "Leeds" })).toBe(40);
    expect(websiteMatchConfidence("Bright smiles for everyone", company)).toBe(0);
  });

  it("picks one page of each kind on the same site", () => {
    const html = `
      <a href="/about-us">About</a><a href="/meet-the-team">Our team</a><a href="https://other.com/contact">x</a>
      <a href="/contact">Contact</a><a href="/careers">Join us</a><a href="/blog">News</a><a href="/brochure.pdf">About PDF</a>`;
    const links = extractLinks(html, "https://www.brightsmile.co.uk/");
    expect(pickPages(links, "brightsmile.co.uk")).toEqual([
      { kind: "team", url: "https://www.brightsmile.co.uk/meet-the-team" },
      { kind: "about", url: "https://www.brightsmile.co.uk/about-us" },
      { kind: "contact", url: "https://www.brightsmile.co.uk/contact" },
      { kind: "careers", url: "https://www.brightsmile.co.uk/careers" },
      { kind: "news", url: "https://www.brightsmile.co.uk/blog" },
    ]);
  });

  it("finds a linked or embedded job board", () => {
    expect(jobBoardFromHtml(`<a href="https://jobs.lever.co/acme/123">Jobs</a>`)).toEqual({ provider: "lever", boardToken: "acme" });
    expect(jobBoardFromHtml(`<script src="https://boards.greenhouse.io/embed/job_board?for=acmeco"></script>`)).toEqual({
      provider: "greenhouse",
      boardToken: "acmeco",
    });
    expect(jobBoardFromHtml("<p>No jobs here</p>")).toBeNull();
  });

  it("reads the company's own email and UK phone", () => {
    const html = `<a href="mailto:hello@brightsmile.co.uk">Email</a> partner@gmail.com logo@2x.png
      <a href="tel:+44 113 496 0000">Call</a>`;
    expect(emailsFrom(html, "brightsmile.co.uk")).toEqual(["hello@brightsmile.co.uk"]);
    expect(phonesFrom(html)).toEqual(["+441134960000"]);
    expect(phonesFrom("<p>Call us on 0113 496 0000 today</p>")).toEqual(["01134960000"]);
  });
});

describe("website facts", () => {
  it("keeps only real names that appear on the pages", () => {
    const facts = finalizeFacts(
      {
        description: " A family dental practice in Leeds. ",
        team: [
          { name: "Sophie Clarke", title: "Practice Principal" },
          { name: "sophie clarke", title: "" },
          { name: "Invented Person", title: "CEO" },
          { name: "Reception Team", title: "" },
        ],
      },
      "Meet Sophie Clarke, our practice principal. Our reception team is here to help.",
    );
    expect(facts).toEqual({ description: "A family dental practice in Leeds.", team: [{ name: "Sophie Clarke", title: "Practice Principal" }] });
  });
});

describe("tenders", () => {
  const hit = {
    item: {
      id: "abc",
      title: "Website redesign &amp; hosting",
      description: "The council requires a new accessible website.",
      organisationName: "LEEDS CITY COUNCIL",
      noticeStatus: "Open",
      publishedDate: "2026-10-20T09:00:00Z",
      deadlineDate: "2026-11-30T12:00:00Z",
      valueLow: 40000,
      valueHigh: 60000,
      regionText: "Yorkshire and The Humber",
      isSubNotice: false,
    },
  };

  it("maps an open notice to a tender with a public link", () => {
    expect(toTender(hit)).toMatchObject({
      title: "Website redesign & hosting",
      buyer: "Leeds City Council",
      url: "https://www.contractsfinder.service.gov.uk/notice/abc",
      deadline: "2026-11-30",
      region: "Yorkshire and The Humber",
    });
    expect(toTender({ item: { ...hit.item, isSubNotice: true } })).toBeNull();
    expect(toTender({ item: { ...hit.item, noticeStatus: "Closed" } })).toBeNull();
  });

  it("puts the facts before the description for the AI", () => {
    expect(tenderSourceText(toTender(hit)!)).toContain("Deadline for bids: 2026-11-30\nValue: £40,000 to £60,000");
  });
});

describe("found signals", () => {
  const analysis: SignalAnalysis = {
    isSignal: true,
    signalType: "rfp_tender",
    intentLevel: "explicit",
    urgency: "high",
    serviceCategories: ["web_development"],
    summary: "Leeds City Council is buying a new website.",
    excerpt: "The council requires a new accessible website.",
    evidenceLabel: "observed",
    confidence: 92,
    occurredOn: null,
    model: "test",
  };

  it("records a confident analysis, keeping the quote only if it's in the source's words", () => {
    const base = { url: "https://example.gov.uk/n/1", occurredOn: "2026-10-20" };
    expect(signalFromAnalysis(analysis, { ...base, evidenceText: "The council requires a new accessible website." })).toMatchObject({
      excerpt: "The council requires a new accessible website.",
      evidenceLabel: "observed",
      source: "ai",
    });
    expect(signalFromAnalysis(analysis, { ...base, evidenceText: "Something else" })).toMatchObject({ excerpt: null, evidenceLabel: "inferred" });
    expect(signalFromAnalysis({ ...analysis, confidence: 30 }, { ...base, evidenceText: "" })).toBeNull();
  });

  it("marks a company formed this year as a new startup, from the register", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    expect(formationSignal({ name: "Acme Ltd", foundedOn: "2026-08-12", registerUrl: "https://x/company/1" }, ["mvp_development"], now)).toMatchObject({
      signalType: "new_startup",
      source: "provider",
      evidenceLabel: "observed",
      occurredOn: "2026-08-12",
      summary: "Acme Ltd was registered at Companies House on 12 August 2026: a new business that may need help to get started.",
    });
    expect(formationSignal({ name: "Old Ltd", foundedOn: "2019-01-01", registerUrl: null }, [], now)).toBeNull();
  });
});
