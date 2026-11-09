/**
 * Local development only: keeps the background queue moving (website reads, people, job boards)
 * without clicking "Run now", the way the scheduler calls the tick endpoint on the server. It calls
 * that same endpoint once a minute, so the work runs exactly as it does in production.
 */

const INTERVAL_MS = 60_000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "development") return;
  // Registered once per dev server, even when this file reloads.
  const state = globalThis as typeof globalThis & { __localTicker?: boolean };
  if (state.__localTicker) return;
  state.__localTicker = true;

  // The endpoint needs a secret; without one set, a throwaway one for this dev server is enough.
  // Global Web Crypto, not `node:crypto`: Next also compiles this file for the Edge runtime.
  process.env.CRON_SECRET ||= crypto.randomUUID();
  const url = `http://localhost:${process.env.PORT ?? "3000"}/api/v1/internal/tick`;

  let running = false;
  setInterval(async () => {
    if (running) return; // a tick takes up to ~45 s; never overlap two
    running = true;
    try {
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
      if (!response.ok) console.warn(`[local ticker] tick returned ${response.status}`);
    } catch (error) {
      console.warn("[local ticker] tick failed:", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
  console.log("[local ticker] processing background jobs every minute (dev only)");
}
