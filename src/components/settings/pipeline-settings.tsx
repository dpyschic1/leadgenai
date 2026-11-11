"use client";

import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useCreateStage, useDeleteStage, usePipeline, useRenameStage, useReorderStages } from "@/hooks/use-pipeline";
import { usePermission } from "@/hooks/use-permission";
import { MAX_STAGE_NAME, STAGE_KINDS, STAGE_KIND_LABELS, type PipelineStage, type StageKind } from "@/lib/domain/pipeline";
import { CONFIG_ROLES } from "@/lib/permissions";
import { SettingsSection } from "./settings-section";

const TITLE = "Sales pipeline";
const DESCRIPTION =
  "The stages an opportunity moves through, shared by your whole workspace. Rename, reorder, add or remove stages. Won and Lost keep their meaning for reporting whatever you call them, so at least one of each must remain.";

export function PipelineSettings() {
  const { data: stages } = usePipeline();
  const canEdit = usePermission(CONFIG_ROLES);

  if (!stages) {
    return (
      <SettingsSection title={TITLE} description={DESCRIPTION}>
        <div className="space-y-2" aria-label="Loading pipeline">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11 w-full rounded-lg" />
          ))}
        </div>
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title={TITLE} description={canEdit ? DESCRIPTION : `${DESCRIPTION} Only owners, admins and managers can change it.`}>
      <div className="space-y-4">
        <ul className="space-y-2" aria-label="Pipeline stages">
          {stages.map((stage, index) => (
            <StageRow key={`${stage.id}:${stage.name}`} stage={stage} stages={stages} index={index} canEdit={canEdit} />
          ))}
        </ul>
        {canEdit && <AddStage />}
      </div>
    </SettingsSection>
  );
}

function StageRow({ stage, stages, index, canEdit }: { stage: PipelineStage; stages: PipelineStage[]; index: number; canEdit: boolean }) {
  const [name, setName] = useState(stage.name);
  const [confirming, setConfirming] = useState(false);
  const [moveTo, setMoveTo] = useState<string>("");
  const rename = useRenameStage();
  const remove = useDeleteStage();
  const reorder = useReorderStages();
  const busy = rename.isPending || remove.isPending || reorder.isPending;
  const others = stages.filter((s) => s.id !== stage.id);

  const save = () => {
    const next = name.trim();
    if (next === stage.name) return;
    if (!next) return setName(stage.name);
    rename.mutate({ id: stage.id, name: next }, { onError: (e) => { toast.error(e.message); setName(stage.name); } });
  };
  const move = (delta: -1 | 1) => {
    const ids = stages.map((s) => s.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    reorder.mutate(ids, { onError: (e) => toast.error(e.message) });
  };
  const doDelete = () =>
    remove.mutate(
      { id: stage.id, moveTo: stage.opportunityCount > 0 ? moveTo || null : null },
      { onSuccess: () => toast.success(`Removed ${stage.name}.`), onError: (e) => toast.error(e.message) },
    );

  return (
    <li className="rounded-lg border p-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          maxLength={MAX_STAGE_NAME}
          disabled={!canEdit || busy}
          aria-label={`Stage ${index + 1} name`}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="h-9 flex-1"
        />
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {stage.kind !== "open" ? STAGE_KIND_LABELS[stage.kind] : stage.intake ? "New opportunities land here" : ""}
        </span>
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground" title="Opportunities in this stage">
          {stage.opportunityCount}
        </span>
        {canEdit && (
          <div className="flex shrink-0 items-center">
            <Button variant="ghost" size="icon" className="size-8" aria-label={`Move ${stage.name} up`} disabled={busy || index === 0} onClick={() => move(-1)}>
              <ArrowUpIcon />
            </Button>
            <Button variant="ghost" size="icon" className="size-8" aria-label={`Move ${stage.name} down`} disabled={busy || index === stages.length - 1} onClick={() => move(1)}>
              <ArrowDownIcon />
            </Button>
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label={`Remove ${stage.name}`} disabled={busy} onClick={() => setConfirming(true)}>
              <Trash2Icon />
            </Button>
          </div>
        )}
      </div>
      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-secondary/60 p-2.5 text-sm">
          {stage.opportunityCount > 0 ? (
            <>
              <span>
                Move {stage.opportunityCount} {stage.opportunityCount === 1 ? "opportunity" : "opportunities"} to
              </span>
              <Select value={moveTo} onValueChange={setMoveTo}>
                <SelectTrigger className="h-8 w-48" aria-label="Move opportunities to">
                  <SelectValue placeholder="Choose a stage" />
                </SelectTrigger>
                <SelectContent>
                  {others.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : (
            <span>Remove &ldquo;{stage.name}&rdquo;?</span>
          )}
          <Button size="sm" variant="destructive" disabled={remove.isPending || (stage.opportunityCount > 0 && !moveTo)} onClick={doDelete}>
            {remove.isPending && <Loader2Icon className="animate-spin" />}
            Remove stage
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  );
}

function AddStage() {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<StageKind>("open");
  const create = useCreateStage();
  const add = () =>
    create.mutate(
      { name: name.trim(), kind },
      { onSuccess: () => { setName(""); toast.success("Stage added."); }, onError: (e) => toast.error(e.message) },
    );

  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) add();
      }}
    >
      <Input value={name} maxLength={MAX_STAGE_NAME} onChange={(e) => setName(e.target.value)} placeholder="New stage, e.g. Negotiation" aria-label="New stage name" className="h-9 min-w-48 flex-1" />
      <Select value={kind} onValueChange={(v) => setKind(v as StageKind)}>
        <SelectTrigger className="h-9 w-40" aria-label="Stage kind">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STAGE_KINDS.map((k) => (
            <SelectItem key={k} value={k}>
              {STAGE_KIND_LABELS[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="submit" disabled={!name.trim() || create.isPending}>
        {create.isPending ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
        Add stage
      </Button>
    </form>
  );
}
