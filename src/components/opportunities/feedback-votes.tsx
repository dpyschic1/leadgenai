"use client";

import { FlagIcon, ThumbsUpIcon, type LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FeedbackVote } from "@/lib/api/types";
import { FEEDBACK_LABELS, isPositiveVerdict } from "@/lib/domain/feedback";
import { cn } from "@/lib/utils";

/**
 * The team's verdicts on a feed card, in words ("1 good fit", "2 flagged"), with who said what on
 * hover or keyboard focus. Sits above the card's stretched link so the tooltip can open.
 */
export function FeedbackVotes({ votes }: { votes: FeedbackVote[] }) {
  const goodFit = votes.filter((vote) => isPositiveVerdict(vote.verdict));
  const flagged = votes.filter((vote) => !isPositiveVerdict(vote.verdict));
  if (votes.length === 0) return null;

  return (
    <span className="relative z-10 inline-flex flex-wrap items-center gap-1.5">
      {goodFit.length > 0 && (
        <VoteBadge
          icon={ThumbsUpIcon}
          label={`${goodFit.length} good ${goodFit.length === 1 ? "fit" : "fits"}`}
          heading="Marked a good fit by"
          lines={goodFit.map((vote) => vote.name)}
          className="border-primary/20 bg-signal-tint text-[var(--signal-deep)]"
        />
      )}
      {flagged.length > 0 && (
        <VoteBadge
          icon={FlagIcon}
          label={`${flagged.length} flagged`}
          heading="Flagged by"
          lines={flagged.map((vote) => `${vote.name}: ${FEEDBACK_LABELS[vote.verdict]}`)}
          className="border-destructive/20 bg-destructive/5 text-destructive"
        />
      )}
    </span>
  );
}

function VoteBadge({
  icon: Icon,
  label,
  heading,
  lines,
  className,
}: {
  icon: LucideIcon;
  label: string;
  heading: string;
  lines: string[];
  className: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable, so keyboard users can open the tooltip too. */}
        <span
          tabIndex={0}
          aria-label={`${label}. ${heading} ${lines.join(", ")}`}
          className={cn(
            "inline-flex cursor-default items-center gap-1 rounded-full border px-2 py-0.5 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            className,
          )}
        >
          <Icon className="size-3" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex-col items-start gap-0.5">
        <span className="text-muted-foreground">{heading}</span>
        {lines.map((line, index) => (
          <span key={index} className="font-medium">
            {line}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
