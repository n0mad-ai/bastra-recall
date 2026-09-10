#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { harvestReviewedMisses } from "../src/learned-recall/reviewed-miss-harvest.js";

function usage(): never {
  console.error("usage: tsx scripts/harvest-reviewed-misses.ts [--out queue.json] session.jsonl [...]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const output = outAt >= 0 ? args[outAt + 1] : null;
  if (outAt >= 0 && !output) usage();
  const valueAt = new Set([outAt].filter((index) => index >= 0).map((index) => index + 1));
  const inputs = args.filter((arg, index) => arg !== "--out" && !valueAt.has(index));
  if (inputs.length === 0) usage();
  const records = (await Promise.all(inputs.map(async (input) =>
    harvestReviewedMisses(await readFile(input, "utf8"), basename(resolve(input))),
  ))).flat();
  const rendered = JSON.stringify(records, null, 2) + "\n";
  if (output) await writeFile(output, rendered, "utf8");
  else process.stdout.write(rendered);
}

void main();
