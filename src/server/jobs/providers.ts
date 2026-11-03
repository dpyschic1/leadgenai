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

export const JOB_BOARD_ADAPTERS: Record<JobBoardProvider, JobBoardAdapter> = { greenhouse, lever, ashby };
