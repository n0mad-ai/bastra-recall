import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cycleIgnorePatterns } from "./scripts/lint-scope.mjs";

const root = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));
const workspaces = root.workspaces.map((folder) => ({
  folder,
  ...JSON.parse(readFileSync(new URL(`./${folder}/package.json`, import.meta.url))),
}));

function sourceEntry(folder, target) {
  return resolve(folder, target.replace(/^\.\/dist\//, "./src/").replace(/\.[cm]?js$/, ".ts"));
}

function exportTarget(target) {
  if (typeof target === "string") return target;
  return target.import ?? target.require ?? target.default;
}

function workspaceAliases(workspace) {
  const entries = Object.entries(workspace.exports ?? {}).map(([entry, target]) => [
    `${workspace.name}${entry === "." ? "" : entry.slice(1)}$`,
    sourceEntry(workspace.folder, exportTarget(target)),
  ]);
  const main = workspace.main ?? (existsSync(resolve(workspace.folder, "src/index.ts")) ? "./src/index.ts" : null);
  if (!workspace.exports && main) entries.push([`${workspace.name}$`, sourceEntry(workspace.folder, main)]);
  entries.push(
    [`${workspace.name}/dist`, resolve(workspace.folder, "src")],
    [workspace.name, resolve(workspace.folder)]
  );
  return entries;
}

export default {
  forbidden: [
    { name: "no-static-cycle", severity: "error", from: {}, to: { circular: true } },
    {
      name: "workspace-import-must-resolve-to-source",
      severity: "error",
      from: {},
      to: { couldNotResolve: true, path: `^(?:${workspaces.map(({ name }) => name).join("|")})(?:/|$)` },
    },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    exclude: { dynamic: true, path: cycleIgnorePatterns },
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
      alias: Object.fromEntries(workspaces.flatMap(workspaceAliases)),
    },
  },
};
