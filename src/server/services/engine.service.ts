import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLogs,
  engineCapabilities,
  engineSettings,
  industries,
  serviceTargetCountries,
  serviceTargetIndustries,
  services,
} from "@/db/schema";
import type { CapabilityState, EngineState } from "@/lib/api/types";
import { COUNTRY_CODES } from "@/lib/countries";
import {
  CAPABILITIES,
  CAPABILITY_CONFIG_SCHEMAS,
  DEFAULT_FREQUENCY_MINUTES,
  nextRunAt,
  parseCapabilityConfig,
  resolveTargeting,
  type Capability,
  type Targeting,
  type TargetingOverride,
} from "@/lib/domain/engine";
import type { CapabilityUpdateInput } from "@/lib/validation/engine";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";

type CapabilityRow = typeof engineCapabilities.$inferSelect;

/** The workspace's Services & ICP as targeting: the default each capability inherits. */
export async function loadWorkspaceTargeting(workspaceId: string): Promise<Targeting> {
  const serviceRows = await db.select({ id: services.id }).from(services).where(eq(services.workspaceId, workspaceId));
  const ids = serviceRows.map((s) => s.id);
  if (ids.length === 0) return { countries: [], industries: [], serviceIds: [] };
  const [countries, industryRows] = await Promise.all([
    db.selectDistinct({ code: serviceTargetCountries.countryCode }).from(serviceTargetCountries).where(inArray(serviceTargetCountries.serviceId, ids)),
    db.selectDistinct({ slug: serviceTargetIndustries.industrySlug }).from(serviceTargetIndustries).where(inArray(serviceTargetIndustries.serviceId, ids)),
  ]);
  return {
    countries: countries.map((c) => c.code).sort(),
    industries: industryRows.map((i) => i.slug).sort(),
    serviceIds: ids,
  };
}

const overrideOf = (row: CapabilityRow | undefined): TargetingOverride => ({
  countries: row?.targetCountries ?? null,
  industries: row?.targetIndustries ?? null,
  serviceIds: row?.targetServiceIds ?? null,
});

function toState(capability: Capability, row: CapabilityRow | undefined, workspace: Targeting, masterEnabled: boolean): CapabilityState {
  const override = overrideOf(row);
  const frequencyMinutes = row?.frequencyMinutes ?? DEFAULT_FREQUENCY_MINUTES[capability];
  const enabled = row?.enabled ?? true;
  return {
    capability,
    enabled,
    frequencyMinutes,
    override,
    effective: resolveTargeting(workspace, override),
    config: parseCapabilityConfig(capability, row?.config),
    lastRunAt: row?.lastRunAt?.toISOString() ?? null,
    lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
    nextRunAt: masterEnabled && enabled ? nextRunAt(row?.lastRunAt ?? null, frequencyMinutes).toISOString() : null,
    lastStatus: row?.lastStatus ?? null,
    lastError: row?.lastError ?? null,
  };
}

/** Master switch and every capability; a missing row means defaults (enabled, spec §2). */
export async function getEngine(auth: AuthContext): Promise<EngineState> {
  const [settings, rows, workspaceTargeting] = await Promise.all([
    db.select().from(engineSettings).where(eq(engineSettings.workspaceId, auth.workspaceId)).limit(1),
    db.select().from(engineCapabilities).where(eq(engineCapabilities.workspaceId, auth.workspaceId)),
    loadWorkspaceTargeting(auth.workspaceId),
  ]);
  const enabled = settings[0]?.enabled ?? true;
  return {
    enabled,
    workspaceTargeting,
    capabilities: CAPABILITIES.map((c) => toState(c, rows.find((r) => r.capability === c), workspaceTargeting, enabled)),
  };
}

export async function setEngineEnabled(auth: AuthContext, enabled: boolean): Promise<EngineState> {
  await db.transaction(async (tx) => {
    await tx
      .insert(engineSettings)
      .values({ workspaceId: auth.workspaceId, enabled })
      .onConflictDoUpdate({ target: engineSettings.workspaceId, set: { enabled } });
    await tx.insert(auditLogs).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: "engine.toggled",
      entityType: "engine_settings",
      metadata: { enabled },
    });
  });
  return getEngine(auth);
}

/** Overrides must reference real values; an override that silently matches nothing would hide opportunities. */
async function validateTargeting(workspaceId: string, targeting: TargetingOverride): Promise<void> {
  const bad = targeting.countries?.filter((c) => !(COUNTRY_CODES as readonly string[]).includes(c));
  if (bad?.length) throw new AppError("VALIDATION_FAILED", `Unknown country: ${bad.join(", ")}.`);

  if (targeting.industries?.length) {
    const found = await db.select({ slug: industries.slug }).from(industries).where(inArray(industries.slug, targeting.industries));
    const missing = targeting.industries.filter((s) => !found.some((f) => f.slug === s));
    if (missing.length) throw new AppError("VALIDATION_FAILED", `Unknown industry: ${missing.join(", ")}.`);
  }
  if (targeting.serviceIds?.length) {
    const found = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.workspaceId, workspaceId), inArray(services.id, targeting.serviceIds)));
    if (found.length !== new Set(targeting.serviceIds).size) throw new AppError("VALIDATION_FAILED", "Unknown service.");
  }
}

export async function updateCapability(auth: AuthContext, capability: Capability, input: CapabilityUpdateInput): Promise<EngineState> {
  let config: Record<string, unknown> | undefined;
  if (input.config) {
    const parsed = CAPABILITY_CONFIG_SCHEMAS[capability].safeParse(input.config);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Invalid settings.");
    config = parsed.data;
  }
  if (input.targeting) await validateTargeting(auth.workspaceId, input.targeting);

  const set = {
    ...(input.enabled !== undefined && { enabled: input.enabled }),
    ...(input.frequencyMinutes !== undefined && { frequencyMinutes: input.frequencyMinutes }),
    ...(input.targeting && {
      targetCountries: input.targeting.countries,
      targetIndustries: input.targeting.industries,
      targetServiceIds: input.targeting.serviceIds,
    }),
    ...(config && { config }),
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(engineCapabilities)
      .values({
        workspaceId: auth.workspaceId,
        capability,
        frequencyMinutes: DEFAULT_FREQUENCY_MINUTES[capability],
        ...set,
      })
      .onConflictDoUpdate({ target: [engineCapabilities.workspaceId, engineCapabilities.capability], set: { ...set, updatedAt: new Date() } });
    await tx.insert(auditLogs).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: "engine.capability_updated",
      entityType: "engine_capability",
      metadata: { capability, ...input },
    });
  });
  return getEngine(auth);
}
