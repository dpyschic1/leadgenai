import type { Metadata } from "next";
import { OpportunitiesView } from "@/components/opportunities/opportunities-view";

export const metadata: Metadata = { title: "Opportunities · LeadGenAI" };

export default function OpportunitiesPage() {
  return <OpportunitiesView />;
}
