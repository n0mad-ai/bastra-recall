import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const configs = {
  "eslint.config.mjs":
    'export default [{files:["**/*.{cjs,cts}"],ignores:["old/**"],rules:{complexity:["error",{max:15}],"max-depth":["error",4]}}];',
  ".jscpd.json": JSON.stringify({ minLines: 20, minTokens: 150, ignore: ["old/**"] }),
  ".dependency-cruiser.mjs":
    'export default {forbidden:[{name:"cycle",severity:"error",to:{circular:true}}],options:{exclude:{path:"old"}}};',
  "package.json": JSON.stringify({
    scripts: {
      lint: "npm run lint:baselines && npm run lint:structure && npm run lint:cycles",
      "lint:baselines": "node scripts/check-lint-baselines.mjs",
      "lint:structure": "node scripts/lint-structure.mjs",
      "lint:cycles": "node scripts/check-cycles.mjs",
    },
  }),
  "scripts/lint-scope.mjs": 'export const codeIgnores=["old/**"]; export const CODE_PATTERN="**/*.{ts,js}";',
};

function execute(root, program, args, env = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bastra-config-ratchet-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  for (const name of [
    "check-lint-baselines.mjs",
    "lint-config-ratchet.mjs",
    "lint-knip-contract.mjs",
    "lint-knip-findings.mjs",
  ]) {
    const source = join(repository, "scripts", name);
    if (existsSync(source)) copyFileSync(source, join(root, "scripts", name));
  }
  // Resolve the existing TypeScript dependency without installing into a fixture.
  const modules = join(repository, "node_modules");
  return { root, modules };
}

async function history(t, overrides = {}) {
  const { root, modules } = fixture(t);
  symlinkSync(modules, join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const [file, source] of Object.entries({ ...configs, ...overrides })) writeFileSync(join(root, file), source);
  for (const file of ["eslint-structure-baseline.json", "clone-baseline.json"]) writeFileSync(join(root, file), "{}");
  writeFileSync(join(root, ".lint-cycle-baseline.json"), "[]");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "trusted"],
  ]) {
    const result = execute(root, "git", args);
    assert.equal(result.status, 0, result.output);
  }
  return root;
}

function guard(root) {
  return execute(root, process.execPath, ["scripts/check-lint-baselines.mjs"], {
    GITHUB_ACTIONS: "true",
    LINT_BASE_REF: "HEAD",
  });
}

function change(root, file, before, after) {
  const source = readFileSync(join(root, file), "utf8");
  assert.ok(source.includes(before));
  writeFileSync(join(root, file), source.replace(before, after));
}

const relaxations = [
  ["complexity", "eslint.config.mjs", "max:15", "max:16"],
  ["depth", "eslint.config.mjs", '"error",4', '"error",5'],
  ["disabled rule", "eslint.config.mjs", 'complexity:["error",{max:15}]', 'complexity:"off"'],
  ["ESLint exclusion", "eslint.config.mjs", '["old/**"]', '["old/**","new/**"]'],
  ["clone threshold", ".jscpd.json", '"minTokens":150', '"minTokens":151'],
  ["clone exclusion", ".jscpd.json", '["old/**"]', '["old/**","new/**"]'],
  ["cycle exclusion", ".dependency-cruiser.mjs", 'path:"old"', 'path:"old|new"'],
  ["disabled cycle rule", ".dependency-cruiser.mjs", 'severity:"error"', 'severity:"ignore"'],
  ["missing lint stage", "package.json", " && npm run lint:cycles", ""],
  ["replaced lint stage", "package.json", "node scripts/check-cycles.mjs", "echo skipped"],
  ["imported scope exclusion", "scripts/lint-scope.mjs", '["old/**"]', '["old/**","new/**"]'],
  ["narrowed imported scope", "scripts/lint-scope.mjs", "**/*.{ts,js}", "**/*.ts"],
];

for (const [name, file, before, after] of relaxations) {
  test(`S2 rejects ${name} against the trusted config in a test repository`, async (t) => {
    const root = await history(t);
    assert.equal(guard(root).status, 0);
    change(root, file, before, after);
    const result = guard(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /lint configuration.*(?:weakened|unverified)/i);
  });
}

test("S2 permits lower thresholds, removed exclusions, formatting and broader case coverage", async (t) => {
  const root = await history(t);
  change(root, "eslint.config.mjs", "max:15", "max:14");
  change(root, "eslint.config.mjs", '"error",4', '"error",3');
  change(root, "eslint.config.mjs", '["old/**"]', "[]");
  change(root, "eslint.config.mjs", "**/*.{cjs,cts}", "**/*.{[cC][jJ][sS],[cC][tT][sS]}");
  change(root, ".jscpd.json", '"minTokens":150', '"minTokens":140');
  change(root, ".jscpd.json", '["old/**"]', "[]");
  change(root, ".dependency-cruiser.mjs", 'exclude:{path:"old"}', "");
  change(root, "scripts/lint-scope.mjs", '["old/**"]', "[]");
  change(root, "scripts/lint-scope.mjs", "**/*.{ts,js}", "**/*.{[tT][sS],[jJ][sS]}");
  change(root, "eslint.config.mjs", "export default", "// formatting is not a policy change\nexport default");
  const result = guard(root);
  assert.equal(result.status, 0, result.output);
});

/** #1646: the repository's own cycle config, whose template and regex text steer the check. */
const realCruiser = { ".dependency-cruiser.mjs": readFileSync(join(repository, ".dependency-cruiser.mjs"), "utf8") };

const literalRewrites = [
  ["a never-matching prefix in the workspace path template head", "path: `^(?:${", "path: `(?!)^(?:${"],
  ["a never-matching suffix in the workspace path template tail", "(?:/|$)` }", "(?:/|$)(?!)` }"],
  ["a never-matching alternative that ends the template tail early", '.join("|")})', '.join("|")}|(?!)$)'],
  ["a never-matching source-entry regex", "/^\\.\\/dist\\//", "/(?!)/"],
];

for (const [name, before, after] of literalRewrites) {
  test(`#1646 rejects ${name} in the real .dependency-cruiser.mjs`, async (t) => {
    const root = await history(t, realCruiser);
    assert.equal(guard(root).status, 0);
    change(root, ".dependency-cruiser.mjs", before, after);
    const result = guard(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /lint configuration.*(?:weakened|unverified)/i);
  });
}

test("#1646 rejects a changed unary operator, which is no child node", async (t) => {
  const eslint = configs["eslint.config.mjs"].replace('"max-depth":["error",4]', '"max-depth":["error",4],offset:-1');
  const root = await history(t, { "eslint.config.mjs": eslint });
  assert.equal(guard(root).status, 0);
  change(root, "eslint.config.mjs", "offset:-1", "offset:+1");
  const result = guard(root);
  assert.equal(result.status, 1, result.output);
});

test("#1646 still permits removing the real cycle exclusion and reformatting", async (t) => {
  const root = await history(t, realCruiser);
  change(root, ".dependency-cruiser.mjs", "exclude: { dynamic: true, path: cycleIgnorePatterns },", "");
  change(root, ".dependency-cruiser.mjs", "export default {", "// formatting only\nexport default {");
  const result = guard(root);
  assert.equal(result.status, 0, result.output);
});

test("S2 rejects a deleted config or imported scope even when other config files remain", async (t) => {
  for (const file of Object.keys(configs)) {
    const root = await history(t);
    unlinkSync(join(root, file));
    const result = guard(root);
    assert.equal(result.status, 1, `${file}: ${result.output}`);
    assert.match(result.output, /lint configuration.*(?:weakened|unverified)/i);
  }
});

test("S2 fails closed if the config checker cannot be loaded", async (t) => {
  const root = await history(t);
  unlinkSync(join(root, "scripts/lint-config-ratchet.mjs"));
  const result = guard(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /lint configuration.*unverified/i);
});
