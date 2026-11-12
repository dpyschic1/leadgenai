import type { OpportunityFilters } from "@/lib/validation/opportunities";
import type { Pagination } from "@/lib/validation/pagination";

/** Central registry of TanStack Query keys, so invalidation never relies on retyped arrays. */
export const queryKeys = {
  me: ["me"] as const,
  /** Members and pending invitations of the current workspace. */
  team: ["team"] as const,
  invitation: (token: string) => ["invitation", token] as const,
  referenceData: ["reference-data"] as const,
  /** Prefix of every services query, whatever the page. */
  services: ["services"] as const,
  servicePage: (page: Pagination) => ["services", page] as const,
  scoringProfile: ["scoring-profile"] as const,
  engine: ["engine"] as const,
  pipeline: ["pipeline"] as const,
  /** Prefix of every companies-list query, whatever the search. */
  companyLists: ["companies"] as const,
  companies: (search: string, page: Pagination) => ["companies", { search, ...page }] as const,
  company: (id: string) => ["company", id] as const,
  /** Prefix of every signals query (per company and recent). */
  signals: ["signals"] as const,
  companySignals: (companyId: string) => ["signals", "company", companyId] as const,
  recentSignals: (limit: number) => ["signals", "recent", limit] as const,
  dataSources: ["data-sources"] as const,
  companySources: (companyId: string) => ["company-sources", companyId] as const,
  /** Prefix of every opportunity query; invalidate it after anything that changes scores. */
  opportunities: ["opportunities"] as const,
  opportunityList: (group: string, filters: OpportunityFilters, page: Pagination, sort: string) => ["opportunities", "list", group, filters, page, sort] as const,
  /** Under "opportunities", so anything that refreshes opportunities refreshes the Leads page too. */
  leads: (tab: string, q: string, page: Pagination) => ["opportunities", "leads", tab, q, page] as const,
  opportunity: (id: string) => ["opportunities", "detail", id] as const,
  /** The saved lists with their counts. */
  lists: ["lists"] as const,
  /** One list's opportunities: under the opportunities prefix so re-scores and status changes refresh it. */
  list: (id: string) => ["opportunities", "saved-list", id] as const,
};
