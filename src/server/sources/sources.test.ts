import { describe, expect, it } from "vitest";
import { boardFromUrl, boardsFromIndexPage, cleanBoardName, hiringEmails, jobInCountries, nameFromBoardTitle, siteOf, sitesInJobPosts, workableProfile } from "./board-directory";
import { finalizeFacts } from "@/server/ai/website-extract";
import { formationSignal, newLocationSignal, signalFromAnalysis } from "@/server/ingestion/found-signal";
import type { SignalAnalysis } from "@/lib/api/types";
import { industryForSicCodes } from "@/lib/domain/uk-codes";
import { pickCompanyNumber, toFoundCompany, toFoundPeople } from "./companies-house";
import { deflateRawSync } from "node:zlib";
import { csvFromZip, parseDirectory, providersFor, providerWebsite, toFoundCompany as toCqcCompany, toLocationDetail } from "./cqc";
import {
  emailFromPattern,
  emailPatternOf,
  inferEmailPattern,
  jobFunctionFromTitle,
  personNameFromRegister,
  seniorityFromTitle,
  titleCaseCompanyName,
} from "./names";
import { isAllowed, parseRobots } from "./http";
import { fitsIndustry, parseSearch, toFoundCompany as toNpiCompany, toLocation as toNpiLocation, toPeople as toNpiPeople, usPhone } from "./nppes";
import { npiSteps } from "@/server/ingestion/handlers";
import { distinctiveWords, MIN_NAME_AGREEMENT, nameAgreement, osmiumFilters, placeFromFeature, proposeMatches, type MatchPlace, type MatchSite } from "./osm";
import { tenderSourceText, toTender, toTenderContact } from "./uk-tenders";
import {
  bookingEvidence,
  frameSources,
  isMobileFriendly,
  takesAppointments,
  candidateDomains,
  generatorOf,
  parseJsonLd,
  sitemapLinks,
  structuredFacts,
  websiteFindings,
  type SiteChecks,
  emailsFrom,
  usableEmails,
  extractLinks,
  jobBoardFromHtml,
  phonesFrom,
  pickPages,
  websiteMatchConfidence,
  isParkedPage,
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

  it("accepts the name with the registered-office postcode, and rejects a site registered to someone else", () => {
    const company = { name: "Worthy Care Services Ltd", companyNumber: "17053601", city: "Leeds", postcode: "LS14 6SX" };
    expect(websiteMatchConfidence("Worthy Care Services, 3 Kentmere Ave, Leeds LS146SX", company)).toBe(85);
    // Same name, another business: "Company No. 09876543" is not ours.
    expect(websiteMatchConfidence("Worthy Care Services Ltd, Leeds. Company No. 09876543", company)).toBe(0);
    // A namesake elsewhere (the Fife holiday park called Largo Law): no postcode, no town, not enough.
    expect(websiteMatchConfidence("Largo Law | Caravans, Glamping & Holiday Houses in Fife KY8 5QG", { name: "Largo Law Limited", companyNumber: "SC880256", city: "Leven", postcode: "KY8 4NB" })).toBe(40);
  });

  it("recognises parked and for-sale domains", () => {
    expect(isParkedPage(`<html><head><script>window.onload=function(){window.location.href="/lander"}</script></head></html>`)).toBe(true);
    expect(isParkedPage("<h1>This domain is for sale!</h1><p>Make an offer.</p>")).toBe(true);
    expect(isParkedPage(`<script src="https://www.sedoparking.com/js.js"></script>`)).toBe(true);
    expect(isParkedPage("<h1>Worthy Care Services</h1><p>We offer the very best in care services.</p>")).toBe(false);
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

  it("finds a linked Workable board, but not a bare job link or Workable's own pages", () => {
    expect(jobBoardFromHtml(`<a href="https://apply.workable.com/Brightway-Dental/">Careers</a>`)).toEqual({ provider: "workable", boardToken: "brightway-dental" });
    expect(jobBoardFromHtml(`<a href="https://brightway.workable.com/">Careers</a>`)).toEqual({ provider: "workable", boardToken: "brightway" });
    expect(jobBoardFromHtml(`<a href="https://apply.workable.com/j/BA193E747D">Apply</a>`)).toBeNull();
    expect(jobBoardFromHtml(`<a href="https://www.workable.com/">Powered by Workable</a>`)).toBeNull();
  });

  it("reads the company's own email and UK phone", () => {
    const html = `<a href="mailto:hello@brightsmile.co.uk">Email</a> partner@gmail.com logo@2x.png
      <a href="tel:+44 113 496 0000">Call</a>`;
    expect(emailsFrom(html, "brightsmile.co.uk")).toEqual(["hello@brightsmile.co.uk"]);
    expect(phonesFrom(html)).toEqual(["+441134960000"]);
    expect(phonesFrom("<p>Call us on 0113 496 0000 today</p>")).toEqual(["01134960000"]);
  });

  it("keeps only addresses that belong to the business, shared inboxes first", () => {
    // Own domain: a named person's address comes after info@.
    expect(usableEmails(["anil.gupta@dmchealthcare.co.uk", "info@dmchealthcare.co.uk"], "dmchealthcare.co.uk")).toEqual([
      "info@dmchealthcare.co.uk",
      "anil.gupta@dmchealthcare.co.uk",
    ]);
    // No address on its own domain: one naming the business is kept, the web designer's isn't.
    expect(usableEmails(["kensingtondentists@gmail.com", "by.blossom@yahoo.com"], "kensington-dentist.com")).toEqual(["kensingtondentists@gmail.com"]);
    expect(usableEmails(["hannah_m_smith@hotmail.com"], "hannahhealthvisitor.org")).toEqual(["hannah_m_smith@hotmail.com"]);
    // NHS-issued mail is the practice's own.
    expect(usableEmails(["ccf-tr.info.clinic@nhs.net"], "clatterbridgeprivate.co.uk")).toEqual(["ccf-tr.info.clinic@nhs.net"]);
    // Template leftovers are never contacts.
    expect(usableEmails(["changeme@client-domain.co.uk"], "theroxtonpractice.nhs.uk")).toEqual([]);
    expect(usableEmails(["email@domain.com", "you@yourdomain.co.uk", "info@acme.co.uk"], "acme.co.uk")).toEqual(["info@acme.co.uk"]);
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

  it("records a recent registration as the register states it, tagged only with what a new business plausibly needs", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const sold = ["web_development", "seo", "mvp_development", "staff_augmentation", "qa_testing"];
    expect(formationSignal({ name: "Acme Ltd", foundedOn: "2026-08-12", registerUrl: "https://x/company/1", industry: "accounting" }, sold, now)).toEqual({
      signalType: "company_formation",
      intentLevel: "low",
      urgency: "unknown",
      // A website and search visibility; not staff augmentation or QA for a firm with no product.
      serviceCategories: ["web_development", "seo"],
      // Only the fact: no guess that it "may need help".
      summary: "Acme Ltd was registered at Companies House on 12 August 2026.",
      personId: null,
      occurredOn: "2026-08-12",
      sourceUrl: "https://x/company/1",
      excerpt: null,
      evidenceLabel: "observed",
      source: "provider",
      confidence: null,
    });
    // A software business may also need software built.
    expect(formationSignal({ name: "Byte Ltd", foundedOn: "2026-08-12", registerUrl: null, industry: "saas" }, sold, now)?.serviceCategories).toEqual(["web_development", "seo", "mvp_development"]);
    // Nothing a new business needs is sold: nothing to record.
    expect(formationSignal({ name: "Acme Ltd", foundedOn: "2026-08-12", registerUrl: null }, ["staff_augmentation"], now)).toBeNull();
    expect(formationSignal({ name: "Old Ltd", foundedOn: "2019-01-01", registerUrl: null }, sold, now)).toBeNull();
  });
});

describe("CQC directory", () => {
  // Real rows from the weekly directory (28 October 2026), trimmed; the file opens with notes.
  const csv = [
    "CQC Locations data,,,,,,,,,,,,,,",
    ",,,,,,,,,,,,,,",
    "This data was produced on 28 October 2026,,,,,,,,,,,,,,",
    ",,,,,,,,,,,,,,",
    "Name,Also known as,Address,Postcode,Phone number,Service's website (if available),Service types,Date of latest check,Specialisms/services,Provider name,Local authority,Region,Location URL,CQC Location ID (for office use only),CQC Provider ID (for office use only)",
    "JA Medical,,\"Room 28, Orpington Health & Wellbeing Centre,19 Homefield Rise,Orpington\",BR6 0FE,2084681086,https://www.ja-medical.co.uk,Doctors/GPs|Doctors/GPs,28/Mar/2023 - 00:00,Services for everyone,JA Medical Services Southeast Ltd,Bromley,London,https://www.cqc.org.uk/location/1-10564403595,1-10564403595,1-1624297480",
    "Cosmopolitan Medical Clinic,,\"80 King Street,Maidstone\",ME14 1BH,1622296440,https://www.cosmopolitanmedicalclinic.co.uk,Doctors/GPs|Doctors/GPs,02/May/2018 - 00:00,Services for everyone,JA Medical Services Southeast Ltd,Kent,South East,https://www.cqc.org.uk/location/1-10565266257,1-10565266257,1-1624297480",
    "Dentalcare Swindon,,\"16 Moredon Road,Swindon\",SN25 3DQ,1793611298,https://www.dentalcareswindon.co.uk,Dentist,12/Nov/2014 - 00:00,Services for everyone,Dentalcare Swindon Ltd,Swindon,South West,https://www.cqc.org.uk/location/1-10570276506,1-10570276506,1-9856009077",
    "Gateway House,,\"149-151 Laughton Road,Dinnington,Sheffield\",S25 2PP,7423434381,https://cristalcare.co.uk,Residential homes,21/Jun/2022 - 00:00,Learning disabilities,Cristal Care Limited,Rotherham,Yorkshire & Humberside,https://www.cqc.org.uk/location/1-10570704049,1-10570704049,1-101620012",
    "",
  ].join("\n");

  it("reads every location, restoring phone numbers' leading zero", () => {
    const locations = parseDirectory(csv);
    expect(locations).toHaveLength(4);
    expect(locations[2]).toMatchObject({
      name: "Dentalcare Swindon",
      postcode: "SN25 3DQ",
      phone: "01793611298",
      website: "dentalcareswindon.co.uk",
      serviceTypes: ["Dentist"],
      providerId: "1-9856009077",
      locationId: "1-10570276506",
    });
  });

  it("reads the directory out of its zip", () => {
    // A minimal one-file zip, laid out as the CQC download is: local header, data, central directory.
    const name = Buffer.from("28_October_2026_CQC_directory.csv");
    const data = deflateRawSync(Buffer.from(csv));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const centralAt = local.length + name.length + data.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(centralAt, 16);
    const zip = Buffer.concat([local, name, data, central, name, end]);
    expect(parseDirectory(csvFromZip(zip))).toHaveLength(4);
  });

  it("rejects a file whose columns changed instead of misreading it", () => {
    expect(() => parseDirectory("Name,Something else\nx,y")).toThrow();
  });

  it("groups locations by provider, for the ICP's industries only", () => {
    const locations = parseDirectory(csv);
    expect(providersFor(locations, ["dental"]).map((p) => p.providerName)).toEqual(["Dentalcare Swindon Ltd"]);
    const gp = providersFor(locations, ["healthcare"]);
    expect(gp).toHaveLength(1);
    expect(gp[0].locations.map((l) => l.name)).toEqual(["JA Medical", "Cosmopolitan Medical Clinic"]);
  });

  it("gives a provider a website only when all its practices list the same one", () => {
    const [many] = providersFor(parseDirectory(csv), ["healthcare"]);
    expect(toCqcCompany(many, ["healthcare"], null)).toMatchObject({
      name: "JA Medical Services Southeast Ltd",
      domain: null,
      industry: "healthcare",
      identity: "verified",
      identifiers: [{ scheme: "gb_cqc_provider", value: "1-1624297480" }],
    });
    const [single] = providersFor(parseDirectory(csv), ["dental"]);
    expect(toCqcCompany(single, ["dental"], "09291004")).toMatchObject({
      domain: "dentalcareswindon.co.uk",
      identifiers: [
        { scheme: "gb_cqc_provider", value: "1-9856009077" },
        { scheme: "gb_company_number", value: "09291004" },
      ],
    });
  });

  it("reads registered managers and the registration date from the API", () => {
    const detail = toLocationDetail(
      {
        registrationDate: "2026-06-01",
        regulatedActivities: [
          { contacts: [{ personGivenName: "Asif", personFamilyName: "Ali", personRoles: ["Registered Manager"] }] },
          { contacts: [{ personGivenName: "Asif", personFamilyName: "Ali", personRoles: ["Registered Manager"] }, { personGivenName: "Nominated", personFamilyName: "Person", personRoles: ["Nominated Individual"] }] },
        ],
      },
      "Dentalcare Swindon",
    );
    expect(detail).toEqual({
      registeredOn: "2026-06-01",
      managers: [{ name: "Asif Ali", title: "Registered manager, Dentalcare Swindon", seniority: "manager", jobFunction: "operations", relationship: "employee", confidence: 90 }],
    });
  });

  it("marks a newly registered location, but not an old one", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const base = { providerName: "Dentalcare Swindon Ltd", name: "Dentalcare Swindon", url: "https://www.cqc.org.uk/location/1" };
    expect(newLocationSignal({ ...base, registeredOn: "2026-06-01" }, ["web_development"], now)).toMatchObject({
      signalType: "new_location",
      source: "provider",
      confidence: 95,
      occurredOn: "2026-06-01",
    });
    expect(newLocationSignal({ ...base, registeredOn: "2014-11-12" }, [], now)).toBeNull();
    expect(newLocationSignal({ ...base, registeredOn: null }, [], now)).toBeNull();
  });

  it("dates a new practice of a followed provider by when it first appeared, without the API", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const signal = newLocationSignal(
      { providerName: "Rodericks Dental Partners Limited", name: "Banbury Dental", registeredOn: null, firstListedOn: "2026-11-03", url: null },
      ["web_development"],
      now,
    );
    expect(signal).toMatchObject({ signalType: "new_location", occurredOn: "2026-11-03", confidence: 85, evidenceLabel: "observed" });
    expect(signal?.summary).toContain("first appeared on the CQC register on 3 November 2026");
  });

  it("gives a chain the website most of its practices list", () => {
    const many = (site: string, n: number) => Array.from({ length: n }, () => site);
    expect(providerWebsite([...many("rodericksdental.co.uk", 5), "banburydental.co.uk", "leysdental.co.uk", null, null])).toBe("rodericksdental.co.uk");
    expect(providerWebsite(["acme.co.uk", null, "acme.co.uk"])).toBe("acme.co.uk");
    // Each practice its own site, or a tie: no provider website.
    expect(providerWebsite(["a-surgery.nhs.uk", "b-surgery.nhs.uk"])).toBeNull();
    expect(providerWebsite([...many("one.co.uk", 2), ...many("two.co.uk", 2)])).toBeNull();
    expect(providerWebsite([null])).toBeNull();
  });
});

describe("Companies House number lookup", () => {
  const item = (title: string, number: string, postcode: string, status = "active") => ({
    title,
    company_number: number,
    company_status: status,
    address: { postal_code: postcode },
  });

  it("links only a single exact, active name at one of the postcodes", () => {
    expect(pickCompanyNumber([item("DENTALCARE SWINDON LTD", "1", "SN25 3DQ")], "Dentalcare Swindon Ltd", ["sn253dq"])).toBe("1");
    // Same name, different postcode: not enough.
    expect(pickCompanyNumber([item("DENTALCARE SWINDON LTD", "1", "M1 1AA")], "Dentalcare Swindon Ltd", ["SN25 3DQ"])).toBeNull();
    // Two exact matches: ambiguous.
    expect(pickCompanyNumber([item("DENTALCARE SWINDON LTD", "1", "SN25 3DQ"), item("Dentalcare Swindon Limited", "2", "SN25 3DQ")], "Dentalcare Swindon Ltd", ["SN25 3DQ"])).toBeNull();
    // Dissolved companies don't count.
    expect(pickCompanyNumber([item("DENTALCARE SWINDON LTD", "1", "SN25 3DQ", "dissolved")], "Dentalcare Swindon Ltd", ["SN25 3DQ"])).toBeNull();
  });
});

describe("website checks (no AI)", () => {
  const checks = (overrides: Partial<SiteChecks> = {}): SiteChecks => ({
    homeUrl: "https://smiles.example/",
    secure: true,
    generator: null,
    booking: null,
    pagesChecked: ["https://smiles.example/", "https://smiles.example/contact", "https://smiles.example/about"],
    ...overrides,
  });

  it("reads the CMS and booking evidence from the page itself", () => {
    expect(generatorOf('<meta name="generator" content="WordPress 5.8.3" />')).toBe("WordPress 5.8.3");
    expect(bookingEvidence('<a href="https://portal.dentally.co/book">Book now</a>')).toMatch(/^dental booking system/);
    expect(bookingEvidence("<a href='/appointments'>Book an appointment</a>")).toBe("booking link: Book an appointment");
    expect(bookingEvidence("<p>Call us to book</p>")).toBeNull();
  });

  it("recognises the booking systems and links real practices use", () => {
    // Pearl portal (Dental Harmony) and Software of Excellence (The Dental Implant Clinic).
    expect(bookingEvidence('<a href="http://www.pearlportal.net/login/DHLN">Patient portal</a>')).toMatch(/^dental booking system/);
    expect(bookingEvidence('<a class="btn" href="https://booking.uk.hsone.app/soe/new/?pid=UKJSC02"><span>Book</span></a>')).toMatch(/^dental booking system/);
    // Words split across nested tags, and a link known only by its address.
    expect(bookingEvidence('<a href="/x"><span>Book</span> <b>online</b></a>')).toBe("booking link: Book online");
    expect(bookingEvidence('<a href="/book-appointment"><img src="cal.png"></a>')).toBe("booking link: /book-appointment");
    // An appointment request form (Kensington Dentist).
    expect(bookingEvidence('<h2>Request an Appointment</h2><form action="send.php"><input name="name"><input name="phone"></form>')).toMatch(/^appointment request form/);
    expect(bookingEvidence('<form><input name="email"><button>Subscribe</button></form>')).toBeNull();
  });

  it("calls a frames or non-mobile site outdated, and reads its frames", () => {
    expect(frameSources('<frameset><frame src="top.htm"><frame src="home.htm"></frameset>', "https://ledbury.example/")).toEqual([
      "https://ledbury.example/top.htm",
      "https://ledbury.example/home.htm",
    ]);
    expect(frameSources("<html><body>Hi</body></html>", "https://x.example/")).toEqual([]);
    expect(isMobileFriendly('<meta name="viewport" content="width=device-width">')).toBe(true);
    const framed = websiteFindings("Ledbury Ltd", checks({ frameset: true, booking: { url: "x", evidence: "booking link" } }), "dental");
    expect(framed.map((f) => f.signalType)).toEqual(["outdated_website"]);
    expect(framed[0].summary).toMatch(/HTML frames/);
    expect(websiteFindings("Old Ltd", checks({ mobileFriendly: false, booking: { url: "x", evidence: "b" } }), "dental")[0].summary).toMatch(/no mobile layout/);
  });

  it("claims no online booking only for appointment businesses, after enough of the site was read", () => {
    const noBooking = (overrides: Partial<SiteChecks>, industry = "dental") =>
      websiteFindings("Smiles Ltd", checks(overrides), industry).some((f) => f.signalType === "no_online_booking");
    expect(noBooking({})).toBe(true);
    expect(noBooking({ pagesChecked: ["https://smiles.example/"] })).toBe(false);
    expect(noBooking({ takesAppointments: false }, "healthcare")).toBe(false);
    expect(takesAppointments("Book a check-up with our hygienist. Appointments at our practice for every treatment.")).toBe(true);
    expect(takesAppointments("Home care and live-in care. Our carers and care workers support you at home. Book a consultation.")).toBe(false);
  });

  it("flags possible problems with their evidence, without calling them buying intent", () => {
    const found = websiteFindings("Smiles Ltd", checks({ secure: false, generator: "WordPress 5.8.3" }), "dental");
    expect(found.map((f) => [f.signalType, f.evidenceLabel, f.confidence])).toEqual([
      ["insecure_website", "observed", 90],
      ["outdated_website", "observed", 85],
      ["no_online_booking", "derived", 60],
    ]);
    expect(found[1].excerpt).toBe('<meta name="generator" content="WordPress 5.8.3">');
    expect(found.every((f) => f.summary.startsWith("Possible problem:"))).toBe(true);
  });

  it("stays quiet about a current site that takes bookings, and about booking outside booking industries", () => {
    expect(websiteFindings("Smiles Ltd", checks({ generator: "WordPress 6.6.2", booking: { url: "x", evidence: "booking link" } }), "dental")).toEqual([]);
    expect(websiteFindings("Ledger Ltd", checks(), "accounting")).toEqual([]);
  });

  it("reads the company's own structured data and sitemap", () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"Dentist","telephone":"0113 496 0000","email":"mailto:Hello@Smiles.example","numberOfEmployees":{"@type":"QuantitativeValue","value":24},
       "founder":{"@type":"Person","name":"Sophie Clarke","jobTitle":"Principal Dentist"}},
      {"@type":"Person","name":"Priya Shah","jobTitle":"Practice Manager"},
      {"@type":"Person","name":"Solo"}]}</script><script type="application/ld+json">{broken</script>`;
    expect(structuredFacts(parseJsonLd(html))).toEqual({
      telephone: "0113 496 0000",
      email: "hello@smiles.example",
      employees: 24,
      people: [
        { name: "Sophie Clarke", title: "Principal Dentist" },
        { name: "Priya Shah", title: "Practice Manager" },
      ],
    });
    expect(sitemapLinks("<urlset><url><loc> https://smiles.example/meet-the-team </loc></url></urlset>")).toEqual([{ url: "https://smiles.example/meet-the-team", text: "" }]);
  });
});

describe("email patterns", () => {
  it("recognises a person's published address, but not a shared mailbox", () => {
    expect(emailPatternOf("sarah.jones@acme.example", "Sarah Jones")).toBe("first.last");
    expect(emailPatternOf("sjones@acme.example", "Dr Sarah Jones")).toBe("flast");
    expect(emailPatternOf("info@acme.example", "Sarah Jones")).toBeNull();
  });

  it("infers a pattern only from two or more agreeing published examples", () => {
    expect(inferEmailPattern([{ pattern: "first.last", name: "Sarah Jones" }])).toBeNull();
    expect(inferEmailPattern([{ pattern: "first.last", name: "Sarah Jones" }, { pattern: "first.last", name: "sarah jones" }])).toBeNull(); // same person twice
    expect(inferEmailPattern([{ pattern: "first.last", name: "Sarah Jones" }, { pattern: "flast", name: "Tom Lee" }])).toBeNull(); // they disagree
    expect(inferEmailPattern([{ pattern: "first.last", name: "Sarah Jones" }, { pattern: "first.last", name: "Tom Lee" }])).toBe("first.last");
    expect(emailFromPattern("first.last", "Priya Shah", "acme.example")).toBe("priya.shah@acme.example");
  });
});

describe("job-board discovery", () => {
  it("takes the board name from an archived board URL, and rejects provider pages and junk", () => {
    expect(boardFromUrl("https://job-boards.greenhouse.io/0x/jobs/7302322002")).toEqual({ provider: "greenhouse", boardToken: "0x" });
    expect(boardFromUrl("https://boards.greenhouse.io/embed/job_board?for=AcmeCo")).toEqual({ provider: "greenhouse", boardToken: "acmeco" });
    expect(boardFromUrl("https://jobs.lever.co/leverdemo/ad208490")).toEqual({ provider: "lever", boardToken: "leverdemo" });
    expect(boardFromUrl("https://jobs.ashbyhq.com/ashby")).toEqual({ provider: "ashby", boardToken: "ashby" });
    // Not company boards.
    expect(boardFromUrl("https://job-boards.greenhouse.io/")).toBeNull();
    expect(boardFromUrl("https://boards.greenhouse.io/103644278")).toBeNull();
    expect(boardFromUrl("https://jobs.lever.co/api/v1")).toBeNull();
    expect(boardFromUrl("https://boards.greenhouse.io/1pyra)mid_health&care")).toBeNull();
    expect(boardFromUrl("https://example.com/careers")).toBeNull();
  });

  it("finds Workable boards, including legacy subdomains, but not Workable's own pages", () => {
    expect(boardFromUrl("https://apply.workable.com/Blueground/")).toEqual({ provider: "workable", boardToken: "blueground" });
    expect(boardFromUrl("https://apply.workable.com/kaizen-gaming/j/BA193E747D/")).toEqual({ provider: "workable", boardToken: "kaizen-gaming" });
    expect(boardFromUrl("https://skroutz.workable.com/jobs/123")).toEqual({ provider: "workable", boardToken: "skroutz" });
    // A job link with no account, Workable's own sites and pages.
    expect(boardFromUrl("https://apply.workable.com/j/BA193E747D")).toBeNull();
    expect(boardFromUrl("https://apply.workable.com/oops")).toBeNull();
    expect(boardFromUrl("https://www.workable.com/pricing")).toBeNull();
    expect(boardFromUrl("https://help.workable.com/hc/en-us")).toBeNull();
  });

  it("finds SmartRecruiters, Personio and Breezy boards, but not the providers' own pages", () => {
    expect(boardFromUrl("https://jobs.smartrecruiters.com/Ubisoft2/744000159658729-cg-supervisor")).toEqual({ provider: "smartrecruiters", boardToken: "ubisoft2" });
    expect(boardFromUrl("https://acme-gmbh.jobs.personio.de/job/1676226")).toEqual({ provider: "personio", boardToken: "acme-gmbh" });
    expect(boardFromUrl("https://acme.jobs.personio.com/")).toEqual({ provider: "personio", boardToken: "acme" });
    expect(boardFromUrl("https://brightway.breezy.hr/p/98323abf2296-qa")).toEqual({ provider: "breezy", boardToken: "brightway" });
    expect(boardFromUrl("https://www.breezy.hr/pricing")).toBeNull();
    expect(boardFromUrl("https://app.breezy.hr/signin")).toBeNull();
    expect(jobBoardFromHtml(`<a href="https://Brightway.breezy.hr/">Careers</a>`)).toEqual({ provider: "breezy", boardToken: "brightway" });
    expect(jobBoardFromHtml(`<a href="https://careers.smartrecruiters.com/Ubisoft2">Jobs</a>`)).toEqual({ provider: "smartrecruiters", boardToken: "Ubisoft2" });
    expect(jobBoardFromHtml(`<a href="https://acme.jobs.personio.de/">Jobs</a>`)).toEqual({ provider: "personio", boardToken: "acme" });
  });

  it("reads a Workable account's name and own website", () => {
    expect(workableProfile({ name: "Blueground Careers", url: "https://www.theblueground.com/" })).toEqual({ name: "Blueground", website: "theblueground.com" });
    expect(workableProfile({ name: "HelloFresh", url: "http://www.hellofresh.com" })).toEqual({ name: "HelloFresh", website: "hellofresh.com" });
    // Not the company's own site.
    expect(workableProfile({ name: "Acme", url: "https://www.linkedin.com/company/acme" }).website).toBeNull();
    expect(workableProfile({ name: "Acme", url: "https://acme.workable.com" }).website).toBeNull();
    expect(workableProfile({})).toEqual({ name: null, website: null });
  });

  it("reads candidate boards from archive index lines, once each", () => {
    const page = [
      '{"url": "https://job-boards.greenhouse.io/0x/jobs/1"}',
      '{"url": "https://job-boards.greenhouse.io/0x/jobs/2"}',
      '{"url": "https://job-boards.greenhouse.io/"}',
      '{"url": "https://job-boards.greenhouse.io/acme?error=true"}',
      '{"url": "https://job-boards.gre', // cut off by a timeout
    ].join("\n");
    expect(boardsFromIndexPage(page).map((b) => b.boardToken)).toEqual(["0x", "acme"]);
  });

  it("names a company from its board page title", () => {
    expect(nameFromBoardTitle("Jobs at Acme Health")).toBe("Acme Health");
    expect(nameFromBoardTitle("Acme Health - Careers")).toBe("Acme Health");
    expect(nameFromBoardTitle("Acme Health | Lever")).toBe("Acme Health");
    expect(nameFromBoardTitle("Jobs")).toBeNull();
  });

  it("cleans board names down to the company's", () => {
    expect(cleanBoardName("TPG Careers Page")).toBe("TPG");
    expect(cleanBoardName("Acme Jobs")).toBe("Acme");
    expect(cleanBoardName("Careers at Acme Health")).toBe("Acme Health");
    expect(cleanBoardName("TraceLink, Inc")).toBe("TraceLink, Inc");
    expect(cleanBoardName("Jobber")).toBe("Jobber");
    expect(cleanBoardName("Acme Recruiting")).toBe("Acme Recruiting");
    expect(cleanBoardName("Careers")).toBeNull();
    expect(cleanBoardName(null)).toBeNull();
  });

  it("keeps jobs in the workspace's countries, and remote roles open worldwide", () => {
    expect(jobInCountries("London, United Kingdom", ["GB"])).toBe(true);
    expect(jobInCountries("Manchester", ["GB"])).toBe(true);
    expect(jobInCountries("Remote", ["GB"])).toBe(true);
    expect(jobInCountries("Remote - US", ["GB"])).toBe(false);
    expect(jobInCountries("Austin, US", ["GB"])).toBe(false);
    expect(jobInCountries("Dublin, Ireland", ["GB", "IE"])).toBe(true);
    expect(jobInCountries("Anywhere", [])).toBe(true);
  });
});

describe("OpenStreetMap", () => {
  const feature = (tags: Record<string, unknown>, geometry: { type: string; coordinates: unknown } = { type: "Point", coordinates: [-1.55, 53.8] }) => ({
    type: "Feature",
    properties: { "@type": "node", "@id": 42, "@version": 3, ...tags },
    geometry,
  });

  it("keeps a named business in our categories with a usable contact", () => {
    expect(
      placeFromFeature(
        feature({
          name: "Smiles Dental Leeds",
          amenity: "dentist",
          "contact:phone": "+44 113 496 0000;0113 496 0001",
          website: "smilesleeds.example",
          email: "info@smilesleeds.example",
          "addr:postcode": "ls1 4ap",
          "ref:GB:cqc_location": "1-123456789",
        }),
      ),
    ).toMatchObject({
      osmType: "node",
      osmId: 42,
      version: 3,
      name: "Smiles Dental Leeds",
      category: "amenity=dentist",
      postcode: "LS14AP",
      phone: "+441134960000",
      website: "https://smilesleeds.example/",
      email: "info@smilesleeds.example",
      cqcLocationRef: "1-123456789",
      lat: 53.8,
      lon: -1.55,
    });
  });

  it("places a mapped building at the centre of its outline", () => {
    const outline = { type: "Polygon", coordinates: [[[-1, 53], [-1, 54], [-2, 54], [-2, 53], [-1, 53]]] };
    const way = feature({ "@type": "way", "@id": 7, name: "Acme Accountants", office: "accountant", phone: "0113 496 0000" }, outline);
    expect(placeFromFeature(way)).toMatchObject({ osmType: "way", osmId: 7, lat: 53.5, lon: -1.5 });
  });

  it("skips what we can't use: no name, another kind of place, no contact, or only a placeholder email", () => {
    expect(placeFromFeature(feature({ amenity: "dentist", phone: "0113 496 0000" }))).toBeNull();
    expect(placeFromFeature(feature({ name: "The Crown", amenity: "pub", phone: "0113 496 0000" }))).toBeNull();
    expect(placeFromFeature(feature({ name: "Smiles", amenity: "dentist" }))).toBeNull();
    expect(placeFromFeature(feature({ name: "Smiles", amenity: "dentist", email: "changeme@client-domain.co.uk", phone: "12" }))).toBeNull();
    expect(placeFromFeature({ properties: { name: "No id", amenity: "dentist", phone: "0113 496 0000" } })).toBeNull();
  });

  it("filters the extract to exactly the categories it matches", () => {
    const filters = osmiumFilters();
    expect(filters).toContain("nwr/office=accountant,tax_advisor,lawyer,notary,estate_agent,financial_advisor,financial,insurance,it,employment_agency,consulting,architect,advertising_agency");
    expect(filters.find((f) => f.startsWith("nwr/amenity="))).toContain("dentist");
  });

  it("compares names on the words that identify a business", () => {
    expect(distinctiveWords("Smiles Dental Leeds Ltd")).toEqual(["smiles", "leeds"]);
    expect(nameAgreement("Smiles Leeds", "Smiles Dental Leeds")).toBe(1);
    expect(nameAgreement("The Dental Practice", "The Dental Practice")).toBe(0); // only common words
    expect(nameAgreement("Smiles Leeds", "Leeds Dental Spa")).toBeLessThan(MIN_NAME_AGREEMENT);
  });

  describe("matching", () => {
    const site = (over: Partial<MatchSite> = {}): MatchSite => ({
      companyId: "c1",
      locationId: "l1",
      name: "Smiles Leeds",
      companyName: "Smiles Group Ltd",
      industry: "dental",
      postcode: "LS14AP",
      domain: null,
      cqcLocationId: null,
      ...over,
    });
    const place = (over: Partial<MatchPlace> = {}): MatchPlace => ({
      osmType: "node",
      osmId: 1,
      name: "Smiles Dental Leeds",
      brand: null,
      operator: null,
      category: "amenity=dentist",
      postcode: "LS14AP",
      website: null,
      cqcLocationRef: null,
      ...over,
    });

    it("links a practice by the CQC location id the place carries, whatever its name", () => {
      expect(proposeMatches([site({ cqcLocationId: "1-1", postcode: null })], [place({ cqcLocationRef: "1-1", name: "Something else", postcode: null })])).toEqual([
        { companyId: "c1", locationId: "l1", osmType: "node", osmId: 1, method: "cqc_ref", confidence: 95 },
      ]);
    });

    it("links by postcode and name only when exactly one place fits, more surely when the website agrees", () => {
      expect(proposeMatches([site()], [place()])).toMatchObject([{ method: "postcode_name", confidence: 75 }]);
      expect(proposeMatches([site({ domain: "smilesleeds.example" })], [place({ website: "https://www.smilesleeds.example/" })])).toMatchObject([{ method: "website", confidence: 90 }]);
      // Two practices that could both be it: no link.
      expect(proposeMatches([site()], [place(), place({ osmId: 2, name: "Smiles Leeds Centre" })])).toEqual([]);
    });

    it("links nothing on a weak or doubtful match", () => {
      expect(proposeMatches([site()], [place({ category: "office=accountant" })])).toEqual([]); // not a dentist
      expect(proposeMatches([site({ industry: null })], [place()])).toEqual([]); // industry unknown
      expect(proposeMatches([site()], [place({ postcode: "LS27EE" })])).toEqual([]); // elsewhere
      expect(proposeMatches([site({ name: "The Dental Practice", companyName: "The Dental Practice Ltd" })], [place({ name: "The Dental Practice" })])).toEqual([]);
      // Two places carrying the same CQC id: ambiguous, and no fallback to the name.
      expect(proposeMatches([site({ cqcLocationId: "1-1" })], [place({ cqcLocationRef: "1-1" }), place({ osmId: 2, cqcLocationRef: "1-1" })])).toEqual([]);
    });

    it("gives a place to neither company when two could claim it", () => {
      expect(proposeMatches([site(), site({ companyId: "c2", locationId: "l2" })], [place()])).toEqual([]);
    });

    it("keeps a chain's practices apart, each with its own place", () => {
      const matches = proposeMatches(
        [site({ cqcLocationId: "1-a" }), site({ locationId: "l2", name: "Smiles York", postcode: "YO17HH" })],
        [place({ cqcLocationRef: "1-a" }), place({ osmId: 2, name: "Smiles York", postcode: "YO17HH" })],
      );
      expect(matches.map((m) => [m.locationId, m.osmId, m.method])).toEqual([
        ["l1", 1, "cqc_ref"],
        ["l2", 2, "postcode_name"],
      ]);
    });
  });
});

describe("US NPI Registry", () => {
  // A real registry result (trimmed), checked live in Nov 2026.
  const org = {
    number: "1154494250",
    enumeration_type: "NPI-2",
    basic: {
      organization_name: "360 DENTAL CARE P.A.",
      organizational_subpart: "NO",
      enumeration_date: "2006-11-16",
      status: "A",
      authorized_official_first_name: "MICHAEL",
      authorized_official_last_name: "NUSSBAUM",
      authorized_official_title_or_position: "President",
      authorized_official_telephone_number: "5123273631",
    },
    addresses: [
      { address_purpose: "MAILING", address_1: "PO BOX 1", city: "IRVINE", state: "CA", postal_code: "926120001", telephone_number: "949-555-0100" },
      { address_purpose: "LOCATION", address_1: "3660 STONERIDGE RD STE B101", city: "AUSTIN", state: "TX", postal_code: "787467759", telephone_number: "512-327-3631" },
    ],
    other_names: [{ code: "3", type: "Doing Business As", organization_name: "MICHAEL B. NUSSBAUM D.D.S." }],
    taxonomies: [{ code: "1223G0001X", desc: "Dentist, General Practice", primary: true }],
  };

  it("reads organizations, and throws on the registry's error replies", () => {
    expect(parseSearch({ result_count: 1, results: [org, { number: "1", enumeration_type: "NPI-1" }] }).map((o) => o.number)).toEqual(["1154494250"]);
    expect(() => parseSearch({ Errors: [{ description: "No taxonomy codes found" }] })).toThrow("No taxonomy codes found");
  });

  it("turns an organization into a company at its place of business, with its phone and authorized official", () => {
    const [parsed] = parseSearch({ results: [org] });
    expect(toNpiCompany(parsed, "dental")).toMatchObject({
      name: "360 Dental Care P.A.",
      industry: "dental",
      hq: { city: "Austin", region: "TX", country: "US", postalCode: "78746" },
      identifiers: [{ scheme: "us_npi", value: "1154494250" }],
      identity: "verified",
      foundedOn: "2006-11-16",
      record: { sourceSlug: "us_npi", externalId: "npi:1154494250", url: "https://npiregistry.cms.hhs.gov/provider-view/1154494250" },
    });
    expect(toNpiLocation(parsed)).toEqual({
      externalId: "1154494250",
      name: "360 Dental Care P.A.",
      address: "3660 Stoneridge Rd Ste B101",
      city: "Austin",
      region: "TX",
      postalCode: "78746",
      website: null,
      phone: "512-327-3631",
    });
    expect(toNpiPeople(parsed)).toEqual([
      { name: "Michael Nussbaum", title: "President", seniority: "c_level", jobFunction: null, relationship: "employee", confidence: 90, phone: "512-327-3631" },
    ]);
  });

  it("keeps only organizations whose main specialty is the industry", () => {
    const [parsed] = parseSearch({ results: [org] });
    expect(fitsIndustry(parsed, "dental")).toBe(true);
    expect(fitsIndustry(parsed, "healthcare")).toBe(false);
    expect(fitsIndustry({ ...parsed, taxonomies: [{ code: "208D00000X", desc: "General Practice", primary: true }] }, "dental")).toBe(false);
  });

  it("formats US phone numbers and rejects others", () => {
    expect(usPhone("5123273631")).toBe("512-327-3631");
    expect(usPhone("1 (512) 327-3631")).toBe("512-327-3631");
    expect(usPhone("0113 496 0000")).toBeNull();
    expect(usPhone(null)).toBeNull();
  });

  it("walks every state on page one before reading page two", () => {
    const steps = npiSteps(["dental"]);
    expect(steps[0]).toEqual({ industry: "dental", taxonomy: "Dentist", state: "CA", skip: 0 });
    expect(steps[1]).toEqual({ industry: "dental", taxonomy: "Dental", state: "CA", skip: 0 });
    expect(steps.length).toBe(2 * 51 * 6);
    expect(steps.find((s) => s.skip > 0)).toMatchObject({ state: "CA", skip: 200 });
    expect(npiSteps(["accounting"])).toEqual([]);
  });
});

describe("toTenderContact", () => {
  it("reads the buyer contact a notice publishes, dropping unusable values", () => {
    const raw = {
      notice: {
        contactDetails: { name: "Tom Outing", email: "T.Outing@northyorkmoors.org.uk", phone: "+44 7896056846", webAddress: "https://www.northyorkmoors.org.uk" },
      },
    };
    expect(toTenderContact(raw)).toEqual({ name: "Tom Outing", email: "t.outing@northyorkmoors.org.uk", phone: "+44 7896056846", website: "https://www.northyorkmoors.org.uk" });
    expect(toTenderContact({ notice: { contactDetails: { name: "Procurement", email: "n/a", phone: "", webAddress: "" } } })).toBeNull();
    expect(toTenderContact({ notice: {} })).toBeNull();
  });
});

describe("company site from its job posts", () => {
  const toast = [
    "Learn more at https://careers.toasttab.com/toast-benefits. Contact candidateaccommodations@toasttab.com. Apply on https://boards.greenhouse.io/toast",
    "See https://careers.toasttab.com/locations-toast and https://www.linkedin.com/company/toast",
    "Equal opportunity: https://www.eeoc.gov/poster",
  ];

  it("finds the employer's own site, not job boards, social or government", () => {
    expect(siteOf("careers.toasttab.com")).toBe("toasttab.com");
    expect(siteOf("jobs.acme.co.uk")).toBe("acme.co.uk");
    expect(sitesInJobPosts(toast)).toEqual([{ site: "toasttab.com", posts: 2 }]);
  });

  it("keeps hiring inboxes at that site, never accommodation or privacy addresses", () => {
    expect(hiringEmails(toast, "toasttab.com")).toEqual([]);
    const posts = ["Send your CV to Careers@Acme.co.uk or recruitment@jobs.acme.co.uk", "privacy@acme.co.uk, accommodations@acme.co.uk, careers@gmail.com, jobs@other.com"];
    expect(hiringEmails(posts, "acme.co.uk")).toEqual(["careers@acme.co.uk", "recruitment@jobs.acme.co.uk"]);
  });
});
