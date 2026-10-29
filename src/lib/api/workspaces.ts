import type { UpdateWorkspaceInput } from "@/lib/validation/auth";
import { apiRequest } from "./client";
import type { Me } from "./types";

export const workspacesApi = {
  me: (signal?: AbortSignal) => apiRequest<Me>("/workspaces/me", { signal }),
  update: (input: UpdateWorkspaceInput) =>
    apiRequest<Me>("/workspaces/me", { method: "PATCH", body: input }),
};
