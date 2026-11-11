/**
 * The sales pipeline (Opportunities Engine spec section 12): a workspace-wide, customizable list of
 * stages. Each stage has a kind so Won and Lost stay identifiable for reporting however they are named.
 */

export const STAGE_KINDS = ["open", "won", "lost"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const STAGE_KIND_LABELS: Record<StageKind, string> = { open: "In the pipeline", won: "Won", lost: "Lost" };

/** The spec's suggested starting point; a workspace gets these when it is created and may change them. */
export const DEFAULT_STAGES: { name: string; kind: StageKind }[] = [
  { name: "New", kind: "open" },
  { name: "Contacted", kind: "open" },
  { name: "Responded", kind: "open" },
  { name: "Meeting Scheduled", kind: "open" },
  { name: "Proposal Sent", kind: "open" },
  { name: "Won", kind: "won" },
  { name: "Lost", kind: "lost" },
];

export const MAX_STAGES = 20;
export const MAX_STAGE_NAME = 40;

/** Outcomes by where an opportunity came from. `signal` is the original company-signal flow. */
export type PipelineReportRow = {
  category: "signal" | "intent" | "funded_company" | "freelance_project";
  total: number;
  open: number;
  won: number;
  lost: number;
  archived: number;
  /** won / (won + lost); null until something has closed. */
  winRate: number | null;
};

export type PipelineReport = { rows: PipelineReportRow[]; total: PipelineReportRow };

export type StageRef = { id: string; name: string; kind: StageKind };

/** A stage in the pipeline editor, with how many opportunities sit in it. */
export type PipelineStage = StageRef & { position: number; opportunityCount: number; intake: boolean };

/**
 * The feed's tabs, derived from stage kind: Open = the first open stage (where discoveries land),
 * In progress = every other open stage, Won, and Closed = lost stages plus archived opportunities.
 */
export const STATUS_GROUP_KEYS = ["open", "inProgress", "won", "closed"] as const;
export type StatusGroup = (typeof STATUS_GROUP_KEYS)[number];
