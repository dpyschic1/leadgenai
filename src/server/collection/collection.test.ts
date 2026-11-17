import { describe, expect, it } from "vitest";
import { careersUrlFrom, jobPageLinks, jobPostingsFrom, listingPageLinks, looksClientRendered } from "./collectors/career-pages";
import { isBlockedUrl } from "./fetch";
import { canonicalUrl, countryCodeOf, dedupeKey, domainOf, normalizeItem, parseDate } from "./normalize";
import { nextInterval, retryDelayMinutes } from "./runner";
import type { CollectedItemInput } from "./types";

const NOW = new Date("2026-11-17T12:00:00Z");

const jsonLd = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

const item = (overrides: Partial<CollectedItemInput> = {}): CollectedItemInput => ({
  externalId: "acme.com:1",
  kind: "job",
  url: "https://acme.com/careers/frontend-engineer",
  extraction: "json_ld",
  fetchedUrl: null,
  title: "Senior Frontend Engineer",
  text: "Build our React web app.\nRequirements:\n• 5 years of React",
  companyName: "Acme",
  companyDomain: "acme.com",
  location: "Austin, TX, US",
  country: "US",
  remote: null,
  postedAt: new Date("2026-11-10T00:00:00Z"),
  validThrough: null,
  data: {},
  ...overrides,
});

describe("normalization", () => {
  it("makes one canonical URL for the same page", () => {
    expect(canonicalUrl("http://WWW.Acme.com/careers/?utm_source=x&b=2&a=1#apply")).toBe("https://acme.com/careers?a=1&b=2");
    expect(canonicalUrl("https://acme.com/")).toBe("https://acme.com/");
    expect(canonicalUrl("https://acme.com/jobs?gh_jid=123&gclid=abc")).toBe("https://acme.com/jobs?gh_jid=123");
    expect(canonicalUrl(" not a url ")).toBe("not a url");
  });

  it("reads domains, countries and dates as sources write them", () => {
    expect(domainOf("https://careers.acme.co.uk/jobs")).toBe("acme.co.uk");
    expect(domainOf("acme.com")).toBe("acme.com");
    expect(domainOf("localhost")).toBeNull();
    expect(countryCodeOf("US")).toBe("US");
    expect(countryCodeOf("USA")).toBe("US");
    expect(countryCodeOf("United States")).toBe("US");
    expect(countryCodeOf("UK")).toBe("GB");
    expect(countryCodeOf("ZZ")).toBeNull();
    expect(countryCodeOf("")).toBeNull();
    expect(parseDate("2026-11-03")?.toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(parseDate("3 days ago")).toBeNull();
    expect(parseDate(20261103)).toBeNull();
  });

  it("keeps a relevant job's text and only the links of any other", () => {
    const relevant = normalizeItem(item());
    expect(relevant.categories).toContain("software_development");
    expect(relevant.body).toContain("React web app");
    const other = normalizeItem(item({ title: "Warehouse Associate", text: "Lift boxes. Apply at https://acme.com/apply" }));
    expect(other.categories).toEqual([]);
    expect(other.body).not.toContain("Lift boxes");
  });

  it("changes the content hash only when stored content changes", () => {
    const a = normalizeItem(item());
    expect(normalizeItem(item()).contentHash).toBe(a.contentHash);
    expect(normalizeItem(item({ title: "Staff Frontend Engineer" })).contentHash).not.toBe(a.contentHash);
    expect(normalizeItem(item({ location: "Remote" })).contentHash).not.toBe(a.contentHash);
  });

  it("gives the same job listed twice the same dedupe key, and other items their URL's", () => {
    const a = normalizeItem(item());
    const repost = normalizeItem(item({ externalId: "acme.com:2", url: "https://acme.com/careers/frontend-engineer-2", title: "senior  frontend engineer" }));
    expect(repost.dedupeKey).toBe(a.dedupeKey);
    expect(normalizeItem(item({ location: "Denver, CO, US" })).dedupeKey).not.toBe(a.dedupeKey);
    const noCompany = normalizeItem(item({ companyDomain: null }));
    expect(noCompany.dedupeKey).toBe(dedupeKey({ ...noCompany, kind: "post" }));
  });
});

describe("collection policy", () => {
  it("never fetches sites whose terms forbid automated collection", () => {
    for (const url of [
      "https://www.linkedin.com/jobs/view/1",
      "https://uk.linkedin.com/in/someone",
      "https://www.indeed.com/viewjob?jk=1",
      "https://indeed.co.uk/",
      "https://www.google.com/search?q=jobs",
      "https://www.glassdoor.co.uk/Job",
      "https://old.reddit.com/r/forhire",
      "not a url",
    ]) {
      expect(isBlockedUrl(url), url).toBe(true);
    }
    expect(isBlockedUrl("https://acme.com/careers")).toBe(false);
    expect(isBlockedUrl("https://notlinkedin.com/")).toBe(false);
  });

  it("backs off failures and adapts the interval to change", () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMinutes(n, 1440))).toEqual([1, 4, 16, 64]);
    expect(retryDelayMinutes(9, 1440)).toBe(1440);
    expect(nextInterval(1440, true)).toBe(720);
    expect(nextInterval(1440, false)).toBe(2880);
    expect(nextInterval(400, true)).toBe(360);
    expect(nextInterval(8000, false)).toBe(10080);
  });
});

describe("careers pages", () => {
  it("finds the careers page among the home page's or sitemap's links", () => {
    const links = [
      { url: "https://acme.com/about", text: "About" },
      { url: "https://acme.com/careers/engineering/frontend", text: "Frontend" },
      { url: "https://acme.com/careers", text: "Careers" },
      { url: "https://other.com/careers", text: "Careers" },
      { url: "https://acme.com/careers.pdf", text: "Careers brochure" },
    ];
    expect(careersUrlFrom(links, "acme.com")).toBe("https://acme.com/careers");
    expect(careersUrlFrom([{ url: "https://acme.com/team", text: "Join our team" }], "acme.com")).toBe("https://acme.com/team");
    expect(careersUrlFrom([{ url: "https://other.com/jobs", text: "Jobs" }], "acme.com")).toBeNull();
  });

  it("follows listing pages and job pages, not files or other sites", () => {
    const html = `
      <a href="/careers/frontend-engineer">Frontend Engineer</a>
      <a href="/careers/frontend-engineer#apply">Apply</a>
      <a href="/jobs/123-designer">Designer</a>
      <a href="/careers/brochure.pdf">Brochure</a>
      <a href="/careers/apply">Apply</a>
      <a href="/careers?page=2">Next</a>
      <a href="/blog/hiring">Blog</a>
      <a href="https://other.com/careers/x">Partner</a>`;
    expect(jobPageLinks(html, "https://acme.com/careers", "https://acme.com/careers", "acme.com")).toEqual([
      "https://acme.com/careers/frontend-engineer",
      "https://acme.com/jobs/123-designer",
    ]);
    expect(listingPageLinks(html, "https://acme.com/careers", "https://acme.com/careers")).toEqual(["https://acme.com/careers?page=2"]);
  });

  it("reads current JobPosting markup as jobs", () => {
    const html =
      jsonLd({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Acme" },
          {
            "@type": "JobPosting",
            title: "Senior Frontend Engineer",
            description: "&lt;p&gt;Build our &lt;b&gt;React&lt;/b&gt; app.&lt;/p&gt;",
            datePosted: "2026-11-10",
            validThrough: "2026-12-31T00:00:00Z",
            employmentType: "FULL_TIME",
            identifier: { "@type": "PropertyValue", name: "Acme", value: "FE-7" },
            hiringOrganization: { "@type": "Organization", name: "Acme Inc.", sameAs: ["https://www.linkedin.com/company/acme", "https://www.acme.com"] },
            jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Austin", addressRegion: "TX", addressCountry: "US" } },
            baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", minValue: 150000, maxValue: 180000, unitText: "YEAR" } },
          },
        ],
      }) +
      jsonLd([
        { "@type": "JobPosting", title: "Remote Designer", url: "/careers/designer", jobLocationType: "TELECOMMUTE", applicantLocationRequirements: { "@type": "Country", name: "USA" } },
        { "@type": "JobPosting", title: "Expired role", validThrough: "2026-01-01" },
        { "@type": "JobPosting", title: "Old role", datePosted: "2026-06-01" },
        { "@type": "JobPosting", description: "No title" },
      ]) +
      `<script type="application/ld+json">{broken</script>`;

    const items = jobPostingsFrom(html, "https://acme.com/careers", "acme.com", NOW);
    expect(items.map((i) => i.title)).toEqual(["Senior Frontend Engineer", "Remote Designer"]);
    const [engineer, designer] = items;
    expect(engineer).toMatchObject({
      externalId: "acme.com:FE-7",
      kind: "job",
      url: "https://acme.com/careers",
      extraction: "json_ld",
      fetchedUrl: null,
      companyName: "Acme Inc.",
      companyDomain: "acme.com",
      location: "Austin, TX, US",
      country: "US",
      remote: null,
      data: { employmentType: ["FULL_TIME"], salary: { currency: "USD", min: 150000, max: 180000, unit: "YEAR" }, identifier: "FE-7" },
    });
    expect(engineer.text).toBe("Build our React app.");
    expect(engineer.postedAt?.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(designer).toMatchObject({
      externalId: "https://acme.com/careers/designer",
      url: "https://acme.com/careers/designer",
      fetchedUrl: "https://acme.com/careers",
      remote: true,
      location: "Remote, USA",
      country: "US",
      companyDomain: "acme.com",
    });
  });

  it("tells apart jobs listed on one page without a URL or id", () => {
    const html = jsonLd([
      { "@type": "JobPosting", title: "Engineer", jobLocation: { address: "Austin, TX, US" } },
      { "@type": "JobPosting", title: "Engineer", jobLocation: { address: "Denver, CO, US" } },
    ]);
    const ids = jobPostingsFrom(html, "https://acme.com/careers", "acme.com", NOW).map((i) => i.externalId);
    expect(new Set(ids).size).toBe(2);
  });

  it("flags a careers page that only a browser can render", () => {
    expect(looksClientRendered(`<html><body><div id="root"></div><script src="/app.js"></script></body></html>`)).toBe(true);
    expect(looksClientRendered(`<div id="root"><h1>Careers</h1><p>${"We are hiring engineers. ".repeat(40)}</p></div>`)).toBe(false);
    expect(looksClientRendered(`<html><body><p>Short page</p></body></html>`)).toBe(false);
  });
});
