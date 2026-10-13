// Starts VeriBook's document reader (docreader/, Docling + OCR) on 127.0.0.1:8090 with its own virtualenv.
//   npm run reader          (set DOCREADER_PORT to change the port; the API finds it via DOCREADER_URL)
// First time: python -m venv docreader/.venv && docreader/.venv/<Scripts|bin>/pip install -r docreader/requirements.txt
// Loading the layout, table and OCR models takes ~10-20 s; the service says "models loaded" when it is ready.
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const python = process.platform === "win32"
  ? path.join(root, "docreader", ".venv", "Scripts", "python.exe")
  : path.join(root, "docreader", ".venv", "bin", "python");
if (!existsSync(python)) {
  console.error(`The document reader's virtualenv is missing (${python}).\nCreate it: python -m venv docreader/.venv, then install docreader/requirements.txt into it.`);
  process.exit(1);
}
const port = process.env.DOCREADER_PORT || "8090";
const child = spawn(python, ["-m", "uvicorn", "app:app", "--app-dir", path.join(root, "docreader"), "--host", "127.0.0.1", "--port", port],
  { cwd: root, stdio: "inherit", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
