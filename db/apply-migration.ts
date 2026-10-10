import fs from "node:fs";
import path from "node:path";
import { getSql, activeSchema } from "./client";
import { assertDestructiveAllowed } from "./guard";

/**
 * Applies ONE migration file from db/migrations/ to the database this process points at,
 * in a transaction, and records it in schema_migrations so it can never be applied twice.
 *
 *   npm run migrate:apply -- 001_human_review_node.sql --yes
 *
 * `--yes` is required when targeting the default (live) schema, same gate as db/migrate.ts.
 * schema.sql is always the full current schema (fresh databases and the test schema are built
 * from it); migrations exist only to bring an already-populated database up to date.
 */
async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) throw new Error("usage: migrate:apply <file-in-db/migrations> [--yes]");
  assertDestructiveAllowed(`applying migration ${file}`, "change the live database schema");

  const name = path.basename(file);
  const sqlText = fs.readFileSync(path.join(process.cwd(), "db", "migrations", name), "utf-8");
  const sql = getSql();

  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT now()::text)`;
  const done = await sql`SELECT 1 FROM schema_migrations WHERE name = ${name}`;
  if (done.length > 0) {
    console.log(`${name} was already applied — nothing to do.`);
    await sql.end();
    return;
  }

  await sql.begin(async (tx) => {
    await tx.unsafe(sqlText);
    await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
  });
  console.log(`Applied ${name} to schema ${activeSchema() ?? "(default)"}.`);
  await sql.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
