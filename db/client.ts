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
      // Bounded pool + explicit timeouts — found the hard way: a client abandoning a query
      // (e.g. a curl -m timeout) left the server-side query running indefinitely with nothing
      // ever reading its result, silently holding a pooled connection forever. With no `max`,
      // enough of those pile up and every subsequent request queues behind them forever too.
      // Raised from 10: found live that several pages polling every 5s, each firing multiple
      // real queries per poll (the dashboard alone runs 8), could genuinely exceed 10
      // concurrent connections with more than one tab open — visible as dashboard calls
      // taking 15-120+ seconds, queued behind each other rather than actually hung.
      max: 20,
      idle_timeout: 10, // seconds a connection can sit idle before this client releases it
      connect_timeout: 10, // seconds to wait for a new connection before failing loud
    });
  }
  return sqlClient;
}
