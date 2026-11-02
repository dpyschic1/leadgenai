import "server-only";
import type { InterpretedSearch } from "@/lib/api/types";
import type { InterpretSearchInput } from "@/lib/validation/opportunities";
import { interpretOpportunitySearch } from "@/server/ai/opportunity-search";
import type { AuthContext } from "@/server/auth/session";
import { getReferenceData } from "./reference-data.service";
import { loadServices } from "./services.service";

/** Translates a plain-language request into feed filters, using the workspace's own services. */
export async function interpretSearch(auth: AuthContext, input: InterpretSearchInput): Promise<InterpretedSearch> {
  const [ref, services] = await Promise.all([getReferenceData(), loadServices(auth.workspaceId)]);
  return interpretOpportunitySearch(input.query, ref, services);
}
