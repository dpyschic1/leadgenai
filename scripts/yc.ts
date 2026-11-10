/**
 * Loads every Y Combinator company into `yc_companies` from the third-party yc-oss dataset.
 *
 *   npm run yc -- import
 *   npm run yc -- boards [count]     (finds the job boards of US YC companies, hiring ones first)
 *
 * `discover_yc` also refreshes it on its own when the last import is a week old; this is for a
 * first load or an immediate refresh. See `src/server/sources/yc.ts`.
 */
import { count, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { ycCompanies } from "@/db/schema";
import { detectYcBoards, importYcCompanies } from "@/server/sources/yc";

async function boards(limit: number) {
  let done = 0;
  while (done < limit) {
    const checked = await detectYcBoards({ limit: Math.min(5, limit - done), deadline: Date.now() + 120_000 });
    if (checked === 0) break;
    done += checked;
    const [found] = await db.select({ n: count() }).from(ycCompanies).where(isNotNull(ycCompanies.boardProvider));
    console.log(`[yc] ${done} checked; ${found.n} YC companies have a job board in the shared pool.`);
  }
}

async function main() {
  if (process.argv[2] === "boards") return boards(Number(process.argv[3] ?? 200));
  if (process.argv[2] !== "import") throw new Error("Usage: npm run yc -- import | boards [count]");
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
