import { z } from "zod";
import { FEEDBACK_VERDICTS } from "@/lib/domain/feedback";

/** Shared by the feedback panel and the route handler. */

export const feedbackSchema = z.object({
  verdict: z.enum(FEEDBACK_VERDICTS, "Pick what's wrong or right about it"),
  reason: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value?.trim() || null)
    .refine((value) => value === null || value.length <= 500, "Keep the reason under 500 characters"),
});

export type FeedbackInput = z.input<typeof feedbackSchema>;
export type FeedbackValues = z.output<typeof feedbackSchema>;
