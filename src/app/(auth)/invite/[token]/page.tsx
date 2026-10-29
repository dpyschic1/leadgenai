import { Suspense } from "react";
import type { Metadata } from "next";
import { AcceptInvitation, AcceptInvitationSkeleton } from "@/components/auth/accept-invitation-form";

export const metadata: Metadata = { title: "Join workspace · LeadGenAI" };

/** The token is read client-side (useParams), which suspends on this dynamic route under Cache Components. */
export default function InvitePage() {
  return (
    <Suspense fallback={<AcceptInvitationSkeleton />}>
      <AcceptInvitation />
    </Suspense>
  );
}
