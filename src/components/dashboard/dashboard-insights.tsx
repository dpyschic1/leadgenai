"use client";

import Link from "next/link";
import { ArrowDownRightIcon, ArrowRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Label, LabelList, Pie, PieChart, PolarAngleAxis, RadialBar, RadialBarChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { useLeads } from "@/hooks/use-opportunities";
import { useDashboardReport, usePipeline, usePipelineReport } from "@/hooks/use-pipeline";
import type { LeadFilter } from "@/lib/api/opportunities";
import { CATEGORY_LABELS, FILTER_CATEGORY_LABELS } from "@/lib/domain/engine";
import { ROLE_FAMILIES, ROLE_FAMILY_LABELS, type RoleFamily } from "@/lib/domain/opportunities";
import type { DashboardReport } from "@/lib/domain/pipeline";
import { cn } from "@/lib/utils";
import { FIRST_PAGE } from "@/lib/validation/pagination";

/**
 * Chart colours: one hue (the brand's signal green) light to dark for magnitude, slate for "not a
 * lead" and "waiting", emerald for won. Text stays in the text colours.
 */
const C = {
  deep: "var(--signal-deep)",
  main: "var(--signal)",
  soft: "color-mix(in oklab, var(--signal) 45%, white)",
  faint: "color-mix(in oklab, var(--signal) 22%, white)",
  slate: "#94a3b8",
  pale: "#dbe1e8",
  won: "#059669",
} as const;

const ALL_LEADS: LeadFilter = { tab: "all", role: null, q: "", companyStage: null };

const fmt = (n: number) => n.toLocaleString();
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

/** The dashboard below the greeting: headline numbers, then the charts that explain them. */
export function DashboardInsights() {
  const { data: report } = useDashboardReport();
  const { data: outcomes } = usePipelineReport();
  const { data: leads } = useLeads(ALL_LEADS, FIRST_PAGE);

  return (
    <div className="space-y-6">
      <section aria-label="Key numbers" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {report ? (
          <>
            <KpiTile
              label="Opportunities found"
              value={report.thisWeek.found}
              change={report.thisWeek.found - report.lastWeek.found}
              daily={report.daily}
              dataKey="found"
              color={C.main}
              footnote={`${fmt(report.funnel.found)} active in total`}
            />
            <KpiTile
              label="New leads"
              value={report.thisWeek.leads}
              change={report.thisWeek.leads - report.lastWeek.leads}
              daily={report.daily}
              dataKey="leads"
              color={C.deep}
              footnote={`${fmt(report.quality.hot)} hot · ${fmt(report.quality.warm)} warm in all`}
            />
          </>
        ) : (
          <>
            <TileSkeleton />
            <TileSkeleton />
          </>
        )}
        {leads ? (
          <RadialTile
            label="Ready to contact"
            value={leads.counts.all - leads.counts.none}
            of={leads.counts.all}
            unit="leads"
            color={C.main}
            footnote={`${fmt(leads.counts.person)} direct · ${fmt(leads.counts.company)} company line`}
            href="/leads"
          />
        ) : (
          <TileSkeleton />
        )}
        {outcomes ? (
          <RadialTile
            label="Win rate"
            value={outcomes.total.won}
            of={outcomes.total.won + outcomes.total.lost}
            unit="closed"
            color={C.won}
            footnote={outcomes.total.won + outcomes.total.lost > 0 ? `${fmt(outcomes.total.won)} won · ${fmt(outcomes.total.lost)} lost` : "Nothing has closed yet"}
          />
        ) : (
          <TileSkeleton />
        )}
      </section>

      <div className="grid items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {report ? <ActivityChart daily={report.daily} /> : <Skeleton className="h-80 rounded-xl" />}
        {report ? <QualityDonut quality={report.quality} /> : <Skeleton className="h-80 rounded-xl" />}
      </div>

      <div className="grid items-stretch gap-6 lg:grid-cols-2">
        {report ? <LeadFunnel funnel={report.funnel} /> : <Skeleton className="h-72 rounded-xl" />}
        {leads ? <RoleDemand counts={leads.roleCounts} total={leads.counts.all} /> : <Skeleton className="h-72 rounded-xl" />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Card({ title, description, action, children, className }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col rounded-xl border bg-card", className)}>
      <div className="flex items-start justify-between gap-3 px-5 pt-4">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <div className="flex-1 p-5">{children}</div>
    </section>
  );
}

function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline underline-offset-4">
      {children}
      <ArrowRightIcon className="size-3.5" />
    </Link>
  );
}

function TileSkeleton() {
  return <Skeleton className="h-[8.5rem] rounded-xl" />;
}

/** The change from last week, with an arrow, so the direction never relies on colour alone. */
function Change({ value }: { value: number }) {
  const Icon = value > 0 ? ArrowUpRightIcon : value < 0 ? ArrowDownRightIcon : MinusIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums",
        value > 0 ? "bg-signal-tint text-[var(--signal-deep)]" : value < 0 ? "bg-red-50 text-red-700" : "bg-secondary text-muted-foreground",
      )}
      title="Compared with the 7 days before"
    >
      <Icon className="size-3" />
      {value > 0 ? `+${fmt(value)}` : fmt(value)}
    </span>
  );
}

/** A headline number for this week, its change from last week, and a 30-day trend. */
function KpiTile({
  label,
  value,
  change,
  daily,
  dataKey,
  color,
  footnote,
}: {
  label: string;
  value: number;
  change: number;
  daily: DashboardReport["daily"];
  dataKey: "found" | "leads";
  color: string;
  footnote: string;
}) {
  const config = { [dataKey]: { label, color } } satisfies ChartConfig;
  const gradient = `spark-${dataKey}`;
  return (
    <div className="flex flex-col rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="mt-1.5 flex items-end justify-between gap-3">
        <div className="shrink-0">
          <p className="text-3xl font-semibold tracking-tight tabular-nums">{fmt(value)}</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Change value={change} /> this week
          </p>
        </div>
        <ChartContainer config={config} className="aspect-auto h-12 w-full max-w-32">
          <AreaChart data={daily} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={`var(--color-${dataKey})`} stopOpacity={0.35} />
                <stop offset="100%" stopColor={`var(--color-${dataKey})`} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, p) => shortDate(p?.[0]?.payload?.date)} />} />
            <Area dataKey={dataKey} type="monotone" stroke={`var(--color-${dataKey})`} strokeWidth={2} fill={`url(#${gradient})`} isAnimationActive={false} />
          </AreaChart>
        </ChartContainer>
      </div>
      <p className="mt-auto truncate border-t pt-2.5 text-xs text-muted-foreground">{footnote}</p>
    </div>
  );
}

/** A share as a ring: how many of a whole (leads with a way in, deals won of those closed). */
function RadialTile({ label, value, of, unit, color, footnote, href }: { label: string; value: number; of: number; unit: string; color: string; footnote: string; href?: string }) {
  const share = pct(value, of);
  const config = { share: { label, color } } satisfies ChartConfig;
  const body = (
    <>
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="mt-1.5 flex items-end justify-between gap-3">
        <div className="shrink-0">
          <p className="text-3xl font-semibold tracking-tight tabular-nums">{of > 0 ? `${share}%` : "—"}</p>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            {fmt(value)} of {fmt(of)} {unit}
          </p>
        </div>
        <ChartContainer config={config} className="aspect-square h-14">
          <RadialBarChart data={[{ share }]} startAngle={90} endAngle={-270} innerRadius="72%" outerRadius="100%">
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
            <RadialBar dataKey="share" background={{ fill: "var(--muted)" }} fill="var(--color-share)" cornerRadius={8} isAnimationActive={false} />
          </RadialBarChart>
        </ChartContainer>
      </div>
      <p className="mt-auto truncate border-t pt-2.5 text-xs text-muted-foreground">{footnote}</p>
    </>
  );
  const className = "flex flex-col rounded-xl border bg-card p-4";
  return href ? (
    <Link href={href} className={cn(className, "transition-colors hover:border-primary/40")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

const activityConfig = {
  found: { label: "Found", color: C.soft },
  leads: { label: "Leads", color: C.deep },
} satisfies ChartConfig;

/** Each day of the last 30: opportunities found next to the leads the AI (or the team) made. */
function ActivityChart({ daily }: { daily: DashboardReport["daily"] }) {
  const totalFound = daily.reduce((s, d) => s + d.found, 0);
  const totalLeads = daily.reduce((s, d) => s + d.leads, 0);
  return (
    <Card title="Activity" description={`Last ${daily.length} days: ${fmt(totalFound)} opportunities found, ${fmt(totalLeads)} new leads.`}>
      <ChartContainer config={activityConfig} className="aspect-auto h-64 w-full">
        <BarChart data={daily} margin={{ top: 8, right: 4, left: -16, bottom: 0 }} barGap={1} barCategoryGap="22%">
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={shortDate} />
          <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={44} />
          <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.6 }} content={<ChartTooltipContent labelFormatter={(value) => shortDate(String(value))} />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="found" fill="var(--color-found)" radius={[3, 3, 0, 0]} />
          <Bar dataKey="leads" fill="var(--color-leads)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </Card>
  );
}

const qualityConfig = {
  hot: { label: "Hot", color: C.deep },
  warm: { label: "Warm", color: C.soft },
  notFit: { label: "Not a fit", color: C.slate },
  awaiting: { label: "Waiting for AI", color: C.pale },
} satisfies ChartConfig;

/** What the AI made of everything strong enough to read: hot, warm, not a fit, or still waiting. */
function QualityDonut({ quality }: { quality: DashboardReport["quality"] }) {
  const keys = ["hot", "warm", "notFit", "awaiting"] as const;
  const data = keys.map((key) => ({ key, value: quality[key], fill: `var(--color-${key})` }));
  const total = data.reduce((s, d) => s + d.value, 0);
  const leads = quality.hot + quality.warm;
  return (
    <Card title="Lead quality" description="How the AI judged what it read." action={<CardLink href="/leads">Leads</CardLink>}>
      <ChartContainer config={qualityConfig} className="mx-auto aspect-square h-52">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel />} />
          <Pie data={data} dataKey="value" nameKey="key" innerRadius="62%" outerRadius="92%" paddingAngle={total > 0 ? 2 : 0} cornerRadius={4} strokeWidth={0}>
            <Label
              content={({ viewBox }) =>
                viewBox && "cx" in viewBox ? (
                  <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                    <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-3xl font-semibold">
                      {fmt(leads)}
                    </tspan>
                    <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 22} className="fill-muted-foreground text-xs">
                      leads · {pct(leads, total)}%
                    </tspan>
                  </text>
                ) : null
              }
            />
          </Pie>
        </PieChart>
      </ChartContainer>
      <ul className="mt-4 space-y-1.5 text-sm">
        {data.map((d) => (
          <li key={d.key} className="flex items-center gap-2 px-1">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: qualityConfig[d.key].color }} aria-hidden="true" />
            <span className="flex-1">{qualityConfig[d.key].label}</span>
            <span className="tabular-nums">{fmt(d.value)}</span>
            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{pct(d.value, total)}%</span>
          </li>
        ))}
      </ul>
      {quality.tooWeak > 0 && <p className="mt-3 text-center text-xs text-muted-foreground">{fmt(quality.tooWeak)} more scored too low to be sent to the AI.</p>}
    </Card>
  );
}

const funnelConfig = { value: { label: "Opportunities" } } satisfies ChartConfig;

/** From found to won, each step a subset of the one before, with the share kept at each step. */
function LeadFunnel({ funnel }: { funnel: DashboardReport["funnel"] }) {
  const steps = [
    { step: "Found", value: funnel.found, fill: C.faint },
    { step: "Checked by AI", value: funnel.checked, fill: C.soft },
    { step: "Leads", value: funnel.leads, fill: C.main },
    { step: "Being worked", value: funnel.worked, fill: C.deep },
    { step: "Won", value: funnel.won, fill: C.won },
  ].map((s, i, all) => ({ ...s, kept: i === 0 ? "" : `${pct(s.value, all[i - 1].value)}%` }));
  return (
    <Card title="Lead funnel" description="How far your opportunities get. The % is what's kept from the step before." action={<CardLink href="/opportunities">Opportunities</CardLink>}>
      <ChartContainer config={funnelConfig} className="aspect-auto h-60 w-full">
        <BarChart data={steps} layout="vertical" margin={{ top: 0, right: 72, left: 0, bottom: 0 }} barCategoryGap="18%">
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="step" tickLine={false} axisLine={false} width={104} />
          <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.6 }} content={<ChartTooltipContent hideIndicator />} />
          <Bar dataKey="value" radius={4}>
            {steps.map((s) => (
              <Cell key={s.step} fill={s.fill} />
            ))}
            <LabelList dataKey="value" position="right" offset={8} className="fill-foreground text-xs font-medium" formatter={(v: unknown) => fmt(Number(v))} />
            <LabelList dataKey="kept" position="right" offset={44} className="fill-muted-foreground text-[11px]" />
          </Bar>
        </BarChart>
      </ChartContainer>
    </Card>
  );
}

const roleConfig = { count: { label: "Leads", color: C.main } } satisfies ChartConfig;

/** What the leads being worked are hiring for, by role type: where the demand for your people is. */
function RoleDemand({ counts, total }: { counts: Record<RoleFamily, number>; total: number }) {
  const rows = ROLE_FAMILIES.map((family) => ({ role: ROLE_FAMILY_LABELS[family], count: counts[family] }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return (
    <Card title="What leads are hiring for" description={`Role types across ${fmt(total)} leads. A lead can hire for several.`} action={<CardLink href="/leads">Leads</CardLink>}>
      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No roles yet. They appear as the AI finds leads.</p>
      ) : (
        <ChartContainer config={roleConfig} className="aspect-auto w-full" style={{ height: rows.length * 30 + 8 }}>
          <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }} barCategoryGap="22%">
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="role" tickLine={false} axisLine={false} width={104} />
            <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.6 }} content={<ChartTooltipContent />} />
            <Bar dataKey="count" fill="var(--color-count)" radius={4}>
              <LabelList dataKey="count" position="right" offset={8} className="fill-foreground text-xs font-medium" />
            </Bar>
          </BarChart>
        </ChartContainer>
      )}
    </Card>
  );
}

const STAGE_COLOR = { open: C.main, won: C.won, lost: C.slate } as const;
const sourceConfig = {
  found: { label: "Found", color: C.soft },
  leads: { label: "Leads", color: C.deep },
} satisfies ChartConfig;
const stageConfig = { count: { label: "Opportunities" } } satisfies ChartConfig;

/** Where opportunities sit in the pipeline, and which sources they come from and turn into leads. */
export function PipelineBreakdown() {
  const { data: stages } = usePipeline();
  const { data: report } = useDashboardReport();
  if (!stages || !report) return <Skeleton className="h-80 rounded-xl" aria-label="Loading pipeline" />;
  const stageRows = stages.map((s) => ({ stage: s.name, count: s.opportunityCount, fill: STAGE_COLOR[s.kind] }));
  const sourceRows = report.sources.map((s) => ({
    source: s.category === "freelance_project" ? CATEGORY_LABELS.freelance_project : FILTER_CATEGORY_LABELS[s.category],
    found: s.found,
    leads: s.leads,
  }));
  return (
    <Card title="Pipeline" description="Opportunities in each stage." action={<CardLink href="/settings">Stages</CardLink>}>
      <ChartContainer config={stageConfig} className="aspect-auto w-full" style={{ height: stageRows.length * 28 + 8 }}>
        <BarChart data={stageRows} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }} barCategoryGap="24%">
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="stage" tickLine={false} axisLine={false} width={120} />
          <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.6 }} content={<ChartTooltipContent hideIndicator />} />
          <Bar dataKey="count" radius={4}>
            {stageRows.map((s) => (
              <Cell key={s.stage} fill={s.fill} />
            ))}
            <LabelList dataKey="count" position="right" offset={8} className="fill-foreground text-xs font-medium" />
          </Bar>
        </BarChart>
      </ChartContainer>
      {sourceRows.length > 0 && (
        <div className="mt-5 border-t pt-4">
          <p className="mb-1 text-xs font-medium text-muted-foreground">By source: found and became leads</p>
          <ChartContainer config={sourceConfig} className="aspect-auto w-full" style={{ height: sourceRows.length * 44 + 36 }}>
            <BarChart data={sourceRows} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }} barGap={2} barCategoryGap="24%">
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="source" tickLine={false} axisLine={false} width={120} />
              <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.6 }} content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="found" fill="var(--color-found)" radius={4}>
                <LabelList dataKey="found" position="right" offset={6} className="fill-muted-foreground text-[11px]" />
              </Bar>
              <Bar dataKey="leads" fill="var(--color-leads)" radius={4}>
                <LabelList dataKey="leads" position="right" offset={6} className="fill-foreground text-[11px] font-medium" />
              </Bar>
            </BarChart>
          </ChartContainer>
        </div>
      )}
    </Card>
  );
}
