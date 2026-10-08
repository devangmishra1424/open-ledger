/**
 * Runs the API (Next.js) against the demo schema instead of the live tables:
 *   npm run dev:demo            -> http://localhost:3001  (the Vite dev server proxies /api here)
 *
 * Build the demo data first, once:
 *   DB_SCHEMA=veribook_demo npm run migrate && DB_SCHEMA=veribook_demo npm run seed
 * Use DEMO_SCHEMA=<name> to point at a different schema.
 */
const { spawn } = require("node:child_process");

const schema = process.env.DEMO_SCHEMA || "veribook_demo";
console.log(`[dev:demo] API on :3001, database schema "${schema}" (live tables are not touched)`);
const next = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "dev", "-p", "3001"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DB_SCHEMA: schema },
});
next.on("exit", (code) => process.exit(code ?? 0));
