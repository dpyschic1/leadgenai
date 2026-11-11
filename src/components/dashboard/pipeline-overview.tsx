"use client";

import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { usePipeline, usePipelineReport } from "@/hooks/use-pipeline";
import { FILTER_CATEGORY_LABELS } from "@/lib/domain/engine";

/** Where opportunities sit in the pipeline, and how each source's opportunities have turned out. */
export function PipelineOverview() {
  const { data: stages } = usePipeline();
  const { data: report } = usePipelineReport();
  if (!stages || !report) return <Skeleton className="h-56 rounded-xl" aria-label="Loading pipeline" />;
  if (report.total.total === 0) return null;

  const max = Math.max(1, ...stages.map((s) => s.opportunityCount));
  const closed = report.total.won + report.total.lost;

  return (
    <section aria-labelledby="pipeline-heading" className="rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 id="pipeline-heading" className="font-semibold">
            Pipeline
          </h2>
          <p className="text-sm text-muted-foreground">
            {closed > 0 ? `Win rate ${report.total.winRate}% across ${closed} closed.` : "Nothing has closed yet, so there is no win rate."}
          </p>
        </div>
        <Link href="/opportunities" className="text-sm font-medium text-primary hover:underline underline-offset-4">
          Open opportunities
        </Link>
      </div>
      <div className="grid gap-6 p-5 lg:grid-cols-2">
        <ul className="space-y-2" aria-label="Opportunities by stage">
          {stages.map((s) => (
            <li key={s.id} className="grid grid-cols-[9rem_minmax(0,1fr)_3rem] items-center gap-3 text-sm">
              <span className="truncate">{s.name}</span>
              <span className="h-2 rounded-full bg-secondary">
                <span
                  className={`block h-2 rounded-full ${s.kind === "won" ? "bg-emerald-500" : s.kind === "lost" ? "bg-muted-foreground/50" : "bg-primary"}`}
                  style={{ width: `${(s.opportunityCount / max) * 100}%` }}
                />
              </span>
              <span className="text-right tabular-nums text-muted-foreground">{s.opportunityCount}</span>
            </li>
          ))}
        </ul>
        <table className="w-full text-sm">
          <caption className="sr-only">Outcomes by source</caption>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="pb-2 font-medium">Source</th>
              <th className="pb-2 text-right font-medium">Open</th>
              <th className="pb-2 text-right font-medium">Won</th>
              <th className="pb-2 text-right font-medium">Lost</th>
              <th className="pb-2 text-right font-medium">Win rate</th>
            </tr>
          </thead>
          <tbody>
            {report.rows
              .filter((r) => r.total > 0)
              .map((r) => (
                <tr key={r.category} className="border-t">
                  <td className="py-1.5">{FILTER_CATEGORY_LABELS[r.category]}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.open}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.won}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.lost}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.winRate === null ? "—" : `${r.winRate}%`}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
