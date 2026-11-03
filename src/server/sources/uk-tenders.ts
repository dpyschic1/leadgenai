import "server-only";
import { z } from "zod";
import { decodeEntities } from "@/server/jobs/html-to-text";
import type { HealthStatus, SourceAdapter, SourceRef } from "./index";
import { titleCaseCompanyName } from "./names";

/**
 * UK public tenders from Contracts Finder (public API, Open Government Licence, no key): open
 * contract notices in the procurement categories (CPV codes) the workspace's services cover.
 * The buying organisation is the company; the notice is the evidence.
 */

const SEARCH_URL = "https://www.contractsfinder.service.gov.uk/api/rest/2/search_notices/json";
const NOTICE_URL = (id: string) => `https://www.contractsfinder.service.gov.uk/notice/${id}`;
const TIMEOUT_MS = 20_000;

export type Tender = {
  id: string;
  title: string;
  description: string;
  buyer: string;
  url: string;
  publishedAt: Date | null;
  deadline: string | null;
  valueLow: number | null;
  valueHigh: number | null;
  region: string | null;
  postcode: string | null;
  record: SourceRef;
};

const notice = z.object({
  item: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    organisationName: z.string().nullish(),
    noticeType: z.string().nullish(),
    noticeStatus: z.string().nullish(),
    publishedDate: z.string().nullish(),
    deadlineDate: z.string().nullish(),
    valueLow: z.number().nullish(),
    valueHigh: z.number().nullish(),
    regionText: z.string().nullish(),
    postcode: z.string().nullish(),
    cpvCodes: z.string().nullish(),
    isSubNotice: z.boolean().nullish(),
  }),
});
const response = z.object({ noticeList: z.array(z.unknown()).nullish() });

const clean = (text: string | null | undefined) => decodeEntities(text ?? "").replace(/\s+/g, " ").trim();
const money = (value: number | null | undefined) => (value && value > 0 ? value : null);

/** Maps one search hit to a tender; null for sub-notices, closed or unusable ones. Exported for tests. */
export function toTender(raw: unknown): Tender | null {
  const parsed = notice.safeParse(raw);
  if (!parsed.success) return null;
  const n = parsed.data.item;
  // Framework sub-notices repeat their parent; only open notices invite bids.
  if (n.isSubNotice || (n.noticeStatus && n.noticeStatus !== "Open") || !n.organisationName) return null;
  const publishedAt = n.publishedDate ? new Date(n.publishedDate) : null;
  return {
    id: n.id,
    title: clean(n.title),
    description: clean(n.description),
    buyer: titleCaseCompanyName(clean(n.organisationName)),
    url: NOTICE_URL(n.id),
    publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
    deadline: n.deadlineDate?.slice(0, 10) ?? null,
    valueLow: money(n.valueLow),
    valueHigh: money(n.valueHigh),
    region: n.regionText?.split(",")[0]?.trim() || null,
    postcode: n.postcode?.trim() || null,
    record: {
      sourceSlug: "uk_tenders",
      externalId: `notice:${n.id}`,
      url: NOTICE_URL(n.id),
      recordType: "tender",
      publishedAt,
      data: { title: clean(n.title), buyer: clean(n.organisationName), deadline: n.deadlineDate ?? null, cpvCodes: n.cpvCodes ?? null },
    },
  };
}

/** Open notices in these CPV categories published since `from` (YYYY-MM-DD), newest first. */
export async function searchTenders({ cpvCodes, from, size }: { cpvCodes: string[]; from: string; size: number }): Promise<Tender[]> {
  if (cpvCodes.length === 0) return [];
  const result = await fetch(SEARCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ searchCriteria: { cpvCodes, statuses: ["Open"], publishedFrom: `${from}T00:00:00` }, size }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!result.ok) throw new Error(`Contracts Finder answered ${result.status}.`);
  const items = response.safeParse(await result.json()).data?.noticeList ?? [];
  const since = new Date(`${from}T00:00:00Z`).getTime();
  return items
    .map(toTender)
    // The search also returns old notices that were merely updated; keep newly published ones.
    .filter((t): t is Tender => t !== null && (t.publishedAt?.getTime() ?? 0) >= since)
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
}

/** The text the AI analyses for a tender: the facts, then the description. */
export function tenderSourceText(tender: Tender): string {
  const value =
    tender.valueLow || tender.valueHigh
      ? `Value: £${(tender.valueLow ?? tender.valueHigh)!.toLocaleString("en-GB")}${tender.valueHigh && tender.valueHigh !== tender.valueLow ? ` to £${tender.valueHigh.toLocaleString("en-GB")}` : ""}`
      : null;
  return [
    `Public tender: ${tender.title}`,
    `Buyer: ${tender.buyer}`,
    tender.publishedAt && `Published: ${tender.publishedAt.toISOString().slice(0, 10)}`,
    tender.deadline && `Deadline for bids: ${tender.deadline}`,
    value,
    tender.region && `Region: ${tender.region}`,
    "",
    tender.description,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n")
    .slice(0, 6000);
}

export const ukTenders: SourceAdapter = {
  slug: "uk_tenders",
  isConfigured: () => true,
  async healthCheck(): Promise<HealthStatus> {
    try {
      await searchTenders({ cpvCodes: ["72000000"], from: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10), size: 1 });
      return { ok: true, message: "Reachable." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Unreachable." };
    }
  },
};
