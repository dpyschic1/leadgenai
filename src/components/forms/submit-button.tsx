"use client";

import type { ReactNode } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Full-width form submit button that shows progress while the request is in flight. */
export function SubmitButton({
  pending,
  pendingLabel,
  children,
}: {
  pending: boolean;
  pendingLabel: string;
  children: ReactNode;
}) {
  return (
    <Button type="submit" size="lg" className="h-10 w-full" disabled={pending} aria-busy={pending}>
      {pending && <Loader2Icon className="animate-spin" />}
      {pending ? pendingLabel : children}
    </Button>
  );
}
