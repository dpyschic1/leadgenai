"use client";

import { useMemo, useState } from "react";
import { Loader2Icon, PlayIcon } from "lucide-react";
import { toast } from "sonner";
import { MultiCombobox } from "@/components/forms/multi-combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useEngine, useRunCapability, useSetEngineEnabled, useUpdateCapability } from "@/hooks/use-engine";
import { usePermission } from "@/hooks/use-permission";
import { useReferenceData } from "@/hooks/use-reference-data";
import { useServices } from "@/hooks/use-services";
import type { CapabilityState } from "@/lib/api/types";
import { COUNTRY_CODES, countryName } from "@/lib/countries";
import {
  CAPABILITY_DESCRIPTIONS,
  CAPABILITY_LABELS,
  FRESHNESS_DAYS,
  type FreelanceConfig,
  type FundedConfig,
  type TargetingDimension,
  type TargetingOverride,
} from "@/lib/domain/engine";
import { CONFIG_ROLES } from "@/lib/permissions";
import { SettingsSection } from "./settings-section";

const TITLE = "LeadGen Engine";
const DESCRIPTION =
  "Finds opportunities automatically: people asking for your services, newly funded companies and freelance projects. Each capability has its own schedule and can target differently from your Services & ICP.";

const FREQUENCIES = [
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 60, label: "Hourly" },
  { minutes: 180, label: "Every 3 hours" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 720, label: "Every 12 hours" },
  { minutes: 1440, label: "Daily" },
  { minutes: 10080, label: "Weekly" },
];

/** A small accessible switch (the UI kit has none). */
function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent bg-input transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-checked:bg-primary"
    >
      <span className="pointer-events-none ml-0.5 size-5 rounded-full bg-background shadow transition-transform" style={{ transform: checked ? "translateX(1.25rem)" : "none" }} />
    </button>
  );
}

/** The presets, plus the saved interval when it isn't one of them (the API accepts any 15 min - 7 days). */
function frequencyOptions(current: number) {
  if (FREQUENCIES.some((f) => f.minutes === current)) return FREQUENCIES;
  const label = current % 60 === 0 ? `Every ${current / 60} hours` : `Every ${current} minutes`;
  return [...FREQUENCIES, { minutes: current, label }].sort((a, b) => a.minutes - b.minutes);
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

export function EngineSettings() {
  const { data } = useEngine();
  const canEdit = usePermission(CONFIG_ROLES);
  const setEnabled = useSetEngineEnabled();

  if (!data) {
    return (
      <SettingsSection title={TITLE} description={DESCRIPTION}>
        <div className="space-y-4" aria-label="Loading LeadGen Engine">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={TITLE} description={canEdit ? DESCRIPTION : `${DESCRIPTION} Only owners, admins and managers can change it.`}>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Enable LeadGen Engine</p>
            <p className="text-sm text-muted-foreground">Master switch. When off, nothing runs, whatever each capability is set to.</p>
          </div>
          <Switch
            label="Enable LeadGen Engine"
            checked={data.enabled}
            disabled={!canEdit || setEnabled.isPending}
            onChange={(enabled) => setEnabled.mutate(enabled, { onError: (e) => toast.error(e.message) })}
          />
        </div>
        <div className="space-y-4">
          {data.capabilities.map((c) => (
            <CapabilityCard key={`${c.capability}:${JSON.stringify(c)}`} state={c} workspace={data.workspaceTargeting} masterEnabled={data.enabled} canEdit={canEdit} />
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}

function CapabilityCard({
  state,
  workspace,
  masterEnabled,
  canEdit,
}: {
  state: CapabilityState;
  workspace: { countries: string[]; industries: string[]; serviceIds: string[] };
  masterEnabled: boolean;
  canEdit: boolean;
}) {
  const save = useUpdateCapability();
  const runNow = useRunCapability();
  const [enabled, setEnabled] = useState(state.enabled);
  const [frequency, setFrequency] = useState(state.frequencyMinutes);
  const [override, setOverride] = useState<TargetingOverride>(state.override);
  const [config, setConfig] = useState(state.config);

  const dirty =
    enabled !== state.enabled ||
    frequency !== state.frequencyMinutes ||
    JSON.stringify(override) !== JSON.stringify(state.override) ||
    JSON.stringify(config) !== JSON.stringify(state.config);

  const onSave = () =>
    save.mutate(
      { capability: state.capability, input: { enabled, frequencyMinutes: frequency, targeting: override, config: config as Record<string, unknown> } },
      {
        onSuccess: () => toast.success(`${CAPABILITY_LABELS[state.capability]} saved.`),
        onError: (error) => toast.error(error.message),
      },
    );

  const onRun = () =>
    runNow.mutate(state.capability, {
      onSuccess: ({ summary }) => {
        const failed = summary.sources.filter((x) => !x.ok);
        const message = `${CAPABILITY_LABELS[state.capability]}: ${summary.found} found, ${summary.created} new, ${summary.updated} updated.`;
        const skipped = summary.sources.filter((x) => x.note);
        const detail = [...failed.map((x) => `${x.source}: ${x.error}`), ...skipped.map((x) => `${x.source} skipped: ${x.note}`)].join(" ");
        if (failed.length || skipped.length) toast.warning(`${message} ${detail}`);
        else toast.success(message);
      },
      onError: (error) => toast.error(error.message),
    });

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">{CAPABILITY_LABELS[state.capability]}</h3>
          <p className="text-sm text-muted-foreground">{CAPABILITY_DESCRIPTIONS[state.capability]}</p>
        </div>
        <Switch label={`Enable ${CAPABILITY_LABELS[state.capability]}`} checked={enabled} onChange={setEnabled} disabled={!canEdit} />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Runs</span>
          <Select value={String(frequency)} onValueChange={(v) => setFrequency(Number(v))} disabled={!canEdit}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {frequencyOptions(state.frequencyMinutes).map((f) => (
                <SelectItem key={f.minutes} value={String(f.minutes)}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="text-sm text-muted-foreground">
          <p>Last run: {when(state.lastRunAt)}{state.lastStatus && ` · ${state.lastStatus}`}</p>
          <p>Next run: {masterEnabled && state.enabled ? when(state.nextRunAt) : "paused"}</p>
          {state.lastError && <p className="text-destructive">{state.lastError}</p>}
        </div>
      </div>

      <Targeting override={override} onChange={setOverride} workspace={workspace} disabled={!canEdit} />
      <CapabilityFilters capability={state.capability} config={config} onChange={setConfig} disabled={!canEdit} />

      {canEdit && (
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={onRun}
            disabled={dirty || runNow.isPending || !masterEnabled}
            aria-busy={runNow.isPending}
            title={dirty ? "Save your changes first" : undefined}
          >
            {runNow.isPending ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            Run now
          </Button>
          <Button onClick={onSave} disabled={!dirty || save.isPending} aria-busy={save.isPending}>
            {save.isPending && <Loader2Icon className="animate-spin" />}
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

function Targeting({
  override,
  onChange,
  workspace,
  disabled,
}: {
  override: TargetingOverride;
  onChange: (o: TargetingOverride) => void;
  workspace: { countries: string[]; industries: string[]; serviceIds: string[] };
  disabled: boolean;
}) {
  const { data: ref } = useReferenceData();
  const { data: serviceList } = useServices();
  const options = useMemo(
    () => ({
      countries: COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code) })).sort((a, b) => a.label.localeCompare(b.label)),
      industries: (ref?.industries ?? []).map((i) => ({ value: i.slug, label: i.name })),
      serviceIds: (serviceList?.items ?? []).map((s) => ({ value: s.id, label: s.name })),
    }),
    [ref, serviceList],
  );
  const dimensions: { key: TargetingDimension; label: string; any: string }[] = [
    { key: "countries", label: "Countries", any: "any country" },
    { key: "industries", label: "Industries", any: "any industry" },
    { key: "serviceIds", label: "Services", any: "all services" },
  ];

  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm font-medium">Targeting</p>
      {dimensions.map(({ key, label, any }) => {
        const custom = override[key] !== null;
        const labelOf = new Map(options[key].map((o) => [o.value, o.label]));
        const inherited = workspace[key].map((v) => labelOf.get(v) ?? v);
        return (
          <div key={key} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>{label}</span>
              <label className="flex items-center gap-2 text-muted-foreground">
                <input
                  type="checkbox"
                  checked={custom}
                  disabled={disabled}
                  onChange={(e) => onChange({ ...override, [key]: e.target.checked ? [...workspace[key]] : null })}
                />
                Customize
              </label>
            </div>
            {custom ? (
              <MultiCombobox
                options={options[key]}
                value={override[key] ?? []}
                onChange={(v) => onChange({ ...override, [key]: v })}
                placeholder={`Choose ${label.toLowerCase()}`}
                searchPlaceholder={`Search ${label.toLowerCase()}`}
                emptyText="No match."
              />
            ) : (
              <p className="text-sm text-muted-foreground">From Services &amp; ICP: {inherited.length ? inherited.join(", ") : any}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CapabilityFilters({
  capability,
  config,
  onChange,
  disabled,
}: {
  capability: CapabilityState["capability"];
  config: CapabilityState["config"];
  onChange: (c: CapabilityState["config"]) => void;
  disabled: boolean;
}) {
  if (capability === "funded") {
    const c = config as FundedConfig;
    return (
      <div className="mt-4 space-y-1.5">
        <p className="text-sm font-medium">Funding date range</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input type="date" aria-label="Funded from" disabled={disabled} value={c.fundedFrom ?? ""} onChange={(e) => onChange({ ...c, fundedFrom: e.target.value || null })} />
          <Input type="date" aria-label="Funded to" disabled={disabled} value={c.fundedTo ?? ""} onChange={(e) => onChange({ ...c, fundedTo: e.target.value || null })} />
        </div>
        <p className="text-sm text-muted-foreground">Every disclosed round counts, at any amount. Leave blank for no limit.</p>
      </div>
    );
  }
  if (capability === "freelance") {
    const c = config as FreelanceConfig;
    return (
      <div className="mt-4 space-y-3">
        <p className="text-sm font-medium">Project filters</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span>Minimum budget (USD)</span>
            <Input type="number" min={0} disabled={disabled} value={c.minBudgetUsd} onChange={(e) => onChange({ ...c, minBudgetUsd: Math.max(0, Math.floor(e.target.valueAsNumber || 0)) })} />
          </label>
          <label className="space-y-1.5 text-sm">
            <span>Posted within</span>
            <Select value={String(c.postedWithinDays)} onValueChange={(v) => onChange({ ...c, postedWithinDays: Number(v) as FreelanceConfig["postedWithinDays"] })} disabled={disabled}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FRESHNESS_DAYS.map((d) => (
                  <SelectItem key={d} value={String(d)}>{d === 1 ? "Last 24 hours" : `Last ${d} days`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span>Projects with no stated budget</span>
            <Select value={c.undisclosedBudget} onValueChange={(v) => onChange({ ...c, undisclosedBudget: v as FreelanceConfig["undisclosedBudget"] })} disabled={disabled}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="include">Include, marked “budget unavailable”</SelectItem>
                <SelectItem value="exclude">Exclude</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span>Work location</span>
            <Select value={c.workMode} onValueChange={(v) => onChange({ ...c, workMode: v as FreelanceConfig["workMode"] })} disabled={disabled}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Remote or on-site</SelectItem>
                <SelectItem value="remote">Remote only</SelectItem>
                <SelectItem value="onsite">On-site only</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        <div className="flex gap-4 text-sm">
          {(["company", "individual"] as const).map((type) => (
            <label key={type} className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={disabled}
                checked={c.clientTypes.includes(type)}
                onChange={(e) => {
                  const next = e.target.checked ? [...c.clientTypes, type] : c.clientTypes.filter((t) => t !== type);
                  if (next.length) onChange({ ...c, clientTypes: next });
                }}
              />
              {type === "company" ? "Companies" : "Individuals"}
            </label>
          ))}
        </div>
      </div>
    );
  }
  return null;
}
