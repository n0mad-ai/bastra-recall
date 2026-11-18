import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import ts from "typescript";

if (process.env.GITHUB_ACTIONS === "true" && !process.env.LINT_BASE_REF) {
  console.error("CI requires an explicit trusted LINT_BASE_REF; refusing to compare against the current checkout.");
  process.exit(1);
}

const base = process.env.LINT_BASE_REF || "HEAD";
try {
  execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { stdio: ["ignore", "pipe", "pipe"] });
} catch {
  console.error(
    `Unknown lint baseline revision: ${base}. Fetch the CI base commit or set LINT_BASE_REF to an existing commit.`
  );
  process.exit(1);
}

const files = ["eslint-structure-baseline.json", ".lint-cycle-baseline.json", "clone-baseline.json"];

// #1572 is a single mechanical tree rename, not transferable function debt.
const oldUi = "packages/daemon/webui/v22/";
const newUi = "packages/daemon/webui/app/";
const oldProbe = "tools/probes/v22-memory-browser.mjs";
const newProbe = "tools/probes/webui-memory-browser.mjs";
let verifiedUiRename;

function baseSource(file) {
  return execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8" });
}

function executableSource(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw new Error(`Cannot verify UI rename: invalid source ${file}`);
  return ts.createPrinter({ removeComments: true }).printFile(parsed);
}

function renamedSnapshot() {
  // Preserve the proof after a later, independently ratcheted refactoring commit.
  const revision = execFileSync("git", ["log", "--reverse", "--format=%H", `${base}..HEAD`, "--", newUi], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
  if (revision) {
    const paths = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", revision, "--", oldUi, newUi, oldProbe, newProbe],
      {
        encoding: "utf8",
      }
    )
      .trim()
      .split("\n");
    return { paths, source: (file) => execFileSync("git", ["show", `${revision}:${file}`], { encoding: "utf8" }) };
  }
  const paths = existsSync(newUi)
    ? readdirSync(newUi, { recursive: true })
        .map((file) => newUi + file)
        .filter((file) => statSync(file).isFile())
    : [];
  if (existsSync(oldUi)) paths.push(oldUi);
  if (existsSync(oldProbe)) paths.push(oldProbe);
  if (existsSync(newProbe)) paths.push(newProbe);
  return { paths, source: (file) => readFileSync(file, "utf8") };
}

function verifyUiRename() {
  if (verifiedUiRename !== undefined) return verifiedUiRename;
  verifiedUiRename = false;
  const previous = execFileSync("git", ["ls-tree", "-r", "--name-only", base, "--", oldUi], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!previous.length) return false;
  const snapshot = renamedSnapshot();
  const expected = previous.map((file) => file.replace(oldUi, newUi)).concat(newProbe);
  if (JSON.stringify(snapshot.paths.sort()) !== JSON.stringify(expected.sort())) return false;
  for (const file of previous.filter((file) => file.endsWith(".js"))) {
    const candidate = file.replace(oldUi, newUi);
    if (executableSource(baseSource(file), file) !== executableSource(snapshot.source(candidate), file)) return false;
  }
  const probe = baseSource(oldProbe).replace('"v22-mb-probe-"', '"webui-mb-probe-"');
  verifiedUiRename = executableSource(probe, oldProbe) === executableSource(snapshot.source(newProbe), oldProbe);
  return verifiedUiRename;
}

function readBase(file) {
  const tree = execFileSync("git", ["ls-tree", base, "--", file], { encoding: "utf8" });
  if (!tree.trim()) return null; // First introduction of this gate is the bootstrap.
  const source = baseSource(file);
  if (!source.includes(oldUi) && !source.includes(oldProbe)) return source;
  if (!verifyUiRename()) return source;
  return source.replaceAll(oldUi, newUi).replaceAll(oldProbe, newProbe);
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
  const source = readBase(file);
  if (!source) continue;
  const previous = JSON.parse(source);
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

for (const file of [
  "eslint.config.mjs",
  ".jscpd.json",
  ".dependency-cruiser.mjs",
  "package.json",
  "scripts/lint-scope.mjs",
]) {
  const previous = readBase(file);
  if (!previous) continue;
  try {
    const { lintConfigurationAllowed } = await import("./lint-config-ratchet.mjs");
    const candidate = readFileSync(file, "utf8");
    if (lintConfigurationAllowed(file, previous, candidate)) continue;
    throw new Error("weakened or unverified operational change");
  } catch (error) {
    console.error(`${file}: lint configuration weakened or unverified against ${base}: ${error.message}`);
    process.exitCode = 1;
  }
}
