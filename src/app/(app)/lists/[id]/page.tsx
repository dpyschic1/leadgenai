import { Suspense } from "react";
import type { Metadata } from "next";
import { ListDetailSkeleton, ListDetailView } from "@/components/lists/list-detail-view";

export const metadata: Metadata = { title: "List · LeadGenAI" };

/** The id is read client-side (useParams), which suspends on this dynamic route under Cache Components. */
export default function ListPage() {
  return (
    <Suspense fallback={<ListDetailSkeleton />}>
      <ListDetailView />
    </Suspense>
  );
}
