"use client";

import { useState } from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInterpretSearch } from "@/hooks/use-opportunities";
import type { InterpretedSearch } from "@/lib/api/types";
import { interpretSearchSchema } from "@/lib/validation/opportunities";

const EXAMPLES = ["Funded startups that need an app", "Hot website leads in the UK, last 30 days", "Companies hiring developers urgently"];

/**
 * Plain-language search (PRD §22). The AI only chooses filters; they're shown as chips the user
 * can check and remove, and `unmatched` says honestly what it couldn't filter by.
 */
export function AiSearch({ onApply }: { onApply: (result: InterpretedSearch) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const interpret = useInterpretSearch();

  const run = (query: string) => {
    const parsed = interpretSearchSchema.safeParse({ query });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Describe what you're looking for");
      return;
    }
    setError(null);
    interpret.mutate(parsed.data, {
      onSuccess: (result) => {
        setUnmatched(result.unmatched);
        onApply(result);
      },
      onError: (e) => setError(e.message),
    });
  };

  return (
    <section aria-label="AI search" className="rounded-xl border bg-card p-4">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          run(text);
        }}
      >
        <div className="relative flex-1">
          <SparklesIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-primary" />
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Describe who you're looking for, e.g. funded UK startups that need an app"
            aria-label="Describe the opportunities you're looking for"
            aria-invalid={error !== null}
            maxLength={300}
            className="h-10 pl-9"
          />
        </div>
        <Button type="submit" className="h-10" disabled={interpret.isPending} aria-busy={interpret.isPending}>
          {interpret.isPending ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
          {interpret.isPending ? "Reading…" : "Search with AI"}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : unmatched.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Couldn&apos;t filter by: {unmatched.join(", ")}. The filters below cover the rest.
        </p>
      ) : (
        <p className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
          Try:
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              disabled={interpret.isPending}
              onClick={() => {
                setText(example);
                run(example);
              }}
              className="rounded-full border px-2 py-0.5 hover:border-foreground/25 hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </p>
      )}
    </section>
  );
}
