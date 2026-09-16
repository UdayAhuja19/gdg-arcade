// Builds the GitHub Pages demo: the same pages and games as the fair laptop,
// with scores kept in each visitor's browser instead of MySQL.
//
//   node scripts/build-static.js [outDir]   (default: dist)
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "public");
const out = path.resolve(root, process.argv[2] ?? "dist");

// The admin page needs the server, so it isn't part of the demo.
const SERVER_ONLY = new Set(["admin.html", path.join("js", "admin.js")]);

await fs.rm(out, { recursive: true, force: true });
await fs.cp(src, out, {
  recursive: true,
  filter: (file) => !SERVER_ONLY.has(path.relative(src, file)),
});
await fs.writeFile(
  path.join(out, "js", "config.js"),
  '// Built by scripts/build-static.js for the GitHub Pages demo.\nexport const MODE = "static";\n'
);
// Tells GitHub Pages to serve the files as-is.
await fs.writeFile(path.join(out, ".nojekyll"), "");

console.log(`Static demo built in ${path.relative(root, out) || "."}`);
