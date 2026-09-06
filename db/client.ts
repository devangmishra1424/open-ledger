import postgres from "postgres";

/**
 * Supabase Postgres connection. Use the POOLED connection string (port 6543, pgbouncer) in
 * DATABASE_URL when deployed to a serverless host (Vercel etc.) — serverless spins up many
 * short-lived instances and a direct (port 5432) connection per instance will exhaust
 * Postgres's connection limit fast. The pooled string is what Supabase's dashboard calls
 * "Transaction" mode under Project Settings > Database > Connection pooling.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — copy your Supabase connection string into .env");
}

let sqlClient: ReturnType<typeof postgres> | undefined;

export function getSql() {
  if (!sqlClient) {
    sqlClient = postgres(connectionString!, {
      // pgbouncer transaction-mode pooling doesn't support prepared statements.
      prepare: false,
    });
  }
  return sqlClient;
}
