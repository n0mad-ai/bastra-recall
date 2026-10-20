#!/usr/bin/env node
/**
 * stub-manifest.mjs — write stub/manifest.json from the per-target checksum
 * files the release workflow produced (#350).
 *
 * The compiled hook client ships as one GitHub Release asset per platform; the
 * daemon package ships only this manifest — the sha256 of every asset, written
 * in the same workflow run that built them, BEFORE `npm publish`. The installer
 * verifies a download against the manifest it was installed with, never
 * against something fetched next to the binary.
 *
 *   node scripts/stub-manifest.mjs <dir> [--out <path>] [--version <v>]
 *
 * <dir> holds `bastra-hook-<target>.sha256` files in `shasum` format
 * (`<hex>  <file>`). The asset name comes from the checksum FILE name, not
 * from its content. --version defaults to this package's version; --out to
 * stub/manifest.json.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHECKSUM_FILE = /^(bastra-hook-([a-z0-9_]+-[a-z0-9_-]+)(?:\.exe)?)\.sha256$/;

/** One checksum file → manifest entry, or null when the name or digest is off. */
export function parseChecksumFile(name, text) {
  const m = CHECKSUM_FILE.exec(name);
  if (!m) return null;
  const token = String(text).trim().split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  return { target: m[2], file: m[1], sha256: token.toLowerCase() };
}

export function buildManifest(version, entries) {
  const assets = {};
  for (const e of entries) assets[e.target] = { file: e.file, sha256: e.sha256 };
  return { version, assets };
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!dir) {
    console.error("usage: node scripts/stub-manifest.mjs <dir> [--out <path>] [--version <v>]");
    process.exit(2);
  }
  const version =
    opt("--version") ?? JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
  const out = resolve(opt("--out") ?? join(packageRoot, "stub", "manifest.json"));

  const entries = [];
  const rejected = [];
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith(".sha256")) continue;
    const e = parseChecksumFile(name, await readFile(join(dir, name), "utf8"));
    if (e) entries.push(e);
    else rejected.push(name);
  }
  if (rejected.length) {
    console.error(`error: unusable checksum file(s): ${rejected.join(", ")}`);
    process.exit(1);
  }
  if (!entries.length) {
    console.error(`error: no bastra-hook-<target>.sha256 files in ${dir}`);
    process.exit(1);
  }
  const manifest = buildManifest(version, entries);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`stub manifest v${version}: ${entries.map((e) => e.target).join(", ")} → ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
