import "server-only";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { ycCompanies } from "@/db/schema";
import type { DiscoveredItem, DiscoveryProvider } from "../types";

/**
 * Companies in a recent Y Combinator batch that are hiring, from the YC directory we already hold.
 * Being funded alone says nothing about needing outside help; funded and hiring does. YC invests in
 * every batch company, but the directory is not evidence of a specific round or amount, so these are
 * "unverified" with no amount, and the date is the batch's start (approximate).
 *
 * "Hiring" alone doesn't say for what, so only startups whose open roles are in the shared job pool
 * are listed, with those roles and their service categories: the runner keeps one only when a role
 * fits a service the workspace sells.
 */

const MAX_ROLES = 5;

type OpenRoles = { titles: string[]; categories: string[] };

/** The open roles of these YC startups' job boards in the shared pool, newest first, with their categories. */
async function openRoles(ids: number[]): Promise<Map<number, OpenRoles>> {
  const result = new Map<number, OpenRoles>();
  if (ids.length === 0) return result;
  const rows = await db.execute<{ id: number; title: string; categories: string[] | null }>(sql`
    select y.id, j.title, array_agg(c.category_slug) filter (where c.category_slug is not null) as categories
    from yc_companies y
    join board_jobs j on j.provider = y.board_provider and j.board_token = y.board_token and j.closed_at is null
    left join board_job_categories c on c.board_job_id = j.id
    where y.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    group by y.id, j.id
    order by coalesce(j.posted_at, j.first_seen_at) desc`);
  for (const r of rows) {
    const roles = result.get(Number(r.id)) ?? { titles: [], categories: [] };
    const categories = r.categories ?? [];
    if (categories.length > 0 && roles.titles.length < MAX_ROLES && !roles.titles.includes(r.title)) roles.titles.push(r.title);
    for (const c of categories) if (!roles.categories.includes(c)) roles.categories.push(c);
    result.set(Number(r.id), roles);
  }
  return result;
}

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

    const recent = rows.filter((r) => {
      const date = batchStart(r.batch);
      // A batch that has not started yet is not funding that has happened.
      return date !== null && date >= cutoff && date <= today;
    });
    const roles = await openRoles(recent.filter((r) => r.boardToken).map((r) => r.id));

    const items: DiscoveredItem[] = [];
    for (const r of recent) {
      const date = batchStart(r.batch)!;
      const open = roles.get(r.id);
      // What it is hiring for is unknown: no evidence it needs any particular service.
      if (!open || open.titles.length === 0) continue;
      items.push({
        capability: "funded",
        category: "funded_company",
        sourceSlug: "yc_directory",
        platform: "Y Combinator",
        externalId: `yc-${r.id}`,
        url: r.url,
        title: `${r.name} joined Y Combinator ${r.batch} and is hiring: ${open.titles.slice(0, 3).join(", ")}`.slice(0, 300),
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
        metadata: {
          batch: r.batch,
          approximateDate: true,
          teamSize: r.teamSize,
          isHiring: r.isHiring,
          website: r.website,
          // The roles it is hiring for and the services they point to: what the runner matches on.
          roles: open.titles,
          jobCategories: open.categories,
        },
      });
    }
    return items;
  },
};
