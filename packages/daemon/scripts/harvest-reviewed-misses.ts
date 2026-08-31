#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { buildHotFileTemplate, harvestReviewedMisses } from "../src/learned-recall/reviewed-miss-harvest.js";

function usage(): never {
  console.error("usage: tsx scripts/harvest-reviewed-misses.ts [--out queue.json] [--private-evidence] [--relative-to root --zone name] session.jsonl [...]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const output = outAt >= 0 ? args[outAt + 1] : null;
  if (outAt >= 0 && !output) usage();
  const rootAt = args.indexOf("--relative-to");
  const zoneAt = args.indexOf("--zone");
  const zoneRoot = rootAt >= 0 ? args[rootAt + 1] : null;
  const zone = zoneAt >= 0 ? args[zoneAt + 1] : null;
  if ((rootAt >= 0) !== (zoneAt >= 0) || (rootAt >= 0 && (!zoneRoot || !zone))) usage();
  const privateEvidence = args.includes("--private-evidence") || rootAt >= 0;
  const skip = new Set(["--out", "--relative-to", "--zone"]);
  const valueAt = new Set([outAt + 1, rootAt + 1, zoneAt + 1]);
  const inputs = args.filter((arg, index) => !skip.has(arg) && !valueAt.has(index) && arg !== "--private-evidence");
  if (inputs.length === 0) usage();
  const records = (await Promise.all(inputs.map(async (input) =>
    harvestReviewedMisses(await readFile(input, "utf8"), basename(resolve(input)), { includePrivateEvidence: privateEvidence }),
  ))).flat();
  const result = zoneRoot && zone
    ? buildHotFileTemplate(records, zoneRoot, zone)
    : records;
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (output) await writeFile(output, rendered, "utf8");
  else process.stdout.write(rendered);
}

void main();
