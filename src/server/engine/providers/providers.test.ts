import { describe, expect, it } from "vitest";
import { parseFreelancerProject } from "./freelancer";
import { parseHnHit } from "./hackernews";
import { parseAtom, parseRedditEntry } from "./reddit";
import { companyKey, countryOf, isVehicleName, parseFeed, parseFormD, withOpenRoles } from "./sec-form-d";
import { batchStart } from "./yc-batches";

const terms = ["mvp", "website", "redesign", "developer"];

describe("Freelancer.com", () => {
  const project = {
    id: 40811470, title: "Redesign our company website", seo_url: "website-design/Redesign-site", description: "We need a website redesign.", type: "fixed",
    time_submitted: 1794309384, currency: { code: "INR", exchange_rate: 0.01 }, budget: { minimum: 150000, maximum: 500000 },
    local: false, location: { country: { code: null } }, jobs: [{ name: "Web Design" }],
  };
  it("converts budget to USD with the project's own exchange rate", () => {
    const item = parseFreelancerProject(project)!;
    expect(item.budget).toEqual({ min: 150000, max: 500000, currency: "INR", usd: 5000 });
    expect(item.url).toBe("https://www.freelancer.com/projects/website-design/Redesign-site");
    expect(item.remote).toBe(true);
  });
  it("does not invent a client country or identity", () => {
    const item = parseFreelancerProject(project)!;
    expect(item.country).toBeNull();
    expect(item.buyerName).toBeNull();
  });
  it("treats hourly projects as having no comparable budget", () => {
    expect(parseFreelancerProject({ ...project, type: "hourly" })!.budget?.usd).toBeNull();
  });
  it("handles a project with no budget block", () => {
    expect(parseFreelancerProject({ ...project, budget: undefined })!.budget).toBeNull();
  });
});

describe("Hacker News", () => {
  const thread = "Ask HN: Freelancer? Seeking freelancer? (November 2026)";
  it("keeps a SEEKING FREELANCER comment that mentions a service", () => {
    const item = parseHnHit({ objectID: "1", author: "jane", created_at_i: 1794309384, story_title: thread, comment_text: "SEEKING FREELANCER | looking for a developer to build our MVP | remote" }, terms)!;
    expect(item.externalId).toBe("1");
    expect(item.url).toBe("https://news.ycombinator.com/item?id=1");
    expect(item.buyerName).toBe("jane");
    expect(item.country).toBeNull();
    expect(item.title).toMatch(/^SEEKING FREELANCER/);
    expect(item.title).not.toMatch(/November 2026/);
  });
  it("keeps an Ask HN post whose title states the request", () => {
    expect(parseHnHit({ objectID: "9", title: "Ask HN: Looking for an agency to redesign our website", story_text: "Details here" }, terms)).not.toBeNull();
  });
  it("drops freelancers advertising themselves and other threads (seen in live data)", () => {
    expect(parseHnHit({ objectID: "2", story_title: "Ask HN: Who wants to be hired? (November 2026)", comment_text: "Location: Sarajevo. Freelance developer, MVP builds." }, terms)).toBeNull();
    expect(parseHnHit({ objectID: "6", story_title: "Ask HN: Who is hiring? (November 2026)", comment_text: "Acme | Looking for a developer to build our website | Remote" }, terms)).toBeNull();
  });
  it("drops ordinary discussion comments even when a phrase appears (seen in live data)", () => {
    expect(parseHnHit({ objectID: "10", story_title: "Why .NET?", comment_text: "We are looking for a developer who knows .NET; the website redesign took a year." }, terms)).toBeNull();
  });
  it("drops article link posts and other Ask/Show HN posts", () => {
    expect(parseHnHit({ objectID: "4", title: "Redesign of the .NET website runtime", url: "https://example.test/a" }, terms)).toBeNull();
    expect(parseHnHit({ objectID: "11", title: "Show HN: my website redesign tool", story_text: "looking for an agency" }, terms)).toBeNull();
    expect(parseHnHit({ objectID: "12", title: "Ask HN: How do you keep up quality when you vibe-code?", story_text: "need to build better habits" }, terms)).toBeNull();
  });
  it("drops posts that match no service", () => {
    expect(parseHnHit({ objectID: "3", title: "Ask HN: Looking for a plumber to fix our sink", story_text: "x" }, terms)).toBeNull();
  });
});

describe("Reddit", () => {
  const xml = `<feed><entry><id>t3_abc123</id><title>[Hiring] Looking for an agency to redesign our website</title>
    <link href="https://www.reddit.com/r/forhire/comments/abc123/x/"/><author><name>/u/acme_founder</name></author>
    <updated>2026-11-10T20:00:00+00:00</updated><content type="html">&lt;p&gt;Need a website redesign, budget $8k.&lt;/p&gt; submitted by &lt;a&gt;x&lt;/a&gt;</content></entry>
    <entry><id>t3_def</id><title>[For Hire] Web developer, MVP specialist</title><link href="https://www.reddit.com/r/forhire/comments/def/y/"/>
    <author><name>/u/dev</name></author><updated>2026-11-10T20:00:00+00:00</updated><content type="html">&lt;p&gt;available for hire&lt;/p&gt;</content></entry></feed>`;
  const entries = parseAtom(xml);
  it("parses Atom entries", () => {
    expect(entries).toHaveLength(2);
    expect(entries[0].author).toBe("/u/acme_founder");
  });
  it("treats [Hiring] on r/forhire as a buyer with high intent", () => {
    const hiring = { id: "t3_h1", title: "[Hiring] Developer for our website redesign", link: "https://www.reddit.com/r/forhire/comments/h1/x/", author: "/u/boss", updated: "2026-11-10T20:00:00+00:00", content: "&lt;p&gt;Paid project.&lt;/p&gt;" };
    expect(parseRedditEntry(hiring, terms)?.metadata.intentLevel).toBe("high");
  });
  it("drops [Hiring] employment ads but keeps project work (seen in live data)", () => {
    const post = (title: string, body: string) => ({ id: "t3_x" + title.length, title, link: "https://www.reddit.com/r/forhire/comments/x/", author: "/u/a", updated: "2026-11-10T20:00:00+00:00", content: `&lt;p&gt;${body}&lt;/p&gt;` });
    expect(parseRedditEntry(post("[Hiring] Talent Acquisition Partner (Remote) - US", "Full-time. Apply here. Website team."), terms)).toBeNull();
    expect(parseRedditEntry(post("[Hiring] Sales partner for a web dev agency. 50% of every deal you close", "Website sales."), terms)).toBeNull();
    expect(parseRedditEntry(post("[Hiring] Developer for a website redesign project", "One-off fixed price project."), terms)).not.toBeNull();
  });
  it("keeps buyers, drops [For Hire] posts, strips the author from the profile name", () => {
    const item = parseRedditEntry(entries[0], terms)!;
    expect(item.externalId).toBe("t3_abc123");
    expect(item.buyerName).toBe("acme_founder");
    expect(item.text).not.toMatch(/submitted by/);
    expect(parseRedditEntry(entries[1], terms)).toBeNull();
  });
});

describe("SEC Form D", () => {
  const filing = { indexUrl: "https://www.sec.gov/Archives/edgar/data/1/0001-26-000001-index.htm", accession: "0001-26-000001", filedOn: "2026-11-10" };
  const doc = (over: { name?: string; industry?: string; sold?: string; amendment?: string } = {}) => `<edgarSubmission><primaryIssuer><entityName>${over.name ?? "Bloodless Diagnostics Inc."}</entityName>
    <issuerAddress><city>AUSTIN</city><stateOrCountry>TX</stateOrCountry><stateOrCountryDescription>TEXAS</stateOrCountryDescription></issuerAddress><entityType>Corporation</entityType></primaryIssuer>
    <relatedPersonsList><relatedPersonInfo><relatedPersonName><firstName>Ada</firstName><lastName>Lovelace</lastName></relatedPersonName>
    <relatedPersonRelationshipList><relationship>Executive Officer</relationship></relatedPersonRelationshipList></relatedPersonInfo></relatedPersonsList>
    <offeringData><industryGroup><industryGroupType>${over.industry ?? "Other Technology"}</industryGroupType></industryGroup>
    <typeOfFiling><newOrAmendment><isAmendment>${over.amendment ?? "false"}</isAmendment></newOrAmendment><dateOfFirstSale><value>2026-11-01</value></dateOfFirstSale></typeOfFiling>
    <offeringSalesAmounts><totalOfferingAmount>3000000</totalOfferingAmount><totalAmountSold>${over.sold ?? "1200000"}</totalAmountSold></offeringSalesAmounts></offeringData></edgarSubmission>`;

  it("marks funding verified only when money was actually sold", () => {
    const sold = parseFormD(doc(), filing)!;
    expect(sold.verification).toBe("verified");
    expect(sold.funding).toMatchObject({ amountUsd: 1_200_000, date: "2026-11-01" });
    expect(sold.country).toBe("US");
    expect(sold.metadata.people).toEqual([{ name: "Ada Lovelace", roles: ["Executive Officer"] }]);
    const unsold = parseFormD(doc({ sold: "0" }), filing)!;
    expect(unsold.verification).toBe("unverified");
    expect(unsold.funding?.amountUsd).toBe(3_000_000);
  });
  it("skips funds, vehicles, finance industries and amendments", () => {
    expect(parseFormD(doc({ name: "Gemspring Capital Fund IV, LP" }), filing)).toBeNull();
    expect(parseFormD(doc({ industry: "Pooled Investment Fund" }), filing)).toBeNull();
    expect(parseFormD(doc({ amendment: "true" }), filing)).toBeNull();
    expect(isVehicleName("Series 85-2, a series of StartEngine Private LLC")).toBe(true);
    expect(isVehicleName("Bloodless Diagnostics Inc.")).toBe(false);
  });
  it("keeps only technology and business-services companies raising a real amount", () => {
    expect(parseFormD(doc({ industry: "Business Services" }), filing)).not.toBeNull();
    for (const industry of ["Biotechnology", "Manufacturing", "Lodging and Conventions", "Other"]) expect(parseFormD(doc({ industry }), filing)).toBeNull();
    expect(parseFormD(doc({ sold: "50000" }), filing)).toBeNull();
    // One-deal syndicates and investment firms.
    expect(isVehicleName("Gaingels Path Robotics SEP 2026 LLC")).toBe(true);
    expect(isVehicleName("Servant Invest, LLC")).toBe(true);
  });
  it("reads new filings from the feed and ignores amendments", () => {
    const feed = `<feed><entry><title>D - Acme Robotics Inc. (0001) (Filer)</title><link href="https://www.sec.gov/Archives/edgar/data/1/000-index.htm"/>
      <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-11-10 &lt;b&gt;AccNo:&lt;/b&gt; 0001-26-000009 &lt;b&gt;Size:&lt;/b&gt; 7 KB</summary></entry>
      <entry><title>D/A - Old Co (0002) (Filer)</title><link href="https://www.sec.gov/x-index.htm"/><summary>&lt;b&gt;AccNo:&lt;/b&gt; 0002-26-000001</summary></entry></feed>`;
    const parsed = parseFeed(feed);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: "Acme Robotics Inc.", accession: "0001-26-000009", filedOn: "2026-11-10" });
  });
  it("keeps a filer only when it is also hiring, listed with its roles", () => {
    const item = parseFormD(doc(), filing)!;
    expect(withOpenRoles(item, undefined)).toBeNull(); // raising money alone is no evidence of need
    expect(withOpenRoles(item, { titles: [], categories: [] })).toBeNull();
    const hiring = withOpenRoles(item, { titles: ["AI Engineer"], categories: ["ai_ml", "staff_augmentation"] })!;
    expect(hiring.title).toBe("Bloodless Diagnostics Inc. filed a Form D for $1,200,000 and is hiring: AI Engineer");
    expect(hiring.metadata.jobCategories).toEqual(["ai_ml", "staff_augmentation"]);
  });
  it("matches a filer to a job board by name, without its legal form", () => {
    expect(companyKey("ANDROMEDA ROBOTICS, INC.")).toBe(companyKey("Andromeda Robotics"));
    expect(companyKey("Clearwood, PBC")).toBe("clearwood");
    expect(companyKey("THIRD EYE MECHATRONICS LLC")).toBe("thirdeyemechatronics");
  });
  it("maps issuer states and provinces to countries", () => {
    expect(countryOf("CA", "CALIFORNIA")).toBe("US");
    expect(countryOf("A6", "ONTARIO")).toBeNull(); // unknown code: not guessed
    expect(countryOf("ON", "ONTARIO")).toBe("CA");
  });
});

describe("YC batches", () => {
  it("dates a batch by its season start", () => {
    expect(batchStart("S26")).toBe("2026-06-01");
    expect(batchStart("W25")).toBe("2025-01-01");
    expect(batchStart("Summer 2025")).toBe("2025-06-01");
    expect(batchStart("Unknown")).toBeNull();
  });
});

// Real markup captured from the live sites (2026-11-11), so a layout change shows up as a failing test.
import { readFileSync } from "node:fs";
import { agoToDate, parseMoney, parseMoneyRange } from "./scrape-utils";
import { parseGuru } from "./guru";
import { parsePeoplePerHour } from "./peopleperhour";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const now = new Date("2026-11-11T12:00:00Z");

describe("scrape helpers", () => {
  it("reads relative times", () => {
    expect(agoToDate("3 hours ago", now)?.toISOString()).toBe("2026-11-11T09:00:00.000Z");
    expect(agoToDate("53 mins ago", now)?.toISOString()).toBe("2026-11-11T11:07:00.000Z");
    expect(agoToDate("a day ago", now)?.toISOString()).toBe("2026-11-10T12:00:00.000Z");
    expect(agoToDate("soon", now)).toBeNull();
  });
  it("reads money and ranges with k suffixes, flagging non-USD as approximate", () => {
    expect(parseMoney("$1,200")).toMatchObject({ amount: 1200, usd: 1200, approximate: false });
    expect(parseMoney("£100")).toMatchObject({ currency: "GBP", usd: 127, approximate: true });
    expect(parseMoneyRange("Fixed Price | $500-$1k")).toMatchObject({ min: 500, max: 1000, usd: 1000 });
    expect(parseMoneyRange("Hourly $59 - $80")).toMatchObject({ min: 59, max: 80 });
    expect(parseMoney("no price")).toBeNull();
  });
});

describe("PeoplePerHour listing (real markup)", () => {
  const items = parsePeoplePerHour(fixture("peopleperhour-listing.html"), now);
  it("reads every card with id, url, price, poster and age", () => {
    expect(items).toHaveLength(2);
    const [a] = items;
    expect(a.externalId).toMatch(/^\d+$/);
    expect(a.url).toMatch(/^https:\/\/www\.peopleperhour\.com\/freelance-jobs\/.+-\d+$/);
    expect(a.budget?.usd).toBeGreaterThan(0);
    expect(a.buyerName).toBeTruthy();
    expect(a.postedAt).not.toBeNull();
    expect(a.title.length).toBeGreaterThan(5);
    expect(a.text.length).toBeGreaterThan(20);
    expect(a.country).toBeNull();
  });
});

describe("Guru listing (real markup)", () => {
  const items = parseGuru(fixture("guru-listing.html"), now);
  it("reads the title, description, poster and country", () => {
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ externalId: "2121767", title: "magazine design", country: "US" });
    expect(items[0].text).toMatch(/^HAVE 58 PAGES/);
    expect(items[0].buyerName).toBe("TEST C");
  });
  it("treats hourly pay as no project budget, fixed ranges as a budget, and fixed with no amount as unavailable", () => {
    expect(items[1].metadata.pricing).toBe("hourly");
    expect(items[1].budget).toBeNull();
    expect(items[0].budget).toBeNull(); // fixed price, amount not shown on the listing
    expect(items[2].budget).toMatchObject({ min: 500, max: 1000, usd: 1000 });
  });
  it("links to the job without Guru's tracking query", () => {
    expect(items[0].url).toBe("https://www.guru.com/jobs/magazine-design/2121767");
  });
});

import { parseSerpResult, platformOf, serpApi } from "./serpapi";

describe("SerpAPI (Google) results", () => {
  const terms = ["website", "redesign", "mvp"];
  it("turns a request on Reddit into an unidentified-buyer intent item", () => {
    const item = parseSerpResult(
      { title: "Looking for an agency to redesign our website : r/smallbusiness", link: "https://www.reddit.com/r/smallbusiness/comments/abc/x/", snippet: "Our site is dated. Need a redesign, budget around 8k.", date: "3 days ago" },
      terms,
      now,
    )!;
    expect(item.platform).toBe("Reddit");
    expect(item.buyerName).toBeNull();
    expect(item.verification).toBe("unverified");
    expect(item.intentHint).toBe("high");
    expect(item.postedAt?.toISOString()).toBe("2026-11-08T12:00:00.000Z");
  });
  it("drops results from other sites, non-requests and results matching no service", () => {
    expect(parseSerpResult({ title: "Looking for an agency to redesign our website", link: "https://example.com/blog", snippet: "x" }, terms, now)).toBeNull();
    expect(parseSerpResult({ title: "Best website redesign tips", link: "https://www.reddit.com/r/x/comments/1/", snippet: "A guide to redesigns" }, terms, now)).toBeNull();
    expect(parseSerpResult({ title: "Looking for a plumber", link: "https://www.reddit.com/r/x/comments/2/", snippet: "leak" }, terms, now)).toBeNull();
  });
  it("names the platform from the link", () => {
    expect(platformOf("https://www.linkedin.com/posts/abc")).toBe("LinkedIn");
    expect(platformOf("https://twitter.com/a/status/1")).toBe("X");
    expect(platformOf("not a url")).toBeNull();
  });
  it("is not configured without a key, so the runner skips it with a note instead of failing", () => {
    const saved = process.env.SERPAPI_API_KEY;
    delete process.env.SERPAPI_API_KEY;
    expect(serpApi.configured?.()).toBe(false);
    expect(serpApi.setupHint).toMatch(/SERPAPI_API_KEY/);
    if (saved) process.env.SERPAPI_API_KEY = saved;
  });
});
