/**
 * Job boards a company can be connected to. Each provider publishes an official, free, public
 * job-board API, so the jobs are the company's own listings with a live link as evidence.
 * The database enums are built from these arrays.
 */

export const JOB_BOARD_PROVIDERS = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "personio", "breezy"] as const;
export type JobBoardProvider = (typeof JOB_BOARD_PROVIDERS)[number];

export const JOB_BOARD_PROVIDER_LABELS: Record<JobBoardProvider, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workable: "Workable",
  smartrecruiters: "SmartRecruiters",
  personio: "Personio",
  breezy: "Breezy HR",
};

/**
 * What the AI made of a job:
 * - `pending`: not looked at yet (new, or waiting for the next fetch)
 * - `relevant`: matches what you sell; usually recorded as a signal
 * - `skipped`: not relevant, with the reason
 */
export const JOB_TRIAGE_STATES = ["pending", "relevant", "skipped"] as const;
export type JobTriage = (typeof JOB_TRIAGE_STATES)[number];

/** Board names are path segments of the provider's URL, so only these characters are allowed. */
export const BOARD_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
