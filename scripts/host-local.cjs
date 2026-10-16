/**
 * Runs the built VeriBook on this computer: screens and API in one production-mode process.
 *   npm run build            (once, or after a code change)
 *   node scripts/host-local.cjs   -> http://localhost:3000   (PORT=<n> to change it)
 *
 * Reads the keys from the main checkout's .env (VERIBOOK_ENV_FILE to use another file) and always
 * works on the demo schema (veribook_demo), like `npm run dev:demo`: the live tables are not touched.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.join(__dirname, "..");
const envFile = process.env.VERIBOOK_ENV_FILE || "D:/AO_Hackathon/ledger-loop/.env";
const port = process.env.PORT || "3000";

if (!fs.existsSync(path.join(root, ".next", "BUILD_ID")) || !fs.existsSync(path.join(root, "public", "index.html"))) {
  console.error("[host-local] No build found: run `npm run build` in this folder first.");
  process.exit(1);
}

const env = { ...process.env };
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  if (!(key in env)) env[key] = trimmed.slice(eq + 1).trim();
}
env.DB_SCHEMA = "veribook_demo";
env.NODE_ENV = "production";

console.log(`[host-local] VeriBook on http://localhost:${port} (database schema veribook_demo, live tables untouched). Ctrl-C stops it.`);
const next = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", port], {
  cwd: root,
  env,
  stdio: "inherit",
});
next.on("exit", (code) => process.exit(code ?? 0));
