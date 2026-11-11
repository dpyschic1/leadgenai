import { z } from "zod";
import { MAX_FREQUENCY_MINUTES, MIN_FREQUENCY_MINUTES } from "@/lib/domain/engine";

const list = z.array(z.string().min(1)).max(300);

/** `null` = inherit the workspace value for that dimension; an array replaces it. */
export const targetingOverrideSchema = z.object({
  countries: list.nullable(),
  industries: list.nullable(),
  serviceIds: z.array(z.uuid()).max(100).nullable(),
});

export const engineToggleSchema = z.object({ enabled: z.boolean() });

/** Capability `config` is validated against that capability's own schema in the service. */
export const capabilityUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  frequencyMinutes: z.number().int().min(MIN_FREQUENCY_MINUTES).max(MAX_FREQUENCY_MINUTES).optional(),
  targeting: targetingOverrideSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export type CapabilityUpdateInput = z.infer<typeof capabilityUpdateSchema>;
