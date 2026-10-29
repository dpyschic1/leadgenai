"use client";

import { useQuery } from "@tanstack/react-query";
import { referenceDataApi } from "@/lib/api/reference-data";
import { queryKeys } from "./query-keys";

/** Global lookup lists. They change only with a migration, so they never go stale in a session. */
export function useReferenceData() {
  return useQuery({
    queryKey: queryKeys.referenceData,
    queryFn: ({ signal }) => referenceDataApi.get(signal),
    staleTime: Infinity,
  });
}

/** Display names for lookup slugs; falls back to the slug while reference data loads. */
export function useLookupNames() {
  const { data } = useReferenceData();
  const index = (rows: { slug: string; name: string }[] | undefined) => new Map(rows?.map((r) => [r.slug, r.name]));
  const industries = index(data?.industries);
  const jobFunctions = index(data?.jobFunctions);
  const categories = index(data?.serviceCategories);
  const signalTypes = new Map(data?.signalTypes.map((t) => [t.slug, t]));
  const signalCategories = index(data?.signalCategories);
  const opportunityTypes = index(data?.opportunityTypes);
  return {
    industry: (slug: string) => industries.get(slug) ?? slug,
    jobFunction: (slug: string) => jobFunctions.get(slug) ?? slug,
    category: (slug: string) => categories.get(slug) ?? slug,
    signalType: (slug: string) => signalTypes.get(slug)?.name ?? slug,
    /** The taxonomy group a signal type belongs to, e.g. "website_redesign" -> "digital". */
    signalCategoryOf: (typeSlug: string) => signalTypes.get(typeSlug)?.categorySlug ?? null,
    signalCategory: (slug: string) => signalCategories.get(slug) ?? slug,
    opportunityType: (slug: string) => opportunityTypes.get(slug) ?? slug,
  };
}
