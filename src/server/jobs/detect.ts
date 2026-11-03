import "server-only";
import { JOB_BOARD_PROVIDERS, type JobBoardProvider } from "@/lib/domain/job-boards";
import { boardExists } from "./fetch-jobs";

/**
 * Board names usually follow the company's domain or name ("stripe.com" → "stripe",
 * "Harbourside Legal" → "harbourside-legal" or "harbourside"). Pure, so it is unit-tested.
 */
export function candidateTokens(company: { name: string; domain: string | null }): string[] {
  const slug = (text: string) =>
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/&/g, " and ");

  const domainLabel = company.domain
    ?.toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[./]/)[0];
  const words = slug(company.name)
    .replace(/\b(inc|ltd|llc|plc|gmbh|limited|corp|co|the|and)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const candidates = [
    domainLabel,
    domainLabel?.replace(/-/g, ""),
    words.join(""),
    words.join("-"),
    words[0],
  ];
  return [...new Set(candidates.filter((c): c is string => !!c && c.length >= 2))].slice(0, 4);
}

/**
 * Tries each provider with each candidate name. Returns the first board that exists, in candidate
 * order (the domain is the strongest hint), or null.
 */
export async function detectBoard(company: {
  name: string;
  domain: string | null;
}): Promise<{ provider: JobBoardProvider; boardToken: string } | null> {
  const attempts = candidateTokens(company).flatMap((boardToken) =>
    JOB_BOARD_PROVIDERS.map((provider) => ({ provider, boardToken })),
  );
  const found = await Promise.all(attempts.map((a) => boardExists(a.provider, a.boardToken)));
  return attempts.find((_, index) => found[index]) ?? null;
}
