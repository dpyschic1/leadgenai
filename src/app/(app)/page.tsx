import { DashboardGreeting } from "@/components/dashboard/dashboard-greeting";
import { PipelineOverview } from "@/components/dashboard/pipeline-overview";
import { ScoreExplainer } from "@/components/dashboard/score-explainer";
import { SetupSteps } from "@/components/dashboard/setup-steps";
import { TopOpportunities } from "@/components/dashboard/top-opportunities";

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <DashboardGreeting />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <SetupSteps />
        <ScoreExplainer />
      </div>
      <TopOpportunities />
      <PipelineOverview />
    </div>
  );
}
