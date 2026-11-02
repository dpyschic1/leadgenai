"use client";

import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryProvider } from "./query-provider";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      {/* A short delay so tooltips don't flash while the pointer just passes over. */}
      <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      <Toaster richColors position="top-right" />
    </QueryProvider>
  );
}
