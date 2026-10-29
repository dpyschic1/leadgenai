import { Suspense } from "react";
import type { Metadata } from "next";
import { OpportunityDetailSkeleton, OpportunityDetailView } from "@/components/opportunities/opportunity-detail-view";

export const metadata: Metadata = { title: "Opportunity · LeadGenAI" };

/** The id is read client-side (useParams), which suspends on this dynamic route under Cache Components. */
export default function OpportunityPage() {
  return (
    <Suspense fallback={<OpportunityDetailSkeleton />}>
      <OpportunityDetailView />
    </Suspense>
  );
}
