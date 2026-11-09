import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";
import unitConfig from "./vitest.config.mjs";

/** Tests that need the database (DATABASE_URL from .env). Each cleans up what it creates. */
export default defineConfig({
  resolve: unitConfig.resolve,
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    env: {
      ...loadEnv({ quiet: true }).parsed,
      // Paid APIs stay off in tests, whatever .env holds: a test tick must never spend real credits.
      THEIRSTACK_API_KEY: "",
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
