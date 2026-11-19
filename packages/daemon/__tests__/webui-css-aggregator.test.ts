// The web UI's styles arrive through one pure aggregator (#1520 D4): index.html links css/main.css
// alone, main.css holds nothing but @import lines, and every module file is imported there exactly
// once and imports nothing itself. The import order in main.css is the cascade order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const app = new URL("../webui/app/", import.meta.url);
const read = (path: string) => readFile(new URL(path, app), "utf8");
const IMPORT = /^@import "\.\/([\w-]+\.css)";$/;

test("index.html links the styles once, through css/main.css", async () => {
  const html = await read("index.html");
  assert.deepEqual(
    [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]),
    ["css/main.css"]
  );
});

test("css/main.css only imports, every module file once, and no module file imports", async () => {
  const lines = (await read("css/main.css"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const imported = lines.map((l) => {
    const m = IMPORT.exec(l);
    assert.ok(m, `main.css holds only @import lines, not: ${l}`);
    return m[1];
  });
  const modules = (await readdir(new URL("css/", app))).filter((f) => f.endsWith(".css") && f !== "main.css");
  assert.deepEqual([...imported].sort(), modules.sort(), "each module file is imported exactly once");
  for (const file of modules)
    assert.doesNotMatch(await read(`css/${file}`), /@import/, `${file} imports nothing; main.css does`);
});
