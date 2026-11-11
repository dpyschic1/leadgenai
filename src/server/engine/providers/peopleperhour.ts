import "server-only";
import { politeGet } from "@/server/sources/http";
import type { DiscoveredItem, DiscoveryProvider } from "../types";
import { agoToDate, parseMoney, textOf } from "./scrape-utils";

/**
 * PeoplePerHour's public job listing, read from the server-rendered HTML. Its robots.txt disallows any
 * URL with a query string except `?page=`, so keyword search is off-limits: we read the category listings
 * (plain paths and `?page=N`) and match on our side. `politeGet` enforces robots.txt, throttles to one
 * request a second and never leaves the site; a block surfaces as a source error, it is not bypassed.
 */

const BASE = "https://www.peopleperhour.com";
const CATEGORIES = ["technology-programming", "design", "digital-marketing", "artificial-intelligence", "marketing-branding-sales"];
const PAGES = 2;

/** Splits a listing page into its job cards. Class names carry CSS-module suffixes (`item__url⤍ListItem⤚20ULx`), so match on the prefix. */
export function parsePeoplePerHour(html: string, now: Date): DiscoveredItem[] {
  const items: DiscoveredItem[] = [];
  for (const card of html.split('<li class="list__item').slice(1)) {
    const link = card.match(/<a class="item__url[^"]*" href="(https:\/\/www\.peopleperhour\.com\/freelance-jobs\/[^"]*?-(\d+))"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const [, url, id, titleHtml] = link;
    const desc = card.match(/<p class="item__desc[^"]*">([\s\S]*?)<\/p>/)?.[1] ?? "";
    const price = parseMoney(textOf(card.match(/card__price[^"]*">([\s\S]*?)<\/div>\s*<div class="u-mgl--1 bookmark/)?.[1] ?? ""));
    const footer = textOf(card.match(/card__footer-left[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const client = card.match(/<a class="small card__user-link[^"]*" href="([^"]+)"[\s\S]*?card__username[^"]*">\s*(?:<!-- -->)?\s*([^<]+)</);
    const category = url.match(/freelance-jobs\/([^/]+)\//)?.[1] ?? null;

    items.push({
      capability: "freelance",
      category: "freelance_project",
      sourceSlug: "peopleperhour",
      platform: "PeoplePerHour",
      externalId: id,
      url,
      title: textOf(titleHtml),
      text: textOf(desc).slice(0, 2000),
      postedAt: agoToDate(footer, now),
      buyerName: client ? textOf(client[2]) : null,
      buyerProfileUrl: client ? client[1] : null,
      companyName: null,
      companyDomain: null,
      country: null, // the card shows no client country; never guessed
      city: null,
      industry: null,
      remote: null,
      clientType: null,
      budget: price ? { min: price.amount, max: price.amount, currency: price.currency, usd: price.usd } : null,
      funding: null,
      intentHint: null,
      verification: "verified", // first-hand listing on the platform; the client's company is unavailable
      metadata: { category, proposals: footer.match(/(\d+)\s*proposals/)?.[1] ?? null, usdApproximate: price?.approximate ?? false },
    });
  }
  return items;
}

export const peoplePerHour: DiscoveryProvider = {
  slug: "peopleperhour",
  name: "PeoplePerHour",
  capability: "freelance",
  async discover({ now }) {
    const found = new Map<string, DiscoveredItem>();
    const failures: string[] = [];
    let requests = 0;
    for (const category of CATEGORIES) {
      for (let page = 1; page <= PAGES; page++) {
        requests++;
        try {
          const response = await politeGet(`${BASE}/freelance-jobs/${category}${page > 1 ? `?page=${page}` : ""}`);
          if (response.status !== 200) throw new Error(`peopleperhour.com answered ${response.status}`);
          for (const item of parsePeoplePerHour(response.body, now)) found.set(item.externalId, item);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (failures.length === requests) throw new Error(failures[0]);
    return [...found.values()];
  },
};
