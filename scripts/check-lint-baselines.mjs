import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const base = process.env.LINT_BASE_REF || "HEAD";
const files = ["eslint-structure-baseline.json", ".lint-cycle-baseline.json", "clone-baseline.json"];

function readBase(file) {
  const tree = execFileSync("git", ["ls-tree", base, "--", file], { encoding: "utf8" });
  if (!tree.trim()) return null; // First introduction of this gate is the bootstrap.
  return JSON.parse(execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8" }));
}

function counts(value) {
  if (Array.isArray(value)) return Object.fromEntries(value.map((edge) => [JSON.stringify(edge), 1]));
  if (value.production && value.tests) {
    return Object.fromEntries(
      ["production", "tests"].flatMap((group) =>
        Object.entries(value[group].fingerprints).map(([key, count]) => [`${group}:${key}`, count])
      )
    );
  }
  return value.fingerprints ?? value;
}

for (const file of files) {
  const previous = readBase(file);
  if (!previous) continue;
  const before = counts(previous);
  const after = counts(JSON.parse(readFileSync(file, "utf8")));
  const added = Object.keys(after).filter((key) => after[key] > (before[key] ?? 0));
  if (!added.length) continue;
  console.error(
    `${file}: ${added.length} new/increased exceptions against ${base}. Fix the code; baselines may only shrink. A justified copy needs explicit review, not a silent baseline expansion.`
  );
  process.exitCode = 1;
}
