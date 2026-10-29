"use client";

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { ScoreWeightsEditor } from "@/components/scoring/score-weights-editor";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermission } from "@/hooks/use-permission";
import { useSaveScoringProfile, useScoringProfile } from "@/hooks/use-scoring-profile";
import { CONFIG_ROLES } from "@/lib/permissions";
import {
  DEFAULT_SCORE_WEIGHTS,
  SCORE_FACTORS,
  totalWeight,
  type ScoreWeights,
} from "@/lib/validation/scoring";
import { SettingsSection } from "./settings-section";

const TITLE = "Opportunity scoring";
const DESCRIPTION =
  "How much each factor counts towards the opportunity score. The score ranks priority; it never predicts a purchase.";

const sameWeights = (a: ScoreWeights, b: ScoreWeights) => SCORE_FACTORS.every(({ key }) => a[key] === b[key]);

export function ScoringSettings() {
  const { data } = useScoringProfile();

  if (!data) {
    return (
      <SettingsSection title={TITLE} description={DESCRIPTION}>
        <div className="space-y-4" aria-label="Loading scoring">
          <Skeleton className="h-3 w-full rounded-full" />
          {SCORE_FACTORS.map(({ key }) => (
            <Skeleton key={key} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </SettingsSection>
    );
  }
  return <ScoringForm saved={data.weights} />;
}

function ScoringForm({ saved }: { saved: ScoreWeights }) {
  const canEdit = usePermission(CONFIG_ROLES);
  const [weights, setWeights] = useState(saved);
  const save = useSaveScoringProfile();
  const changed = !sameWeights(weights, saved);

  const onSave = () =>
    save.mutate(
      { weights },
      {
        onSuccess: () => toast.success("Scoring weights saved."),
        onError: (error) => toast.error(error.message),
      },
    );

  return (
    <SettingsSection
      title={TITLE}
      description={canEdit ? DESCRIPTION : `${DESCRIPTION} Only owners, admins and managers can change it.`}
      footer={
        canEdit && (
          <>
            <Button
              variant="ghost"
              onClick={() => setWeights(DEFAULT_SCORE_WEIGHTS)}
              disabled={sameWeights(weights, DEFAULT_SCORE_WEIGHTS)}
            >
              Reset to defaults
            </Button>
            <Button
              onClick={onSave}
              disabled={!changed || totalWeight(weights) !== 100 || save.isPending}
              aria-busy={save.isPending}
            >
              {save.isPending && <Loader2Icon className="animate-spin" />}
              Save weights
            </Button>
          </>
        )
      }
    >
      <ScoreWeightsEditor value={weights} onChange={setWeights} disabled={!canEdit} />
    </SettingsSection>
  );
}
