import "server-only";
import { createGroq, type GroqLanguageModelChatOptions } from "@ai-sdk/groq";
import { AppError } from "@/server/http/errors";

/**
 * The single place that knows which AI provider and model we use. Everything else asks for
 * `languageModel()`, so switching to a paid model later (e.g. Claude) changes only this file.
 *
 * Default: Groq's openai/gpt-oss-120b — free tier, and supports strict structured outputs.
 */
export const AI_MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

export function languageModel() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new AppError("AI_UNAVAILABLE", "AI analysis isn't configured. Add GROQ_API_KEY to the server environment.");
  }
  return createGroq({ apiKey })(AI_MODEL_ID);
}

/** Constrained decoding, so the reply always matches the requested schema. */
export const structuredOutputOptions = {
  groq: {
    structuredOutputs: true,
    strictJsonSchema: true,
    reasoningEffort: "medium",
  } satisfies GroqLanguageModelChatOptions,
};
