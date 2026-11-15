import { readFileSync, writeFileSync } from "node:fs";
import { cruise } from "dependency-cruiser";
import config from "../.dependency-cruiser.mjs";
import { assertSingleRootConfig, listCodeFiles } from "./lint-scope.mjs";

assertSingleRootConfig();

const baselinePath = ".lint-cycle-baseline.json";
const mode = process.argv[2];
if (mode && !["--prune", "--report"].includes(mode)) {
  throw new Error("Usage: node scripts/check-cycles.mjs [--prune|--report]");
}

const result = await cruise(listCodeFiles(), {
  ...config.options,
  ruleSet: { forbidden: config.forbidden },
  validate: true,
  outputType: "json",
});
const report = typeof result.output === "string" ? JSON.parse(result.output) : result.output;
const unresolved = report.summary.violations.filter(
  ({ rule }) => rule.name === "workspace-import-must-resolve-to-source"
);
if (unresolved.length) {
  console.error("Workspace imports must resolve to real source entry points; no dist or invented fallback entries:");
  for (const { from, to } of unresolved) console.error(`  ${from} -> ${to}`);
  process.exit(1);
}
const edges = report.modules.flatMap(({ source, dependencies }) =>
  dependencies.filter((dependency) => dependency.circular).map(({ resolved }) => [source, resolved])
);
const current = [...new Set(edges.map((edge) => JSON.stringify(edge)))].sort();

if (mode === "--report") {
  console.log(
    JSON.stringify(
      current.map((edge) => JSON.parse(edge)),
      null,
      2
    )
  );
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const known = new Set(baseline.map((edge) => JSON.stringify(edge)));
  const added = current.filter((edge) => !known.has(edge));
  const remaining = new Set(current);
  const removed = [...known].filter((edge) => !remaining.has(edge));
  for (const edge of added) {
    console.error(`New static import cycle: ${JSON.parse(edge).join(" -> ")}`);
  }
  if (added.length) {
    console.error(
      "Break the cycle: move shared behavior below both modules or use their public interface. Do not enlarge the cycle baseline."
    );
    process.exitCode = 1;
  } else if (mode === "--prune") {
    writeFileSync(
      baselinePath,
      `${JSON.stringify(
        current.map((edge) => JSON.parse(edge)),
        null,
        2
      )}\n`
    );
    console.log(`Cycle baseline reduced by ${removed.length} edges; ${current.length} remain.`);
  } else if (removed.length) {
    console.error(
      `Cycle baseline has ${removed.length} obsolete edges. Run npm run lint:cycles:prune and commit the smaller baseline.`
    );
    process.exitCode = 1;
  } else {
    console.log(`Static cycles: ${current.length} frozen edges; no new or obsolete exceptions.`);
  }
}
