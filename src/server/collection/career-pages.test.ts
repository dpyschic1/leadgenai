import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchBlockedError, OffSiteRedirectError, politeGet } from "@/server/sources/http";
import { careerPages } from "./collectors/career-pages";
import { ripplingBoards } from "./collectors/hosted-boards";
import { createFetcher, fetchHome, moveDestination } from "./fetch";

/**
 * The careers collector over the network: websites that redirect to another domain, and careers
 * pages without markup, through the real polite fetch with the network
 * replaced: DNS answers from `ADDRESSES`, and each URL answers from `ROUTES` (robots.txt is absent,
 * so it allows everything). Every test uses its own host names, because the fetch keeps one request
 * a second per site across the whole file; tests that cross several sites get a longer timeout.
 */

const ADDRESSES: Record<string, string> = {};
const ROUTES: Record<string, { status: number; location?: string; body?: string }> = {};

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => [{ address: ADDRESSES[host] ?? "93.184.216.34", family: 4 }]),
  resolveMx: vi.fn(async () => []),
}));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      const url = new URL(input.toString());
      const route = url.pathname === "/robots.txt" ? undefined : ROUTES[url.toString()];
      if (!route) return new Response("", { status: 404 });
      return new Response(route.body ?? "", { status: route.status, headers: route.location ? { location: route.location } : {} });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const fetcher = () => createFetcher({ maxRequests: 20, deadline: Date.now() + 60_000 });
const html = (body: string) => ({ status: 200, body: `<html><body>${body}</body></html>` });

describe("which redirect destinations count as a website's new domain", () => {
  it("accepts a company website on another domain", () => {
    expect(moveDestination("cedana.ai", "https://www.cedana.com/", ["cedana.ai"])).toEqual({ domain: "cedana.com" });
    expect(moveDestination("acme.io", "http://new.acme.co.uk/home", ["acme.io"])).toEqual({ domain: "acme.co.uk" });
  });

  it("refuses unsafe, blocked, parked and looping destinations", () => {
    const refused = (to: string, visited = ["old.com"]) => "refused" in moveDestination("old.com", to, visited);
    for (const to of [
      "http://127.0.0.1/",
      "http://10.0.0.5/admin",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]:8080/",
      "http://localhost:3000/",
      "http://intranet/",
      "https://server.internal/",
      "ftp://files.example.com/",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(refused(to), to).toBe(true);
    }
    for (const to of ["https://www.linkedin.com/company/acme", "https://www.indeed.com/cmp/acme", "https://www.google.com/search?q=acme"]) {
      expect(refused(to), to).toBe(true);
    }
    expect(refused("https://www.hugedomains.com/domain_profile.cfm?d=old.com")).toBe(true);
    expect(refused("https://old.com/en")).toBe(true);
    expect(refused("https://new.com/", ["old.com", "new.com"])).toBe(true);
  });
});

describe("the polite fetch on redirects", () => {
  it("doesn't follow a redirect to another site, and says where it pointed and how it got there", async () => {
    ROUTES["https://pf-old.com/"] = { status: 301, location: "https://pf-old.com/home" };
    ROUTES["https://pf-old.com/home"] = { status: 302, location: "https://www.pf-new.com/" };
    const error = await politeGet("https://pf-old.com/").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OffSiteRedirectError);
    expect(error).toBeInstanceOf(FetchBlockedError);
    expect((error as Error).message).toBe("Redirected off-site to www.pf-new.com");
    expect((error as OffSiteRedirectError).to).toBe("https://www.pf-new.com/");
    expect((error as OffSiteRedirectError).hops).toEqual(["https://pf-old.com/", "https://pf-old.com/home"]);
  });

  it("still refuses a same-site redirect to a private address", async () => {
    ADDRESSES["internal.pf-private.com"] = "10.1.2.3";
    ROUTES["https://pf-private.com/"] = { status: 301, location: "https://internal.pf-private.com/" };
    await expect(politeGet("https://pf-private.com/")).rejects.toThrow("not a public address");
  });

  it("gives up on a redirect loop within a site", async () => {
    ROUTES["https://pf-loop.com/"] = { status: 301, location: "https://pf-loop.com/a" };
    ROUTES["https://pf-loop.com/a"] = { status: 301, location: "https://pf-loop.com/" };
    await expect(politeGet("https://pf-loop.com/")).rejects.toThrow("Too many redirects");
  }, 15_000);
});

describe("following a website to its new domain", () => {
  it("records the move, with the original URL and every hop", async () => {
    ROUTES["https://mv-old.com/"] = { status: 301, location: "https://www.mv-new.com/" };
    ROUTES["https://mv-new.com/"] = html("Welcome");
    const home = await fetchHome("mv-old.com", fetcher());
    expect(home.domain).toBe("mv-new.com");
    expect(home.moves).toEqual([{ from: "https://mv-old.com/", to: "https://www.mv-new.com/", hops: ["https://mv-old.com/"], domain: "mv-new.com" }]);
  });

  it("follows a second move, but not a loop back", async () => {
    ROUTES["https://ch-a.com/"] = { status: 301, location: "https://ch-b.com/" };
    ROUTES["https://ch-b.com/"] = { status: 301, location: "https://ch-c.com/" };
    ROUTES["https://ch-c.com/"] = html("Here now");
    expect((await fetchHome("ch-a.com", fetcher())).moves.map((m) => m.domain)).toEqual(["ch-b.com", "ch-c.com"]);

    ROUTES["https://lp-a.com/"] = { status: 301, location: "https://lp-b.com/" };
    ROUTES["https://lp-b.com/"] = { status: 301, location: "https://lp-a.com/" };
    await expect(fetchHome("lp-a.com", fetcher())).rejects.toThrow("redirect loop back to lp-a.com");
  }, 20_000);

  it("never follows a move to a blocked platform or an unsafe destination", async () => {
    ROUTES["https://bl-old.com/"] = { status: 301, location: "https://www.linkedin.com/company/bl-old" };
    await expect(fetchHome("bl-old.com", fetcher())).rejects.toThrow("platform we never collect from");

    ROUTES["https://ip-old.com/"] = { status: 301, location: "http://169.254.169.254/latest/meta-data" };
    await expect(fetchHome("ip-old.com", fetcher())).rejects.toThrow("an IP address");

    // A domain that resolves to a private address: the new site's own fetch refuses it.
    ADDRESSES["dn-new.com"] = "192.168.1.10";
    ROUTES["https://dn-old.com/"] = { status: 301, location: "https://dn-new.com/" };
    await expect(fetchHome("dn-old.com", fetcher())).rejects.toBeInstanceOf(FetchBlockedError);
  }, 20_000);

  it("the careers collector stops at the old domain and hands the new one on", async () => {
    ROUTES["https://cc-old.com/"] = { status: 308, location: "https://cc-new.com/" };
    ROUTES["https://cc-new.com/"] = html('<a href="/careers">Careers</a>');
    const now = new Date("2026-11-17T12:00:00Z");
    const result = await careerPages.collect({
      target: { id: "t", sourceSlug: "career_pages", targetKey: "cc-old.com", params: {}, cursor: { careersUrl: undefined, redirects: [] }, intervalMinutes: 1440 },
      now,
      deadline: Date.now() + 60_000,
      fetcher: fetcher(),
    });
    expect(result).toMatchObject({ items: [], complete: true, movedTo: { domain: "cc-new.com" }, note: "Website moved to cc-new.com" });
    expect(result.cursor).toMatchObject({
      movedTo: "cc-new.com",
      redirects: [{ from: "https://cc-old.com/", to: "https://cc-new.com/", domain: "cc-new.com", at: now.toISOString() }],
    });
  });

  it("a careers page that now redirects to a job board we read is left to that engine", async () => {
    ROUTES["https://jb-co.com/careers"] = { status: 301, location: "https://jobs.ashbyhq.com/jbco" };
    const result = await careerPages.collect({
      target: { id: "t", sourceSlug: "career_pages", targetKey: "jb-co.com", params: {}, cursor: { careersUrl: "https://jb-co.com/careers" }, intervalMinutes: 1440 },
      now: new Date(),
      deadline: Date.now() + 60_000,
      fetcher: fetcher(),
    });
    expect(result).toMatchObject({ items: [], complete: true, cursor: { jobBoard: "ashby:jbco" } });
    expect(result.movedTo).toBeUndefined();
  });
});

describe("collecting a careers page without markup", () => {
  it("reads the listing's job links, each job's own page, and never a job board elsewhere", async () => {
    const jobPosting = JSON.stringify({ "@type": "JobPosting", title: "Staff Engineer", identifier: "SE-1", datePosted: "2026-11-10" });
    ROUTES["https://hx-co.com/careers"] = html(`
      <a href="/careers/staff-engineer"><span>Staff Engineer</span><span>Austin, TX · Full-time</span></a>
      <a href="/careers/growth-marketer"><span>Growth Marketer</span><span>Remote (US)</span></a>
      <a href="https://www.ycombinator.com/companies/hx/jobs/abc-founding-designer"><strong>Founding Designer</strong><span>$120K–$150K</span></a>`);
    ROUTES["https://hx-co.com/careers/staff-engineer"] = html(`<script type="application/ld+json">${jobPosting}</script><h1>Staff Engineer</h1>`);
    ROUTES["https://hx-co.com/careers/growth-marketer"] = html(`<main><h1>Growth Marketer</h1><h2>About the role</h2>
      <p>In this role you will run our paid campaigns.</p><h2>Requirements</h2><p>3+ years of experience with paid social. Apply today.</p></main>`);

    const result = await careerPages.collect({
      target: { id: "t", sourceSlug: "career_pages", targetKey: "hx-co.com", params: {}, cursor: { careersUrl: "https://hx-co.com/careers" }, intervalMinutes: 1440 },
      now: new Date("2026-11-17T12:00:00Z"),
      deadline: Date.now() + 60_000,
      fetcher: fetcher(),
    });

    expect(result.complete).toBe(true);
    const byTitle = Object.fromEntries(result.items.map((i) => [i.title, i]));
    expect(Object.keys(byTitle).sort()).toEqual(["Founding Designer", "Growth Marketer", "Staff Engineer"]);
    // The job's own page had markup: that is the item, not its card.
    expect(byTitle["Staff Engineer"]).toMatchObject({ extraction: "json_ld", externalId: "hx-co.com:SE-1" });
    // No markup: the card's facts with the description from the job's own page.
    expect(byTitle["Growth Marketer"]).toMatchObject({ extraction: "html", url: "https://hx-co.com/careers/growth-marketer", location: "Remote (US)", remote: true });
    expect(byTitle["Growth Marketer"].text).toContain("run our paid campaigns");
    expect(byTitle["Founding Designer"]).toMatchObject({ extraction: "html", data: { applyUrl: "https://www.ycombinator.com/companies/hx/jobs/abc-founding-designer" } });

    const fetched = vi.mocked(fetch).mock.calls.map(([input]) => input.toString());
    expect(fetched.some((u) => u.includes("ycombinator.com"))).toBe(false);
  }, 20_000);
});

describe("jobs on Gem and Rippling boards", () => {
  const run = (collector: typeof careerPages, targetKey: string, cursor: Record<string, unknown> = {}, params: Record<string, unknown> = {}) =>
    collector.collect({
      target: { id: "t", sourceSlug: collector.slug, targetKey, params, cursor, intervalMinutes: 1440 },
      now: new Date("2026-11-18T12:00:00Z"),
      deadline: Date.now() + 60_000,
      fetcher: fetcher(),
    });

  it("a careers page linking its jobs to Gem hands the board to the Gem collector", async () => {
    ROUTES["https://gb-co.com/careers"] = html(`
      <a href="https://jobs.gem.com/gbco/AAA"><span>Robotics Engineer</span><span>In office</span></a>
      <a href="https://jobs.gem.com/gbco/BBB"><span>Data Operations Lead</span></a>`);
    const result = await run(careerPages, "gb-co.com", { careersUrl: "https://gb-co.com/careers" });
    expect(result.items).toEqual([]);
    expect(result.discovered).toEqual([{ sourceSlug: "gem_board", targetKey: "gbco", params: { company: "gb-co.com", foundOn: "https://jobs.gem.com/gbco/AAA" } }]);
    expect(result.cursor.hostedBoards).toEqual(["gem_board:gbco"]);
    expect(result.handedOver).toEqual(["https://jobs.gem.com/gbco/AAA", "https://jobs.gem.com/gbco/BBB"]);
  });

  it("a home page with no careers page but a Rippling board link hands the board over", async () => {
    ROUTES["https://rb-co.com/"] = html(`<a href="/about">About</a><a href="https://ats.rippling.com/rb-co/jobs">We're hiring</a>`);
    const result = await run(careerPages, "rb-co.com");
    expect(result.discovered?.map((d) => [d.sourceSlug, d.targetKey])).toEqual([["rippling_board", "rb-co"]]);
  });

  it("reads a Rippling board, and each job's own page only once", async () => {
    const page = (props: unknown) => html(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props })}</script>`);
    ROUTES["https://ats.rippling.com/rp-co/jobs"] = page({
      pageProps: {
        dehydratedState: {
          queries: [
            {
              queryKey: ["board", "rp-co", "job-posts"],
              state: {
                data: {
                  totalPages: 1,
                  items: [
                    { id: "old", name: "Platform Engineer", url: "https://ats.rippling.com/rp-co/jobs/old", locations: [{ city: "Austin", stateCode: "TX", countryCode: "US", workplaceType: "ON_SITE" }] },
                    { id: "new", name: "Account Executive", url: "https://ats.rippling.com/rp-co/jobs/new", department: { name: "Sales" }, locations: [{ countryCode: "US", workplaceType: "REMOTE" }] },
                  ],
                },
              },
            },
          ],
        },
      },
    });
    ROUTES["https://ats.rippling.com/rp-co/jobs/new"] = page({
      pageProps: { apiData: { jobPost: { description: { role: "<p>Sell our product.</p>" }, createdOn: "2026-11-01T00:00:00Z", employmentType: { id: "Salaried, full-time" } } } },
    });
    const result = await run(ripplingBoards, "rp-co", { posted: { old: "2026-10-01T00:00:00Z" } }, { company: "rp-co.com" });
    expect(result.complete).toBe(true);
    const [old, fresh] = result.items;
    expect(old).toMatchObject({ externalId: "old", title: "Platform Engineer", location: "Austin, TX, US", country: "US", remote: false, text: null, companyDomain: "rp-co.com" });
    expect(old.postedAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(fresh).toMatchObject({ externalId: "new", text: "Sell our product.", country: "US", remote: true, data: { departments: ["Sales"], employmentType: ["Salaried, full-time"] } });
    expect(result.cursor).toEqual({ posted: { old: "2026-10-01T00:00:00Z", new: "2026-11-01T00:00:00Z" } });
    const fetched = vi.mocked(fetch).mock.calls.map(([input]) => input.toString());
    expect(fetched).not.toContain("https://ats.rippling.com/rp-co/jobs/old");
  }, 20_000);
});
