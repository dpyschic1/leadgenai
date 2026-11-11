import "server-only";
import type { Capability } from "@/lib/domain/engine";
import type { DiscoveryProvider } from "../types";
import { freelancer } from "./freelancer";
import { guru } from "./guru";
import { hackerNews } from "./hackernews";
import { peoplePerHour } from "./peopleperhour";
import { serpApi } from "./serpapi";
import { secFormD } from "./sec-form-d";
import { ycBatches } from "./yc-batches";

/**
 * Every discovery provider. Adding a source (a paid aggregator for Upwork, LinkedIn, X or Google, say)
 * means implementing `DiscoveryProvider` and listing it here; the engine does not change.
 *
 * Reddit is deliberately NOT listed: its robots.txt is `Disallow: /` and its Public Content Policy restricts
 * use. `./reddit.ts` is kept for use with Reddit's official API credentials if the workspace obtains them.
 */
export const PROVIDERS: DiscoveryProvider[] = [hackerNews, serpApi, ycBatches, secFormD, freelancer, peoplePerHour, guru];

/** The providers for a capability, optionally limited to the slugs the workspace chose (empty = all). */
export function providersFor(capability: Capability, wanted: string[] = []): DiscoveryProvider[] {
  return PROVIDERS.filter((p) => p.capability === capability && (wanted.length === 0 || wanted.includes(p.slug)));
}
