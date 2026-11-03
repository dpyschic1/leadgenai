"use client";

import { useId, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangleIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Combobox } from "@/components/forms/combobox";
import { ControlledField } from "@/components/forms/controlled-field";
import { EditorBody, EditorFooter, FormSection } from "@/components/forms/editor-sheet";
import { MultiCombobox } from "@/components/forms/multi-combobox";
import { SegmentedControl } from "@/components/forms/segmented-control";
import { TextField } from "@/components/forms/text-field";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useReferenceData } from "@/hooks/use-reference-data";
import { useAnalyzeSignal, useCompanySignals, useSaveSignal } from "@/hooks/use-signals";
import type { CompanyPerson, Signal, SignalAnalysis } from "@/lib/api/types";
import {
  EVIDENCE_LABEL_NAMES,
  EVIDENCE_LABELS,
  INTENT_LABELS,
  INTENT_LEVELS,
  URGENCY_LABELS,
  URGENCY_LEVELS,
} from "@/lib/domain/signals";
import { applyApiError } from "@/lib/forms/apply-api-error";
import { findDuplicateSignal, normalizeSourceUrl } from "@/lib/signals/duplicates";
import { cn } from "@/lib/utils";
import {
  MAX_SOURCE_TEXT,
  signalSchema,
  todayIso,
  type SignalInput,
  type SignalValues,
} from "@/lib/validation/signals";
import { DuplicateSignalNotice, SameSourceNote } from "./duplicate-notice";
import { EvidenceMark } from "./signal-badges";

const FIELDS = [
  "signalType",
  "intentLevel",
  "urgency",
  "serviceCategories",
  "summary",
  "personId",
  "occurredOn",
  "sourceUrl",
  "excerpt",
  "evidenceLabel",
] as const;

const NO_PERSON = "none";
const MIN_ANALYSIS_TEXT = 30;

const INTENT_OPTIONS = INTENT_LEVELS.map((value) => ({ value, label: INTENT_LABELS[value] }));
const URGENCY_OPTIONS = URGENCY_LEVELS.map((value) => ({ value, label: URGENCY_LABELS[value] }));

function defaults(signal?: Signal): SignalInput {
  if (!signal) {
    return {
      signalType: "",
      intentLevel: "unknown",
      urgency: "unknown",
      serviceCategories: [],
      summary: "",
      personId: null,
      occurredOn: todayIso(),
      sourceUrl: "",
      excerpt: "",
      evidenceLabel: "observed",
      source: "manual",
      confidence: null,
    };
  }
  return {
    signalType: signal.signalType,
    intentLevel: signal.intentLevel,
    urgency: signal.urgency,
    serviceCategories: signal.serviceCategories,
    summary: signal.summary,
    personId: signal.personId,
    occurredOn: signal.occurredOn,
    sourceUrl: signal.evidence?.sourceUrl ?? "",
    excerpt: signal.evidence?.excerpt ?? "",
    evidenceLabel: signal.evidenceLabel,
    // A signal stated by a data source becomes the person's own once they edit it.
    source: signal.source === "provider" ? "manual" : signal.source,
    confidence: signal.confidence,
  };
}

/** Records a signal for a company (or edits `signal`), optionally pre-filled by AI analysis. */
export function SignalForm({
  companyId,
  companyName,
  people,
  signal,
  onDone,
  onCancel,
}: {
  companyId: string;
  companyName: string;
  people: CompanyPerson[];
  signal?: Signal;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { data: ref } = useReferenceData();
  const form = useForm<SignalInput, unknown, SignalValues>({
    resolver: zodResolver(signalSchema),
    defaultValues: defaults(signal),
  });
  const save = useSaveSignal(companyId);
  const analyze = useAnalyzeSignal();
  const [sourceText, setSourceText] = useState("");
  const [analysis, setAnalysis] = useState<SignalAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Live duplicate check against the company's timeline (the API enforces the same rule).
  const { data: companySignals } = useCompanySignals(companyId);
  const [watchedType, watchedUrl, watchedExcerpt] = useWatch({
    control: form.control,
    name: ["signalType", "sourceUrl", "excerpt"],
  });
  const { duplicate, sameSource } = useMemo(() => {
    const existing = (companySignals ?? []).map((s) => ({
      ...s,
      sourceUrl: s.evidence?.sourceUrl ?? null,
      excerpt: s.evidence?.excerpt ?? null,
    }));
    const url = normalizeSourceUrl(watchedUrl);
    return {
      duplicate: findDuplicateSignal(existing, { signalType: watchedType, sourceUrl: watchedUrl ?? null, excerpt: watchedExcerpt ?? null }, signal?.id),
      sameSource: url ? existing.filter((s) => s.id !== signal?.id && normalizeSourceUrl(s.sourceUrl) === url) : [],
    };
  }, [companySignals, watchedType, watchedUrl, watchedExcerpt, signal?.id]);
  const sourceId = useId();

  const signalTypes = useMemo(() => {
    const groupName = new Map(ref?.signalCategories.map((c) => [c.slug, c.name]));
    const rank = new Map(ref?.signalCategories.map((c, index) => [c.slug, index]));
    return (ref?.signalTypes ?? [])
      .map((t) => ({ value: t.slug, label: t.name, group: groupName.get(t.categorySlug), rank: rank.get(t.categorySlug) ?? 99 }))
      .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  }, [ref]);
  const serviceCategories = useMemo(
    () => ref?.serviceCategories.map((c) => ({ value: c.slug, label: c.name })) ?? [],
    [ref],
  );

  const runAnalysis = () => {
    if (sourceText.trim().length < MIN_ANALYSIS_TEXT) {
      setAnalysisError("Paste at least a sentence or two first.");
      return;
    }
    setAnalysisError(null);
    analyze.mutate(
      { companyId, text: sourceText, sourceUrl: form.getValues("sourceUrl") || null },
      {
        onSuccess: (result) => {
          setAnalysis(result);
          const set = { shouldDirty: true, shouldValidate: true } as const;
          form.setValue("signalType", result.signalType ?? "", set);
          form.setValue("intentLevel", result.intentLevel, set);
          form.setValue("urgency", result.urgency, set);
          form.setValue("serviceCategories", result.serviceCategories, set);
          form.setValue("summary", result.summary, set);
          form.setValue("excerpt", result.excerpt ?? "", set);
          form.setValue("evidenceLabel", result.evidenceLabel, set);
          form.setValue("source", "ai", set);
          form.setValue("confidence", result.confidence, set);
          if (result.occurredOn) form.setValue("occurredOn", result.occurredOn, set);
        },
        onError: (error) => setAnalysisError(error.message),
      },
    );
  };

  const onSubmit = form.handleSubmit((values) =>
    save.mutate(
      { signalId: signal?.id, input: values },
      {
        onSuccess: () => {
          toast.success(signal ? "Signal saved." : `Signal recorded for ${companyName}.`);
          onDone();
        },
        onError: (error) => applyApiError(error, form.setError, FIELDS),
      },
    ),
  );

  return (
    <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
      <EditorBody>
        <FormSection title="Source" description="Where you saw it. Paste the text to let AI fill in the signal for you.">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={sourceId}>
                Source text
                <span className="font-normal text-muted-foreground">For AI analysis</span>
              </FieldLabel>
              <Textarea
                id={sourceId}
                rows={6}
                maxLength={MAX_SOURCE_TEXT}
                value={sourceText}
                onChange={(event) => setSourceText(event.target.value)}
                placeholder="Paste a job post, request for proposals, news item, LinkedIn post or email…"
                className="max-h-72"
              />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <FieldDescription>Only the quote you keep as evidence is saved, not the full text.</FieldDescription>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {sourceText.length.toLocaleString()} / {MAX_SOURCE_TEXT.toLocaleString()}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/20 bg-signal-tint/60 p-3">
                <Button type="button" onClick={runAnalysis} disabled={analyze.isPending} aria-busy={analyze.isPending}>
                  {analyze.isPending ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
                  {analyze.isPending ? "Analysing…" : analysis ? "Analyse again" : "Analyze with AI"}
                </Button>
                <p className="min-w-0 flex-1 text-sm text-[var(--signal-deep)]">
                  Finds the signal type, intent, urgency and matching services, and quotes the evidence.
                </p>
              </div>
              {analysisError && <FieldError>{analysisError}</FieldError>}
            </Field>

            <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <TextField
                control={form.control}
                name="sourceUrl"
                label="Source link"
                placeholder="https://…"
                autoComplete="off"
              />
              <ControlledField control={form.control} name="occurredOn" label="Date">
                {({ field, id, invalid }) => (
                  <Input
                    {...field}
                    id={id}
                    type="date"
                    max={todayIso()}
                    aria-invalid={invalid}
                    className="h-10"
                  />
                )}
              </ControlledField>
            </div>
            {!duplicate && sameSource.length > 0 && <SameSourceNote signals={sameSource} />}

            <ControlledField
              control={form.control}
              name="personId"
              label="Person"
              optional
              description={people.length === 0 ? `No one at ${companyName} has been added yet.` : "Who posted it or is behind it."}
            >
              {({ field, id, invalid, describedBy }) => (
                <Select
                  value={field.value ?? NO_PERSON}
                  onValueChange={(value) => field.onChange(value === NO_PERSON ? null : value)}
                  disabled={people.length === 0}
                >
                  <SelectTrigger id={id} aria-invalid={invalid} aria-describedby={describedBy} className="h-10! w-full sm:max-w-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PERSON}>Not linked to a person</SelectItem>
                    {people.map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        {person.name}
                        {person.title ? `, ${person.title}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </ControlledField>
          </FieldGroup>
        </FormSection>

        <FormSection title="Signal" description="What it means for you. Review AI suggestions before saving.">
          {analysis && <AnalysisNotice analysis={analysis} />}
          <div className={cn("transition-opacity", analyze.isPending && "pointer-events-none opacity-50")}>
            <FieldGroup>
              <ControlledField control={form.control} name="signalType" label="Signal type">
                {({ field, id, invalid }) => (
                  <Combobox
                    id={id}
                    options={signalTypes}
                    value={field.value || null}
                    onChange={(value) => field.onChange(value ?? "")}
                    invalid={invalid}
                    placeholder="What kind of signal is this?"
                    searchPlaceholder="Search signal types"
                    emptyText="No signal type matches."
                  />
                )}
              </ControlledField>

              <div className="grid gap-6 md:grid-cols-2">
                <ControlledField
                  control={form.control}
                  name="intentLevel"
                  label="Intent"
                  description="Explicit means they asked for a vendor."
                >
                  {({ field, id }) => (
                    <SegmentedControl id={id} label="Intent" options={INTENT_OPTIONS} value={field.value} onChange={field.onChange} />
                  )}
                </ControlledField>
                <ControlledField control={form.control} name="urgency" label="Urgency" description="How soon they need it.">
                  {({ field, id }) => (
                    <SegmentedControl id={id} label="Urgency" options={URGENCY_OPTIONS} value={field.value} onChange={field.onChange} />
                  )}
                </ControlledField>
              </div>

              <ControlledField
                control={form.control}
                name="serviceCategories"
                label="Services it points to"
                optional
                description="What they may need to buy. Used to match your services."
              >
                {({ field, id, invalid, describedBy }) => (
                  <MultiCombobox
                    id={id}
                    options={serviceCategories}
                    value={field.value}
                    onChange={field.onChange}
                    invalid={invalid}
                    describedBy={describedBy}
                    placeholder="Select services"
                    searchPlaceholder="Search services"
                    emptyText="No service matches."
                  />
                )}
              </ControlledField>

              <ControlledField control={form.control} name="summary" label="Summary" description="One or two sentences a colleague would understand.">
                {({ field, id, invalid, describedBy }) => (
                  <Textarea
                    {...field}
                    id={id}
                    rows={3}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                    placeholder="e.g. Opening a second office in January and wants an agency to redesign their website first."
                  />
                )}
              </ControlledField>

              <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_14rem]">
                <ControlledField
                  control={form.control}
                  name="excerpt"
                  label="Evidence quote"
                  optional
                  description="The exact words from the source that support this signal."
                >
                  {({ field, id, invalid, describedBy }) => (
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      id={id}
                      rows={3}
                      aria-invalid={invalid}
                      aria-describedby={describedBy}
                      className="border-l-4 border-l-primary/40"
                    />
                  )}
                </ControlledField>
                <ControlledField control={form.control} name="evidenceLabel" label="Evidence">
                  {({ field, id, invalid }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-invalid={invalid} className="h-10! w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EVIDENCE_LABELS.map((label) => (
                          <SelectItem key={label} value={label}>
                            <EvidenceMark label={label} />
                            {EVIDENCE_LABEL_NAMES[label]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </ControlledField>
              </div>
            </FieldGroup>
          </div>
          {duplicate && <DuplicateSignalNotice duplicate={duplicate} />}
        </FormSection>
        {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
      </EditorBody>
      <EditorFooter
        submitLabel={signal ? "Save changes" : "Record signal"}
        pending={save.isPending}
        disabled={duplicate !== null}
        onCancel={onCancel}
      />
    </form>
  );
}

function AnalysisNotice({ analysis }: { analysis: SignalAnalysis }) {
  if (!analysis.isSignal) {
    return (
      <div role="status" className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
        <p>
          This doesn&apos;t look like a buying signal for this company ({analysis.confidence}% confident). Check the
          source, or adjust the fields if you still want to record it.
        </p>
      </div>
    );
  }
  return (
    <div role="status" className="flex gap-3 rounded-lg border border-primary/20 bg-signal-tint/60 p-3 text-sm text-[var(--signal-deep)]">
      <SparklesIcon className="mt-0.5 size-4 shrink-0" />
      <p>
        Filled in by AI with {analysis.confidence}% confidence. Review each field before saving
        {analysis.excerpt ? "." : "; the AI's quote wasn't found word-for-word in the source, so it was left out."}
      </p>
    </div>
  );
}
