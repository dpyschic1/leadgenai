import "server-only";
import { and, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { companies, discoveryRuns, engineCapabilities, engineSettings, opportunities, serviceServiceCategories, services } from "@/db/schema";
import { categorizeJob, isAiTrainingWork } from "@/server/jobs/job-categories";
import { DEFAULT_ENGINE_WEIGHTS } from "@/lib/domain/engine";
import {
  DEFAULT_FREQUENCY_MINUTES,
  isDue,
  parseCapabilityConfig,
  resolveTargeting,
  CAPABILITIES,
  type Capability,
  type FreelanceConfig,
  type FundedConfig,
  type RunStatus,
} from "@/lib/domain/engine";
import { AppError } from "@/server/http/errors";
import { loadWorkspaceTargeting } from "@/server/services/engine.service";
import { passesFreelanceFilters, passesFundedFilters } from "./filters";
import { ingestItem } from "./ingest";
import { matchedTerms, termsOf } from "./match";
import { providersFor } from "./providers";
import { discoveredInput, loadScoreContext, scoreColumns, scoreDiscovered } from "./our-score";
import { scoreItem } from "./score-item";
import type { DiscoveredItem } from "./types";

/** A run that has been "running" this long died with its process; a new one may start. */
const STALE_RUN_MS = 10 * 60_000;
/** Most items one provider may store per run, so a noisy source cannot flood a workspace or starve the others. */
const MAX_ITEMS_PER_PROVIDER = 150;

export type RunSummary = {
  runId: string;
  status: RunStatus;
  found: number;
  created: number;
  updated: number;
  skipped: number;
  sources: { source: string; ok: boolean; found: number; error?: string; note?: string }[];
};

type ServiceTerms = { id: string; terms: string[]; categories: string[] };

async function loadServices(workspaceId: string, serviceIds: string[]): Promise<ServiceTerms[]> {
  if (serviceIds.length === 0) return [];
  const rows = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(and(eq(services.workspaceId, workspaceId), inArray(services.id, serviceIds)));
  const categories = await db
    .select({ serviceId: serviceServiceCategories.serviceId, slug: serviceServiceCategories.categorySlug })
    .from(serviceServiceCategories)
    .where(inArray(serviceServiceCategories.serviceId, rows.map((r) => r.id)));
  // Names only. Description text is prose ("first", "within", "product") and matches almost any post;
  // matching on it ranked an electrician's cabling job as a strong fit for a software agency.
  return rows.map((r) => ({ id: r.id, terms: termsOf(r.name), categories: categories.filter((c) => c.serviceId === r.id).map((c) => c.slug) }));
}

/** The service whose name terms the item matched most (first on a tie); null when none matched. Pure. */
export function bestService(serviceTerms: Pick<ServiceTerms, "id" | "terms">[], matched: string[]): string | null {
  let best: { id: string; hits: number } | null = null;
  for (const service of serviceTerms) {
    const hits = service.terms.filter((t) => matched.includes(t)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { id: service.id, hits };
  }
  return best?.id ?? null;
}

/**
 * One execution of one capability for one workspace (spec §6, §7). Providers run independently: a
 * failing source is recorded against that source and the run is "partial", never silently dropped.
 */
export async function runCapability(workspaceId: string, capability: Capability, trigger: "schedule" | "manual", now = new Date()): Promise<RunSummary> {
  const [settings] = await db.select().from(engineSettings).where(eq(engineSettings.workspaceId, workspaceId));
  if (settings && !settings.enabled) throw new AppError("VALIDATION_FAILED", "LeadGen Engine is switched off for this workspace.");
  const [row] = await db
    .select()
    .from(engineCapabilities)
    .where(and(eq(engineCapabilities.workspaceId, workspaceId), eq(engineCapabilities.capability, capability)));
  if (row && !row.enabled && trigger === "schedule") throw new AppError("VALIDATION_FAILED", "This capability is switched off.");

  const [running] = await db
    .select({ id: discoveryRuns.id })
    .from(discoveryRuns)
    .where(
      and(
        eq(discoveryRuns.workspaceId, workspaceId),
        eq(discoveryRuns.capability, capability),
        isNull(discoveryRuns.finishedAt),
        gt(discoveryRuns.startedAt, new Date(now.getTime() - STALE_RUN_MS)),
      ),
    );
  if (running) throw new AppError("ALREADY_EXISTS", "This capability is already running.");

  const [run] = await db.insert(discoveryRuns).values({ workspaceId, capability, trigger, startedAt: now }).returning({ id: discoveryRuns.id });

  const summary: RunSummary = { runId: run.id, status: "success", found: 0, created: 0, updated: 0, skipped: 0, sources: [] };
  let fatal: string | null = null;
  try {
    const workspaceTargeting = await loadWorkspaceTargeting(workspaceId);
    const targeting = resolveTargeting(workspaceTargeting, {
      countries: row?.targetCountries ?? null,
      industries: row?.targetIndustries ?? null,
      serviceIds: row?.targetServiceIds ?? null,
    });
    const servicesTargeted = await loadServices(workspaceId, targeting.serviceIds);
    const serviceTerms = [...new Set(servicesTargeted.flatMap((s) => s.terms))].slice(0, 20);
    const serviceCategories = [...new Set(servicesTargeted.flatMap((s) => s.categories))];
    if (serviceTerms.length === 0) throw new Error("No services to match against. Add a service in Services & ICP first.");

    const config = parseCapabilityConfig(capability, row?.config);
    // The engine's own reading of each item (intent, matched words) uses its fixed defaults; the
    // opportunity's score is the workspace scoring profile's, via our-score.ts.
    const weights = DEFAULT_ENGINE_WEIGHTS;
    // Scored by the same rules as company opportunities, so the whole list is on one scale.
    const ourContext = await loadScoreContext(workspaceId);
    const wanted = "providers" in config ? (config as { providers: string[] }).providers : [];

    // One company, one opportunity: a company that already has its own opportunity here (found by
    // its hiring, with contacts) is not added again as "recently funded".
    const known =
      capability === "funded"
        ? new Set(
            (
              await db
                .select({ domain: companies.domain })
                .from(companies)
                .innerJoin(opportunities, eq(opportunities.companyId, companies.id))
                .where(and(eq(companies.workspaceId, workspaceId), isNotNull(companies.domain)))
            ).map((c) => c.domain!),
          )
        : new Set<string>();

    for (const provider of providersFor(capability, wanted)) {
      const source = { source: provider.slug, ok: true, found: 0 } as RunSummary["sources"][number];
      let stored = 0;
      summary.sources.push(source);
      // A provider missing its credential is reported as skipped (with how to enable it), never dropped silently.
      if (provider.configured && !provider.configured()) {
        source.note = provider.setupHint ?? "Not configured";
        continue;
      }
      try {
        const items = await provider.discover({ targeting, serviceTerms, config: config as Record<string, unknown>, now });
        source.found = items.length;
        summary.found += items.length;

        for (const item of items) {
          if (stored >= MAX_ITEMS_PER_PROVIDER) break;
          if (item.companyDomain && known.has(item.companyDomain)) {
            summary.skipped++;
            continue;
          }
          if (!isRelevant(item, capability, config as FreelanceConfig & FundedConfig, targeting, serviceTerms, now, serviceCategories)) {
            summary.skipped++;
            continue;
          }
          const score = scoreItem({ item, targeting, serviceTerms, freelance: capability === "freelance" ? (config as FreelanceConfig) : undefined, weights, now });
          const matched = bestService(servicesTargeted, score.matchedTerms);
          const input = discoveredInput(item, score, servicesTargeted.find((s) => s.id === matched)?.categories ?? serviceCategories, now);
          const ours = scoreDiscovered(input, ourContext, now);
          // Nothing the services need: no opportunity, as for a company with no positive signal.
          if (!ours || ours.serviceId === null) {
            summary.skipped++;
            continue;
          }
          const result = await ingestItem({ workspaceId, runId: run.id, item, score, now, serviceId: matched, ours: scoreColumns(ours, input) });
          stored++;
          if (result.outcome === "created") summary.created++;
          else summary.updated++;
        }
      } catch (error) {
        source.ok = false;
        source.error = error instanceof Error ? error.message : String(error);
      }
    }
    const failed = summary.sources.filter((s) => !s.ok).length;
    summary.status = failed === 0 ? "success" : failed === summary.sources.length ? "failed" : "partial";
  } catch (error) {
    fatal = error instanceof Error ? error.message : String(error);
    summary.status = "failed";
  }

  const error = fatal ?? summary.sources.find((s) => !s.ok)?.error ?? null;
  const finished = new Date();
  await db
    .update(discoveryRuns)
    .set({ finishedAt: finished, status: summary.status, found: summary.found, created: summary.created, updated: summary.updated, sources: summary.sources, error })
    .where(eq(discoveryRuns.id, run.id));
  await db
    .insert(engineCapabilities)
    .values({
      workspaceId,
      capability,
      frequencyMinutes: DEFAULT_FREQUENCY_MINUTES[capability],
      lastRunAt: now,
      lastSuccessAt: summary.status === "failed" ? null : finished,
      lastStatus: summary.status,
      lastError: error,
    })
    .onConflictDoUpdate({
      target: [engineCapabilities.workspaceId, engineCapabilities.capability],
      set: {
        lastRunAt: now,
        lastStatus: summary.status,
        lastError: error,
        ...(summary.status === "failed" ? {} : { lastSuccessAt: finished }),
      },
    });
  return summary;
}

/** Whether a discovered item belongs in this workspace's opportunities. Never filters on score. */
function isRelevant(
  item: DiscoveredItem,
  capability: Capability,
  config: FreelanceConfig & FundedConfig,
  targeting: { countries: string[]; industries: string[]; serviceIds: string[] },
  serviceTerms: string[],
  now: Date,
  serviceCategories: string[] = [],
): boolean {
  if (capability === "funded") {
    // A startup listed with the roles it's hiring for fits only when one of them is work a service delivers.
    if (!fitsHiringRoles(item, serviceCategories)) return false;
    return passesFundedFilters(item, config, targeting).pass;
  }
  if (matchedTerms(serviceTerms, `${item.title}\n${item.text}`).length === 0) return false;
  // A project is work the workspace delivers only when its role fits a service's categories (the
  // same title rules as job matching): "Laravel developer" fits software development; "LPG pipeline
  // design" or "photo editing" share a word with a service name but are not its work.
  if (capability === "freelance" && serviceCategories.length > 0 && !fitsServiceCategories(item, serviceCategories)) return false;
  return capability === "freelance" ? passesFreelanceFilters(item, config, targeting, now).pass : true;
}

/**
 * For an item listed with the roles it's hiring for (a YC startup): one role's categories are among
 * these service categories. Items without a role list (an SEC filing) are not judged here. Pure.
 */
export function fitsHiringRoles(item: Pick<DiscoveredItem, "metadata">, serviceCategories: string[]): boolean {
  const roles = item.metadata?.jobCategories;
  if (!Array.isArray(roles)) return true;
  return roles.some((c) => typeof c === "string" && serviceCategories.includes(c));
}

/** The project's own role (title and listed skills) falls in one of these service categories. Pure. */
export function fitsServiceCategories(item: Pick<DiscoveredItem, "title" | "metadata">, serviceCategories: string[]): boolean {
  // "Remote AI Training Specialists Needed": hand-labelling work for people, not a project to build.
  if (isAiTrainingWork(item.title)) return false;
  const skills = Array.isArray(item.metadata?.skills) ? (item.metadata.skills as unknown[]).filter((s): s is string => typeof s === "string") : [];
  const found = new Set([...categorizeJob({ title: item.title, department: null }), ...categorizeJob({ title: `${item.title} ${skills.join(" ")}`, department: null })]);
  return [...found].some((c) => serviceCategories.includes(c));
}

/**
 * Runs every capability that is due (spec §6): the master switch and the capability switch are on and
 * its own interval has passed. Called from the background tick; `deadline` keeps a tick inside its budget.
 */
export async function runDueCapabilities(deadline: number, workspaceId?: string): Promise<void> {
  const workspaces = await db
    .selectDistinct({ id: services.workspaceId })
    .from(services)
    .where(workspaceId ? eq(services.workspaceId, workspaceId) : undefined);

  for (const { id } of workspaces) {
    const [settings] = await db.select().from(engineSettings).where(eq(engineSettings.workspaceId, id));
    const master = settings?.enabled ?? true;
    const rows = await db.select().from(engineCapabilities).where(eq(engineCapabilities.workspaceId, id));
    for (const capability of CAPABILITIES) {
      // A discovery run takes several seconds per source; do not start one a tick cannot finish.
      if (Date.now() > deadline) return;
      const row = rows.find((r) => r.capability === capability);
      const due = isDue(
        { enabled: row?.enabled ?? true, frequencyMinutes: row?.frequencyMinutes ?? DEFAULT_FREQUENCY_MINUTES[capability], lastRunAt: row?.lastRunAt ?? null },
        master,
      );
      if (!due) continue;
      try {
        await runCapability(id, capability, "schedule");
      } catch (error) {
        // "already running" is normal when ticks overlap; anything else is logged, never thrown.
        if (!(error instanceof AppError && error.code === "ALREADY_EXISTS")) console.error(`[engine] ${capability} failed for ${id}`, error);
      }
    }
  }
}

export async function latestRun(workspaceId: string, capability: Capability) {
  const [run] = await db
    .select()
    .from(discoveryRuns)
    .where(and(eq(discoveryRuns.workspaceId, workspaceId), eq(discoveryRuns.capability, capability)))
    .orderBy(desc(discoveryRuns.startedAt))
    .limit(1);
  return run ?? null;
}
