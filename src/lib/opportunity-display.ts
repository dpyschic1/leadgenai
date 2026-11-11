import type { OpportunitySummary } from "@/lib/api/types";

/** What to call an opportunity: its company, or for an engine discovery with no company, its title. */
export const opportunityName = (o: Pick<OpportunitySummary, "company" | "engine">): string =>
  o.company?.name ?? o.engine?.title ?? "Untitled opportunity";
