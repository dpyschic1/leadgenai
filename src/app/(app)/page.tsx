import { DashboardGreeting } from "@/components/dashboard/dashboard-greeting";
import { DashboardInsights, PipelineBreakdown } from "@/components/dashboard/dashboard-insights";
import { TopOpportunities } from "@/components/dashboard/top-opportunities";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <DashboardGreeting />
      <DashboardInsights />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <TopOpportunities />
        <PipelineBreakdown />
      </div>
    </div>
  );
}
