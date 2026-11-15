import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolve workspace exports against source, independently of stale/missing dist builds.
const core = JSON.parse(readFileSync(new URL("./packages/core/package.json", import.meta.url)));
const aliases = Object.fromEntries(
  Object.entries(core.exports).map(([entry, target]) => [
    `${core.name}${entry === "." ? "" : entry.slice(1)}$`,
    resolve("packages/core", target.import.replace("./dist/", "./src/").replace(/\.js$/, ".ts")),
  ])
);

export default {
  forbidden: [{ name: "no-static-cycle", severity: "error", from: {}, to: { circular: true } }],
  options: {
    includeOnly: "^(packages|scripts|tools)/",
    exclude: {
      dynamic: true,
      path: [
        "(^|/)(node_modules|dist|build|coverage|vendor|__fixtures__|stress-fixtures|goldset)/",
        "^packages/eval/fixtures/",
        "^packages/daemon/stub/build-info\\.ts$",
        "^tools/model-compare/(data|results)/",
        "^tools/probes/convention-e2e/fixtures\\.mjs$",
      ],
    },
    // Compiler-erased type imports never participate in the runtime graph.
    tsPreCompilationDeps: false,
    moduleSystems: ["es6", "cjs"],
    enhancedResolveOptions: {
      extensions: [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json"],
      extensionAlias: {
        ".js": [".ts", ".tsx", ".js"],
        ".mjs": [".mts", ".mjs"],
        ".cjs": [".cts", ".cjs"],
        ".jsx": [".tsx", ".jsx"],
      },
      alias: { ...aliases, "@bastra-recall/statusline$": resolve("packages/statusline/src/index.ts") },
    },
  },
};
