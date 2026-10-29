import "server-only";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { industries, jobFunctions, opportunityTypes, serviceCategories, signalCategories, signalTypes } from "@/db/schema";
import type { ReferenceData } from "@/lib/api/types";
import { SIGNAL_CATEGORY_ORDER } from "@/lib/domain/signals";

/** Unknown (newly seeded) categories sort after the known ones. */
const categoryRank = (slug: string) => {
  const index = (SIGNAL_CATEGORY_ORDER as readonly string[]).indexOf(slug);
  return index === -1 ? SIGNAL_CATEGORY_ORDER.length : index;
};

/** Global lookup lists used by the forms and the AI analysis. */
export async function getReferenceData(): Promise<ReferenceData> {
  const [categoryRows, industryRows, jobFunctionRows, signalCategoryRows, signalTypeRows, opportunityTypeRows] = await Promise.all([
    db.select().from(serviceCategories).orderBy(asc(serviceCategories.name)),
    db.select().from(industries).orderBy(asc(industries.name)),
    db.select().from(jobFunctions).orderBy(asc(jobFunctions.name)),
    db.select().from(signalCategories),
    db.select().from(signalTypes).orderBy(asc(signalTypes.name)),
    db.select().from(opportunityTypes).orderBy(asc(opportunityTypes.name)),
  ]);
  return {
    serviceCategories: categoryRows,
    industries: industryRows,
    jobFunctions: jobFunctionRows,
    signalCategories: signalCategoryRows.sort(
      (a, b) => categoryRank(a.slug) - categoryRank(b.slug) || a.name.localeCompare(b.name),
    ),
    signalTypes: signalTypeRows,
    opportunityTypes: opportunityTypeRows,
  };
}
