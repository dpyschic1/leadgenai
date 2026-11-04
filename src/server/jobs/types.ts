import type { JobBoardProvider } from "@/lib/domain/job-boards";

/** One open job, in the same shape whatever board it came from. */
export type NormalizedJob = {
  externalId: string;
  title: string;
  department: string | null;
  location: string | null;
  url: string;
  /** Plain text. */
  description: string | null;
  postedAt: Date | null;
};

export type JobBoardAdapter = {
  provider: JobBoardProvider;
  /** The board's public jobs URL (fixed host; the token is validated before it is used). */
  endpoint: (token: string) => string;
  /** A cheaper URL that only answers "does this board exist?" (used by board detection). */
  probeEndpoint: (token: string) => string;
  /** The board's public page, linked as the source of what was found on it. */
  boardUrl: (token: string) => string;
  /** Parses the provider's response (JSON, or the raw text for XML feeds) into jobs; throws when the shape is not what we expect. */
  parse: (body: unknown) => NormalizedJob[];
  /** The feed's format; JSON unless stated. */
  format?: "json" | "xml";
  /**
   * The provider answers an unknown board with an empty list instead of a 404 (SmartRecruiters), so
   * a board with no open jobs can't be told from one that doesn't exist: treat it as missing.
   */
  emptyMeansMissing?: boolean;
};
