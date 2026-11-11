import "server-only";
import { fetchJson } from "../http";
import type { DiscoveredItem, DiscoveryProvider } from "../types";

/**
 * Freelancer.com public projects API (no key needed for reading active projects). Budget is in the
 * project's own currency; `exchange_rate` converts to USD. Hourly projects have a per-hour range
 * that is not comparable to a project minimum, so they count as "no stated budget".
 */

export type FreelancerProject = {
  id: number;
  title: string;
  seo_url?: string;
  description?: string;
  preview_description?: string;
  type?: "fixed" | "hourly" | string;
  time_submitted?: number;
  currency?: { code?: string; exchange_rate?: number };
  budget?: { minimum?: number | null; maximum?: number | null };
  local?: boolean | null;
  location?: { country?: { code?: string | null } | null; city?: string | null } | null;
  jobs?: { name?: string }[];
};

export function parseFreelancerProject(p: FreelancerProject): DiscoveredItem | null {
  if (!p.id || !p.title) return null;
  const rate = p.currency?.exchange_rate ?? null;
  const fixed = p.type !== "hourly";
  const max = p.budget?.maximum ?? null;
  const min = p.budget?.minimum ?? null;
  const top = max ?? min;
  const usd = fixed && top !== null && rate ? Math.round(top * rate) : null;
  const skills = (p.jobs ?? []).map((j) => j.name).filter((n): n is string => !!n);
  const country = p.location?.country?.code?.toUpperCase() || null;

  return {
    capability: "freelance",
    category: "freelance_project",
    sourceSlug: "freelancer",
    platform: "Freelancer.com",
    externalId: String(p.id),
    url: p.seo_url ? `https://www.freelancer.com/projects/${p.seo_url}` : `https://www.freelancer.com/projects/${p.id}`,
    title: p.title,
    text: [p.description ?? p.preview_description ?? "", skills.length ? `Skills: ${skills.join(", ")}` : ""].filter(Boolean).join("\n"),
    postedAt: p.time_submitted ? new Date(p.time_submitted * 1000) : null,
    buyerName: null, // the public API does not name the client; never guess
    buyerProfileUrl: null,
    companyName: null,
    companyDomain: null,
    country,
    city: p.location?.city ?? null,
    industry: null,
    remote: p.local === true ? false : p.local === false ? true : null,
    clientType: null, // not exposed publicly
    budget: top === null && min === null ? null : { min, max, currency: p.currency?.code ?? null, usd },
    funding: null,
    intentHint: null,
    // The project is first-hand evidence of a request; the client's identity is unavailable.
    verification: "verified",
    metadata: { type: p.type ?? null, skills, hourly: !fixed },
  };
}

export const freelancer: DiscoveryProvider = {
  slug: "freelancer",
  name: "Freelancer.com",
  capability: "freelance",
  async discover({ serviceTerms, signal }) {
    const queries = [...new Set(serviceTerms)].slice(0, 6);
    const seen = new Map<string, DiscoveredItem>();
    for (const query of queries) {
      const url =
        "https://www.freelancer.com/api/projects/0.1/projects/active/?" +
        new URLSearchParams({ query, limit: "50", full_description: "true", job_details: "true", sort_field: "time_submitted" });
      const data = await fetchJson<{ result?: { projects?: FreelancerProject[] } }>(url, { signal });
      for (const project of data.result?.projects ?? []) {
        const item = parseFreelancerProject(project);
        if (item) seen.set(item.externalId, item);
      }
    }
    return [...seen.values()];
  },
};
