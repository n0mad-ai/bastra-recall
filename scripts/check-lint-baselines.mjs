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
  return value.functions ?? value.fingerprints ?? value;
}

async function isVerifiedMigration(file, previous, candidate) {
  if (file !== "eslint-structure-baseline.json" || previous.schema || candidate.schema !== 2) return false;
  const { inspectStructure } = await import("./lint-structure.mjs");
  const { findings, legacyFindings } = await inspectStructure(undefined, { legacy: true });
  const canonical = (value) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  if (canonical(previous) !== canonical(legacyFindings) || canonical(candidate.functions) !== canonical(findings)) {
    throw new Error(
      "Structure baseline migration must preserve the exact legacy findings and measured function values. Restore the unchanged legacy code before migrating."
    );
  }
  console.log("Verified structure baseline migration: unchanged legacy findings, measured per-function budgets.");
  return true;
}

for (const file of files) {
  const previous = readBase(file);
  if (!previous) continue;
  const candidate = JSON.parse(readFileSync(file, "utf8"));
  if (await isVerifiedMigration(file, previous, candidate)) continue;
  const before = counts(previous);
  const after = counts(candidate);
  const added = Object.keys(after).filter((key) => after[key] > (before[key] ?? 0));
  if (!added.length) continue;
  console.error(
    `${file}: ${added.length} new/increased exceptions against ${base}. Fix the code; baselines may only shrink. A justified copy needs explicit review, not a silent baseline expansion.`
  );
  process.exitCode = 1;
}
