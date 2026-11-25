"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  ArrowRightIcon,
  BriefcaseBusinessIcon,
  CheckIcon,
  ClockIcon,
  FlameIcon,
  KanbanIcon,
  MailIcon,
  PhoneIcon,
  SearchIcon,
  SunIcon,
  TimerIcon,
  TrophyIcon,
  UserRoundIcon,
  UsersRoundIcon,
  XCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { CompanyAvatar } from "@/components/companies/company-avatar";
import { PageHeader } from "@/components/layout/page-header";
import { ScoreRing } from "@/components/opportunities/score-ring";
import { LeadBadge } from "@/components/opportunities/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermission } from "@/hooks/use-permission";
import { useMoveLead, usePipeline, usePipelineBoard } from "@/hooks/use-pipeline";
import type { PipelineCard } from "@/lib/api/types";
import type { PipelineStage, StageRef } from "@/lib/domain/pipeline";
import { opportunityName } from "@/lib/opportunity-display";
import { EDITOR_ROLES } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { StageManager } from "./stage-manager";

/** Days a lead can sit before it needs a nudge: new leads should be reached quickly, the rest followed up weekly. */
const REACH_OUT_DAYS = 3;
const FOLLOW_UP_DAYS = 7;
const DAY = 86_400_000;

type Temperature = "all" | "hot" | "warm";

/**
 * Where every lead stands, as a board: one column per stage, New through Won and Lost. Drag a card to
 * move it; click it for a quick look and its contact. Leads that have sat too long are flagged.
 */
export function PipelineBoard() {
  const { data: stages } = usePipeline();
  const { data: board } = usePipelineBoard();
  const canMove = usePermission(EDITOR_ROLES);
  const move = useMoveLead();
  const [now] = useState(() => Date.now());
  const [search, setSearch] = useState("");
  const [temperature, setTemperature] = useState<Temperature>("all");
  const [dragging, setDragging] = useState<string | null>(null);
  const [peekId, setPeekId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));

  const cards = useMemo(() => board?.items ?? [], [board]);
  const q = search.trim().toLowerCase();
  const visible = cards.filter((c) => (temperature === "all" || c.lead.status === temperature) && (!q || opportunityName(c).toLowerCase().includes(q)));
  const intakeId = stages?.find((s) => s.intake)?.id;
  const daysIn = (card: PipelineCard) => Math.max(0, Math.floor((now - new Date(card.enteredStageAt).getTime()) / DAY));
  const nudge = (card: PipelineCard): "reach" | "follow" | null => {
    if (card.stage.kind !== "open") return null;
    if (card.stage.id === intakeId) return daysIn(card) >= REACH_OUT_DAYS ? "reach" : null;
    return daysIn(card) >= FOLLOW_UP_DAYS ? "follow" : null;
  };

  const drop = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    const card = cards.find((c) => c.id === active.id);
    const stage = stages?.find((s) => s.id === over?.id);
    if (!card || !stage || card.stage.id === stage.id) return;
    moveTo(card, stage);
  };
  const moveTo = (card: PipelineCard, stage: StageRef) =>
    move.mutate(
      { id: card.id, stage: { id: stage.id, name: stage.name, kind: stage.kind } },
      { onSuccess: () => toast.success(`${opportunityName(card)} moved to ${stage.name}.`), onError: (e) => toast.error(e.message) },
    );

  const active = cards.find((c) => c.id === dragging) ?? null;
  const peek = cards.find((c) => c.id === peekId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline"
        description="Every lead by the stage it's in. Drag a card to move it on; leads that have waited too long are flagged."
        action={<StageManager />}
      />

      {stages && board ? (
        <Summary cards={cards} stages={stages} nudges={cards.filter((c) => nudge(c) !== null).length} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[4.5rem] rounded-xl" />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="radiogroup" aria-label="Temperature" className="inline-flex self-start rounded-lg border bg-card p-1">
          {(["all", "hot", "warm"] as const).map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={temperature === t}
              onClick={() => setTemperature(t)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                temperature === t ? "bg-signal-tint font-medium text-[var(--signal-deep)]" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "hot" && <FlameIcon className="size-3.5" />}
              {t === "warm" && <SunIcon className="size-3.5" />}
              {t === "all" ? "All leads" : t === "hot" ? "Hot" : "Warm"}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a lead" aria-label="Find a lead" className="h-9 bg-card pl-9" />
        </div>
      </div>

      {!stages || !board ? (
        <div className="flex gap-4 overflow-hidden">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-96 w-72 shrink-0 rounded-xl" />
          ))}
        </div>
      ) : cards.length === 0 ? (
        <EmptyBoard />
      ) : (
        <DndContext sensors={sensors} onDragStart={({ active }) => setDragging(String(active.id))} onDragCancel={() => setDragging(null)} onDragEnd={drop}>
          <div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-3">
            {stages.map((stage) => {
              const inStage = visible.filter((c) => c.stage.id === stage.id);
              return (
                <Column key={stage.id} stage={stage} accent={stageAccent(stage, stages)} count={inStage.length}>
                  {inStage.map((card) => (
                    <DraggableCard key={card.id} card={card} disabled={!canMove} onOpen={() => setPeekId(card.id)}>
                      <LeadCard card={card} days={daysIn(card)} nudge={nudge(card)} />
                    </DraggableCard>
                  ))}
                </Column>
              );
            })}
          </div>
          <DragOverlay dropAnimation={null}>
            {active && (
              <div className="w-72 rotate-2 cursor-grabbing shadow-xl">
                <LeadCard card={active} days={daysIn(active)} nudge={nudge(active)} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
      {board?.truncated && <p className="text-xs text-muted-foreground">Showing the best {cards.length} leads. Archive closed ones to see the rest here.</p>}

      <LeadPeek card={peek} stages={stages ?? []} days={peek ? daysIn(peek) : 0} canMove={canMove} onMove={moveTo} onClose={() => setPeekId(null)} />
    </div>
  );
}

/** Open stages deepen in green as a lead gets closer to a deal; Won is emerald, Lost slate. */
function stageAccent(stage: PipelineStage, stages: PipelineStage[]): string {
  if (stage.kind === "won") return "#059669";
  if (stage.kind === "lost") return "#94a3b8";
  const open = stages.filter((s) => s.kind === "open");
  const step = open.findIndex((s) => s.id === stage.id);
  const share = open.length > 1 ? 35 + Math.round((65 * step) / (open.length - 1)) : 100;
  return `color-mix(in oklab, var(--signal) ${share}%, white)`;
}

/** The board at a glance: what needs doing now, what's moving, and what closed. */
function Summary({ cards, stages, nudges }: { cards: PipelineCard[]; stages: PipelineStage[]; nudges: number }) {
  const intake = stages.find((s) => s.intake)?.id;
  const count = (test: (c: PipelineCard) => boolean) => cards.filter(test).length;
  const tiles = [
    { label: "To reach out", value: count((c) => c.stage.id === intake), icon: UsersRoundIcon, hint: "New leads nobody has contacted yet" },
    { label: "In progress", value: count((c) => c.stage.kind === "open" && c.stage.id !== intake), icon: TimerIcon, hint: "Contacted and moving through your stages" },
    { label: "Need a nudge", value: nudges, icon: ClockIcon, hint: `New for ${REACH_OUT_DAYS}+ days, or no move in ${FOLLOW_UP_DAYS}+ days`, warn: nudges > 0 },
    { label: "Won · lost", value: `${count((c) => c.stage.kind === "won")} · ${count((c) => c.stage.kind === "lost")}`, icon: TrophyIcon, hint: "Closed leads still on the board" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map(({ label, value, icon: Icon, hint, warn }) => (
        <div key={label} className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3" title={hint}>
          <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", warn ? "bg-amber-50 text-amber-700" : "bg-signal-tint text-[var(--signal-deep)]")}>
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-xl leading-tight font-semibold tabular-nums">{value}</p>
            <p className="truncate text-xs text-muted-foreground">{label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function Column({ stage, accent, count, children }: { stage: PipelineStage; accent: string; count: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const hint = stage.kind === "won" ? "Closed, won" : stage.kind === "lost" ? "Closed, lost" : stage.intake ? "New leads land here" : "In progress";
  return (
    <section
      ref={setNodeRef}
      aria-label={`${stage.name}, ${count} leads`}
      className={cn("flex w-72 shrink-0 flex-col rounded-xl border bg-canvas transition-colors", isOver && "border-primary/50 bg-signal-tint/60")}
    >
      <header className="rounded-t-xl border-t-[3px] px-3 pt-2.5 pb-2" style={{ borderTopColor: accent }}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-sm font-semibold">{stage.name}</h2>
          <span className="rounded-full bg-card px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground ring-1 ring-border">{count}</span>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
      </header>
      <div className="flex max-h-[68vh] min-h-32 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {children}
        {count === 0 && <p className="m-auto px-4 py-6 text-center text-xs text-muted-foreground">Drop a lead here</p>}
      </div>
    </section>
  );
}

function DraggableCard({ card, disabled, onOpen, children }: { card: PipelineCard; disabled: boolean; onOpen: () => void; children: React.ReactNode }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: card.id, disabled });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      aria-label={`${opportunityName(card)}. Press Enter to open, Space to pick up and move.`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
        else listeners?.onKeyDown?.(e);
      }}
      className={cn("rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50", disabled ? "cursor-pointer" : "cursor-grab", isDragging && "opacity-40")}
    >
      {children}
    </div>
  );
}

/** One lead on the board: who, how hot, who to talk to, how to reach them, and how long it's been here. */
function LeadCard({ card, days, nudge }: { card: PipelineCard; days: number; nudge: "reach" | "follow" | null }) {
  const name = opportunityName(card);
  const email = card.contact?.email ?? card.companyContact.email;
  const phone = card.contact?.phone ?? card.companyContact.phone;
  const hot = card.lead.status === "hot";
  const closed = card.stage.kind !== "open";
  const roles = card.openRoles.titles;
  return (
    <article className="rounded-lg border bg-card p-3 shadow-[0_1px_2px_rgba(27,36,51,0.05)] transition-colors hover:border-primary/40">
      <div className="flex items-start gap-2.5">
        <CompanyAvatar name={name} className="size-8 rounded-md text-[11px]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm leading-snug font-medium">{name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {roles.length > 0 ? (
              <>
                <BriefcaseBusinessIcon className="mr-1 inline size-3 align-[-2px]" />
                {roles[0]}
                {card.openRoles.total > 1 && ` +${card.openRoles.total - 1}`}
              </>
            ) : (
              (card.service?.name ?? "No service matched")
            )}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
            hot ? "bg-primary text-primary-foreground" : "bg-signal-tint text-[var(--signal-deep)]",
          )}
          title={card.lead.score !== null ? `AI fit ${card.lead.score}` : undefined}
        >
          {hot ? <FlameIcon className="size-3" /> : <SunIcon className="size-3" />}
          {card.lead.score ?? (hot ? "Hot" : "Warm")}
        </span>
      </div>

      <p className="mt-2.5 flex items-center gap-1.5 truncate text-xs">
        {card.contact ? (
          <>
            <UserRoundIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">
              <span className="font-medium">{card.contact.name}</span>
              {card.contact.title && <span className="text-muted-foreground"> · {card.contact.title}</span>}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{email || phone ? "Company line only" : "No contact yet"}</span>
        )}
      </p>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t pt-2">
        <span className="flex items-center gap-1.5">
          <MailIcon className={cn("size-3.5", email ? "text-foreground/70" : "text-muted-foreground/30")} aria-label={email ? "Has email" : "No email"} />
          <PhoneIcon className={cn("size-3.5", phone ? "text-foreground/70" : "text-muted-foreground/30")} aria-label={phone ? "Has phone" : "No phone"} />
        </span>
        {nudge ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
            <ClockIcon className="size-3" />
            {nudge === "reach" ? "Reach out" : "Follow up"} · {days}d
          </span>
        ) : (
          <span className="text-[11px] tabular-nums text-muted-foreground">{closed ? `Closed ${ago(days)}` : `${days === 0 ? "Today" : `${days}d`} in stage`}</span>
        )}
      </div>
    </article>
  );
}

const ago = (days: number) => (days === 0 ? "today" : `${days}d ago`);

/**
 * A quick look without leaving the board: the AI's reason, who to contact and how, and the stages as
 * steps to move it along. The full lead page is one click away.
 */
function LeadPeek({
  card,
  stages,
  days,
  canMove,
  onMove,
  onClose,
}: {
  card: PipelineCard | null;
  stages: PipelineStage[];
  days: number;
  canMove: boolean;
  onMove: (card: PipelineCard, stage: StageRef) => void;
  onClose: () => void;
}) {
  const email = card ? (card.contact?.email ?? card.companyContact.email) : null;
  const phone = card ? (card.contact?.phone ?? card.companyContact.phone) : null;
  const current = card ? stages.findIndex((s) => s.id === card.stage.id) : -1;
  return (
    <Sheet open={card !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        {card && (
          <>
            <SheetHeader className="border-b">
              <div className="flex items-center gap-3 pr-8">
                <CompanyAvatar name={opportunityName(card)} className="size-11 rounded-xl text-sm" />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-lg">{opportunityName(card)}</SheetTitle>
                  <SheetDescription className="mt-0.5 flex items-center gap-2">
                    <LeadBadge lead={card.lead} showScore={false} />
                    <span>
                      {card.stage.name} · {card.stage.kind === "open" ? `${days === 0 ? "today" : `${days}d`} in stage` : `closed ${ago(days)}`}
                    </span>
                  </SheetDescription>
                </div>
                <ScoreRing score={card.lead.score} size="sm" />
              </div>
            </SheetHeader>

            <div className="flex-1 space-y-6 overflow-y-auto p-4">
              {card.lead.reason && (
                <section>
                  <h3 className="text-xs font-medium text-muted-foreground">Why it&apos;s a lead</h3>
                  <p className="mt-1 text-sm leading-relaxed">{card.lead.reason}</p>
                </section>
              )}

              <section>
                <h3 className="text-xs font-medium text-muted-foreground">Contact</h3>
                <p className="mt-1 text-sm">
                  {card.contact ? (
                    <>
                      <span className="font-medium">{card.contact.name}</span>
                      {card.contact.title && <span className="text-muted-foreground">, {card.contact.title}</span>}
                    </>
                  ) : email || phone ? (
                    <span className="text-muted-foreground">No named person yet: use the company line.</span>
                  ) : (
                    <span className="text-muted-foreground">No contact found yet.</span>
                  )}
                </p>
                {(email || phone) && (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {email && (
                      <Button asChild size="sm">
                        <a href={`mailto:${email}`} title={email}>
                          <MailIcon />
                          Email
                        </a>
                      </Button>
                    )}
                    {phone && (
                      <Button asChild size="sm" variant="outline">
                        <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} title={phone}>
                          <PhoneIcon />
                          Call
                        </a>
                      </Button>
                    )}
                  </div>
                )}
              </section>

              <section>
                <h3 className="text-xs font-medium text-muted-foreground">Stage</h3>
                <ol className="mt-2 space-y-1">
                  {stages.map((stage, index) => {
                    const isCurrent = stage.id === card.stage.id;
                    const passed = stage.kind === "open" && card.stage.kind !== "lost" && index < current;
                    const Icon = stage.kind === "won" ? TrophyIcon : stage.kind === "lost" ? XCircleIcon : null;
                    return (
                      <li key={stage.id}>
                        <button
                          type="button"
                          disabled={!canMove || isCurrent}
                          onClick={() => onMove(card, stage)}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                            isCurrent ? "bg-signal-tint font-medium text-[var(--signal-deep)]" : "enabled:hover:bg-accent disabled:cursor-default",
                          )}
                        >
                          <span
                            className={cn(
                              "grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold tabular-nums",
                              isCurrent && "border-primary bg-primary text-primary-foreground",
                              passed && "border-primary/30 bg-signal-tint text-primary",
                              !isCurrent && !passed && "text-muted-foreground",
                            )}
                          >
                            {passed ? <CheckIcon className="size-3" /> : Icon ? <Icon className="size-3" /> : index + 1}
                          </span>
                          <span className="flex-1">{stage.name}</span>
                          {isCurrent ? <span className="text-xs">Current</span> : canMove && <span className="text-xs text-muted-foreground">Move here</span>}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </section>
            </div>

            <div className="border-t p-4">
              <Button asChild variant="outline" className="w-full">
                <Link href={`/leads/${card.id}`}>
                  Open full lead
                  <ArrowRightIcon />
                </Link>
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function EmptyBoard() {
  return (
    <section className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-16 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-signal-tint text-primary">
        <KanbanIcon className="size-5" />
      </span>
      <h2 className="mt-4 font-semibold">No leads on the board yet</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        When the AI judges an opportunity Hot or Warm it appears here in the first stage, ready to be worked.
      </p>
      <Button asChild variant="outline" className="mt-5">
        <Link href="/opportunities">See opportunities</Link>
      </Button>
    </section>
  );
}
