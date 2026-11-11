import "server-only";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { ycCompanies } from "@/db/schema";
import type { DiscoveredItem, DiscoveryProvider } from "../types";

/**
 * Companies in a recent Y Combinator batch that are hiring, from the YC directory we already hold.
 * Being funded alone says nothing about needing outside help; funded and hiring does. YC invests in
 * every batch company, but the directory is not evidence of a specific round or amount, so these are
 * "unverified" with no amount, and the date is the batch's start (approximate).
 */

const SEASON_START: Record<string, string> = { W: "01-01", X: "03-01", S: "06-01", F: "09-01" };

/** "S26" -> "2026-06-01"; null for batches in a format we don't know. */
export function batchStart(batch: string | null): string | null {
  const m = batch?.match(/^([WXSF])(\d{2})$/) ?? batch?.match(/^(Winter|Spring|Summer|Fall) (\d{4})$/);
  if (!m) return null;
  const season = m[1].length === 1 ? m[1] : m[1][0] === "S" && m[1] === "Spring" ? "X" : m[1][0];
  const year = m[2].length === 2 ? `20${m[2]}` : m[2];
  const start = SEASON_START[season];
  return start ? `${year}-${start}` : null;
}

export const ycBatches: DiscoveryProvider = {
  slug: "yc_directory",
  name: "Y Combinator batches",
  capability: "funded",
  async discover({ targeting, now }) {
    // Only recent batches: an older batch is not "recently funded".
    const cutoff = new Date(now.getTime() - 400 * 86_400_000).toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    const rows = await db
      .select()
      .from(ycCompanies)
      .where(
        and(
          eq(ycCompanies.status, "Active"),
          eq(ycCompanies.isHiring, true),
          isNotNull(ycCompanies.batch),
          targeting.countries.length ? inArray(ycCompanies.country, targeting.countries) : undefined,
        ),
      )
      .orderBy(desc(ycCompanies.launchedAt))
      .limit(400);

    const items: DiscoveredItem[] = [];
    for (const r of rows) {
      const date = batchStart(r.batch);
      // A batch that has not started yet is not funding that has happened.
      if (!date || date < cutoff || date > today) continue;
      items.push({
        capability: "funded",
        category: "funded_company",
        sourceSlug: "yc_directory",
        platform: "Y Combinator",
        externalId: `yc-${r.id}`,
        url: r.url,
        title: `${r.name} joined Y Combinator ${r.batch} and is hiring`,
        text: [r.oneLiner, r.longDescription].filter(Boolean).join("\n"),
        postedAt: null,
        buyerName: null,
        buyerProfileUrl: null,
        companyName: r.name,
        companyDomain: r.domain,
        country: r.country,
        city: null,
        industry: r.industry,
        remote: null,
        clientType: "company",
        budget: null,
        funding: { amountUsd: null, stage: `Y Combinator ${r.batch}`, date, investors: ["Y Combinator"] },
        intentHint: null,
        verification: "unverified",
        metadata: { batch: r.batch, approximateDate: true, teamSize: r.teamSize, isHiring: r.isHiring, website: r.website },
      });
    }
    return items;
  },
};
