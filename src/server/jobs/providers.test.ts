import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-to-text";
import { JOB_BOARD_ADAPTERS } from "./providers";

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
