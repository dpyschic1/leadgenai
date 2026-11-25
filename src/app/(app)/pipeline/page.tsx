import type { Metadata } from "next";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";

export const metadata: Metadata = { title: "Pipeline · LeadGenAI" };

export default function PipelinePage() {
  return <PipelineBoard />;
}
