import { getSql, activeSchema } from "../db/client";
import { migrateSchema } from "../db/migrate-lib";

/**
 * Vitest globalSetup: rebuilds the isolated test schema (tables + reference data) once before
 * the run. Refuses to continue unless the connection really is pinned to a non-`public`
 * schema — migrateSchema() on the default schema would drop the live ledger tables.
 */
export default async function setup() {
  if (!process.env.DATABASE_URL) {
    // Not an error here: the pure-logic suites need no database. Every DB-backed suite calls
    // getSql() and fails loud on its own with "DATABASE_URL is not set".
    console.warn("[global-setup] DATABASE_URL not set — skipping test-schema rebuild; DB-backed suites will fail.");
    return;
  }
  const schema = activeSchema();
  if (!schema || schema === "public") {
    throw new Error(`global-setup refused to run: DB_SCHEMA must be a non-public schema (got '${schema ?? "(unset)"}').`);
  }
  const sql = getSql();
  const [{ search_path }] = await sql`SHOW search_path`;
  if (search_path.replace(/"/g, "").trim() !== schema) {
    throw new Error(`global-setup refused to run: search_path is '${search_path}', expected exactly '${schema}' (the pooler did not apply it).`);
  }
  await migrateSchema(sql);
  return async () => {
    await sql.end({ timeout: 5 });
  };
}
