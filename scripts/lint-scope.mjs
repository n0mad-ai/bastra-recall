import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";

// Root dot-directories hold session, editor and repository metadata, not application code.
// Keep root dot-files and hidden directories inside visible source trees in scope.
const ROOT_HIDDEN_DIRECTORY = /^\.[^/]+\//;

export const CODE_PATTERN = "**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}";
export const codeIgnores = [
  "**/node_modules/**",
  ".*/**",
  "packages/core/dist/**",
  "packages/daemon/dist/**",
  "packages/statusline/dist/**",
  "packages/daemon/mcpb/build/**",
  "packages/daemon/vendor/**",
  "packages/daemon/webui/v22/vendor/**",
  "packages/eval/fixtures/**",
  "packages/eval/goldset/**",
  "packages/daemon/__fixtures__/**",
  "packages/daemon/scripts/stress-fixtures/**",
  "packages/daemon/stub/build-info.ts",
  "tools/model-compare/data/**",
  "tools/model-compare/results/**",
  "tools/probes/convention-e2e/fixtures.mjs",
];

export function repositoryFiles(root = process.cwd()) {
  return [
    ...new Set(
      execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      })
        .split("\0")
        .filter((file) => file && existsSync(resolve(root, file)))
    ),
  ];
}

export function isCodeIgnored(file) {
  if (file.split("/").includes("node_modules")) return true;
  return codeIgnores.slice(1).some((pattern) => {
    if (pattern === ".*/**") return ROOT_HIDDEN_DIRECTORY.test(file);
    const prefix = pattern.replace(/\/\*\*$/, "");
    return pattern.endsWith("/**") ? file === prefix || file.startsWith(`${prefix}/`) : file === prefix;
  });
}

export function listCodeFiles(root = process.cwd()) {
  return repositoryFiles(root).filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && !isCodeIgnored(file));
}

export function assertSingleRootConfig(root = process.cwd()) {
  const extra = repositoryFiles(root).filter(
    (file) =>
      !ROOT_HIDDEN_DIRECTORY.test(file) && /^eslint\.config\./.test(basename(file)) && file !== "eslint.config.mjs"
  );
  if (extra.length)
    throw new Error(
      `Additional ESLint configuration is forbidden: ${extra.join(", ")}. Use only the root eslint.config.mjs.`
    );
}

export const cycleIgnorePatterns = codeIgnores.map((pattern) => {
  if (pattern === ".*/**") return ROOT_HIDDEN_DIRECTORY.source;
  if (pattern.startsWith("**/")) return "(^|/)node_modules/";
  const prefix = pattern.replace(/\/\*\*$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return pattern.endsWith("/**") ? `^${prefix}(?:/|$)` : `^${prefix}$`;
});
