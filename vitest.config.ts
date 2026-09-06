import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

// Plain `vitest run` (unlike the migrate/seed/eval scripts, which use tsx --env-file)
// doesn't populate process.env from .env on its own — verified empirically, not assumed.
// lib/agent's DB-touching integration tests read process.env.DATABASE_URL directly, so
// load it here. A minimal hand-rolled parser rather than a new dependency: KEY=VALUE per
// line, '#' comments, blank lines skipped — matches this project's actual .env, no more.
function loadDotEnv(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv(path.resolve(__dirname, ".env"));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    // Vitest runs different test FILES in parallel worker processes by default. Several
    // suites here write real rows into the shared `decisions` table (the global, sequential
    // hash chain) against one live Supabase DB — no isolated per-worker test database exists.
    // Running files in parallel lets one file's afterAll delete rows out from under another
    // file's still-in-flight verifyChain() check, breaking a chain-integrity assertion that
    // has nothing wrong with it — reproduced and confirmed multiple times, not a guess.
    // Sequential file execution is the real fix; a to-DO comment wouldn't have caught the
    // next person's new DB-writing test suite hitting the exact same race.
    fileParallelism: false,
  },
});
