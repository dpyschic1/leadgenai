import type { AuthContext } from "./session";

/**
 * Who a write is attributed to. A signed-in user (`AuthContext` fits), or the system itself when
 * background ingestion runs on a schedule (`userId: null`: audit rows and records show no author).
 */
export type Actor = Pick<AuthContext, "workspaceId"> & { userId: string | null };

export const systemActor = (workspaceId: string): Actor => ({ workspaceId, userId: null });
