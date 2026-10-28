import { apiRequest } from "./client";
import type { Me } from "./types";

export const workspacesApi = {
  me: (signal?: AbortSignal) => apiRequest<Me>("/workspaces/me", { signal }),
};
