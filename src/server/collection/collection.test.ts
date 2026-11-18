import { describe, expect, it } from "vitest";
import { careersUrlFrom, jobPageLinks, jobPostingsFrom, listingPageLinks, looksClientRendered } from "./collectors/career-pages";
import { askRequest, freelancerRequest, hiringPost, newestThread } from "./collectors/hacker-news";
import { gemJobs, hostedBoardOf, ripplingJob, ripplingList } from "./collectors/hosted-boards";
import { samDate, samTenders } from "./collectors/sam-gov";
import { jobCardsFrom, jobPageFrom } from "./collectors/html-jobs";
import { pickBatch, seedCandidates, seedDomain, seedPlacesSql, type SeedPlace } from "./overture-seed";
import { isBlockedUrl } from "./fetch";
import { canonicalUrl, countriesIn, countryCodeOf, dedupeKey, domainOf, normalizeItem, parseDate } from "./normalize";
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
    expect(careersUrlFrom([{ url: "https://acme.com/company", text: "Work at Acme" }], "acme.com")).toBe("https://acme.com/company");
    expect(careersUrlFrom([{ url: "https://other.com/jobs", text: "Jobs" }], "acme.com")).toBeNull();
  });

  it("doesn't take customer pages, sign-ups or text that only mentions jobs for the careers page", () => {
    for (const link of [
      { url: "https://acme.com/who-we-serve/how-to-work-with-us", text: "How to work with us" },
      { url: "https://acme.com/customers/parrot", text: "How Parrot automated 10,000 jobs" },
      { url: "https://acme.com/join", text: "Join the waitlist" },
      { url: "https://acme.com/convert/resume", text: "Turn your resume into job applications" },
    ]) {
      expect(careersUrlFrom([link], "acme.com"), link.text).toBeNull();
    }
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
    expect(looksClientRendered(`<h1>Open roles</h1><p>${"About us. ".repeat(80)}</p><p>JavaScript is required to load the job board.</p>`)).toBe(true);
  });
});

describe("jobs from careers-page HTML (no markup)", () => {
  const PAGE = "https://acme.com/careers";
  const cards = (html: string) => jobCardsFrom(html, PAGE, "acme.com");

  it("reads job links with their facts: place, contract, pay", () => {
    const html = `<ul>
      <li><a class="role-link" href="/careers/platform-engineer"><span class="name">Platform Engineer</span><span class="meta">Austin, TX, USA<!-- --> · <!-- -->Full-time</span></a></li>
      <li><a class="role-link" href="/careers/design-intern"><span class="name">Product Designer (Intern)</span><span class="meta">Remote (US) · Internship · $40/hour</span></a></li>
    </ul>`;
    expect(cards(html)).toEqual([
      expect.objectContaining({
        externalId: "https://acme.com/careers/platform-engineer",
        url: "https://acme.com/careers/platform-engineer",
        fetchedUrl: PAGE,
        extraction: "html",
        title: "Platform Engineer",
        location: "Austin, TX, USA",
        country: "US",
        companyDomain: "acme.com",
        data: { employmentType: ["FULL_TIME"], facts: "Austin, TX, USA · Full-time" },
      }),
      expect.objectContaining({ title: "Product Designer (Intern)", location: "Remote (US)", remote: true, data: expect.objectContaining({ employmentType: ["INTERNSHIP"], salaryText: "$40/hour" }) }),
    ]);
  });

  it("reads jobs linked to a job board elsewhere, keeping that address to apply at", () => {
    const html = `<a href="https://www.ycombinator.com/companies/acme/jobs/X1-full-stack-engineer" class="career-link">
      <div class="career-link-title"><strong>Full-Stack Engineer</strong></div><div class="career-link-meta">San Francisco · $110K–$160K</div></a>`;
    const [job] = cards(html);
    expect(job).toMatchObject({
      title: "Full-Stack Engineer",
      url: "https://www.ycombinator.com/companies/acme/jobs/X1-full-stack-engineer",
      fetchedUrl: PAGE,
      location: null, // a bare city name is not read as a place
      data: { salaryText: "$110K–$160K", applyUrl: "https://www.ycombinator.com/companies/acme/jobs/X1-full-stack-engineer" },
    });
    // Its address on the job board is its id.
    expect(job.externalId).toBe("https://ycombinator.com/companies/acme/jobs/X1-full-stack-engineer");
  });

  it("reads tabs of open roles, and not the filled ones shown without a link", () => {
    const html = `<div class="nav nav-pills" role="tablist">
      <a class="nav-link active" href="#job4">Solutions Consultant (Sales)</a>
      <a class="nav-link" href="#job2">SEO &amp; Digital Marketing Specialist</a>
      <div class="nav-link disabled" href="#job3">Director of Partnerships</div>
      <div class="nav-link disabled" href="#job1">DevOps Engineer</div></div>`;
    const found = cards(html);
    expect(found.map((j) => j.title)).toEqual(["Solutions Consultant (Sales)", "SEO & Digital Marketing Specialist"]);
    for (const job of found) {
      expect(job).toMatchObject({ url: PAGE, fetchedUrl: null, data: {} });
    }
  });

  it("takes the title from a heading for 'View role' links, and skips a leading department", () => {
    const html = `
      <div class="role"><h3 class="title"><a href="/careers/head-of-sales">Head of Sales</a></h3><ul class="facts"><li>Sales</li><li>New York, NY</li></ul></div>
      <div class="role"><h3>Member of Technical Staff: Systems</h3><p>Build our systems.</p><a href="/careers/mts-systems">View role</a></div>
      <a href="/careers/data-engineer"><span>Engineering</span><h4>Data Engineer</h4><p>We centralize data for thousands of teams, from ingestion to the warehouse.</p></a>`;
    const found = cards(html);
    expect(found.map((j) => [j.title, j.location])).toEqual([
      ["Head of Sales", "New York, NY"],
      ["Member of Technical Staff: Systems", null],
      ["Data Engineer", null],
    ]);
    expect(found[2].text).toBe("We centralize data for thousands of teams, from ingestion to the warehouse.");
  });

  it("doesn't read people, menus, features or filters as jobs", () => {
    const html = `
      <nav><ul><li><a href="/dev">Developer</a></li></ul></nav>
      <div class="team-member"><h3><a href="https://www.linkedin.com/in/someone">Jane Doe, Ph.D.</a></h3><span class="team-role">Lead IC Designer</span></div>
      <div class="quote"><p>"Great place."</p><span class="author-subtitle">Head of Product Ops</span></div>
      <a href="#" class="footer-link">Lead form landing page V1</a>
      <a href="/careers/life-at-acme">Life at Acme</a>
      <a href="/careers#engineering">Engineering</a>
      <a href="/blog/how-we-hire-engineers">How we hire engineers</a>
      <a href="/careers/senior-engineer" class="team-member-card">Senior Engineer</a>
      <footer><a href="/careers/x">Careers</a></footer>`;
    expect(cards(html)).toEqual([]);
  });

  it("doesn't read a department and a topic as a place", () => {
    const [job] = cards(`<a href="/careers/sre"><span>Site Reliability Engineer</span><span>Engineering, Infrastructure · Remote (US)</span></a>`);
    expect(job.location).toBe("Remote (US)");
  });

  it("reads a job's own page only when it reads as a job description", () => {
    const description = `<header><nav><a href="/">Acme</a></nav></header><main><h1>Senior Backend Engineer</h1>
      <p>Location: Denver, CO · Full-time</p><h2>About the role</h2><p>In this role you will design our APIs.</p>
      <h2>Requirements</h2><ul><li>5+ years of experience with Go</li></ul><p>Apply below.</p></main>`;
    expect(jobPageFrom(description, "https://acme.com/careers/backend", "acme.com")).toMatchObject({
      externalId: "https://acme.com/careers/backend",
      title: "Senior Backend Engineer",
      location: "Denver, CO",
      country: "US",
      data: { employmentType: ["FULL_TIME"] },
    });
    const post = `<main><h1>Engineering Manager offsite recap</h1><p>We spent a week in Lisbon talking about the roadmap.</p></main>`;
    expect(jobPageFrom(post, "https://acme.com/careers/offsite", "acme.com")).toBeNull();
    const notARole = `<main><h1>Life at Acme</h1><p>Responsibilities, requirements, apply, experience with everything.</p></main>`;
    expect(jobPageFrom(notARole, "https://acme.com/careers/life", "acme.com")).toBeNull();
    // An unfinished website template's sample job.
    const template = `<h1>UI/UX product designer</h1><p>Lorem ipsum dolor sit amet consectetur.</p><h2>Job description</h2>
      <p>About the role: in this role you will design. Requirements: 3+ years of experience with Figma. Apply now.</p>`;
    expect(jobPageFrom(template, "https://acme.com/careers/ui-ux-product-designer", "acme.com")).toBeNull();
    expect(cards(`<a href="/careers/sample"><span>Product Designer</span><span>Lorem ipsum dolor sit amet.</span></a>`)).toEqual([]);
  });

  it("starts a page's description at its heading when it has no main element", () => {
    const html = `<div class="navbar"><a href="/pricing">Pricing</a><a href="/demo">Book a demo</a></div>
      <h1>Account Executive</h1><p>About the role: you will close deals. Requirements: 2+ years of experience in SaaS sales. Apply below.</p>`;
    const job = jobPageFrom(html, "https://acme.com/careers/ae", "acme.com");
    expect(job?.text?.startsWith("Account Executive")).toBe(true);
    expect(job?.text).not.toContain("Book a demo");
  });
});

describe("careers-page targets from Overture places", () => {
  const place = (overrides: Partial<SeedPlace> = {}): SeedPlace => ({
    id: "p1",
    name: "Acme Legal",
    category: "attorney_or_law_firm",
    confidence: 0.9,
    websites: ["https://www.acmelegal.com/contact"],
    city: "Austin",
    region: "TX",
    postcode: "78701",
    datasets: ["meta", "Foursquare"],
    ...overrides,
  });

  it("takes the business's own website, never a platform, a social profile or a government site", () => {
    expect(seedDomain(["https://www.acmelegal.com/contact"])).toBe("acmelegal.com");
    expect(seedDomain(["acme-co.wixsite.com/home", "https://www.facebook.com/acme"])).toBeNull();
    expect(seedDomain(["https://www.facebook.com/acme", "https://acme.co"])).toBe("acme.co");
    expect(seedDomain(["https://linktr.ee/acme"])).toBeNull();
    expect(seedDomain(["https://www.austintexas.gov/department/x"])).toBeNull();
    expect(seedDomain(["http://10.0.0.1/"])).toBeNull();
    expect(seedDomain(null)).toBeNull();
  });

  it("keeps seeded categories with a usable website, one per domain, and skips existing targets", () => {
    const { candidates, stats } = seedCandidates(
      [
        place(),
        place({ id: "p2", name: "Acme Legal (Downtown)", confidence: 0.95 }), // the same firm's other office
        place({ id: "p3", category: "restaurant", websites: ["https://tacos.com"] }),
        place({ id: "p4", category: "technical_service", websites: ["https://acme.wixsite.com/it"] }),
        place({ id: "p5", category: "corporate_or_business_office", confidence: 0.5, websites: ["https://lowconf.com"] }),
        place({ id: "p6", category: "dental_clinic", websites: ["https://smiles.com"] }),
        place({ id: "p7", category: "corporate_or_business_office", websites: ["https://known.com"] }),
      ],
      new Set(["known.com"]),
    );
    expect(stats).toEqual({ places: 7, inCategories: 5, withDomain: 4, domains: 3, alreadyTargets: 1, candidates: 2 });
    expect(candidates.map((c) => [c.domain, c.tier, c.places, c.place.id])).toEqual([
      ["acmelegal.com", 1, 2, "p2"],
      ["smiles.com", 2, 1, "p6"],
    ]);
  });

  it("picks a batch tier 1 first, categories taking turns, capped per category", () => {
    const candidate = (domain: string, category: string, tier: 1 | 2) => ({ domain, tier, places: 1, place: place({ id: domain, category }) });
    const all = [
      ...["a1", "a2", "a3", "a4"].map((d) => candidate(`${d}.com`, "attorney_or_law_firm", 1)),
      ...["f1", "f2"].map((d) => candidate(`${d}.com`, "financial_service", 1)),
      ...["h1", "h2"].map((d) => candidate(`${d}.com`, "health_care", 2)),
    ];
    expect(pickBatch(all, { limit: 5, perCategory: 3 }).map((c) => c.domain)).toEqual(["a1.com", "f1.com", "a2.com", "f2.com", "a3.com"]);
    expect(pickBatch(all, { limit: 10, perCategory: 1 }).map((c) => c.domain)).toEqual(["a1.com", "f1.com", "h1.com"]);
  });

  it("spreads each category's share over the areas read", () => {
    const candidate = (domain: string, area: string, confidence: number) => ({ domain, tier: 1 as const, places: 1, place: place({ id: domain, area, confidence }) });
    const all = [candidate("b1.com", "boston", 0.99), candidate("b2.com", "boston", 0.98), candidate("b3.com", "boston", 0.97), candidate("d1.com", "denver", 0.8)];
    expect(pickBatch(all, { limit: 2, perCategory: 2 }).map((c) => c.domain)).toEqual(["b1.com", "d1.com"]);
  });

  it("reads each area in its own scan, US places with a website in the seeded categories only", () => {
    const query = seedPlacesSql("2026-10-21.0", [{ name: "austin", box: [-97.8, 30.22, -97.68, 30.34] }, { name: "denver", box: [-105.05, 39.68, -104.92, 39.8] }], "out.json");
    expect(query.match(/read_parquet\('s3:\/\/overturemaps-us-west-2\/release\/2026-10-21\.0\//g)).toHaveLength(2);
    expect(query).toContain("bbox.xmin BETWEEN -97.8 AND -97.68 AND bbox.ymin BETWEEN 30.22 AND 30.34");
    expect(query).toContain("UNION ALL");
    expect(query).toContain("addresses[1].country = 'US'");
    expect(query).toContain("'attorney_or_law_firm'");
    expect(query).not.toContain("'restaurant'");
  });
});

describe("jobs from careers-page HTML: patterns from the Overture pilot", () => {
  const PAGE = "https://acme.com/careers";
  const cards = (html: string) => jobCardsFrom(html, PAGE, "acme.com");

  it("doesn't read links to job areas, searches or filters as jobs", () => {
    const html = `
      <a href="/us-en/careers/life-at-acme/leadership-careers">Executive leaders</a>
      <a href="https://campus-us-acme.icims.com/jobs/search?ss=1">Early Career and Internship Opportunities</a>
      <a href="/company/careers/medical-staff">Medical Support Staff</a>
      <a href="https://acme.wd1.myworkdayjobs.com/External_Careers?jobFamily=5323a40849ab1">Customer Service &amp; Support</a>
      <a href="https://acme.wd1.myworkdayjobs.com/External_Careers?jobFamily=7a1b">Operations Support</a>
      <a href="/careers/career-areas/support-services">Support Services</a>
      <a href="/careers/teams/engineering">Engineering Manager</a>`;
    expect(cards(html)).toEqual([]);
  });

  it("still reads single jobs whose titles name support or a team", () => {
    const titles = cards(`
      <a href="/careers/technical-support-engineer">Technical Support Engineer</a>
      <a href="/careers/customer-success-manager">Customer Success Manager</a>
      <a href="/careers/chief-of-staff">Chief of Staff</a>`).map((j) => j.title);
    expect(titles).toEqual(["Technical Support Engineer", "Customer Success Manager", "Chief of Staff"]);
  });

  it("reads a job linked twice on a job board as one job, with the facts either link gave", () => {
    const job = "https://ats.rippling.com/acme/jobs/5df9fe65";
    const found = cards(`
      <div class="card"><a href="${job}"><h3>Platform Engineer</h3></a>
        <a href="${job}"><span>Platform Engineer</span><span>Remote (United States)</span></a></div>`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ externalId: "https://ats.rippling.com/acme/jobs/5df9fe65", location: "Remote (United States)", remote: true });
  });

  it("reads a location line up to the next label on it", () => {
    const html = `<main><h1>Family Medicine Physician</h1><p>Location: Austin, TX Job Type: Full-Time</p>
      <h2>About the role</h2><p>In this role you will see patients. Requirements: board certified, 3+ years of experience. Apply today.</p></main>`;
    expect(jobPageFrom(html, "https://acme.com/jobs/physician", "acme.com")?.location).toBe("Austin, TX");
  });
});

describe("Gem and Rippling job boards", () => {
  it("knows a Gem or Rippling board from a job link, and nothing else", () => {
    expect(hostedBoardOf("https://jobs.gem.com/ultra/am9icG9zdDoEoy3YKd")).toEqual({ sourceSlug: "gem_board", token: "ultra" });
    expect(hostedBoardOf("https://ats.rippling.com/solv-health/jobs/d41ab491")).toEqual({ sourceSlug: "rippling_board", token: "solv-health" });
    expect(hostedBoardOf("https://jobs.gem.com/")).toBeNull();
    expect(hostedBoardOf("https://app.dover.com/apply/Conduit/fcede910")).toBeNull();
    expect(hostedBoardOf("https://www.ycombinator.com/companies/x/jobs/1")).toBeNull();
    expect(hostedBoardOf("not a url")).toBeNull();
  });

  it("reads a Gem board's posts", () => {
    const [job] = gemJobs(
      [
        {
          id: "am9icG9zdDpI7",
          title: "Robotics Application Engineer - Hardware",
          absolute_url: "https://jobs.gem.com/ultra/am9icG9zdDpI7",
          content: "<h1>About Ultra</h1><p>Robots.</p>",
          content_plain: "About Ultra\nRobots.",
          first_published_at: "2026-04-16T22:28:51.373Z",
          created_at: "2026-04-16T21:12:46.658Z",
          location: { name: "New York, United States" },
          location_type: "in_office",
          employment_type: "full_time",
          departments: [{ name: "Hardware" }],
        },
        { id: "x", title: "", absolute_url: "https://jobs.gem.com/ultra/x" },
      ],
      "ultra.tech",
      new Date("2026-05-01T00:00:00Z"),
    );
    expect(job).toMatchObject({
      externalId: "am9icG9zdDpI7",
      url: "https://jobs.gem.com/ultra/am9icG9zdDpI7",
      extraction: "api",
      title: "Robotics Application Engineer - Hardware",
      text: "About Ultra\nRobots.",
      companyDomain: "ultra.tech",
      location: "New York, United States",
      country: "US",
      remote: false,
      data: { employmentType: ["FULL_TIME"], workplace: "in_office", departments: ["Hardware"] },
    });
    expect(job.postedAt?.toISOString()).toBe("2026-04-16T22:28:51.373Z");
    expect(() => gemJobs({ message: "Forbidden" }, null)).toThrow();
  });

  const nextPage = (props: unknown) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props })}</script></html>`;

  it("reads a Rippling board page's jobs and page count, and a job page's description", () => {
    const list = nextPage({
      pageProps: {
        dehydratedState: {
          queries: [
            { queryKey: ["board", "acme", "locations"], state: { data: { items: [{ name: "Italy" }], totalPages: 1 } } },
            {
              queryKey: ["board", "acme", "job-posts", true, { page: 0 }],
              state: { data: { items: [{ id: "j1", name: "Platform Engineer", url: "https://ats.rippling.com/acme/jobs/j1" }], page: 0, totalPages: 2 } },
            },
          ],
        },
      },
    });
    expect(ripplingList(list)).toEqual({ jobs: [{ id: "j1", name: "Platform Engineer", url: "https://ats.rippling.com/acme/jobs/j1" }], totalPages: 2 });
    expect(() => ripplingList("<html></html>")).toThrow();

    const job = nextPage({
      pageProps: {
        apiData: {
          jobPost: {
            name: "Platform Engineer",
            description: { company: "<p>About Acme.</p>", role: "<p>You will run our platform.</p>" },
            createdOn: "2026-10-12T07:04:49.977000-07:00",
            employmentType: { label: "SALARIED_FT", id: "Salaried, full-time" },
          },
        },
      },
    });
    expect(ripplingJob(job)).toEqual({ text: "You will run our platform.\nAbout Acme.", createdOn: "2026-10-12T07:04:49.977000-07:00", employmentType: "Salaried, full-time" });
  });
});

describe("Gem posts older than the freshness limit", () => {
  it("leaves out posts first published more than 60 days ago", () => {
    const post = (id: string, published: string) => ({ id, title: "Engineer", absolute_url: `https://jobs.gem.com/acme/${id}`, first_published_at: published });
    const now = new Date("2026-11-18T12:00:00Z");
    expect(gemJobs([post("fresh", "2026-10-01T00:00:00Z"), post("stale", "2026-04-16T00:00:00Z")], "acme.com", now).map((j) => j.externalId)).toEqual(["fresh"]);
  });
});

describe("Hacker News", () => {
  const comment = (id: number, text: string) => ({ id, author: "someone", created_at_i: 1_793_000_000, text });

  it("finds the newest thread, the busiest one when a month has two", () => {
    const stories = [
      { objectID: "1", title: "Ask HN: Freelancer? Seeking freelancer? (October 2026)", created_at_i: 100, num_comments: 22 },
      { objectID: "2", title: "Ask HN: Freelancer? Seeking freelancer? (November 2026)", created_at_i: 300, num_comments: 2 },
      { objectID: "3", title: "Ask HN: Freelancer? Seeking freelancer? (November 2026)", created_at_i: 200, num_comments: 22 },
      { objectID: "4", title: "Ask HN: Who is hiring? (November 2026)", created_at_i: 400, num_comments: 377 },
    ];
    expect(newestThread(stories, /^Ask HN: Freelancer\? Seeking freelancer\? \(/)?.objectID).toBe("3");
    expect(newestThread(stories, /^Ask HN: Who is hiring\? \(/)?.objectID).toBe("4");
    expect(newestThread([], /x/)).toBeNull();
  });

  it("reads a Who is hiring post as a job: company, role, place, website", () => {
    const job = hiringPost(
      comment(
        11,
        'Synteq | Growth Lead &amp; Systems Administrator | Austin, TX | REMOTE (US) | Full-time<p>We build things. <a href="https:&#x2F;&#x2F;synteq.io&#x2F;careers">synteq.io</a> Apply: <a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;synteq">here</a>',
      ),
      "50338728",
    );
    expect(job).toMatchObject({
      externalId: "11",
      kind: "job",
      url: "https://news.ycombinator.com/item?id=11",
      title: "Growth Lead & Systems Administrator",
      companyName: "Synteq",
      companyDomain: "synteq.io",
      location: "Austin, TX; REMOTE (US)",
      country: "US",
      remote: true,
      data: expect.objectContaining({ employmentType: ["FULL_TIME"], thread: "50338728", applyUrl: "https://jobs.ashbyhq.com/synteq" }),
    });
    expect(job?.text).toContain("We build things.");
  });

  it("finds the role wherever the header puts it, plural or not", () => {
    expect(hiringPost(comment(12, "We The Flywheel | Remote | Brand Identity Designer (AI-agent team) | Hourly"), "t")?.title).toBe("Brand Identity Designer (AI-agent team)");
    expect(hiringPost(comment(13, "MixRank (YC S11) | Software Engineers | 100% Remote (Global) | Full-Time"), "t")).toMatchObject({ companyName: "MixRank", title: "Software Engineers" });
    expect(hiringPost(comment(14, "United Risk | Early-Career AI Engineers – Full-Stack (10 openings) | New York, NY"), "t")?.title).toBe("Early-Career AI Engineers – Full-Stack");
  });

  it("leaves out posts without the header or without a role in it", () => {
    expect(hiringPost(comment(15, "Shepherd (Series B) | ONSITE | San Francisco, CA"), "t")).toBeNull();
    expect(hiringPost(comment(16, "Cambridge | PhD in AI / Earth Observation | ONSITE | UK only"), "t")).toBeNull();
    expect(hiringPost(comment(17, "UPDATE (Nov 13): We're no longer taking applications for these roles."), "t")).toBeNull();
  });

  it("reads SEEKING FREELANCER posts as buyer requests, with the work they name", () => {
    const request = freelancerRequest(comment(20, "SEEKING FREELANCER | Remote (US)<p>Need a React developer to rebuild our customer portal."), "t");
    expect(request).toMatchObject({ kind: "post", title: "SEEKING FREELANCER | Remote (US)", remote: true, data: { intent: "high", author: "someone" } });
    expect(request?.categories).toContain("software_development");
    expect(freelancerRequest(comment(21, "SEEKING WORK | Python, Django | Remote"), "t")).toBeNull();
  });

  it("reads Ask HN posts that ask to hire someone, not discussions or link posts", () => {
    expect(askRequest({ objectID: "30", title: "Ask HN: Looking for an agency to build our MVP", created_at_i: 1_793_000_000 })).toMatchObject({ kind: "post", data: { intent: "high" } });
    expect(askRequest({ objectID: "31", title: "Ask HN: What's your favourite editor?" })).toBeNull();
    expect(askRequest({ objectID: "32", title: "Ask HN: Looking for an agency", url: "https://example.com" })).toBeNull();
  });
});

describe("SAM.gov", () => {
  const notice = (overrides: Record<string, unknown> = {}) => ({
    noticeId: "abc123",
    title: "Agency Website Redesign and Hosting",
    solicitationNumber: " 47QTCA26Q0001 ",
    fullParentPathName: "GENERAL SERVICES ADMINISTRATION.FEDERAL ACQUISITION SERVICE.IT CENTER",
    postedDate: "2026-11-17",
    type: "Combined Synopsis/Solicitation",
    responseDeadLine: "2026-12-05T17:00:00-05:00",
    naicsCode: "541511",
    typeOfSetAsideDescription: "Total Small Business Set-Aside (FAR 19.5)",
    active: "Yes",
    uiLink: "https://sam.gov/opp/abc123/view",
    placeOfPerformance: { city: { name: "Washington" }, state: { code: "DC" }, country: { code: "USA" } },
    ...overrides,
  });
  const NOW = new Date("2026-11-18T12:00:00Z");

  it("reads open notices for our kind of work as tenders", () => {
    const [tender] = samTenders([notice()], NOW);
    expect(tender).toMatchObject({
      externalId: "abc123",
      kind: "tender",
      url: "https://sam.gov/opp/abc123/view",
      title: "Agency Website Redesign and Hosting",
      companyName: "GENERAL SERVICES ADMINISTRATION",
      location: "Washington, DC",
      country: "US",
      categories: ["software_development", "web_development"],
      data: { solicitationNumber: "47QTCA26Q0001", naicsCode: "541511", setAside: "Total Small Business Set-Aside (FAR 19.5)", noticeType: "Combined Synopsis/Solicitation" },
    });
    expect(tender.validThrough?.toISOString()).toBe("2026-12-05T22:00:00.000Z");
    expect(JSON.stringify(tender)).not.toMatch(/pointOfContact|@/);
  });

  it("keeps other codes only when the title names our work, and leaves out awards, expired and closed notices", () => {
    expect(samTenders([notice({ naicsCode: "236220", title: "Historic Office Renovation" })], NOW)).toEqual([]);
    expect(samTenders([notice({ naicsCode: "611710", title: "Mobile App Development for Veterans" })], NOW)[0]?.categories).toContain("mobile_development");
    expect(samTenders([notice({ type: "Award Notice" })], NOW)).toEqual([]);
    expect(samTenders([notice({ responseDeadLine: "2026-11-01T17:00:00-05:00" })], NOW)).toEqual([]);
    expect(samTenders([notice({ active: "No" })], NOW)).toEqual([]);
  });

  it("writes dates the way the API takes them", () => {
    expect(samDate(new Date("2026-01-05T00:00:00Z"))).toBe("01/05/2026");
  });
});

describe("Hacker News hiring posts: patterns from the first run", () => {
  const comment = (id: number, text: string) => ({ id, author: "a", created_at_i: 1_793_000_000, text });

  it("never takes a code host, video, form or profile for the company's website", () => {
    const html = (link: string, own = "") =>
      `Acme | Senior Engineer | REMOTE (US)<p><a href="${link}">x</a>${own ? ` <a href="${own}">site</a>` : ""}`;
    for (const link of ["https://github.com/acme/repo", "https://youtu.be/abc", "https://www.linkedin.com/company/acme", "https://forms.gle/xyz", "https://acme.notion.site/jobs"]) {
      expect(hiringPost(comment(1, html(link)), "t")?.companyDomain, link).toBeNull();
    }
    expect(hiringPost(comment(2, html("https://github.com/acme", "https://www.acme.dev/careers")), "t")?.companyDomain).toBe("acme.dev");
  });

  it("finds the company when the header opens with a place", () => {
    expect(hiringPost(comment(3, "Cologne, Germany | UMH | Product Engineer | Full-time | ONSITE (part remote)"), "t")).toMatchObject({ companyName: "UMH", title: "Product Engineer" });
  });

  it("reads a SEEKING FREELANCER post in the hiring thread as a request, not a company's job", () => {
    expect(freelancerRequest(comment(4, "SEEKING FREELANCER | Devops Engineer | Remote - UK or EU"), "t")?.kind).toBe("post");
  });
});

describe("countries in text", () => {
  it("reads Germany as DE, not also as the obsolete DD", () => {
    expect(countriesIn("Cologne, Germany")).toEqual(["DE"]);
    expect(countryCodeOf("Germany")).toBe("DE");
  });
});

describe("Hacker News hiring posts: websites", () => {
  const comment = (id: number, text: string) => ({ id, author: "a", created_at_i: 1_793_000_000, text });

  it("takes the website the header states, and never a short link or app-hosting address", () => {
    expect(hiringPost(comment(1, "Clad (YC W23) | Software Engineer | New York, NY | withclad.com"), "t")?.companyDomain).toBe("withclad.com");
    expect(hiringPost(comment(2, 'GovStar | https://govstar.us | Remote (US) | Security Engineer<p><a href="https://github.com/x">x</a>'), "t")).toMatchObject({ companyDomain: "govstar.us", title: "Security Engineer" });
    for (const link of ["https://grnh.se/abc", "https://me.vercel.app/", "https://acme.netlify.app/jobs"]) {
      expect(hiringPost(comment(3, `Acme | Senior Engineer | REMOTE<p><a href="${link}">x</a>`), "t")?.companyDomain, link).toBeNull();
    }
  });
});

describe("countries: the US abbreviation", () => {
  it("reads US and USA in capitals, never the word us", () => {
    expect(countriesIn("REMOTE (US)")).toEqual(["US"]);
    expect(countriesIn("Remote, USA only")).toEqual(["US"]);
    expect(countriesIn("Join us remotely")).toEqual([]);
    expect(countriesIn("REMOTE (US, Budapest)")).toEqual(["US"]);
  });

  it("never takes a job platform for a hiring company's website", () => {
    const post = (link: string) => ({ id: 9, created_at_i: 1_793_000_000, text: `Acme | Lead Software Engineer | REMOTE (US)<p><a href="${link}">apply</a>` });
    for (const link of ["https://jpmc.fa.oraclecloud.com/hcmUI/x", "https://devitjobs.com/jobs/1", "https://www.welcometothejungle.com/en/companies/acme"]) {
      expect(hiringPost(post(link), "t")?.companyDomain, link).toBeNull();
    }
    expect(hiringPost(post("https://x.com"), "t")?.country).toBe("US");
  });
});
