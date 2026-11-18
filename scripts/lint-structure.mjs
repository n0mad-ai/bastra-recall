import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { analyzeFunctions, functionAt, legacyFingerprint } from "./lint-function-identities.mjs";
import { assertSingleRootConfig, listCodeFiles } from "./lint-scope.mjs";

const baselinePath = new URL("../eslint-structure-baseline.json", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const structuralRules = new Set(["complexity", "max-depth"]);
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

export async function inspectStructure(paths = listCodeFiles(repositoryRoot), { legacy = false } = {}) {
  // Read raw findings: native file/rule counters cannot freeze individual functions.
  assertSingleRootConfig(repositoryRoot);
  const eslint = new ESLint({
    cwd: repositoryRoot,
    applySuppressions: false,
    allowInlineConfig: false,
    overrideConfigFile: fileURLToPath(new URL("../eslint.config.mjs", import.meta.url)),
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
    for (const message of messages) {
      const owner = functionAt(message, source, parsed);
      const key = JSON.stringify([file, owner.identity, message.ruleId]);
      const metric = message.message.match(/(?:complexity of |too deeply \()(\d+)/);
      if (!metric) throw new Error(`Unrecognized structural finding: ${message.message}`);
      findings[key] = Math.max(findings[key] ?? 0, Number(metric[1]));
      message.baselineKey = key;
      if (legacy) {
        const oldKey = `${file}:${message.ruleId}:${legacyFingerprint(message, owner, parsed)}`;
        legacyFindings[oldKey] = (legacyFindings[oldKey] ?? 0) + 1;
      }
    }
  }
  return {
    eslint,
    results,
    findings: Object.fromEntries(Object.entries(findings).sort()),
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

async function main() {
  const prune = process.argv.includes("--prune");
  const paths = process.argv.slice(2).filter((argument) => argument !== "--prune");
  if (prune && paths.length) throw new Error("Prune requires the complete project; omit file arguments.");
  const snapshot = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (snapshot.schema !== 2) throw new Error("Structure baseline requires schema 2 function maxima.");
  const baseline = snapshot.functions;
  const { eslint, results, findings } = await inspectStructure(paths.length ? paths : undefined);
  const { added, removed } = compareBaseline(baseline, findings);
  const allowed = new Set(Object.keys(baseline).filter((key) => !added.includes(key)));
  const visible = results.map((result) => {
    const messages = result.messages.filter((message) => !allowed.has(message.baselineKey));
    return {
      ...result,
      messages,
      errorCount: messages.filter((message) => message.severity === 2).length,
      warningCount: messages.filter((message) => message.severity === 1).length,
    };
  });
  const formatter = await eslint.loadFormatter("stylish");
  process.stdout.write(formatter.format(visible));
  if (added.length) {
    explainExceeded(added, baseline, findings);
    console.error(
      "Structure limit exceeded: new functions need complexity <=15 and nesting <=4; existing functions must not exceed their frozen individual maxima. Reuse existing modules and split responsibilities where appropriate. Do not add suppressions or expand the baseline."
    );
  }
  if (prune && !added.length) {
    writeFileSync(baselinePath, JSON.stringify({ schema: 2, functions: findings }, null, 2) + "\n");
    console.log(`Structure baseline lowered: ${removed.length} maxima reduced or removed.`);
  } else if (removed.length && !paths.length) {
    console.error(
      `Structure baseline has ${removed.length} outdated function maxima. Run npm run lint:prune after the cleanup and commit the smaller baseline.`
    );
  }
  const errors = visible.reduce((sum, result) => sum + result.errorCount, 0);
  process.exitCode = errors || (!prune && !paths.length && removed.length) ? 1 : 0;
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
