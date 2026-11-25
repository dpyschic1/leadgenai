import { z } from "zod";

/** JobSpy import (Settings → JobSpy import): the boards it may search and how often. */
export const JOBSPY_BOARDS = ["indeed", "linkedin", "glassdoor", "zip_recruiter"] as const;
export type JobspyBoard = (typeof JOBSPY_BOARDS)[number];

export const JOBSPY_BOARD_LABELS: Record<JobspyBoard, string> = {
  indeed: "Indeed",
  linkedin: "LinkedIn",
  glassdoor: "Glassdoor",
  zip_recruiter: "ZipRecruiter",
};

export const JOBSPY_MAX_RESULTS = 50;
/** Minutes between runs, across all workspaces (one service, one IP). */
export const JOBSPY_COOLDOWN_MINUTES = 30;
/** "Posted within" choices, in hours; null = any time. */
export const JOBSPY_HOURS_OLD = [24, 72, 168, 720] as const;

export const jobspyRunSchema = z.object({
  searchTerm: z.string().trim().min(1, "Enter keywords.").max(200),
  location: z.string().trim().min(1, "Enter a US location.").max(200),
  boards: z.array(z.enum(JOBSPY_BOARDS)).min(1, "Pick at least one board.").transform((b) => [...new Set(b)]),
  resultsPerBoard: z.number().int().min(1).max(JOBSPY_MAX_RESULTS),
  hoursOld: z.union([z.literal(JOBSPY_HOURS_OLD), z.null()]),
});
export type JobspyRunInput = z.input<typeof jobspyRunSchema>;

export const jobspySwitchSchema = z.object({ sendToOpportunities: z.boolean() });
