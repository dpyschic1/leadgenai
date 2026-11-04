import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-to-text";
import { JOB_BOARD_ADAPTERS, parsePersonio } from "./providers";

/** Trimmed copies of real responses (shapes checked against the live APIs, Nov 2026). */

describe("greenhouse adapter", () => {
  const body = {
    jobs: [
      {
        id: 8172508,
        title: " Senior React Engineer ",
        absolute_url: "https://stripe.com/jobs/search?gh_jid=8172508",
        content: "&lt;h2&gt;About us&lt;/h2&gt;\n&lt;p&gt;We&amp;rsquo;re hiring &lt;strong&gt;three&lt;/strong&gt; engineers.&lt;/p&gt;",
        first_published: "2026-09-03T13:32:53-04:00",
        updated_at: "2026-10-29T10:42:09-04:00",
        location: { name: "Dublin" },
        departments: [{ name: "Engineering" }],
      },
      { id: 2, title: "No link", absolute_url: "javascript:alert(1)" },
      { title: "Missing id" },
    ],
    meta: { total: 3 },
  };

  it("normalises jobs, decoding the escaped HTML description", () => {
    const [job, ...rest] = JOB_BOARD_ADAPTERS.greenhouse.parse(body);
    expect(rest).toEqual([]);
    expect(job).toEqual({
      externalId: "8172508",
      title: "Senior React Engineer",
      department: "Engineering",
      location: "Dublin",
      url: "https://stripe.com/jobs/search?gh_jid=8172508",
      description: "About us\nWe’re hiring three engineers.",
      postedAt: new Date("2026-09-03T17:32:53Z"),
    });
  });

  it("rejects a response that isn't a job list", () => {
    expect(() => JOB_BOARD_ADAPTERS.greenhouse.parse({ error: "nope" })).toThrow();
  });
});

describe("lever adapter", () => {
  it("joins the description sections and reads the millisecond timestamp", () => {
    const [job] = JOB_BOARD_ADAPTERS.lever.parse([
      {
        id: "ad208490",
        text: "QA Engineer",
        hostedUrl: "https://jobs.lever.co/acme/ad208490",
        createdAt: 1788199939703,
        descriptionPlain: "Join our team.",
        lists: [{ text: "What you'll do", content: "<li>Write tests</li><li>Ship</li>" }],
        additionalPlain: "Remote friendly.",
        categories: { team: "Quality", location: "Atlanta, Georgia" },
      },
    ]);
    expect(job.department).toBe("Quality");
    expect(job.location).toBe("Atlanta, Georgia");
    expect(job.postedAt).toEqual(new Date(1788199939703));
    expect(job.description).toBe("Join our team.\n\nWhat you'll do\n• Write tests\n• Ship\n\nRemote friendly.");
  });
});

describe("ashby adapter", () => {
  it("drops unlisted jobs", () => {
    const jobs = JOB_BOARD_ADAPTERS.ashby.parse({
      jobs: [
        {
          id: "a1",
          title: "Engineering Manager",
          jobUrl: "https://jobs.ashbyhq.com/acme/a1",
          department: "Engineering",
          location: "Remote",
          publishedAt: "2024-03-04T14:29:08.532+00:00",
          isListed: true,
          descriptionPlain: " Lead the team. ",
        },
        { id: "a2", title: "Hidden", jobUrl: "https://jobs.ashbyhq.com/acme/a2", isListed: false },
      ],
    });
    expect(jobs.map((j) => j.externalId)).toEqual(["a1"]);
    expect(jobs[0].description).toBe("Lead the team.");
  });
});

describe("workable adapter", () => {
  // Shape from apply.workable.com/api/v1/widget/accounts/{slug}?details=true (checked live, Nov 2026).
  const row = (city: string, country: string) => ({
    title: " Client Experience Coordinator ",
    shortcode: "186545F8C1",
    code: null,
    employment_type: "Full-time",
    telecommuting: false,
    department: "Shared Services",
    url: "https://apply.workable.com/j/186545F8C1",
    published_on: "2026-02-12",
    created_at: "2025-09-30",
    country,
    city,
    state: null,
    locations: [{ country, countryCode: "XX", city, region: null, hidden: false }],
    description: "<h3>Redefining how people live.</h3><p>Join our <strong>team</strong>.</p>",
  });
  const body = {
    name: "Blueground",
    description: null,
    jobs: [
      row("Athens", "Greece"),
      // The same job open in a second place: listed again, once per place.
      row("London", "United Kingdom"),
      { title: "Remote engineer", shortcode: "AB12CD34EF", url: "https://apply.workable.com/j/AB12CD34EF", telecommuting: true, locations: [], country: null, city: null, published_on: null, created_at: "2026-10-01" },
      { title: "Bad link", shortcode: "X", url: "javascript:alert(1)" },
      { title: "No shortcode", url: "https://apply.workable.com/j/1" },
    ],
  };

  it("merges a job listed once per place, keeping every place", () => {
    const jobs = JOB_BOARD_ADAPTERS.workable.parse(body);
    expect(jobs.map((j) => j.externalId)).toEqual(["186545F8C1", "AB12CD34EF"]);
    expect(jobs[0]).toEqual({
      externalId: "186545F8C1",
      title: "Client Experience Coordinator",
      department: "Shared Services",
      location: "Athens, Greece; London, United Kingdom",
      url: "https://apply.workable.com/j/186545F8C1",
      description: "Redefining how people live.\nJoin our team.",
      postedAt: new Date("2026-02-12"),
    });
    expect(jobs[1]).toMatchObject({ location: "Remote", postedAt: new Date("2026-10-01"), description: null });
  });

  it("calls Workable with the lowercase account name, on its own host", () => {
    expect(JOB_BOARD_ADAPTERS.workable.endpoint("Blueground")).toBe("https://apply.workable.com/api/v1/widget/accounts/blueground?details=true");
    expect(JOB_BOARD_ADAPTERS.workable.probeEndpoint("blueground")).toBe("https://apply.workable.com/api/v1/accounts/blueground");
    expect(JOB_BOARD_ADAPTERS.workable.boardUrl("blueground")).toBe("https://apply.workable.com/blueground/");
  });

  it("reads an account with no published jobs as an empty board", () => {
    expect(JOB_BOARD_ADAPTERS.workable.parse({ name: "HelloFresh", jobs: [] })).toEqual([]);
  });
});

describe("smartrecruiters adapter", () => {
  it("reads postings, linking each to its page, with remote roles marked", () => {
    const jobs = JOB_BOARD_ADAPTERS.smartrecruiters.parse({
      totalFound: 1,
      content: [
        {
          id: "744000159658729",
          name: "CG Supervisor ",
          releasedDate: "2026-11-04T15:09:00.494Z",
          company: { identifier: "Ubisoft2", name: "Ubisoft" },
          location: { city: "Montreal", country: "ca", remote: true, fullLocation: "Montreal, QC, Canada" },
          department: { label: "Ubisoft" },
        },
      ],
    });
    expect(jobs).toEqual([
      {
        externalId: "744000159658729",
        title: "CG Supervisor",
        department: "Ubisoft",
        location: "Montreal, QC, Canada; Remote",
        url: "https://jobs.smartrecruiters.com/Ubisoft2/744000159658729",
        description: null,
        postedAt: new Date("2026-11-04T15:09:00.494Z"),
      },
    ]);
    // Unknown companies answer with an empty list, so an empty board counts as missing.
    expect(JOB_BOARD_ADAPTERS.smartrecruiters.emptyMeansMissing).toBe(true);
  });
});

describe("personio adapter", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
  <id>1676226</id>
  <office>London</office>
  <department>Engineering</department>
  <name>Senior React Developer</name>
  <jobDescriptions><jobDescription><name>Your mission</name><value><![CDATA[<p>Build our <b>booking</b> app.</p>]]></value></jobDescription></jobDescriptions>
  <createdAt>2026-10-10T11:33:38+00:00</createdAt>
</position>
<position><id>2</id></position>
</workzag-jobs>`;

  it("reads the XML feed's fixed fields, with the description sections as text", () => {
    expect(parsePersonio(xml, "acme")).toEqual([
      {
        externalId: "1676226",
        title: "Senior React Developer",
        department: "Engineering",
        location: "London",
        url: "https://acme.jobs.personio.de/job/1676226",
        description: "Your mission\nBuild our booking app.",
        postedAt: new Date("2026-10-10T11:33:38+00:00"),
      },
    ]);
    expect(parsePersonio("<workzag-jobs></workzag-jobs>", "acme")).toEqual([]);
    expect(() => parsePersonio("<html>Not found</html>", "acme")).toThrow();
  });
});

describe("breezy adapter", () => {
  it("reads the public list with each job's own link", () => {
    expect(
      JOB_BOARD_ADAPTERS.breezy.parse([
        {
          id: "98323abf2296",
          name: "QA Engineer",
          url: "https://acme.breezy.hr/p/98323abf2296-qa-engineer",
          published_date: "2026-10-15T14:37:22.684Z",
          department: "Engineering",
          location: { name: "Austin, TX", is_remote: true, country: { name: "United States", id: "US" } },
        },
      ]),
    ).toEqual([
      {
        externalId: "98323abf2296",
        title: "QA Engineer",
        department: "Engineering",
        location: "Austin, TX, United States; Remote",
        url: "https://acme.breezy.hr/p/98323abf2296-qa-engineer",
        description: null,
        postedAt: new Date("2026-10-15T14:37:22.684Z"),
      },
    ]);
  });
});

describe("htmlToText", () => {
  it("keeps paragraphs and bullets, drops tags, scripts and extra space", () => {
    expect(htmlToText("<p>Hello&nbsp; <b>world</b></p><script>x()</script><ul><li>One</li><li>Two &amp; three</li></ul>")).toBe(
      "Hello world\n• One\n• Two & three",
    );
  });

  it("decodes numeric entities", () => {
    expect(htmlToText("Caf&#233; &#x2014; ok")).toBe("Café — ok");
  });
});
