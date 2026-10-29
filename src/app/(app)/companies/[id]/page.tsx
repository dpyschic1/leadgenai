import { Suspense } from "react";
import type { Metadata } from "next";
import { CompanyDetailSkeleton, CompanyDetailView } from "@/components/companies/company-detail-view";

export const metadata: Metadata = { title: "Company · LeadGenAI" };

/**
 * The id is read client-side (useParams), which suspends on this dynamic route under Cache
 * Components; the skeleton is the prerendered fallback.
 */
export default function CompanyPage() {
  return (
    <Suspense fallback={<CompanyDetailSkeleton />}>
      <CompanyDetailView />
    </Suspense>
  );
}
