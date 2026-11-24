import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { dailyLimitWait, providerBusyError } from "./model";

/** A 429 as Groq sends it. */
const limited = (message: string) =>
  new APICallError({
    message: "Rate limit reached",
    url: "https://api.groq.com/openai/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 429,
    responseBody: JSON.stringify({ error: { message, type: "tokens", code: "rate_limit_exceeded" } }),
  });

const DAILY =
  "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199481, Requested 722. Please try again in 1h27m41.5s.";
const PER_MINUTE = "Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 900. Please try again in 6.5s.";

describe("the AI's limits", () => {
  it("tells the daily allowance running out from the per-minute limit", () => {
    expect(dailyLimitWait(limited(DAILY))).toBe(((1 * 60 + 27) * 60 + 41.5) * 1000);
    expect(dailyLimitWait(limited(PER_MINUTE))).toBeNull();
    expect(dailyLimitWait(new Error("network down"))).toBeNull();
  });
  it("waits a few minutes at least, and half an hour when Groq doesn't say", () => {
    expect(dailyLimitWait(limited("Rate limit reached on tokens per day (TPD). Please try again in 1m27.6s."))).toBe(5 * 60_000);
    expect(dailyLimitWait(limited("Rate limit reached on requests per day (RPD)."))).toBe(30 * 60_000);
  });
  it("says the allowance is used up, not that the AI is briefly busy", () => {
    expect(providerBusyError(limited(DAILY))?.code).toBe("RATE_LIMITED");
    expect(providerBusyError(limited(PER_MINUTE))?.code).toBe("AI_BUSY");
  });
});
