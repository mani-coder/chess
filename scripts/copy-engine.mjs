// Copies the Stockfish WASM engine from node_modules into public/ so the browser
// can load it. Keeps the ~7 MB binary out of git — node_modules is the single
// source of truth. Runs automatically via `postinstall` and `prebuild`.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "stockfish", "bin");
const dest = join(root, "public", "stockfish");

// The single-threaded lite build (loader + wasm). See PLAN.md for why this build.
const files = ["stockfish-18-lite-single.js", "stockfish-18-lite-single.wasm"];

mkdirSync(dest, { recursive: true });

let copied = 0;
for (const file of files) {
  const from = join(src, file);
  if (!existsSync(from)) {
    // Don't fail the install — just warn (e.g. if run before deps are present).
    console.warn(`[copy-engine] source not found, skipping: ${from}`);
    continue;
  }
  copyFileSync(from, join(dest, file));
  copied++;
}

console.log(`[copy-engine] copied ${copied}/${files.length} Stockfish file(s) → public/stockfish`);
