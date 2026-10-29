"use client";

import type { UserRole } from "@/lib/api/types";
import { hasRole } from "@/lib/permissions";
import { useCurrentUser } from "./use-current-user";

/** Whether the signed-in user holds one of `roles`. False while loading, so actions never flash in. */
export function usePermission(roles: readonly UserRole[]): boolean {
  const { data: me } = useCurrentUser();
  return me ? hasRole(me.user.role, roles) : false;
}
