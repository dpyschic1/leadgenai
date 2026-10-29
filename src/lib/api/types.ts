/** Response DTOs shared by the route handlers and the client. Only these shapes leave the server. */
import type { memberRole } from "@/db/schema";
import type { ScoreWeights } from "@/lib/validation/scoring";

export type UserRole = (typeof memberRole.enumValues)[number];

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
};

export type Workspace = {
  id: string;
  name: string;
  plan: string;
  timezone: string;
};

/** The signed-in user and their workspace; returned by register, login and GET /workspaces/me. */
export type Me = {
  user: CurrentUser;
  workspace: Workspace;
};

/** An entry in a global lookup table (service categories, industries, job functions). */
export type LookupOption = { slug: string; name: string };

export type ReferenceData = {
  serviceCategories: LookupOption[];
  industries: LookupOption[];
  jobFunctions: LookupOption[];
};

/** Something the workspace sells, with who it is sold to. Empty targeting lists mean "any". */
export type Service = {
  id: string;
  name: string;
  description: string;
  categories: string[];
  targetIndustries: string[];
  targetJobFunctions: string[];
  targetCountries: string[];
  companySizeMin: number | null;
  companySizeMax: number | null;
};

export type ScoringProfile = {
  weights: ScoreWeights;
};
