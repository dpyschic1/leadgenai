"use client";

import { CopyIcon, InfoIcon } from "lucide-react";
import { useLookupNames } from "@/hooks/use-reference-data";
import type { Signal } from "@/lib/api/types";

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const formatDate = (isoDate: string) => dateFormat.format(new Date(`${isoDate}T12:00:00`));

/** Blocks saving: this exact signal (same type, same source) is already on the timeline. */
export function DuplicateSignalNotice({ duplicate }: { duplicate: Signal }) {
  const names = useLookupNames();
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
      <CopyIcon className="mt-0.5 size-4 shrink-0" />
      <p>
        Already recorded: this source is on the timeline as a <strong className="font-medium">{names.signalType(duplicate.signalType)}</strong>{" "}
        signal dated {formatDate(duplicate.occurredOn)}. Edit that signal instead, or pick a different signal type if
        the source reports something else too.
      </p>
    </div>
  );
}

/** Informational: the link was used before, for other signal types (which is allowed). */
export function SameSourceNote({ signals }: { signals: Signal[] }) {
  const names = useLookupNames();
  const types = [...new Set(signals.map((signal) => names.signalType(signal.signalType)))].join(", ");
  return (
    <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>
        You&apos;ve already recorded a signal from this link ({types}). Record it again only if it reports a different
        kind of signal.
      </span>
    </p>
  );
}
