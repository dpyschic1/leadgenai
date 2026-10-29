import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { ScoringSettings } from "@/components/settings/scoring-settings";
import { WorkspaceSettings } from "@/components/settings/workspace-settings";

export const metadata: Metadata = { title: "Settings · LeadGenAI" };

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Settings" description="Workspace details and how opportunities are scored." />
      <div className="space-y-8">
        <WorkspaceSettings />
        <ScoringSettings />
      </div>
    </div>
  );
}
