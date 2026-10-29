import "server-only";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { industries, jobFunctions, serviceCategories } from "@/db/schema";
import type { ReferenceData } from "@/lib/api/types";

/** Global lookup lists used by the service form. */
export async function getReferenceData(): Promise<ReferenceData> {
  const [categoryRows, industryRows, jobFunctionRows] = await Promise.all([
    db.select().from(serviceCategories).orderBy(asc(serviceCategories.name)),
    db.select().from(industries).orderBy(asc(industries.name)),
    db.select().from(jobFunctions).orderBy(asc(jobFunctions.name)),
  ]);
  return { serviceCategories: categoryRows, industries: industryRows, jobFunctions: jobFunctionRows };
}
