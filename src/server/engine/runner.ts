import "server-only";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { discoveryRuns, engineCapabilities, engineSettings, services } from "@/db/schema";
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
import { loadEngineWeights } from "./rescore";
import { matchedTerms, termsOf } from "./match";
import { providersFor } from "./providers";
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

async function loadServiceTerms(workspaceId: string, serviceIds: string[]): Promise<string[]> {
  if (serviceIds.length === 0) return [];
  const rows = await db
    .select({ name: services.name })
    .from(services)
    .where(and(eq(services.workspaceId, workspaceId), inArray(services.id, serviceIds)));
  // Names only. Description text is prose ("first", "within", "product") and matches almost any post;
  // matching on it ranked an electrician's cabling job as a strong fit for a software agency.
  return [...new Set(rows.flatMap((r) => termsOf(r.name)))].slice(0, 20);
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
    const serviceTerms = await loadServiceTerms(workspaceId, targeting.serviceIds);
    if (serviceTerms.length === 0) throw new Error("No services to match against. Add a service in Services & ICP first.");

    const config = parseCapabilityConfig(capability, row?.config);
    const weights = await loadEngineWeights(workspaceId);
    const wanted = "providers" in config ? (config as { providers: string[] }).providers : [];

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
          if (!isRelevant(item, capability, config as FreelanceConfig & FundedConfig, targeting, serviceTerms, now)) {
            summary.skipped++;
            continue;
          }
          const score = scoreItem({ item, targeting, serviceTerms, freelance: capability === "freelance" ? (config as FreelanceConfig) : undefined, weights, now });
          const result = await ingestItem({ workspaceId, runId: run.id, item, score, now });
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
): boolean {
  if (capability === "funded") return passesFundedFilters(item, config, targeting).pass;
  if (matchedTerms(serviceTerms, `${item.title}\n${item.text}`).length === 0) return false;
  return capability === "freelance" ? passesFreelanceFilters(item, config, targeting, now).pass : true;
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
