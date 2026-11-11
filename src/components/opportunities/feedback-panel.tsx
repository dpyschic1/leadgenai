"use client";

import { useState } from "react";
import {
  Building2Icon,
  BriefcaseBusinessIcon,
  FlagIcon,
  Loader2Icon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  UserRoundXIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useGiveFeedback, useRemoveFeedback, useUpdateOpportunity } from "@/hooks/use-opportunities";
import type { OpportunityDetail, OpportunityFeedback } from "@/lib/api/types";
import { FEEDBACK_DESCRIPTIONS, FEEDBACK_LABELS, isPositiveVerdict, type FeedbackVerdict } from "@/lib/domain/feedback";
import { cn } from "@/lib/utils";
import { opportunityName } from "@/lib/opportunity-display";

const ICONS: Record<FeedbackVerdict, LucideIcon> = {
  good_fit: ThumbsUpIcon,
  not_relevant: ThumbsDownIcon,
  wrong_service: BriefcaseBusinessIcon,
  wrong_person: UserRoundXIcon,
  wrong_company: Building2Icon,
};

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/**
 * "Is this a good opportunity?" (launch checklist: users flag incorrect matches and quality).
 * A verdict takes two steps, choose then save, so a reason can be added. Wrong-contact and
 * wrong-service flags re-match the opportunity straight away.
 */
export function FeedbackPanel({ opportunity, canEdit }: { opportunity: OpportunityDetail; canEdit: boolean }) {
  const [choosing, setChoosing] = useState<FeedbackVerdict | null>(null);
  const [showFlags, setShowFlags] = useState(false);
  // Lives here, not in the form: the toast's "Archive it" runs after the form has closed.
  const update = useUpdateOpportunity(opportunity.id);
  const dismiss = () =>
    update.mutate(
      { archived: true },
      { onSuccess: () => toast.success("Archived."), onError: (error) => toast.error(error.message) },
    );
  const myOpinion = opportunity.feedback.find((f) => f.isMine && (f.verdict === "good_fit" || f.verdict === "not_relevant"));

  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-semibold">Is this a good opportunity?</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">Your verdict is shared with the team. Flags fix the match.</p>

      {canEdit && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {(["good_fit", "not_relevant"] as const).map((verdict) => (
              <VerdictButton
                key={verdict}
                verdict={verdict}
                active={choosing === verdict || (choosing === null && myOpinion?.verdict === verdict)}
                onClick={() => setChoosing(choosing === verdict ? null : verdict)}
              />
            ))}
          </div>

          {showFlags ? (
            <div className="grid gap-2" role="group" aria-label="Something's wrong">
              <VerdictButton
                verdict="wrong_service"
                detail={opportunity.service?.name}
                disabled={!opportunity.service}
                active={choosing === "wrong_service"}
                onClick={() => setChoosing("wrong_service")}
              />
              <VerdictButton
                verdict="wrong_person"
                detail={opportunity.contact?.name}
                disabled={!opportunity.contact}
                active={choosing === "wrong_person"}
                onClick={() => setChoosing("wrong_person")}
              />
              {/* An engine opportunity with no identified company has no company match to dispute. */}
              {opportunity.company && (
                <VerdictButton
                  verdict="wrong_company"
                  detail={opportunityName(opportunity)}
                  active={choosing === "wrong_company"}
                  onClick={() => setChoosing("wrong_company")}
                />
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowFlags(true)}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <FlagIcon className="size-3.5" />
              Something&apos;s wrong with the match…
            </button>
          )}

          {choosing && (
            <VerdictForm
              key={choosing}
              opportunity={opportunity}
              verdict={choosing}
              initialReason={choosing === myOpinion?.verdict ? (myOpinion.reason ?? "") : ""}
              onDismiss={dismiss}
              onDone={() => {
                setChoosing(null);
                setShowFlags(false);
              }}
            />
          )}
        </div>
      )}

      {opportunity.feedback.length > 0 && (
        <ul className="mt-5 space-y-3 border-t pt-4" aria-label="Team feedback">
          {opportunity.feedback.map((feedback) => (
            <FeedbackEntry key={feedback.id} opportunityId={opportunity.id} feedback={feedback} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </section>
  );
}

function VerdictButton({
  verdict,
  detail,
  active,
  disabled,
  onClick,
}: {
  verdict: FeedbackVerdict;
  detail?: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const Icon = ICONS[verdict];
  const positive = isPositiveVerdict(verdict);
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        active
          ? positive
            ? "border-primary bg-signal-tint font-medium text-[var(--signal-deep)]"
            : "border-destructive/40 bg-destructive/5 font-medium text-destructive"
          : "hover:bg-accent",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0">
        <span className="block">{FEEDBACK_LABELS[verdict]}</span>
        {detail && <span className="block truncate text-xs font-normal text-muted-foreground">{detail}</span>}
      </span>
    </button>
  );
}

function VerdictForm({
  opportunity,
  verdict,
  initialReason,
  onDismiss,
  onDone,
}: {
  opportunity: OpportunityDetail;
  verdict: FeedbackVerdict;
  initialReason: string;
  onDismiss: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState(initialReason);
  const give = useGiveFeedback(opportunity.id);

  const save = () =>
    give.mutate(
      { verdict, reason },
      {
        onSuccess: (updated) => {
          toast.success(savedMessage(verdict, opportunity, updated), {
            // A "not relevant" verdict usually means the team won't pursue it.
            action:
              verdict === "not_relevant" && !updated.archived
                ? { label: "Archive it", onClick: onDismiss }
                : undefined,
          });
          onDone();
        },
        onError: (error) => toast.error(error.message),
      },
    );

  return (
    <div className="space-y-2 rounded-lg bg-secondary/60 p-3">
      <p className="text-xs text-muted-foreground">{FEEDBACK_DESCRIPTIONS[verdict]}</p>
      <Textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={2}
        maxLength={500}
        placeholder="Why? (optional) e.g. they already have an agency"
        aria-label="Reason"
        className="bg-background"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={give.isPending} aria-busy={give.isPending}>
          {give.isPending && <Loader2Icon className="animate-spin" />}
          Save feedback
        </Button>
      </div>
    </div>
  );
}

/** Tells the user what their flag changed, using the re-matched opportunity. */
function savedMessage(verdict: FeedbackVerdict, before: OpportunityDetail, after: OpportunityDetail): string {
  if (verdict === "wrong_person") {
    return after.contact
      ? `Flagged ${before.contact?.name}. Now suggesting ${after.contact.name}.`
      : `Flagged ${before.contact?.name}. No one else to suggest yet; add people on the company page.`;
  }
  if (verdict === "wrong_service") {
    return after.service
      ? `Flagged ${before.service?.name}. Now matched to ${after.service.name}.`
      : `Flagged ${before.service?.name}. None of your other services match.`;
  }
  if (verdict === "wrong_company") return "Flagged. Move or delete the signal on the company page if it belongs elsewhere.";
  return "Thanks, feedback saved.";
}

function FeedbackEntry({
  opportunityId,
  feedback,
  canEdit,
}: {
  opportunityId: string;
  feedback: OpportunityFeedback;
  canEdit: boolean;
}) {
  const remove = useRemoveFeedback(opportunityId);
  const Icon = ICONS[feedback.verdict];
  const about =
    feedback.verdict === "wrong_person" ? feedback.personName : feedback.verdict === "wrong_service" ? feedback.serviceName : null;

  return (
    <li className="flex gap-2.5 text-sm">
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", isPositiveVerdict(feedback.verdict) ? "text-primary" : "text-destructive")}
      />
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium">{FEEDBACK_LABELS[feedback.verdict]}</span>
          {about && <span className="text-muted-foreground">: {about}</span>}
        </p>
        {feedback.reason && <p className="mt-0.5 text-muted-foreground">&ldquo;{feedback.reason}&rdquo;</p>}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {feedback.isMine ? "You" : (feedback.author?.name ?? "Former teammate")}
          <span aria-hidden> · </span>
          {dateFormat.format(new Date(feedback.updatedAt))}
          {feedback.scoreAtFeedback !== null && ` · score was ${feedback.scoreAtFeedback}`}
        </p>
      </div>
      {feedback.isMine && canEdit && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={`Remove your feedback: ${FEEDBACK_LABELS[feedback.verdict]}`}
          title="Remove"
          disabled={remove.isPending}
          // A promise rather than mutate callbacks: this entry unmounts as soon as it's removed.
          onClick={() =>
            remove.mutateAsync(feedback.id).then(
              () => toast.success("Feedback removed."),
              (error: Error) => toast.error(error.message),
            )
          }
        >
          <XIcon />
        </Button>
      )}
    </li>
  );
}
