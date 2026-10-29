import type { UserRole } from "@/lib/api/types";

/** Role groups (SRS §3). Shared so the UI can hide actions the API would reject. */

/** May change workspace configuration: services, ICP and scoring. */
export const CONFIG_ROLES = ["owner", "admin", "manager"] as const satisfies readonly UserRole[];

/** May change workspace-level settings such as the name. */
export const ADMIN_ROLES = ["owner", "admin"] as const satisfies readonly UserRole[];

export function hasRole(role: UserRole, allowed: readonly UserRole[]): boolean {
  return allowed.includes(role);
}
