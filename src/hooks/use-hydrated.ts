"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/** False on the server and during hydration, true from the first client render after it. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
