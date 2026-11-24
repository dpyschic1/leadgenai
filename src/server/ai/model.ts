import "server-only";
import { createGroq, type GroqLanguageModelChatOptions } from "@ai-sdk/groq";
import { APICallError, RetryError, wrapLanguageModel } from "ai";
import { AppError } from "@/server/http/errors";

/**
 * The single place that knows which AI provider and model we use. Everything else asks for
 * `languageModel()`, so switching to a paid model later (e.g. Claude) changes only this file.
 *
 * Default: Groq's openai/gpt-oss-120b — free tier, and supports strict structured outputs.
 */
export const AI_MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

/**
 * A smaller model for high-volume, simple checks (job-title triage). Groq gives every model its own
 * daily allowance, so these don't use up the main model's quota (200,000 tokens a day on the free plan).
 */
export const FAST_AI_MODEL_ID = process.env.GROQ_FAST_MODEL || "openai/gpt-oss-20b";

/**
 * The main model, falling back to the fast one for the day: Groq's free allowance is per model
 * (200,000 tokens a day each), so when the main model's runs out, the fast model answers the same
 * request with the same instructions and structured output. Every AI feature goes through here.
 */
export function languageModel(kind: "main" | "fast" = "main") {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new AppError("AI_UNAVAILABLE", "AI analysis isn't configured. Add GROQ_API_KEY to the server environment.");
  }
  const groq = createGroq({ apiKey });
  if (kind === "fast" || AI_MODEL_ID === FAST_AI_MODEL_ID) return groq(FAST_AI_MODEL_ID);
  const backup = groq(FAST_AI_MODEL_ID);
  return wrapLanguageModel({
    model: groq(AI_MODEL_ID),
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        // Known to be out for now: straight to the backup, without spending a request on the main model.
        if (Date.now() < mainModelOutUntil) return backup.doGenerate(params);
        try {
          return await doGenerate();
        } catch (error) {
          const wait = dailyLimitWait(error);
          if (wait === null) throw error;
          mainModelOutUntil = Date.now() + wait;
          console.warn(`[ai] ${AI_MODEL_ID} is out of today's allowance for ${Math.round(wait / 60_000)} min; using ${FAST_AI_MODEL_ID}`);
          return backup.doGenerate(params);
        }
      },
    },
  });
}

/** Until when the main model's daily allowance is known to be used up (per server process). */
let mainModelOutUntil = 0;
/** How long to leave the main model alone when Groq doesn't say. */
const DEFAULT_DAILY_WAIT_MS = 30 * 60_000;
const MIN_DAILY_WAIT_MS = 5 * 60_000;

/**
 * How long until a model's daily allowance frees up again, when `error` says it ran out (Groq:
 * "Rate limit reached ... on tokens per day (TPD) ... Please try again in 1m27.696s"); null for
 * any other error, including the per-minute limit. Pure.
 */
export function dailyLimitWait(error: unknown): number | null {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(cause) || cause.statusCode !== 429) return null;
  const message = `${cause.responseBody ?? ""} ${cause.message}`;
  if (!/per day|\b(TPD|RPD)\b/i.test(message)) return null;
  const retry = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message);
  if (!retry || !retry[0].trim().replace(/^try again in/i, "").trim()) return DEFAULT_DAILY_WAIT_MS;
  const ms = ((Number(retry[1] ?? 0) * 60 + Number(retry[2] ?? 0)) * 60 + Number(retry[3] ?? 0)) * 1000;
  // Not less than a few minutes: the window is rolling, and a few tokens freeing up isn't a day's worth.
  return Math.max(ms, MIN_DAILY_WAIT_MS);
}

/**
 * The provider's limit was hit, as an error that tells the user to wait rather than that the AI
 * failed: the per-minute limit (Groq's free plan allows ~8,000 tokens a minute) is a short wait;
 * the daily allowance used up (on the backup model too) is a long one, which background jobs wait
 * an hour for. Null for any other error.
 */
export function providerBusyError(error: unknown): AppError | null {
  // The SDK retries a 429 itself, then reports the last attempt's error inside a RetryError.
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(cause) || cause.statusCode !== 429) return null;
  if (dailyLimitWait(cause) !== null) {
    return new AppError("RATE_LIMITED", "Today's free AI allowance is used up. It frees up again over the next few hours.");
  }
  return new AppError("AI_BUSY", "The AI is busy right now (the free plan allows a few requests a minute). Try again in a minute.");
}

/** Constrained decoding, so the reply always matches the requested schema. */
export const structuredOutputOptions = {
  groq: {
    structuredOutputs: true,
    strictJsonSchema: true,
    reasoningEffort: "medium",
  } satisfies GroqLanguageModelChatOptions,
};
