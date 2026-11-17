/**
 * Invariant: the web UI speaks both languages completely (docs/invariants.md, #1570).
 *
 * A key missing in the German catalog silently falls back to English; a key
 * missing in both shows the raw key; a placeholder dropped in one language
 * leaves "{n}" on screen or loses the number. None of these fails anywhere
 * else, so the catalogs are compared here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const jsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "webui", "v22", "js");
const i18nDir = join(jsDir, "i18n");

type Catalog = Record<string, string>;

async function load(file: string): Promise<Catalog> {
  return ((await import(pathToFileURL(join(i18nDir, file)).href)) as { default: Catalog }).default;
}

/** de.js ↔ en.js and every <section>-de.js ↔ <section>-en.js. */
function pairs(): [string, string][] {
  const files = readdirSync(i18nDir).filter((f) => f.endsWith(".js"));
  const german = files.filter((f) => f === "de.js" || f.endsWith("-de.js"));
  assert.equal(german.length * 2, files.length, `every catalog has a partner: ${files.join(", ")}`);
  return german.map((de) => [de, de === "de.js" ? "en.js" : de.replace(/-de\.js$/, "-en.js")]);
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("INV-I18N-01: German and English catalogs carry the same keys and placeholders", async () => {
  const problems: string[] = [];
  for (const [deFile, enFile] of pairs()) {
    const [de, en] = [await load(deFile), await load(enFile)];
    for (const key of Object.keys(de)) if (!(key in en)) problems.push(`${deFile}: ${key} missing in ${enFile}`);
    for (const key of Object.keys(en)) if (!(key in de)) problems.push(`${enFile}: ${key} missing in ${deFile}`);
    for (const key of Object.keys(de)) {
      if (key in en && placeholders(de[key]!).join() !== placeholders(en[key]!).join())
        problems.push(`${key}: placeholders differ between ${deFile} and ${enFile}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("INV-I18N-01: every literal key the UI code asks for exists in the catalog", async () => {
  const known = new Set<string>();
  for (const [, enFile] of pairs()) for (const key of Object.keys(await load(enFile))) known.add(key);
  const missing: string[] = [];
  let asked = 0;
  for (const entry of readdirSync(jsDir, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".js") || entry.startsWith("i18n")) continue;
    for (const line of readFileSync(join(jsDir, entry), "utf8").split("\n")) {
      if (line.trimStart().startsWith("//")) continue;
      for (const m of line.matchAll(/\bt\(\s*["']([\w.-]+)["']/g)) {
        asked++;
        if (!known.has(m[1]!)) missing.push(`${entry}: ${m[1]}`);
      }
    }
  }
  assert.ok(asked >= 500, `found only ${asked} t() calls, the source scan is broken`);
  assert.deepEqual(missing, []);
});
