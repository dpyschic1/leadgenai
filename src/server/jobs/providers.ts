import { z } from "zod";
import type { JobBoardProvider } from "@/lib/domain/job-boards";
import { decodeEntities, htmlToText } from "./html-to-text";
import type { JobBoardAdapter, NormalizedJob } from "./types";

/**
 * Adapters for the public job-board APIs. Each one knows its provider's URL and response shape
 * and nothing else; fetching, limits and storage live in `fetch-jobs.ts` and the service.
 *
 * A job that doesn't match the expected shape is skipped rather than failing the whole board.
 */

const text = z.string().nullish();
const toDate = (value: string | number | null | undefined): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const clean = (value: string | null | undefined): string | null => value?.trim() || null;
const isWebUrl = (value: string) => value.length <= 2000 && z.url({ protocol: /^https?$/ }).safeParse(value).success;

function parseEach<T>(items: unknown[], schema: z.ZodType<T>, map: (item: T) => NormalizedJob | null): NormalizedJob[] {
  return items.flatMap((item) => {
    const result = schema.safeParse(item);
    const job = result.success ? map(result.data) : null;
    // The link becomes the signal's evidence, so it must be a real web address.
    return job && job.title && isWebUrl(job.url) ? [job] : [];
  });
}

// --- Greenhouse: GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true --------------

const greenhouseJob = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  absolute_url: z.string(),
  /** HTML, itself HTML-escaped. */
  content: text,
  first_published: text,
  updated_at: text,
  location: z.object({ name: text }).nullish(),
  departments: z.array(z.object({ name: text })).nullish(),
});

const greenhouse: JobBoardAdapter = {
  provider: "greenhouse",
  endpoint: (token) => `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
  probeEndpoint: (token) => `https://boards-api.greenhouse.io/v1/boards/${token}`,
  boardUrl: (token) => `https://job-boards.greenhouse.io/${token}`,
  parse: (body) =>
    parseEach(z.object({ jobs: z.array(z.unknown()) }).parse(body).jobs, greenhouseJob, (job) => ({
      externalId: String(job.id),
      title: job.title.trim(),
      department: clean(job.departments?.[0]?.name),
      location: clean(job.location?.name),
      url: job.absolute_url,
      description: job.content ? htmlToText(decodeEntities(job.content)) : null,
      postedAt: toDate(job.first_published ?? job.updated_at),
    })),
};

// --- Lever: GET api.lever.co/v0/postings/{token}?mode=json -------------------------------------

const leverJob = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  createdAt: z.number().nullish(),
  descriptionPlain: text,
  additionalPlain: text,
  /** Sections such as "Responsibilities"; `content` is HTML list items. */
  lists: z.array(z.object({ text: text, content: text })).nullish(),
  categories: z.object({ department: text, team: text, location: text }).nullish(),
});

const lever: JobBoardAdapter = {
  provider: "lever",
  endpoint: (token) => `https://api.lever.co/v0/postings/${token}?mode=json`,
  probeEndpoint: (token) => `https://api.lever.co/v0/postings/${token}?mode=json&limit=1`,
  boardUrl: (token) => `https://jobs.lever.co/${token}`,
  parse: (body) =>
    parseEach(z.array(z.unknown()).parse(body), leverJob, (job) => {
      const sections = (job.lists ?? []).map((list) =>
        [clean(list.text), list.content ? htmlToText(list.content) : null].filter(Boolean).join("\n"),
      );
      const description = [job.descriptionPlain, ...sections, job.additionalPlain]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join("\n\n");
      return {
        externalId: job.id,
        title: job.text.trim(),
        department: clean(job.categories?.department) ?? clean(job.categories?.team),
        location: clean(job.categories?.location),
        url: job.hostedUrl,
        description: description || null,
        postedAt: toDate(job.createdAt),
      };
    }),
};

// --- Ashby: GET api.ashbyhq.com/posting-api/job-board/{token} ----------------------------------

const ashbyJob = z.object({
  id: z.string(),
  title: z.string(),
  jobUrl: z.string(),
  department: text,
  team: text,
  location: text,
  publishedAt: text,
  isListed: z.boolean().nullish(),
  descriptionPlain: text,
});

const ashby: JobBoardAdapter = {
  provider: "ashby",
  endpoint: (token) => `https://api.ashbyhq.com/posting-api/job-board/${token}`,
  probeEndpoint: (token) => `https://api.ashbyhq.com/posting-api/job-board/${token}`,
  boardUrl: (token) => `https://jobs.ashbyhq.com/${token}`,
  parse: (body) =>
    parseEach(z.object({ jobs: z.array(z.unknown()) }).parse(body).jobs, ashbyJob, (job) =>
      job.isListed === false
        ? null
        : {
            externalId: job.id,
            title: job.title.trim(),
            department: clean(job.department) ?? clean(job.team),
            location: clean(job.location),
            url: job.jobUrl,
            description: clean(job.descriptionPlain),
            postedAt: toDate(job.publishedAt),
          },
    ),
};

// --- Workable: GET apply.workable.com/api/v1/widget/accounts/{slug}?details=true --------------
// The public feed behind Workable's own careers-page embed: the whole board in one reply, with
// descriptions. Account names are lowercase (the API treats them case-sensitively). A job open in
// several places appears once per place, so rows are merged by shortcode.

const workableLocation = z.object({ city: text, region: text, country: text, hidden: z.boolean().nullish() });
const workableJob = z.object({
  shortcode: z.string(),
  title: z.string(),
  url: z.string(),
  department: text,
  telecommuting: z.boolean().nullish(),
  description: text,
  published_on: text,
  created_at: text,
  city: text,
  state: text,
  country: text,
  locations: z.array(workableLocation).nullish(),
});
type WorkableJob = z.infer<typeof workableJob>;

const placeOf = (p: { city?: string | null; region?: string | null; state?: string | null; country?: string | null }) =>
  [p.city, p.region ?? p.state, p.country].map(clean).filter(Boolean).join(", ");

/** "Athens, Attica, Greece; London, United Kingdom; Remote": every listed place, once. */
function workableLocations(rows: WorkableJob[]): string | null {
  const places = rows.flatMap((row) => {
    const listed = (row.locations ?? []).filter((l) => !l.hidden).map(placeOf);
    return listed.length > 0 ? listed : [placeOf(row)];
  });
  if (rows.some((row) => row.telecommuting)) places.push("Remote");
  return clean([...new Set(places.filter(Boolean))].join("; "));
}

const workableSlug = (token: string) => token.toLowerCase();

const workable: JobBoardAdapter = {
  provider: "workable",
  endpoint: (token) => `https://apply.workable.com/api/v1/widget/accounts/${workableSlug(token)}?details=true`,
  // The account record: 404 for a board that doesn't exist, small for one that does.
  probeEndpoint: (token) => `https://apply.workable.com/api/v1/accounts/${workableSlug(token)}`,
  boardUrl: (token) => `https://apply.workable.com/${workableSlug(token)}/`,
  parse: (body) => {
    const rows = z.object({ jobs: z.array(z.unknown()) }).parse(body).jobs.flatMap((item) => {
      const parsed = workableJob.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
    const byShortcode = new Map<string, WorkableJob[]>();
    for (const row of rows) byShortcode.set(row.shortcode, [...(byShortcode.get(row.shortcode) ?? []), row]);
    return parseEach([...byShortcode.values()], z.array(workableJob).min(1), (same) => {
      const job = same[0];
      return {
        externalId: job.shortcode,
        title: job.title.trim(),
        department: clean(job.department),
        location: workableLocations(same),
        url: job.url,
        description: job.description ? htmlToText(job.description) : null,
        postedAt: toDate(job.published_on ?? job.created_at),
      };
    });
  },
};

// --- SmartRecruiters: GET api.smartrecruiters.com/v1/companies/{id}/postings -------------------
// Public Posting API. An unknown company answers 200 with no postings, so an empty board counts as
// missing. The list has no descriptions (the AI title check runs on titles); the newest 100 are read.

const smartRecruitersJob = z.object({
  id: z.string(),
  name: z.string(),
  releasedDate: text,
  company: z.object({ identifier: z.string() }),
  location: z.object({ fullLocation: text, city: text, country: text, remote: z.boolean().nullish() }).nullish(),
  department: z.object({ label: text }).nullish(),
});

const smartRecruiters: JobBoardAdapter = {
  provider: "smartrecruiters",
  endpoint: (token) => `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`,
  probeEndpoint: (token) => `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=1`,
  boardUrl: (token) => `https://careers.smartrecruiters.com/${token}`,
  emptyMeansMissing: true,
  parse: (body) =>
    parseEach(z.object({ content: z.array(z.unknown()) }).parse(body).content, smartRecruitersJob, (job) => ({
      externalId: job.id,
      title: job.name.trim(),
      department: clean(job.department?.label),
      location: [clean(job.location?.fullLocation) ?? clean(job.location?.city), job.location?.remote ? "Remote" : null].filter(Boolean).join("; ") || null,
      url: `https://jobs.smartrecruiters.com/${job.company.identifier}/${job.id}`,
      description: null,
      postedAt: toDate(job.releasedDate),
    })),
};

// --- Personio: GET {slug}.jobs.personio.de/xml (XML feed) ---------------------------------------
// The feed behind Personio's own careers pages. Only its fixed fields are read, so no XML library.

const xmlTag = (block: string, tag: string) => {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeEntities(match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")).trim() || null : null;
};

/** Jobs from a Personio XML feed, linked to their page on the board. Pure. */
export function parsePersonio(xml: string, token: string): NormalizedJob[] {
  if (!/<workzag-jobs\s*\/?>/.test(xml)) throw new Error("Not a Personio jobs feed.");
  return [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].flatMap(([, block]) => {
    const id = xmlTag(block, "id");
    const title = xmlTag(block, "name");
    if (!id || !title) return [];
    const descriptions = [...block.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)]
      .map(([, d]) => [xmlTag(d, "name"), htmlToText(xmlTag(d, "value") ?? "")].filter(Boolean).join("\n"))
      .filter(Boolean);
    return [
      {
        externalId: id,
        title,
        department: xmlTag(block, "department"),
        location: xmlTag(block, "office"),
        url: `https://${token}.jobs.personio.de/job/${id}`,
        description: descriptions.join("\n\n") || null,
        postedAt: toDate(xmlTag(block, "createdAt")),
      },
    ];
  });
}

const personio: JobBoardAdapter = {
  provider: "personio",
  endpoint: (token) => `https://${token}.jobs.personio.de/xml?language=en`,
  probeEndpoint: (token) => `https://${token}.jobs.personio.de/xml`,
  boardUrl: (token) => `https://${token}.jobs.personio.de/`,
  format: "xml",
  // The token is needed for job links, so the fetcher passes it with the text.
  parse: (body) => {
    const { xml, token } = body as { xml: string; token: string };
    return parsePersonio(xml, token);
  },
};

// --- Breezy HR: GET {slug}.breezy.hr/json --------------------------------------------------------
// The public list behind a Breezy careers page. No descriptions in the list; titles are judged.

const breezyJob = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  published_date: text,
  department: text,
  location: z.object({ name: text, is_remote: z.boolean().nullish(), country: z.object({ name: text }).nullish() }).nullish(),
});

const breezy: JobBoardAdapter = {
  provider: "breezy",
  endpoint: (token) => `https://${token}.breezy.hr/json`,
  probeEndpoint: (token) => `https://${token}.breezy.hr/json`,
  boardUrl: (token) => `https://${token}.breezy.hr/`,
  parse: (body) =>
    parseEach(z.array(z.unknown()).parse(body), breezyJob, (job) => ({
      externalId: job.id,
      title: job.name.trim(),
      department: clean(job.department),
      location:
        [clean(job.location?.name) && `${job.location!.name}${job.location?.country?.name ? `, ${job.location.country.name}` : ""}`, job.location?.is_remote ? "Remote" : null]
          .filter(Boolean)
          .join("; ") || null,
      url: job.url,
      description: null,
      postedAt: toDate(job.published_date),
    })),
};

export const JOB_BOARD_ADAPTERS: Record<JobBoardProvider, JobBoardAdapter> = { greenhouse, lever, ashby, workable, smartrecruiters: smartRecruiters, personio, breezy };
