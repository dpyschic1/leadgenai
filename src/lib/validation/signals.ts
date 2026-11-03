import { z } from "zod";
import { EVIDENCE_LABELS, INTENT_LEVELS, URGENCY_LEVELS, USER_SIGNAL_SOURCES, type SignalSource } from "@/lib/domain/signals";

/** Shared by the record-signal form and the route handlers. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Longest source text the AI analysis accepts (keeps prompts, cost and latency bounded). */
export const MAX_SOURCE_TEXT = 8000;

/** Today in the viewer's timezone as YYYY-MM-DD (the format of `<input type="date">`). */
export function todayIso(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

const nullableUrl = z
  .string()
  .nullable()
  .transform((value) => value?.trim() ?? "")
  .refine((value) => value === "" || z.url({ protocol: /^https?$/ }).safeParse(value).success, "Enter a full link starting with https://")
  .refine((value) => value.length <= 2000, "Link is too long")
  .transform((value) => value || null);

const nullableExcerpt = z
  .string()
  .nullable()
  .transform((value) => value?.trim() ?? "")
  .refine((value) => value.length <= 2000, "Keep the excerpt under 2,000 characters")
  .transform((value) => value || null);

export const signalSchema = z.object({
  signalType: z.string().min(1, "Pick a signal type").max(64),
  intentLevel: z.enum(INTENT_LEVELS),
  urgency: z.enum(URGENCY_LEVELS),
  serviceCategories: z
    .array(z.string().min(1).max(64))
    .max(8, "Pick at most 8 categories")
    .transform((values) => [...new Set(values)]),
  summary: z.string().trim().min(1, "Describe the signal in a sentence").max(500, "Keep the summary under 500 characters"),
  personId: z.uuid().nullable(),
  occurredOn: z
    .string()
    .regex(ISO_DATE, "Enter a date")
    // One day of slack so a viewer ahead of the server's timezone can still pick "today".
    .refine((value) => value <= todayIso(new Date(Date.now() + 86_400_000)), "The date can't be in the future"),
  sourceUrl: nullableUrl,
  excerpt: nullableExcerpt,
  evidenceLabel: z.enum(EVIDENCE_LABELS),
  source: z.enum(USER_SIGNAL_SOURCES),
  confidence: z.number().int().min(0).max(100).nullable(),
});

export const analyzeSignalSchema = z.object({
  companyId: z.uuid(),
  text: z
    .string()
    .trim()
    .min(30, "Paste at least a sentence or two so there's something to analyse")
    .max(MAX_SOURCE_TEXT, `Keep the text under ${MAX_SOURCE_TEXT.toLocaleString("en")} characters`),
  sourceUrl: nullableUrl,
});

export type SignalInput = z.input<typeof signalSchema>;
export type SignalValues = z.output<typeof signalSchema>;
/** A signal found by background ingestion: may also come straight from a data source. */
export type DetectedSignalValues = Omit<SignalValues, "source"> & { source: SignalSource };
export type AnalyzeSignalInput = z.input<typeof analyzeSignalSchema>;
export type AnalyzeSignalValues = z.output<typeof analyzeSignalSchema>;
