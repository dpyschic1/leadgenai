import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import type { CollectedItemKind } from "@/lib/domain/collection";

/**
 * Our own index of everything collected (jobs, posts, tenders): full-text search in Postgres over
 * each item's title, company and text, with the filters engines match on. Uses the GIN index
 * `collected_items_search_idx`, whose expression `DOCUMENT` repeats exactly. Read-only.
 */

export type CollectedSearch = {
  /** Words as people type them: `react "web app" -wordpress`, `seo or "google ads"`. Empty: everything, newest first. */
  query?: string;
  kinds?: CollectedItemKind[];
  /** Service category slugs; an item matches when it has any of them. */
  categories?: string[];
  country?: string;
  remote?: boolean;
  /** Closed items and copies of an item are left out unless asked for. */
  includeClosed?: boolean;
  includeDuplicates?: boolean;
  limit?: number;
  offset?: number;
};

export type CollectedHit = {
  id: string;
  kind: CollectedItemKind;
  sourceSlug: string;
  title: string;
  url: string;
  companyName: string | null;
  companyDomain: string | null;
  location: string | null;
  country: string | null;
  remote: boolean | null;
  postedAt: Date | null;
  firstSeenAt: Date;
  closedAt: Date | null;
  categories: string[];
  /** Words around the match in the text (matches between « »); null when the text doesn't match (or no words). */
  snippet: string | null;
  rank: number;
};

const MAX_LIMIT = 200;

/** The searched text, exactly as the index is built on it. */
const DOCUMENT = sql`(setweight(to_tsvector('english', i.title), 'A') || setweight(to_tsvector('english', coalesce(i.company_name, '')), 'B') || setweight(to_tsvector('english', coalesce(i.body, '')), 'C'))`;

/**
 * Items matching the search, best first: how well the words match, halved for each month since the
 * item was posted (or first seen), so a fresh good match beats an old one. Without words, newest first.
 */
export async function searchCollected(search: CollectedSearch = {}): Promise<CollectedHit[]> {
  const words = search.query?.trim() ?? "";
  const query = sql`websearch_to_tsquery('english', ${words})`;
  const age = sql`extract(epoch from now() - coalesce(i.posted_at, i.first_seen_at)) / 2592000`;
  const filters: SQL[] = [];
  if (words) filters.push(sql`${DOCUMENT} @@ ${query}`);
  if (search.kinds?.length) filters.push(sql`i.kind in (${sql.join(search.kinds.map((k) => sql`${k}`), sql`, `)})`);
  if (search.categories?.length)
    filters.push(sql`exists (select 1 from collected_item_categories c where c.item_id = i.id and c.category_slug in (${sql.join(search.categories.map((c) => sql`${c}`), sql`, `)}))`);
  if (search.country) filters.push(sql`i.country = ${search.country.toUpperCase()}`);
  if (search.remote !== undefined) filters.push(sql`i.remote = ${search.remote}`);
  if (!search.includeClosed) filters.push(sql`i.closed_at is null`);
  if (!search.includeDuplicates) filters.push(sql`i.duplicate_of is null`);
  const where = filters.length ? sql`where ${sql.join(filters, sql` and `)}` : sql``;
  const rank = words ? sql`ts_rank_cd(${DOCUMENT}, ${query}) * power(0.5, greatest(${age}, 0))` : sql`0`;
  const limit = Math.min(Math.max(1, search.limit ?? 50), MAX_LIMIT);

  const rows = await db.execute<Omit<CollectedHit, "rank" | "postedAt" | "firstSeenAt" | "closedAt"> & { rank: string; postedAt: string | null; firstSeenAt: string; closedAt: string | null }>(sql`
    select hit.*,
      case when ${words} <> '' and to_tsvector('english', coalesce(item.body, '')) @@ ${query}
        then trim(regexp_replace(ts_headline('english', item.body, ${query}, 'StartSel=«,StopSel=»,MaxWords=30,MinWords=12,MaxFragments=1'), '\\s+', ' ', 'g')) end as snippet
    from (
      select i.id, i.kind, i.source_slug as "sourceSlug", i.title, i.url, i.company_name as "companyName",
        i.company_domain as "companyDomain", i.location, i.country, i.remote, i.posted_at as "postedAt",
        i.first_seen_at as "firstSeenAt", i.closed_at as "closedAt",
        coalesce((select array_agg(c.category_slug order by c.category_slug) from collected_item_categories c where c.item_id = i.id), '{}') as categories,
        ${rank} as rank
      from collected_items i
      ${where}
      order by rank desc, coalesce(i.posted_at, i.first_seen_at) desc, i.id
      limit ${limit} offset ${Math.max(0, search.offset ?? 0)}
    ) hit
    join collected_items item on item.id = hit.id
    order by hit.rank desc, coalesce(hit."postedAt", hit."firstSeenAt") desc, hit.id`);

  // Snippets are made only for the page of hits, never for every match.
  return rows.map((row) => ({
    ...row,
    rank: Number(row.rank),
    postedAt: row.postedAt ? new Date(row.postedAt) : null,
    firstSeenAt: new Date(row.firstSeenAt),
    closedAt: row.closedAt ? new Date(row.closedAt) : null,
  }));
}
