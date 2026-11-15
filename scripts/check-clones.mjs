import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const baselinePath = resolve("clone-baseline.json");
const previous = JSON.parse(readFileSync(baselinePath, "utf8"));
const config = JSON.parse(readFileSync(".jscpd.json", "utf8"));
const temporary = mkdtempSync(join(tmpdir(), "bastra-clones-"));
const prune = process.argv.includes("--prune");
const groups = ["production", "tests"];
const current = { version: 1 };
let failed = false;

function scan(group) {
  const nativeBaseline = join(temporary, `${group}-baseline.json`);
  writeFileSync(nativeBaseline, JSON.stringify(previous[group]));
  const extra =
    group === "production"
      ? ["--ignore", [...config.ignore, "**/__tests__/**", "**/*.test.*", "**/*.spec.*", "**/tests/**"].join(",")]
      : ["--min-lines", "40", "--min-tokens", "300"];
  const result = spawnSync(
    resolve("node_modules/.bin/jscpd"),
    [
      "--fail-on-empty",
      "--absolute",
      "--workers",
      "1",
      "--config",
      ".jscpd.json",
      "--baseline",
      nativeBaseline,
      "--update-baseline",
      "--reporters",
      "json",
      "--output",
      join(temporary, group),
      "--silent",
      "--no-colors",
      ...extra,
    ],
    { encoding: "utf8" }
  );
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || result.stdout);
  }
  const report = JSON.parse(readFileSync(join(temporary, group, "jscpd-report.json"), "utf8"));
  const baseline = JSON.parse(readFileSync(nativeBaseline, "utf8"));
  return { report, baseline };
}

function compare(group, report, baseline) {
  const oldHashes = previous[group].fingerprints;
  const newHashes = baseline.fingerprints;
  const added = Object.entries(newHashes).some(([hash, count]) => count > (oldHashes[hash] ?? 0));
  const removed = Object.entries(oldHashes).some(([hash, count]) => count > (newHashes[hash] ?? 0));
  if (added) {
    failed = true;
    console.error(`New copied code (${group}):`);
    for (const clone of report.duplicates.filter((clone) => clone.isNew)) {
      console.error(
        `  ${clone.firstFile.name}:${clone.firstFile.start} ↔ ${clone.secondFile.name}:${clone.secondFile.start} (${clone.lines} lines, ${clone.tokens} tokens)`
      );
    }
    console.error(
      "Check whether an existing helper fits. Do not merge code merely to silence this check. If the copy is correct for the domain, document the reason and request a reviewed baseline exception; never expand the baseline by hand to bypass a finding."
    );
  }
  if (removed && !prune) {
    failed = true;
    console.error(`Removed copied code (${group}): run npm run lint:clones:prune and commit the smaller baseline.`);
  }
  console.log(`Clones (${group}): ${report.duplicates.length}`);
}

try {
  for (const group of groups) {
    const { report, baseline } = scan(group);
    current[group] = baseline;
    compare(group, report, baseline);
  }
  if (prune && !failed) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    console.log("Clone baseline lowered; commit clone-baseline.json.");
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
