"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

const formatter = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });

/**
 * Today's date in the viewer's locale and timezone, e.g. "Thursday, 29 October".
 * Null during server rendering, so the server and the browser never disagree.
 */
export function useToday(): string | null {
  return useSyncExternalStore(noopSubscribe, () => formatter.format(new Date()), () => null);
}
