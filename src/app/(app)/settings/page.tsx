import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { DataSourcesSettings } from "@/components/settings/data-sources-settings";
import { ScoringSettings } from "@/components/settings/scoring-settings";
import { TeamSettings } from "@/components/settings/team-settings";
import { WorkspaceSettings } from "@/components/settings/workspace-settings";

export const metadata: Metadata = { title: "Settings · LeadGenAI" };

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Settings" description="Workspace details, your team, how opportunities are scored and where data comes from." />
      <div className="space-y-8">
        <WorkspaceSettings />
        <TeamSettings />
        <ScoringSettings />
        <DataSourcesSettings />
      </div>
    </div>
  );
}
