import { activeSchema } from "./client";

/**
 * Safety gate for scripts that wipe the ledger (db/migrate.ts, scripts/setup-clean-demo.ts,
 * scripts/generate_demo_pdfs.ts). Against the default schema they delete every invoice, decision
 * and journal entry — including the hash chain — so they must be asked for explicitly with
 * `--yes`. Against a named DB_SCHEMA (the test schema) no flag is needed.
 */
export function assertDestructiveAllowed(action: string, effect = "DELETE the live ledger tables (including the decisions hash chain)"): void {
  if (activeSchema()) return;
  if (process.argv.includes("--yes")) return;
  let target = "(database)";
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    target = `${u.hostname}${u.pathname}`; // never print credentials
  } catch {
    // Unparseable URL: the "(database)" placeholder is enough for the message; getSql() will fail loud right after.
  }
  throw new Error(
    `${action} would ${effect} on ${target}. ` +
    `Re-run with --yes if that is what you want, or set DB_SCHEMA=<name> to work in a separate schema.`,
  );
}
