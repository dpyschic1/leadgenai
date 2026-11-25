import { Suspense } from "react";
import type { Metadata } from "next";
import { LeadDetailSkeleton, LeadDetailView } from "@/components/leads/lead-detail-view";

export const metadata: Metadata = { title: "Lead · LeadGenAI" };

/** The id is read client-side (useParams), which suspends on this dynamic route under Cache Components. */
export default function LeadPage() {
  return (
    <Suspense fallback={<LeadDetailSkeleton />}>
      <LeadDetailView />
    </Suspense>
  );
}
