import "server-only";
import { politeGet } from "@/server/sources/http";
import type { DiscoveredItem, DiscoveryProvider } from "../types";
import { agoToDate, countryFromName, parseMoney, parseMoneyRange, textOf } from "./scrape-utils";

/**
 * Guru's public job listing (`/d/jobs/c/<category>`), read from the server-rendered HTML. Its robots.txt
 * disallows `/d/search/*` but not these category pages. The listing shows hourly ranges but not a fixed
 * project's amount, so a fixed-price job has no stated budget here (never estimated).
 */

const BASE = "https://www.guru.com";
const CATEGORIES = ["programming-development", "design-art", "sales-marketing", "business-finance"];

export function parseGuru(html: string, now: Date): DiscoveredItem[] {
  const items: DiscoveredItem[] = [];
  const body = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  for (const record of body.split('<div class="record jobRecord"').slice(1)) {
    const id = record.match(/data-gid="(\d+)"/)?.[1];
    const link = record.match(/<h2 class="jobRecord__title[^"]*">\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!id || !link) continue;

    const meta = textOf(record.match(/jobRecord__meta">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const budgetBlock = textOf(record.match(/jobRecord__budget">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const hourly = /hourly/i.test(budgetBlock);
    const description = textOf(record.match(/<p class="jobRecord__desc"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
    const skills = [...record.matchAll(/<a[^>]*href="\/d\/jobs\/(?:skill|sc|c)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => textOf(m[1])).filter(Boolean);
    // The poster: "FRANK D", with their country underneath, in Guru's avatar block.
    const avatar = record.match(/freelancerAvatar[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?freelancerAvatar__subText[^>]*>\s*<strong>([^<]+)<\/strong>/);
    // An hourly rate is not a project budget; a fixed-price job may show a range ("$500-$1k") or nothing.
    const range = hourly ? null : parseMoneyRange(budgetBlock);
    const single = hourly || range ? null : parseMoney(budgetBlock);

    items.push({
      capability: "freelance",
      category: "freelance_project",
      sourceSlug: "guru",
      platform: "Guru",
      externalId: id,
      url: new URL(link[1].replace(/&SearchUrl=.*$/, ""), BASE).toString(),
      title: textOf(link[2]),
      text: description.slice(0, 2000),
      postedAt: agoToDate(meta, now),
      buyerName: avatar ? textOf(avatar[1]) || null : null,
      buyerProfileUrl: null,
      companyName: null,
      companyDomain: null,
      country: countryFromName(avatar ? textOf(avatar[2]) : null),
      city: null,
      industry: null,
      remote: null,
      clientType: null,
      budget: range
        ? { min: range.min, max: range.max, currency: range.currency, usd: range.usd }
        : single
          ? { min: single.amount, max: single.amount, currency: single.currency, usd: single.usd }
          : null,
      funding: null,
      intentHint: null,
      verification: "verified",
      metadata: {
        pricing: hourly ? "hourly" : /fixed/i.test(budgetBlock) ? "fixed" : null,
        hourlyRate: hourly ? (budgetBlock.match(/\$\s?\d[\d,]*\s*-\s*\$?\s?\d[\d,]*/)?.[0] ?? null) : null,
        skills: skills.slice(0, 12),
        quotes: meta.match(/(\d+)\s+Quotes?/i)?.[1] ?? null,
      },
    });
  }
  return items;
}

export const guru: DiscoveryProvider = {
  slug: "guru",
  name: "Guru",
  capability: "freelance",
  async discover({ now }) {
    const found = new Map<string, DiscoveredItem>();
    const failures: string[] = [];
    for (const category of CATEGORIES) {
      try {
        const response = await politeGet(`${BASE}/d/jobs/c/${category}/`);
        if (response.status !== 200) throw new Error(`guru.com answered ${response.status}`);
        for (const item of parseGuru(response.body, now)) found.set(item.externalId, item);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length === CATEGORIES.length) throw new Error(failures[0]);
    return [...found.values()];
  },
};
