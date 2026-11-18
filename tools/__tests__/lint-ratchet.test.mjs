import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeFunctions, functionAt } from "../../scripts/lint-function-identities.mjs";
import { isCodeIgnored, cycleIgnorePatterns } from "../../scripts/lint-scope.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const scriptNames = /^(?:lint-.*|check-(?:cycles|clones|lint-baselines))\.mjs$/;
const configs = ["eslint.config.mjs", ".dependency-cruiser.mjs", ".jscpd.json"];

async function put(root, name, body) {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
}

function execute(root, program, args, env = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LINT_BASE_REF: "HEAD", ...env },
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

function tool(root, name, ...args) {
  return execute(root, process.execPath, [join(root, "scripts", name), ...args]);
}

async function fixture(t) {
  // macOS /var is a symlink: match Node's canonical import.meta.url for CLI entry detection.
  const root = await realpath(await mkdtemp(join(tmpdir(), "bastra-lint-ratchet-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
  await mkdir(join(root, "scripts"));
  const scripts = (await readdir(join(repository, "scripts"))).filter((name) => scriptNames.test(name));
  for (const name of scripts) await copyFile(join(repository, "scripts", name), join(root, "scripts", name));
  for (const name of configs) await copyFile(join(repository, name), join(root, name));
  await symlink(
    join(repository, "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const workspaces = ["core", "daemon", "statusline", "eval", "bastra-recall"];
  await put(root, "package.json", {
    type: "module",
    private: true,
    workspaces: workspaces.map((name) => `packages/${name}`),
  });
  for (const name of workspaces) {
    const packageName = name === "bastra-recall" ? "bastra-recall" : `@bastra-recall/${name}`;
    const metadata = { name: packageName, type: "module", main: "./dist/index.js" };
    if (name === "core") metadata.exports = { ".": { import: "./dist/index.js" } };
    if (name === "eval") delete metadata.main;
    await put(root, `packages/${name}/package.json`, metadata);
    await put(root, `packages/${name}/src/index.ts`, "export {};\n");
  }
  await put(root, ".gitignore", "node_modules/\n");
  assert.equal(execute(root, "git", ["init", "-q"]).status, 0);
  await put(root, "eslint-structure-baseline.json", { schema: 2, functions: {} });
  await put(root, ".lint-cycle-baseline.json", []);
  await put(root, "clone-baseline.json", {
    version: 1,
    production: { version: 1, fingerprints: {} },
    tests: { version: 1, fingerprints: {} },
  });
  return root;
}

function branches(name, amount) {
  const choices = Array.from({ length: amount }, (_, n) => `if (value === ${n}) return ${n};`).join("\n");
  return `export function ${name}(value) {\n${choices}\nreturn value;\n}\n`;
}

function nested(name, depth) {
  return `export function ${name}(value) { ${"if (value) {".repeat(depth)} return 1; ${"}".repeat(depth)} return 0; }\n`;
}

function assertComplexity(output, file) {
  // Require the actual rule diagnostic, not a path inside an ignored-file warning.
  assert.match(output, new RegExp(`${RegExp.escape(file)}\\n[^\\n]*\\bcomplexity\\b`));
}

async function freezeStructure(root) {
  const source = [
    'import { inspectStructure } from "./scripts/lint-structure.mjs";',
    'import { writeFileSync } from "node:fs";',
    "const { findings } = await inspectStructure();",
    'writeFileSync("eslint-structure-baseline.json", JSON.stringify({schema:2, functions:findings}));',
  ].join("\n");
  const result = execute(root, process.execPath, ["--input-type=module", "--eval", source]);
  assert.equal(result.status, 0, result.output);
}

test("function identities follow named, method, nested and anonymous owners, not their bodies", () => {
  const source = `
export function outer() { function inner() { return 1; } return inner(); }
export class Counter { read() { return 2; } }
export const assigned = () => 3;
invoke("stable title", () => 4, () => 5);
`;
  const identities = analyzeFunctions(source).functions.map(({ identity }) => identity);
  assert.equal(new Set(identities).size, identities.length);
  assert.ok(identities.some((id) => id.includes("function:outer") && id.includes("function:inner")));
  assert.ok(identities.some((id) => id.includes("class:Counter") && id.includes("property:read")));
  assert.ok(identities.some((id) => id.includes("variable:assigned")));
  assert.ok(identities.some((id) => id.includes("argument:1")));
  assert.ok(identities.some((id) => id.includes("argument:2")));
  const changed = source.replaceAll(/return (\d)/g, "return $1 + 10").replace("() => 4", "() => 40");
  assert.deepEqual(
    analyzeFunctions(changed).functions.map(({ identity }) => identity),
    identities
  );
  const preceded = 'invoke("different title", () => 0);\n' + source;
  assert.deepEqual(
    analyzeFunctions(preceded)
      .functions.slice(1)
      .map(({ identity }) => identity),
    identities
  );
});

test("a nested diagnostic belongs to the innermost function and duplicate names fail closed", () => {
  const source = "function outer() { function inner() { return 1; } return inner(); }";
  const parsed = analyzeFunctions(source);
  const owner = functionAt({ line: 1, column: source.indexOf("return 1") + 1 }, source, parsed);
  assert.ok(owner.identity.includes("function:inner"));
  assert.throws(() => analyzeFunctions("function same() {} function same() {}"), /Ambiguous function identity/);
});

test("reordered anonymous siblings report ambiguity instead of an ordinal function identity", () => {
  const first = "() => { return 101; }";
  const second = "() => { return 202; }";
  for (const [left, right] of [
    [first, second],
    [second, first],
  ]) {
    for (const source of [
      `invoke("same title", ${left}); invoke("same title", ${right});`,
      `const callbacks = [${left}, ${right}];`,
      `invoke("same title", () => { function named() { return 101; } }); invoke("same title", () => { function named() { return 202; } });`,
    ]) {
      const parsed = analyzeFunctions(source);
      const diagnostic = { line: 1, column: source.indexOf("return 101") + 1 };
      assert.equal(functionAt(diagnostic, source, parsed).ambiguous, true);
    }
  }
});

test("distinct callback names, owners and call titles remain unambiguous", () => {
  for (const source of [
    'invoke("same title", function first() { return 101; }); invoke("same title", function second() { return 202; });',
    'invoke("first title", () => { return 101; }); invoke("second title", () => { return 202; });',
    "const first = () => { return 101; }; const second = () => { return 202; };",
    "const callbacks = [function first() { return 101; }, function second() { return 202; }];",
  ]) {
    const parsed = analyzeFunctions(source);
    assert.equal(parsed.ambiguousIdentities.size, 0);
    assert.ok(functionAt({ line: 1, column: source.indexOf("return 101") + 1 }, source, parsed).identity);
  }
});

test("reordered anonymous sibling violations are marked ambiguous without changing frozen maxima", async (t) => {
  const root = await fixture(t);
  const large = branches("legacy", 25).replace("export function legacy", "function").trim();
  const small = "function(value) { return value; }";
  const original = `invoke("same title", ${large}); invoke("same title", ${small});`;
  await put(root, "src/callbacks.ts", original);
  await freezeStructure(root);
  const baseline = await readFile(join(root, "eslint-structure-baseline.json"), "utf8");
  assert.equal(tool(root, "lint-structure.mjs").status, 0);
  for (const [left, right] of [
    [small, large],
    [large.replace("return value;", "if (value === 100) return 100; return value;"), small],
  ]) {
    await put(root, "src/callbacks.ts", `invoke("same title", ${left}); invoke("same title", ${right});`);
    const result = tool(root, "lint-structure.mjs", "--prune");
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Ambiguous function identity/);
    assert.match(result.output, /can exchange ordinal identities when reordered/);
    assert.doesNotMatch(result.output, /\n\s+at /);
    assert.equal(await readFile(join(root, "eslint-structure-baseline.json"), "utf8"), baseline);
  }
});

test("legacy complexity can stay equal, cannot grow and must ratchet down after cleanup", async (t) => {
  const root = await fixture(t);
  await put(root, "src/legacy.ts", branches("legacy", 25));
  await freezeStructure(root);
  await put(root, "src/legacy.ts", branches("legacy", 25).replace("return value;", "return value + 1;"));
  assert.equal(tool(root, "lint-structure.mjs").status, 0);
  await put(root, "src/legacy.ts", branches("legacy", 26));
  const increased = tool(root, "lint-structure.mjs");
  assert.equal(increased.status, 1, increased.output);
  assert.match(increased.output, /frozen maximum 26, actual 27/);
  const before = await readFile(join(root, "eslint-structure-baseline.json"), "utf8");
  assert.equal(tool(root, "lint-structure.mjs", "--prune").status, 1);
  assert.equal(await readFile(join(root, "eslint-structure-baseline.json"), "utf8"), before);
  await put(root, "src/legacy.ts", branches("legacy", 24));
  const reduced = tool(root, "lint-structure.mjs");
  assert.equal(reduced.status, 1, reduced.output);
  assert.match(reduced.output, /outdated function maxima|obsolete entries/);
  assert.equal(tool(root, "lint-structure.mjs", "--prune").status, 0);
  const lowered = JSON.parse(await readFile(join(root, "eslint-structure-baseline.json"), "utf8"));
  assert.deepEqual(Object.values(lowered.functions), [25]);
  await put(root, "src/legacy.ts", branches("legacy", 24) + branches("differentFunction", 15));
  const added = tool(root, "lint-structure.mjs");
  assert.equal(added.status, 1, added.output);
  assert.match(added.output, /maximum 15, actual 16/);
});

test("depth has an independent frozen maximum and new functions stay within four levels", async (t) => {
  const root = await fixture(t);
  await put(root, "src/depth.ts", nested("legacy", 6));
  await freezeStructure(root);
  await put(root, "src/depth.ts", nested("legacy", 6).replace("return 1;", "return 2;"));
  assert.equal(tool(root, "lint-structure.mjs").status, 0);
  await put(root, "src/depth.ts", nested("legacy", 7));
  const increased = tool(root, "lint-structure.mjs");
  assert.equal(increased.status, 1, increased.output);
  assert.match(increased.output, /frozen maximum 6, actual 7/);
  await put(root, "src/depth.ts", nested("legacy", 5));
  assert.equal(tool(root, "lint-structure.mjs").status, 1);
  assert.equal(tool(root, "lint-structure.mjs", "--prune").status, 0);
  const lowered = JSON.parse(await readFile(join(root, "eslint-structure-baseline.json"), "utf8"));
  assert.deepEqual(Object.values(lowered.functions), [5]);
  await put(root, "src/new.ts", nested("newDepth", 4));
  assert.equal(tool(root, "lint-structure.mjs").status, 0);
  await put(root, "src/new.ts", nested("newDepth", 5));
  const added = tool(root, "lint-structure.mjs");
  assert.equal(added.status, 1, added.output);
  assert.match(added.output, /maximum 4, actual 5/);
  await rm(join(root, "src/new.ts"));
  const flatBranches = Array.from({ length: 15 }, (_, n) => `if (value === ${n}) return ${n};`).join("\n");
  await put(root, "src/depth.ts", nested("legacy", 5).replace("{", `{${flatBranches}`));
  const previouslyCompliant = tool(root, "lint-structure.mjs");
  assert.equal(previouslyCompliant.status, 1, previouslyCompliant.output);
  assert.match(previouslyCompliant.output, /maximum 15, actual 21/);
});

test("independent deep module statements cannot share an existing frozen depth", async (t) => {
  const root = await fixture(t);
  const deep = (name, depth) =>
    `let ${name} = true; ${`if (${name}) {`.repeat(depth)} ${name} = false; ${"}".repeat(depth)}\n`;
  const original = deep("original", 5);
  await put(root, "src/module-depth.ts", original);
  await freezeStructure(root);
  const baseline = await readFile(join(root, "eslint-structure-baseline.json"), "utf8");
  assert.equal(JSON.parse(baseline).functions[JSON.stringify(["src/module-depth.ts", "module", "max-depth"])], 5);
  assert.equal(tool(root, "lint-structure.mjs").status, 0);
  for (const source of [original + deep("added", 5), deep("added", 5) + original]) {
    await put(root, "src/module-depth.ts", source);
    const added = tool(root, "lint-structure.mjs");
    assert.equal(added.status, 1, added.output);
    assert.match(added.output, /independent module statements|separate module statements/);
    assert.equal(tool(root, "lint-structure.mjs", "--prune").status, 1);
    assert.equal(await readFile(join(root, "eslint-structure-baseline.json"), "utf8"), baseline);
  }
  await put(root, "src/module-depth.ts", original + deep("shallow", 4));
  assert.equal(tool(root, "lint-structure.mjs").status, 0);
  await put(root, "src/module-depth.ts", deep("original", 6));
  const deeper = tool(root, "lint-structure.mjs");
  assert.equal(deeper.status, 1, deeper.output);
  assert.match(deeper.output, /frozen maximum 5, actual 6/);
});

test("the root rules cover every JS/TS extension and arbitrary code directories", async (t) => {
  const root = await fixture(t);
  const extensions = ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "MJS", "Ts", "CTS"];
  for (const [index, ext] of extensions.entries()) {
    const lower = ext.toLowerCase();
    let source = branches(`oversized_${ext}`, 15).replace("export ", "");
    if (["jsx", "tsx"].includes(lower)) source = source.replace("return value;", "return <span>{value}</span>;");
    if (["tsx", "cts", "ts"].includes(lower)) source = source.replace("(value)", "(value: number)");
    source += ["cjs", "cts"].includes(lower) ? `module.exports = oversized_${ext};\n` : `oversized_${ext}(0);\n`;
    await put(root, `outside/${index}/over-limit.${ext}`, source);
  }
  const result = tool(root, "lint-structure.mjs");
  assert.equal(result.status, 1, result.output);
  for (const [index, ext] of extensions.entries()) {
    assertComplexity(result.output, `outside/${index}/over-limit.${ext}`);
  }
  assert.doesNotMatch(result.output, /no matching configuration/);
  assert.doesNotMatch(result.output, /Parsing error/);
});

test("an ignore glob cannot silently remove a discovered code file", async (t) => {
  const root = await fixture(t);
  const scope = join(root, "scripts/lint-scope.mjs");
  const source = await readFile(scope, "utf8");
  await writeFile(
    scope,
    source.replace("export const codeIgnores = [", 'export const codeIgnores = ["**/glob-hidden.*",')
  );
  await put(root, "outside/glob-hidden.ts", branches("mustNotDisappear", 15));
  const result = tool(root, "lint-structure.mjs");
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /File ignored/);
  assert.match(result.output, /configure coverage/);
});

test("structure checks use repository-root identities when invoked from a subfolder", async (t) => {
  const root = await fixture(t);
  await put(root, "packages/core/src/legacy.ts", branches("legacyFromSubfolder", 25));
  await freezeStructure(root);
  const script = join(root, "scripts/lint-structure.mjs");
  const same = execute(join(root, "packages/core"), process.execPath, [script]);
  assert.equal(same.status, 0, same.output);
  await put(root, "packages/core/src/legacy.ts", branches("legacyFromSubfolder", 26));
  const increased = execute(join(root, "packages/core"), process.execPath, [script]);
  assert.equal(increased.status, 1, increased.output);
  assert.match(increased.output, /packages\/core\/src\/legacy\.ts/);
  assert.match(increased.output, /frozen maximum 26, actual 27/);
});

test("an explicitly requested unconfigured file is an error rather than an ignored warning", async (t) => {
  const root = await fixture(t);
  await put(root, "outside/unsupported.custom", branches("hidden", 15));
  const result = tool(root, "lint-structure.mjs", "outside/unsupported.custom");
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Unsupported source type|configure coverage|no matching configuration/);
});

test("generic generated-looking folder names cannot hide tracked application code", async (t) => {
  const root = await fixture(t);
  await put(root, ".gitignore", "node_modules/\nbuild/\ncoverage/\nvendor/\ngoldset/\n");
  for (const folder of ["build", "coverage", "vendor", "goldset"]) {
    await put(root, `${folder}/new.ts`, branches(`application_${folder}`, 15));
    assert.equal(execute(root, "git", ["add", "--force", `${folder}/new.ts`]).status, 0);
  }
  const result = tool(root, "lint-structure.mjs");
  assert.equal(result.status, 1, result.output);
  for (const folder of ["build", "coverage", "vendor", "goldset"]) {
    assertComplexity(result.output, `${folder}/new.ts`);
  }
});

test("only hidden root directories are excluded from every code check", async (t) => {
  const root = await fixture(t);
  for (const folder of [".claude-run", ".codex-run", ".github"]) {
    await put(root, `${folder}/eslint.config.mjs`, 'export default [{ rules: { complexity: "off" } }];');
    await put(root, `${folder}/source.ts`, branches("hidden", 25));
    await put(root, `${folder}/a.ts`, 'import "./b.js"; export const a = 1;');
    await put(root, `${folder}/b.ts`, 'import "./a.js"; export const b = 1;');
    assert.equal(isCodeIgnored(`${folder}/source.ts`), true);
    assert.ok(cycleIgnorePatterns.some((pattern) => new RegExp(pattern).test(`${folder}/source.ts`)));
  }
  const hidden = tool(root, "lint-structure.mjs");
  assert.equal(hidden.status, 0, hidden.output);
  const cycles = tool(root, "check-cycles.mjs", "--report");
  assert.equal(cycles.status, 0, cycles.output);
  assert.deepEqual(JSON.parse(cycles.stdout), []);
  const clones = tool(root, "check-clones.mjs");
  assert.equal(clones.status, 0, clones.output);
  for (const file of ["probe.mjs", "plugins/x.mjs", ".root-file.mjs", "packages/.hidden/source.ts"]) {
    await put(root, file, branches("mustBeChecked", 15));
    assert.equal(isCodeIgnored(file), false);
    assert.equal(
      cycleIgnorePatterns.some((pattern) => new RegExp(pattern).test(file)),
      false
    );
  }
  const visible = tool(root, "lint-structure.mjs");
  assert.equal(visible.status, 1, visible.output);
  for (const file of ["probe.mjs", "plugins/x.mjs", ".root-file.mjs", "packages/.hidden/source.ts"]) {
    assertComplexity(visible.output, file);
  }
  await put(root, "probe.mjs", 'import "./.root-file.mjs";\n' + branches("visibleClone", 60));
  await put(root, ".root-file.mjs", 'import "./probe.mjs";\n' + branches("visibleClone", 60));
  const visibleCycles = tool(root, "check-cycles.mjs", "--report");
  assert.equal(visibleCycles.status, 0, visibleCycles.output);
  assert.equal(JSON.parse(visibleCycles.stdout).length, 2);
  const visibleClones = tool(root, "check-clones.mjs");
  assert.equal(visibleClones.status, 1, visibleClones.output);
  assert.match(visibleClones.output, /New copied code/);
  assert.match(visibleClones.output, /\.root-file\.mjs/);
  assert.match(visibleClones.output, /probe\.mjs/);
});

test("a nested eslint.config cannot disable the root limits", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    "packages/core/src/nested/eslint.config.mjs",
    'export default [{rules:{complexity:"off","max-depth":"off"}}];'
  );
  await put(root, "packages/core/src/nested/bypass.ts", branches("bypass", 15));
  const result = tool(root, "lint-structure.mjs");
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /eslint\.config\.mjs/);
  assert.match(result.output, /root|additional|nested|single/i);
});

test("ambiguous function names fail with an actionable message instead of a stack trace", async (t) => {
  const root = await fixture(t);
  await put(root, "src/duplicate.ts", branches("same", 15) + branches("same", 0));
  const result = tool(root, "lint-structure.mjs");
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Ambiguous function identity/);
  assert.doesNotMatch(result.output, /\n\s+at /);
});

test("the structure CLI runs when invoked through a directory alias", async (t) => {
  const root = await fixture(t);
  await put(root, "packages/core/src/alias-target.ts", branches("mustActuallyRun", 15));
  await symlink(join(root, "scripts"), join(root, "scripts-alias"), process.platform === "win32" ? "junction" : "dir");
  const result = execute(root, process.execPath, [join(root, "scripts-alias", "lint-structure.mjs")]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /mustActuallyRun/);
  assert.match(result.output, /maximum 15, actual 16/);
});

async function commitBaselines(root) {
  assert.equal(
    execute(root, "git", ["add", "eslint-structure-baseline.json", ".lint-cycle-baseline.json", "clone-baseline.json"])
      .status,
    0
  );
  const result = execute(root, "git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=.git/hooks",
    "commit",
    "-qm",
    "Freeze fixture budgets",
  ]);
  assert.equal(result.status, 0, result.output);
}

test("the Git guard refuses new or increased function, cycle and clone exceptions", async (t) => {
  const root = await fixture(t);
  const structural = { schema: 2, functions: { legacy: 26 } };
  const cycles = [
    ["a.ts", "b.ts"],
    ["b.ts", "a.ts"],
  ];
  const clones = { version: 1, production: { fingerprints: { existing: 2 } }, tests: { fingerprints: { test: 1 } } };
  await put(root, "eslint-structure-baseline.json", structural);
  await put(root, ".lint-cycle-baseline.json", cycles);
  await put(root, "clone-baseline.json", clones);
  await commitBaselines(root);
  assert.equal(tool(root, "check-lint-baselines.mjs").status, 0);
  for (const [file, enlarged, original] of [
    ["eslint-structure-baseline.json", { schema: 2, functions: { legacy: 27 } }, structural],
    ["eslint-structure-baseline.json", { schema: 2, functions: { legacy: 26, newFunction: 16 } }, structural],
    [".lint-cycle-baseline.json", [...cycles, ["new.ts", "a.ts"]], cycles],
    ["clone-baseline.json", { ...clones, production: { fingerprints: { existing: 3 } } }, clones],
    ["clone-baseline.json", { ...clones, tests: { fingerprints: { test: 1, newClone: 1 } } }, clones],
  ]) {
    await put(root, file, enlarged);
    const result = tool(root, "check-lint-baselines.mjs");
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /new\/increased exceptions|may only shrink/);
    await put(root, file, original);
  }
  await put(root, "eslint-structure-baseline.json", { schema: 2, functions: { legacy: 25 } });
  await put(root, ".lint-cycle-baseline.json", cycles.slice(0, 1));
  await put(root, "clone-baseline.json", { ...clones, production: { fingerprints: { existing: 1 } } });
  assert.equal(tool(root, "check-lint-baselines.mjs").status, 0);
  const unknown = execute(root, process.execPath, ["scripts/check-lint-baselines.mjs"], {
    LINT_BASE_REF: "missing-fixture-base",
  });
  assert.equal(unknown.status, 1, unknown.output);
  assert.match(unknown.output, /baseline|basis|base|revision/i);
  assert.doesNotMatch(unknown.output, /\n\s+at /);
});

test("cycle exceptions shrink and workspace package names resolve to source", async (t) => {
  const root = await fixture(t);
  for (const workspace of ["daemon", "eval", "statusline"]) {
    await put(
      root,
      `packages/${workspace}/src/index.ts`,
      'import { peer } from "./peer.js"; export const value = () => peer;'
    );
    await put(
      root,
      `packages/${workspace}/src/peer.ts`,
      `import { value } from "@bastra-recall/${workspace}${workspace === "statusline" ? "/dist/index.js" : ""}"; export const peer = () => value;`
    );
  }
  const report = tool(root, "check-cycles.mjs", "--report");
  assert.equal(report.status, 0, report.output);
  const edges = JSON.parse(report.stdout);
  assert.equal(edges.length, 6, report.output);
  await put(root, ".lint-cycle-baseline.json", edges);
  assert.equal(tool(root, "check-cycles.mjs").status, 0);
  await put(root, "packages/core/src/index.ts", 'import "./loop.js"; export const core = 1;');
  await put(root, "packages/core/src/loop.ts", 'import { core } from "./index.js"; export const peer = core;');
  const grown = tool(root, "check-cycles.mjs", "--prune");
  assert.equal(grown.status, 1, grown.output);
  assert.match(grown.output, /New static import cycle/);
  assert.deepEqual(JSON.parse(await readFile(join(root, ".lint-cycle-baseline.json"), "utf8")), edges);
  await put(root, "packages/core/src/index.ts", "export {};\n");
  await put(root, "packages/core/src/loop.ts", "export {};\n");
  await put(root, "packages/eval/src/peer.ts", "export const peer = 1;\n");
  const stale = tool(root, "check-cycles.mjs");
  assert.equal(stale.status, 1, stale.output);
  assert.match(stale.output, /obsolete edges/);
  assert.equal(tool(root, "check-cycles.mjs", "--prune").status, 0);
  assert.equal(JSON.parse(await readFile(join(root, ".lint-cycle-baseline.json"), "utf8")).length, 4);
  await rm(join(root, "packages/eval/src/index.ts"));
  await put(root, "outside/invalid-workspace.ts", 'import "@bastra-recall/eval"; export const loaded = true;\n');
  const unresolved = tool(root, "check-cycles.mjs", "--report");
  assert.equal(unresolved.status, 1, unresolved.output);
  assert.match(unresolved.output, /Workspace imports must resolve to real source entry points/);
  assert.match(unresolved.output, /@bastra-recall\/eval/);
});

async function freezeClones(root) {
  const snapshot = { version: 1 };
  for (const group of ["production", "tests"]) {
    const file = `${group}-native-baseline.json`;
    const result = execute(root, join(root, "node_modules", ".bin", "jscpd"), [
      "--config",
      ".jscpd.json",
      "--workers",
      "1",
      "--baseline",
      file,
      "--update-baseline",
      "--silent",
      "--no-colors",
      "--min-lines",
      group === "tests" ? "40" : "20",
      "--min-tokens",
      group === "tests" ? "300" : "150",
    ]);
    assert.equal(result.status, 0, result.output);
    snapshot[group] = JSON.parse(await readFile(join(root, file), "utf8"));
  }
  await put(root, "clone-baseline.json", snapshot);
}

test("clone exceptions count repeated content and prune only after copies disappear", async (t) => {
  const root = await fixture(t);
  const body = Array.from({ length: 90 }, (_, n) => `value += ${n};`).join("\n");
  const source = `function repeated(value) {\n${body}\nreturn value;\n}\nmodule.exports = repeated;\n`;
  await put(root, "outside/first.cjs", source);
  await put(root, "outside/second.cts", source);
  await freezeClones(root);
  const frozen = JSON.parse(await readFile(join(root, "clone-baseline.json"), "utf8"));
  assert.ok(Object.keys(frozen.production.fingerprints).length > 0, "CommonJS/CTS copies must be scanned");
  assert.ok(Object.keys(frozen.tests.fingerprints).length > 0, "the larger threshold must still detect this fixture");
  assert.equal(tool(root, "check-clones.mjs").status, 0);
  const before = await readFile(join(root, "clone-baseline.json"), "utf8");
  await put(root, "outside/third.tsx", source);
  const grown = tool(root, "check-clones.mjs", "--prune");
  assert.equal(grown.status, 1, grown.output);
  assert.match(grown.output, /New copied code/);
  assert.equal(await readFile(join(root, "clone-baseline.json"), "utf8"), before);
  await rm(join(root, "outside/third.tsx"));
  await rm(join(root, "outside/second.cts"));
  const stale = tool(root, "check-clones.mjs");
  assert.equal(stale.status, 1, stale.output);
  assert.match(stale.output, /Removed copied code/);
  assert.equal(tool(root, "check-clones.mjs", "--prune").status, 0);
  const lowered = JSON.parse(await readFile(join(root, "clone-baseline.json"), "utf8"));
  assert.deepEqual(lowered.production.fingerprints, {});
  assert.deepEqual(lowered.tests.fingerprints, {});
});

async function uiRenameFixture(t) {
  const root = await fixture(t);
  const oldFile = "packages/daemon/webui/v22/js/legacy.js";
  const newFile = oldFile.replace("webui/v22/", "webui/app/");
  const literals = 'export const literals = ["original", /original/i, `original ${42}`];\n';
  await put(root, oldFile, branches("legacy", 25) + literals);
  await put(root, "tools/probes/v22-memory-browser.mjs", 'export const prefix = "v22-mb-probe-";');
  for (const file of [".jscpd.json", "scripts/lint-scope.mjs"]) {
    await put(root, file, (await readFile(join(root, file), "utf8")).replaceAll("webui/app/", "webui/v22/"));
  }
  await freezeStructure(root);
  assert.equal(execute(root, "git", ["add", "."]).status, 0);
  await commitBaselines(root);
  for (const [before, after] of [
    ["packages/daemon/webui/v22", "packages/daemon/webui/app"],
    ["tools/probes/v22-memory-browser.mjs", "tools/probes/webui-memory-browser.mjs"],
  ])
    assert.equal(execute(root, "git", ["mv", before, after]).status, 0);
  for (const file of ["eslint-structure-baseline.json", ".jscpd.json", "scripts/lint-scope.mjs"]) {
    await put(root, file, (await readFile(join(root, file), "utf8")).replaceAll("webui/v22/", "webui/app/"));
  }
  await put(root, newFile, "// renamed UI\n" + branches("legacy", 25) + literals);
  await put(root, "tools/probes/webui-memory-browser.mjs", 'export const prefix = "webui-mb-probe-";');
  return { root, newFile };
}

test("UI rename proves the complete file mapping and unchanged code before carrying exact maxima", async (t) => {
  const { root, newFile } = await uiRenameFixture(t);
  assert.equal(tool(root, "check-lint-baselines.mjs").status, 0);
  await put(root, newFile, branches("legacy", 26));
  assert.equal(tool(root, "check-lint-baselines.mjs").status, 1);
  assert.equal(tool(root, "lint-structure.mjs", newFile).status, 1);
  await put(root, newFile, branches("replacement", 25));
  assert.equal(tool(root, "check-lint-baselines.mjs").status, 1);
  await put(root, newFile, branches("legacy", 25));
  await put(root, "packages/daemon/webui/app/js/extra.js", "export const added = true;");
  assert.equal(tool(root, "check-lint-baselines.mjs").status, 1);
});

test("UI rename never permits increased budgets or extra vendor exclusions", async (t) => {
  const { root } = await uiRenameFixture(t);
  const baseline = await readFile(join(root, "eslint-structure-baseline.json"), "utf8");
  const expanded = JSON.parse(baseline);
  const key = Object.keys(expanded.functions)[0];
  expanded.functions[key] += 1;
  await put(root, "eslint-structure-baseline.json", expanded);
  assert.equal(tool(root, "check-lint-baselines.mjs").status, 1);
  await put(root, "eslint-structure-baseline.json", baseline);
  const config = JSON.parse(await readFile(join(root, ".jscpd.json"), "utf8"));
  config.ignore.push("packages/daemon/webui/app/js/**");
  await put(root, ".jscpd.json", config);
  assert.equal(tool(root, "check-lint-baselines.mjs").status, 1);
});

test("committed UI rename proof survives later refactoring while new functions remain bounded", async (t) => {
  const { root, newFile } = await uiRenameFixture(t);
  const base = execute(root, "git", ["rev-parse", "HEAD"]).stdout.trim();
  assert.equal(execute(root, "git", ["add", "."]).status, 0);
  await commitBaselines(root);
  await put(root, newFile, branches("legacy", 25) + branches("newFunction", 15));
  const guard = execute(root, process.execPath, ["scripts/check-lint-baselines.mjs"], { LINT_BASE_REF: base });
  assert.equal(guard.status, 0, guard.output);
  const structure = tool(root, "lint-structure.mjs", newFile);
  assert.equal(structure.status, 1, structure.output);
  assert.match(structure.output, /maximum 15, actual 16/);
  const snapshot = JSON.parse(await readFile(join(root, "eslint-structure-baseline.json"), "utf8"));
  snapshot.functions[JSON.stringify([newFile, '["function:newFunction"]', "complexity"])] = 16;
  await put(root, "eslint-structure-baseline.json", snapshot);
  const expanded = execute(root, process.execPath, ["scripts/check-lint-baselines.mjs"], { LINT_BASE_REF: base });
  assert.equal(expanded.status, 1, expanded.output);
});

test("UI rename proof preserves string, regexp and template literal contents", async (t) => {
  const { root, newFile } = await uiRenameFixture(t);
  // Literal changes must never disappear in executable-code normalization.
  const original = await readFile(join(root, newFile), "utf8");
  for (const literal of ['"original"', "/original/i", "`original ${42}`"]) {
    await put(root, newFile, original.replace(literal, literal.replace("original", "changed")));
    const result = tool(root, "check-lint-baselines.mjs");
    assert.equal(result.status, 1, result.output);
  }
});
