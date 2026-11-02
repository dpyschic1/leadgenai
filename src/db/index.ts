import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pg?: ReturnType<typeof postgres> };

// Reuse one connection pool across hot reloads in development. Prepared statements are off because
// hosted poolers (e.g. Neon's PgBouncer, transaction mode) don't keep them between transactions.
const client = globalForDb.pg ?? postgres(process.env.DATABASE_URL!, { prepare: false });
if (process.env.NODE_ENV !== "production") globalForDb.pg = client;

export const db = drizzle(client, { schema, casing: "snake_case" });
export { schema };

/** A transaction handle, for helpers that must run inside a caller's `db.transaction`. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
