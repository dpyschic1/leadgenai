import { DashboardGreeting } from "@/components/dashboard/dashboard-greeting";
import { EmptyOpportunities } from "@/components/dashboard/empty-opportunities";
import { ScoreExplainer } from "@/components/dashboard/score-explainer";
import { SetupSteps } from "@/components/dashboard/setup-steps";

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <DashboardGreeting />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <SetupSteps />
        <ScoreExplainer />
      </div>
      <EmptyOpportunities />
    </div>
  );
}
