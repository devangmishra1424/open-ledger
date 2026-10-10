import { getSql, activeSchema } from "./client";
import { migrateSchema } from "./migrate-lib";
import { assertDestructiveAllowed } from "./guard";

/**
 * CLI: `npm run migrate -- --yes` rebuilds the default (live) schema; with DB_SCHEMA=<name> it
 * rebuilds only that schema. Fresh start every run — this is a demo DB, not a migration chain.
 */
async function main() {
  assertDestructiveAllowed("db/migrate.ts");
  const sql = getSql();
  const result = await migrateSchema(sql, { log: console.log });
  console.log(`Migrated ${connectionInfo(process.env.DATABASE_URL ?? "")} schema=${activeSchema() ?? "(default)"} — ${result.accounts} accounts, ${result.reasonCodes} reason codes, ${result.periods} periods.`);
  await sql.end();
}

function connectionInfo(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`; // never print credentials
  } catch {
    return "(database)";
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
