import "server-only";
import { createGroq, type GroqLanguageModelChatOptions } from "@ai-sdk/groq";
import { APICallError, RetryError } from "ai";
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

export function languageModel(kind: "main" | "fast" = "main") {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new AppError("AI_UNAVAILABLE", "AI analysis isn't configured. Add GROQ_API_KEY to the server environment.");
  }
  return createGroq({ apiKey })(kind === "fast" ? FAST_AI_MODEL_ID : AI_MODEL_ID);
}

/**
 * The provider's per-minute limit was hit (Groq's free plan allows ~8,000 tokens a minute), as an
 * error that tells the user to wait rather than that the AI failed. Null for any other error.
 */
export function providerBusyError(error: unknown): AppError | null {
  // The SDK retries a 429 itself, then reports the last attempt's error inside a RetryError.
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(cause) || cause.statusCode !== 429) return null;
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
