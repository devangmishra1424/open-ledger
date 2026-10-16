/**
 * Copies the built frontend (frontend/dist) into ./public so the one Next.js deployment serves both the
 * API and the screens. Run by `npm run build:web`. Removes what it copied last time first, so an old
 * hashed bundle never lingers.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "frontend", "dist");
const target = path.join(root, "public");

if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error(`copy-web: ${dist} has no index.html: build the frontend first (npm --prefix frontend run build).`);
  process.exit(1);
}
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(dist, target, { recursive: true });
console.log(`copy-web: ${path.relative(root, dist)} -> ${path.relative(root, target)} (${fs.readdirSync(target).join(", ")})`);
