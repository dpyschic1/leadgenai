/** Central registry of TanStack Query keys, so invalidation never relies on retyped arrays. */
export const queryKeys = {
  me: ["me"] as const,
  referenceData: ["reference-data"] as const,
  services: ["services"] as const,
  scoringProfile: ["scoring-profile"] as const,
};
