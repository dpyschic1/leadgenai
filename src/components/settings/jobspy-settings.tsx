"use client";

import { useEffect, useState } from "react";
import { ExternalLinkIcon, Loader2Icon, PlayIcon } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useJobspy, useRunJobspy, useSetJobspySendToOpportunities } from "@/hooks/use-jobspy";
import { usePermission } from "@/hooks/use-permission";
import type { JobspyRunRow, JobspySwitchResult } from "@/lib/api/jobspy";
import { CONFIG_ROLES } from "@/lib/permissions";
import {
  JOBSPY_BOARD_LABELS,
  JOBSPY_BOARDS,
  JOBSPY_HOURS_OLD,
  JOBSPY_MAX_RESULTS,
  type JobspyBoard,
} from "@/lib/validation/jobspy";
import { SettingsSection } from "./settings-section";

/**
 * JobSpy import: runs one JobSpy search on the separate JobSpy service and stores the jobs in
 * their own tables; "Send to Opportunities" (off by default) turns them into companies and signals.
 */

const TITLE = "JobSpy import";
const DESCRIPTION =
  "Fetches job posts from Indeed, LinkedIn, Glassdoor and ZipRecruiter through the separate JobSpy service. Stored apart from the engines, and only sent to Opportunities when you switch it on. One run at a time, then a cooldown.";

const HOURS_LABELS: Record<(typeof JOBSPY_HOURS_OLD)[number], string> = { 24: "Last 24 hours", 72: "Last 3 days", 168: "Last 7 days", 720: "Last 30 days" };
const when = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const label = (board: string) => JOBSPY_BOARD_LABELS[board as JobspyBoard] ?? board;

/** Re-renders every few seconds so the cooldown counts down. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function JobspySettings() {
  const canRun = usePermission(CONFIG_ROLES);
  // Only owners, admins and managers may see or run it (the API refuses everyone else).
  if (!canRun) return null;
  return <JobspyCard />;
}

function JobspyCard() {
  const { data } = useJobspy();
  const run = useRunJobspy();
  const now = useNow(5_000);
  const [searchTerm, setSearchTerm] = useState("");
  const [location, setLocation] = useState("United States");
  const [boards, setBoards] = useState<JobspyBoard[]>([...JOBSPY_BOARDS]);
  const [resultsPerBoard, setResultsPerBoard] = useState(JOBSPY_MAX_RESULTS);
  const [hoursOld, setHoursOld] = useState<(typeof JOBSPY_HOURS_OLD)[number] | null>(72);

  if (!data) {
    return (
      <SettingsSection title={TITLE} description={DESCRIPTION}>
        <Skeleton className="h-40 w-full rounded-lg" aria-label="Loading JobSpy import" />
      </SettingsSection>
    );
  }

  const waitMs = data.nextRunAt ? new Date(data.nextRunAt).getTime() - now : 0;
  const coolingDown = waitMs > 0;
  const blocked = !data.configured || coolingDown || run.isPending || !boards.length || !searchTerm.trim() || !location.trim();

  const onRun = () =>
    run.mutate(
      { searchTerm, location, boards, resultsPerBoard, hoursOld },
      {
        onSuccess: ({ lastRun }) => {
          if (!lastRun) return;
          const message = `JobSpy: ${lastRun.found} found, ${lastRun.created} new.`;
          const problems = Object.entries(lastRun.errors).map(([board, error]) => `${label(board)}: ${error}`).join(" ");
          if (lastRun.status === "failed") toast.error(`${message} ${problems}`);
          else if (problems) toast.warning(`${message} ${problems}`);
          else toast.success(message);
        },
        onError: (error) => toast.error(error.message),
      },
    );

  const total = Object.values(data.totals).reduce((a, b) => a + b, 0);

  return (
    <SettingsSection title={TITLE} description={DESCRIPTION}>
      <div className="space-y-5">
        {!data.configured && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            Not set up: start the JobSpy service (<code>jobspy-service/</code>) and set <code>JOBSPY_SERVICE_URL</code> and <code>JOBSPY_SERVICE_KEY</code> in the app&apos;s environment.
          </p>
        )}

        <SendToOpportunities on={data.sendToOpportunities} />

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Keywords</span>
            <Input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="e.g. .NET developer" maxLength={200} />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Location (US)</span>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Austin, TX" maxLength={200} />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Jobs per board</span>
            <Input
              type="number"
              min={1}
              max={JOBSPY_MAX_RESULTS}
              value={resultsPerBoard}
              onChange={(e) => setResultsPerBoard(Math.min(JOBSPY_MAX_RESULTS, Math.max(1, Math.floor(e.target.valueAsNumber || 1))))}
            />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Posted within</span>
            <Select value={hoursOld === null ? "any" : String(hoursOld)} onValueChange={(v) => setHoursOld(v === "any" ? null : (Number(v) as (typeof JOBSPY_HOURS_OLD)[number]))}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {JOBSPY_HOURS_OLD.map((h) => (
                  <SelectItem key={h} value={String(h)}>{HOURS_LABELS[h]}</SelectItem>
                ))}
                <SelectItem value="any">Any time</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>

        <fieldset className="space-y-1.5 text-sm">
          <legend className="font-medium">Boards</legend>
          <div className="flex flex-wrap gap-4 pt-1.5">
            {JOBSPY_BOARDS.map((board) => (
              <label key={board} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={boards.includes(board)}
                  onChange={(e) => setBoards(e.target.checked ? [...boards, board] : boards.filter((b) => b !== board))}
                />
                {JOBSPY_BOARD_LABELS[board]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {run.isPending
              ? "Searching… this can take up to a minute."
              : coolingDown
                ? `Next run allowed in ${Math.ceil(waitMs / 60_000)} min (every ${data.cooldownMinutes} min).`
                : `Ready. After a run, the button stays off for ${data.cooldownMinutes} minutes.`}
          </p>
          <Button onClick={onRun} disabled={blocked} aria-busy={run.isPending}>
            {run.isPending ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            Run
          </Button>
        </div>

        {data.lastRun && <LastRun run={data.lastRun} />}

        <div className="space-y-2">
          <p className="text-sm font-medium">
            Stored jobs: {total}
            {total > 0 && (
              <span className="font-normal text-muted-foreground">
                {" "}({Object.entries(data.totals).map(([board, n]) => `${label(board)} ${n}`).join(" · ")})
              </span>
            )}
          </p>
          {data.recent.length > 0 && (
            <ul className="divide-y rounded-md border text-sm">
              {data.recent.map((job) => (
                <li key={job.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{job.title}</p>
                    <p className="truncate text-muted-foreground">
                      {[job.company, job.location, label(job.board), job.datePosted].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <a href={job.jobUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={`Open ${job.title}`}>
                    <ExternalLinkIcon className="size-4" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function LastRun({ run }: { run: JobspyRunRow }) {
  const errors = Object.entries(run.errors);
  return (
    <div className="rounded-md bg-muted/50 p-3 text-sm">
      <p>
        Last run {when.format(new Date(run.startedAt))} · <span className="font-medium">{run.status}</span> · “{run.searchTerm}” in {run.location} ·{" "}
        {run.found} found, {run.created} new
      </p>
      {errors.map(([board, error]) => (
        <p key={board} className="text-destructive">{label(board)}: {error}</p>
      ))}
    </div>
  );
}

function summary(result: JobspySwitchResult): string {
  if (result.removed) return `Removed ${result.removed.signals} JobSpy signals and ${result.removed.companies} companies found only by JobSpy.`;
  const m = result.matched;
  if (!m) return "Saved.";
  const parts = [`${m.companies} companies matched (${m.newCompanies} new), ${m.signals} signals`];
  if (m.skippedNoWebsite) parts.push(`${m.skippedNoWebsite} jobs skipped: no company website`);
  if (m.more) parts.push("more after the next run");
  return `Sent to Opportunities: ${parts.join("; ")}.`;
}

function SendToOpportunities({ on }: { on: boolean }) {
  const toggle = useSetJobspySendToOpportunities();
  const [confirmOff, setConfirmOff] = useState(false);
  const set = (value: boolean) =>
    toggle.mutate(value, {
      onSuccess: (result) => {
        setConfirmOff(false);
        toast.success(summary(result));
      },
      onError: (error) => toast.error(error.message),
    });

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">Send to Opportunities</p>
        <p className="text-sm text-muted-foreground">
          {on
            ? "On: jobs in your services and countries become companies and hiring signals, scored like any other. Only jobs with a company website are used."
            : "Off: jobs stay here only. Turning it on matches the stored jobs now and every new run after."}
        </p>
      </div>
      <label className="flex shrink-0 items-center gap-2 text-sm">
        {toggle.isPending && <Loader2Icon className="size-4 animate-spin" />}
        <input
          type="checkbox"
          role="switch"
          aria-label="Send to Opportunities"
          checked={on}
          disabled={toggle.isPending}
          onChange={(e) => (e.target.checked ? set(true) : setConfirmOff(true))}
        />
      </label>
      <ConfirmDialog
        open={confirmOff}
        title="Stop sending JobSpy jobs to Opportunities?"
        description="This removes every signal JobSpy added in this workspace, and deletes the companies only JobSpy found (with their opportunities, contacts and pipeline place). Companies with signals from other sources stay and are re-scored. The stored jobs stay here."
        confirmLabel="Turn off and remove"
        pending={toggle.isPending}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => set(false)}
      />
    </div>
  );
}
