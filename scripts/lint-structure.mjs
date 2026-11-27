import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { analyzeFunctions, functionAt, legacyFingerprint } from "./lint-function-identities.mjs";
import { CODE_PATTERN, assertSingleRootConfig, listCodeFiles } from "./lint-scope.mjs";

const baselinePath = new URL("../eslint-structure-baseline.json", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const anyBaselinePath = new URL("../eslint-any-baseline.json", import.meta.url);
const doubleCastBaselinePath = new URL("../eslint-double-cast-baseline.json", import.meta.url);
const structuralRules = new Set(["complexity", "max-depth"]);
const anyRule = "@typescript-eslint/no-explicit-any";
const doubleCastRule = "no-restricted-syntax";
const typeAssertion = ":matches(TSAsExpression, TSTypeAssertion)";
const assertionRules = {
  [anyRule]: "error",
  [doubleCastRule]: [
    "error",
    {
      selector: `${typeAssertion} > ${typeAssertion}.expression`,
      message: "Avoid chaining two type assertions. Narrow the value or validate it before asserting its type.",
    },
  ],
  "@typescript-eslint/ban-ts-comment": [
    "error",
    { "ts-ignore": true, "ts-check": false, "ts-nocheck": false, "ts-expect-error": false },
  ],
};

function rejectUnconfiguredFiles(results) {
  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId === null && /no matching configuration|File ignored/.test(message.message)) {
        message.severity = 2;
        message.message += " Unsupported source type: configure coverage before adding this code file.";
      }
    }
  }
}

function countRule(results, rule) {
  const counts = {};
  for (const result of results) {
    const count = result.messages.filter((message) => message.ruleId === rule).length;
    if (count) counts[relative(repositoryRoot, result.filePath).split("\\").join("/")] = count;
  }
  return Object.fromEntries(Object.entries(counts).sort());
}

export async function inspectStructure(paths = listCodeFiles(repositoryRoot), { legacy = false } = {}) {
  // Read raw findings: native file/rule counters cannot freeze individual functions.
  assertSingleRootConfig(repositoryRoot);
  const eslint = new ESLint({
    cwd: repositoryRoot,
    applySuppressions: false,
    allowInlineConfig: false,
    overrideConfigFile: fileURLToPath(new URL("../eslint.config.mjs", import.meta.url)),
    // The existing assertion counts are frozen per file below.
    overrideConfig: { files: [CODE_PATTERN], rules: assertionRules },
  });
  const results = await eslint.lintFiles(paths);
  rejectUnconfiguredFiles(results);
  const findings = {};
  const legacyFindings = {};
  for (const result of results) {
    const messages = result.messages.filter((message) => structuralRules.has(message.ruleId));
    if (!messages.length) continue;
    const source = result.source ?? readFileSync(result.filePath, "utf8");
    const file = relative(repositoryRoot, result.filePath).split("\\").join("/");
    const parsed = analyzeFunctions(source, result.filePath);
    const moduleStatements = new Set();
    for (const message of messages) {
      const owner = functionAt(message, source, parsed);
      if (owner.statementRange) moduleStatements.add(owner.statementRange.join(":"));
      const key = JSON.stringify([file, owner.identity, message.ruleId]);
      const metric = message.message.match(/(?:complexity of |too deeply \()(\d+)/);
      if (!metric) throw new Error(`Unrecognized structural finding: ${message.message}`);
      findings[key] = Math.max(findings[key] ?? 0, Number(metric[1]));
      message.baselineKey = key;
      if (legacy) {
        const oldKey = `${file}:${message.ruleId}:${legacyFingerprint(message, owner, parsed)}`;
        legacyFindings[oldKey] = (legacyFindings[oldKey] ?? 0) + 1;
      }
      message.message += owner.ambiguityNotice;
    }
    // Preserve each numeric legacy module budget without lending it to a new top-level statement.
    if (moduleStatements.size > 1) {
      throw new Error(
        `${file}: independent module statements cannot share a frozen depth budget. Refactor the separate module statements; do not expand the baseline.`
      );
    }
  }
  return {
    eslint,
    results,
    findings: Object.fromEntries(Object.entries(findings).sort()),
    anyCounts: countRule(results, anyRule),
    doubleCastCounts: countRule(results, doubleCastRule),
    ...(legacy ? { legacyFindings } : {}),
  };
}

function compareBaseline(baseline, findings) {
  const added = Object.keys(findings).filter((key) => findings[key] > (baseline[key] ?? 0));
  const removed = Object.keys(baseline).filter((key) => baseline[key] > (findings[key] ?? 0));
  return { added, removed };
}

function explainExceeded(keys, baseline, findings) {
  for (const key of keys) {
    const [file, identity, rule] = JSON.parse(key);
    const limit = rule === "complexity" ? 15 : 4;
    const prior = baseline[key];
    const instruction = prior
      ? `frozen maximum ${prior}, actual ${findings[key]}; do not worsen this function. Refactor separately via the associated refactoring issue (#1508–#1519)`
      : `new function or previously compliant metric maximum ${limit}, actual ${findings[key]}; split responsibilities using existing modules`;
    console.error(`${file} ${identity} ${rule}: ${instruction}. Do not expand the baseline.`);
  }
}

function readPerFileBaseline(path) {
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  if (snapshot.schema !== 1) throw new Error(`${fileURLToPath(path)} requires schema 1 per-file counts.`);
  return snapshot.files;
}

function visibleResults(results, allowed, anyAdded, doubleCastAdded) {
  return results.map((result) => {
    const file = relative(repositoryRoot, result.filePath).split("\\").join("/");
    const messages = result.messages.filter(
      (message) =>
        !allowed.has(message.baselineKey) &&
        !(message.ruleId === anyRule && !anyAdded.includes(file)) &&
        !(message.ruleId === doubleCastRule && !doubleCastAdded.includes(file))
    );
    return {
      ...result,
      messages,
      errorCount: messages.filter((message) => message.severity === 2).length,
      warningCount: messages.filter((message) => message.severity === 1).length,
    };
  });
}

function explainAny(files, baseline, counts) {
  for (const file of files) {
    const prior = baseline[file];
    const instruction = prior
      ? `frozen at ${prior} explicit any, now ${counts[file]}; type the new value instead of adding any`
      : `${counts[file]} explicit any in a file with none frozen; use a concrete or parsed type (unknown plus narrowing)`;
    console.error(`${file} ${anyRule}: ${instruction}. Do not add suppressions or expand the baseline.`);
  }
}

async function main() {
  const prune = process.argv.includes("--prune");
  const paths = process.argv.slice(2).filter((argument) => argument !== "--prune");
  if (prune && paths.length) throw new Error("Prune requires the complete project; omit file arguments.");
  const snapshot = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (snapshot.schema !== 2) throw new Error("Structure baseline requires schema 2 function maxima.");
  const baseline = snapshot.functions;
  const anyBaseline = readPerFileBaseline(anyBaselinePath);
  const doubleCastBaseline = readPerFileBaseline(doubleCastBaselinePath);
  const { eslint, results, findings, anyCounts, doubleCastCounts } = await inspectStructure(
    paths.length ? paths : undefined
  );
  const { added, removed } = compareBaseline(baseline, findings);
  const { added: anyAdded, removed: anyRemoved } = compareBaseline(anyBaseline, anyCounts);
  const doubleCast = compareBaseline(doubleCastBaseline, doubleCastCounts);
  const allowed = new Set(Object.keys(baseline).filter((key) => !added.includes(key)));
  const visible = visibleResults(results, allowed, anyAdded, doubleCast.added);
  const formatter = await eslint.loadFormatter("stylish");
  process.stdout.write(formatter.format(visible));
  if (added.length) {
    explainExceeded(added, baseline, findings);
    console.error(
      "Structure limit exceeded: new functions need complexity <=15 and nesting <=4; existing functions must not exceed their frozen individual maxima. Reuse existing modules and split responsibilities where appropriate. Do not add suppressions or expand the baseline."
    );
  }
  explainAny(anyAdded, anyBaseline, anyCounts);
  const outdated = removed.length + anyRemoved.length + doubleCast.removed.length;
  const newExceptions = added.length + anyAdded.length + doubleCast.added.length;
  if (prune && !newExceptions) {
    writeFileSync(baselinePath, JSON.stringify({ schema: 2, functions: findings }, null, 2) + "\n");
    writeFileSync(anyBaselinePath, JSON.stringify({ schema: 1, files: anyCounts }, null, 2) + "\n");
    writeFileSync(doubleCastBaselinePath, JSON.stringify({ schema: 1, files: doubleCastCounts }, null, 2) + "\n");
    console.log(`Structure baseline lowered: ${outdated} maxima or any counts reduced or removed.`);
  } else if (outdated && !paths.length) {
    console.error(
      `Structure baseline has ${outdated} outdated function maxima or any counts or double casts. Run npm run lint:prune after the cleanup and commit the smaller baseline.`
    );
  }
  const errors = visible.reduce((sum, result) => sum + result.errorCount, 0);
  process.exitCode = errors || (!prune && !paths.length && outdated) ? 1 : 0;
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    await main();
  } catch (error) {
    console.error(`Structure check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
