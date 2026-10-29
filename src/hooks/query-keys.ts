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
};
