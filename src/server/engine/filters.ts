import type { FreelanceConfig, FundedConfig, Targeting } from "@/lib/domain/engine";
import { matchesCountry } from "./match";
import type { DiscoveredItem } from "./types";

/**
 * The user's own filters for a capability (spec §4, §5). They drop an item only for a reason the user
 * chose and that the item's data supports: an unknown value never excludes (nothing is assumed),
 * and a project with no budget never counts as meeting the minimum.
 */
export type FilterResult = { pass: true } | { pass: false; reason: string };

const pass: FilterResult = { pass: true };
const fail = (reason: string): FilterResult => ({ pass: false, reason });

export function passesFreelanceFilters(item: DiscoveredItem, config: FreelanceConfig, targeting: Targeting, now: Date): FilterResult {
  if (item.postedAt) {
    const days = (now.getTime() - item.postedAt.getTime()) / 86_400_000;
    if (days > config.postedWithinDays) return fail(`Posted more than ${config.postedWithinDays} days ago`);
  }
  const usd = item.budget?.usd ?? null;
  if (usd === null) {
    if (config.undisclosedBudget === "exclude") return fail("No budget stated");
  } else if (usd < config.minBudgetUsd) {
    return fail(`Budget under $${config.minBudgetUsd}`);
  }
  if (item.clientType && !config.clientTypes.includes(item.clientType)) return fail("Client type not selected");
  if (config.workMode === "remote" && item.remote === false) return fail("On-site project");
  if (config.workMode === "onsite" && item.remote === true) return fail("Remote project");
  if (item.country && !matchesCountry(targeting, item.country)) return fail("Client outside target countries");
  if (config.cities.length && item.city && !config.cities.some((c) => c.toLowerCase() === item.city!.toLowerCase())) return fail("City not selected");
  return pass;
}

export function passesFundedFilters(item: DiscoveredItem, config: FundedConfig, targeting: Targeting): FilterResult {
  const date = item.funding?.date ?? null;
  // A funding event is the whole point of this capability: no evidence of one, no opportunity.
  if (!item.funding) return fail("No funding event");
  if (date) {
    if (config.fundedFrom && date < config.fundedFrom) return fail("Funded before the start date");
    if (config.fundedTo && date > config.fundedTo) return fail("Funded after the end date");
  }
  if (item.country && !matchesCountry(targeting, item.country)) return fail("Outside target countries");
  return pass;
}
