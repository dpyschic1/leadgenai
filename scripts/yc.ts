/**
 * Loads every Y Combinator company into `yc_companies` from the third-party yc-oss dataset.
 *
 *   npm run yc -- import
 *
 * `discover_yc` also refreshes it on its own when the last import is a week old; this is for a
 * first load or an immediate refresh. See `src/server/sources/yc.ts`.
 */
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { ycCompanies } from "@/db/schema";
import { importYcCompanies } from "@/server/sources/yc";

async function main() {
  if (process.argv[2] !== "import") throw new Error("Usage: npm run yc -- import");
  const saved = await importYcCompanies();
  const [us] = await db.select({ n: count() }).from(ycCompanies).where(eq(ycCompanies.country, "US"));
  console.log(`[yc] ${saved} companies imported (${us.n} in the US).`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
