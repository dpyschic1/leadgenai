/** Central registry of TanStack Query keys, so invalidation never relies on retyped arrays. */
export const queryKeys = {
  me: ["me"] as const,
  referenceData: ["reference-data"] as const,
  services: ["services"] as const,
  scoringProfile: ["scoring-profile"] as const,
  /** Prefix of every companies-list query, whatever the search. */
  companyLists: ["companies"] as const,
  companies: (search: string) => ["companies", { search }] as const,
  company: (id: string) => ["company", id] as const,
  /** Prefix of every signals query (per company and recent). */
  signals: ["signals"] as const,
  companySignals: (companyId: string) => ["signals", "company", companyId] as const,
  recentSignals: (limit: number) => ["signals", "recent", limit] as const,
};
