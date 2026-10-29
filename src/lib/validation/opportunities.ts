import { z } from "zod";
import { OPPORTUNITY_STATUSES, STATUS_GROUPS, type StatusGroup } from "@/lib/domain/opportunities";

/** Shared by the opportunity pages and the route handlers. */

export const opportunityListQuerySchema = z.object({
  group: z.enum(Object.keys(STATUS_GROUPS) as [StatusGroup, ...StatusGroup[]]).default("open"),
  q: z.string().trim().max(200).optional(),
});

export const updateOpportunitySchema = z
  .object({
    status: z.enum(OPPORTUNITY_STATUSES).optional(),
    notes: z
      .string()
      .nullable()
      .transform((value) => value?.trim() || null)
      .refine((value) => value === null || value.length <= 5000, "Keep notes under 5,000 characters")
      .optional(),
  })
  .refine((value) => value.status !== undefined || value.notes !== undefined, "Nothing to update");

export type OpportunityListQuery = z.input<typeof opportunityListQuerySchema>;
export type UpdateOpportunityInput = z.input<typeof updateOpportunitySchema>;
export type UpdateOpportunityValues = z.output<typeof updateOpportunitySchema>;
