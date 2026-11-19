import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertKnipDownward,
  digest,
  KNIP_CATEGORIES,
  KNIP_VERSION,
  parseKnipReport,
  validateKnipBaseline,
} from "../../scripts/lint-knip-findings.mjs";
import {
  assertKnipBudget,
  assertKnipLock,
  assertKnipWorkflow,
  KNIP_SCRIPT,
  knipPackageAllowed,
  verifyKnipContract,
} from "../../scripts/lint-knip-contract.mjs";
import { checkKnip, runKnip } from "../../scripts/lint-knip.mjs";
import { dropCallerGitEnv } from "../../scripts/caller-git-env.mjs";

// #1669: started without test-env.mjs, this file's git must still not reach a caller's GIT_DIR/GIT_WORK_TREE.
dropCallerGitEnv();

const repository = fileURLToPath(new URL("../../", import.meta.url));
const config = { workspaces: { ".": { entry: ["index.ts"], project: ["**/*.ts"] } } };
const source = "a".repeat(40);
const workflow = `jobs:
  build-and-test:
    name: build + test (node \${{ matrix.node }})
    steps:
      - name: Build
        run: npm run build
      - name: Unused code (Knip, shrinking baseline)
        env:
          LINT_BASE_REF: \${{ steps.lint-baseline.outputs.sha }}
        run: npm run lint:knip
`;
const metadata = { scripts: { "lint:knip": KNIP_SCRIPT }, devDependencies: { knip: KNIP_VERSION } };
const lock = {
  packages: {
    "": { devDependencies: { knip: KNIP_VERSION } },
    "node_modules/knip": {
      version: KNIP_VERSION,
      integrity: "sha512-fixture",
      resolved: "https://registry.npmjs.org/knip/-/knip-6.45.1.tgz",
    },
  },
};

function row(file = "src/old.ts", category = "exports", issues = [{ name: "old", line: 2 }]) {
  return { file, ...Object.fromEntries(KNIP_CATEGORIES.map((key) => [key, []])), [category]: issues };
}

function findings(...rows) {
  return parseKnipReport({ issues: rows });
}

function baseline(fingerprints = findings(row())) {
  return {
    schema: 1,
    toolVersion: KNIP_VERSION,
    configDigest: digest(config),
    categories: KNIP_CATEGORIES,
    source,
    fingerprints,
  };
}

function put(root, file, value) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), typeof value === "string" ? value : JSON.stringify(value));
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bastra-knip-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function history(t) {
  const root = fixture(t);
  for (const file of [
    "check-lint-baselines.mjs",
    "lint-config-ratchet.mjs",
    "lint-knip-contract.mjs",
    "lint-knip-findings.mjs",
  ]) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(join(repository, "scripts", file), join(root, "scripts", file));
  }
  for (const [file, value] of Object.entries({
    "knip.json": config,
    "knip-baseline.json": baseline(),
    "package.json": metadata,
    "package-lock.json": lock,
    ".github/workflows/ci.yml": workflow,
    "eslint-structure-baseline.json": {},
    "clone-baseline.json": {},
    ".lint-cycle-baseline.json": [],
    ".gitignore": "node_modules/\n",
  }))
    put(root, file, value);
  symlinkSync(
    join(repository, "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "trusted");
  return root;
}

function guard(root) {
  const result = spawnSync(process.execPath, ["scripts/check-lint-baselines.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, GITHUB_ACTIONS: "true", LINT_BASE_REF: "HEAD" },
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("all issue categories survive the strict JSON reporter parser", () => {
  for (const category of KNIP_CATEGORIES) {
    const grouped = ["duplicates", "cycles"].includes(category);
    const issue = { name: category === "files" ? "src/a.ts" : `candidate-${category}` };
    const actual = findings(row("src/a.ts", category, [grouped ? [issue, { name: "other" }] : issue]));
    assert.equal(Object.keys(actual).length, 1, category);
    assert.equal(JSON.parse(Object.keys(actual)[0])[0], category);
    assert.equal(Object.values(actual)[0], 1);
  }
});

test("empty issues is valid; missing payload, categories and unknown categories fail closed", () => {
  assert.deepEqual(findings(), {});
  assert.throws(() => parseKnipReport({}), /issues/);
  assert.throws(() => parseKnipReport({ issues: {}, files: [] }), /unknown/);
  const missing = row();
  delete missing.catalogReferences;
  assert.throws(() => findings(missing), /catalogReferences/);
  assert.throws(() => findings({ ...row(), surprise: [] }), /unknown/);
  assert.throws(() => findings({ ...row(), exports: {} }), /exports/);
  assert.throws(() => findings(row("src/a.ts", "exports", [{ line: 2 }])), /name/);
  assert.throws(() => findings(row("src/a.ts", "cycles", [[]])), /group/);
});

test("identity ignores line shifts and normalizes separators, but retains file/category/namespace", () => {
  const a = findings(row("src/a.ts", "exports", [{ name: "same", namespace: "A", line: 1 }]));
  const shifted = findings(row(".\\src\\a.ts", "exports", [{ name: "same", namespace: "A", line: 100 }]));
  assert.deepEqual(a, shifted);
  for (const different of [
    row("src/b.ts", "exports", [{ name: "same", namespace: "A" }]),
    row("src/a.ts", "types", [{ name: "same", namespace: "A" }]),
    row("src/a.ts", "exports", [{ name: "same", namespace: "B" }]),
  ])
    assert.throws(() => assertKnipDownward(a, findings(different)), /new\/increased/);
  const group = [{ name: "one" }, { name: "two" }];
  assert.deepEqual(
    findings(row("a.ts", "duplicates", [group])),
    findings(row("a.ts", "duplicates", [[...group].reverse()]))
  );
});

test("outside paths and mismatched file issue identities fail closed", () => {
  for (const path of ["../a.ts", "src/../../a.ts", "/a.ts", "C:\\a.ts", ".", "a\0b.ts"]) {
    assert.throws(() => findings(row(path)), /path|outside|empty/);
  }
  assert.throws(() => findings(row("a.ts", "files", [{ name: "b.ts" }])), /match/);
});

test("replacing one old finding with a new one cannot spend freed debt", () => {
  const old = findings(row());
  const replacement = findings(row("src/new.ts", "exports", [{ name: "new" }]));
  assert.throws(() => assertKnipDownward(old, replacement), /new\/increased/);
  assert.doesNotThrow(() => assertKnipDownward(old, {}));
  assert.doesNotThrow(() => assertKnipDownward(old, old));
});

test("repeated identical keys are a multiset, so a second identical declaration fails", () => {
  const old = findings(row());
  const repeated = findings(row(), row());
  assert.equal(Object.values(repeated)[0], 2);
  assert.throws(() => assertKnipDownward(old, repeated), /new\/increased/);
});

test("baseline validates scope/schema/version/config before comparing budgets", () => {
  for (const changed of [
    { schema: 2 },
    { toolVersion: "6.45.2" },
    { configDigest: "0".repeat(64) },
    { categories: KNIP_CATEGORIES.slice(1) },
    { source: "unknown" },
    { fingerprints: { nonsense: 1 } },
    { fingerprints: { [Object.keys(baseline().fingerprints)[0]]: -1 } },
  ])
    assert.throws(() => validateKnipBaseline({ ...baseline(), ...changed }, config));
  assert.deepEqual(validateKnipBaseline(baseline(), config), baseline().fingerprints);
});

test("bootstrap is exact and closed until a final reviewed inventory exists", () => {
  const candidate = baseline();
  assert.throws(() => assertKnipBudget(candidate, config, null, null), /fresh inventory/);
  const approved = { source, configDigest: digest(config), fingerprintsDigest: digest(candidate.fingerprints) };
  assert.doesNotThrow(() => assertKnipBudget(candidate, config, null, null, approved));
  assert.throws(() => assertKnipBudget(baseline(findings(row(), row())), config, null, null, approved), /bootstrap/);
  assert.throws(
    () => assertKnipBudget({ ...candidate, source: "b".repeat(40) }, config, null, null, approved),
    /bootstrap/
  );
});

test("trusted guard rejects matching code/baseline inflation; lowering both is allowed", (t) => {
  const root = history(t);
  assert.equal(guard(root).status, 0);
  const newActual = findings(row(), row("new.ts", "types", [{ name: "newType" }]));
  put(root, "new.ts", "export type newType = string;\n");
  put(root, "knip-baseline.json", baseline(newActual));
  const result = guard(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /new\/increased/);
  put(root, "knip-baseline.json", baseline({}));
  assert.equal(guard(root).status, 0);
});

test("missing/deleted baseline cannot re-enter bootstrap against a trusted baseline", (t) => {
  const root = history(t);
  rmSync(join(root, "knip-baseline.json"));
  const result = guard(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Knip contract failed/);
});

test("config entries/exclusions/project narrowing and bootstrap rewrites cannot weaken the guard", (t) => {
  const root = history(t);
  for (const next of [
    { ...config, ignore: ["**/*"] },
    { workspaces: { ".": { entry: ["**/*.ts"], project: ["**/*.ts"] } } },
    { workspaces: { ".": { entry: ["index.ts"], project: ["index.ts"] } } },
  ]) {
    put(root, "knip.json", next);
    put(root, "knip-baseline.json", { ...baseline(), configDigest: digest(next) });
    const result = guard(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /configuration change/);
  }
  put(root, "knip.json", config);
  put(root, "knip-baseline.json", baseline());
  put(
    root,
    "scripts/lint-knip-contract.mjs",
    readFileSync(join(root, "scripts/lint-knip-contract.mjs"), "utf8") + "\n// changed\n"
  );
  assert.match(guard(root).output, /bootstrap\/contract changes/);
});

test("workflow contract rejects skips, optional execution, different commands and order", () => {
  assert.doesNotThrow(() => assertKnipWorkflow(workflow));
  for (const changed of [
    workflow.replace("        env:", "        if: false\n        env:"),
    workflow.replace("        env:", "        continue-on-error: true\n        env:"),
    workflow.replace("run: npm run lint:knip", "run: npm run lint:knip || true"),
    workflow.replace("run: npm run lint:knip", "run: echo skipped"),
    workflow.replace("run: npm run build", "run: echo skipped"),
    workflow.replace("    name:", "    if: false\n    name:"),
    workflow.replace("LINT_BASE_REF:", "UNTRUSTED_REF:"),
  ])
    assert.throws(() => assertKnipWorkflow(changed), /Knip|mandatory/);
});

test("package and lock contracts reject script/version/integrity weakening", () => {
  const json = JSON.stringify;
  assert.ok(knipPackageAllowed(json(metadata), json(metadata)));
  assert.ok(!knipPackageAllowed(json(metadata), json({ ...metadata, scripts: { "lint:knip": "echo skipped" } })));
  assert.ok(!knipPackageAllowed(json(metadata), json({ ...metadata, devDependencies: { knip: "^6.45.1" } })));
  assert.doesNotThrow(() => assertKnipLock(lock));
  assert.throws(
    () => assertKnipLock({ packages: { ...lock.packages, "node_modules/knip": { version: KNIP_VERSION } } }),
    /integrity/
  );
});

test("contract remains inactive in genuinely older minimal fixture repositories", () => {
  assert.doesNotThrow(() =>
    verifyKnipContract(
      () => "{}",
      () => null
    )
  );
});

test("tool/config failures and timeouts never become an empty successful inventory", (t) => {
  const root = fixture(t);
  put(root, "node_modules/knip/package.json", { version: KNIP_VERSION });
  for (const result of [
    { status: 2, stderr: "invalid configuration\n" },
    { status: null, signal: "SIGTERM" },
    { status: null, error: new Error("ETIMEDOUT") },
    { status: 0, stdout: "", stderr: "" },
  ])
    assert.throws(() => runKnip(root, () => result), /Knip failed|required JSON report/);
});

function fakeTool(report) {
  return (_program, args) => {
    const file = args[args.indexOf("--output-file") + 1].slice("json=".length);
    assert.equal(args[args.indexOf("--include") + 1], KNIP_CATEGORIES.join(","));
    writeFileSync(file, typeof report === "string" ? report : JSON.stringify(report));
    return { status: 0, stdout: "", stderr: "" };
  };
}

test("mandatory checker rejects actual new unused code and accepts reduced current debt", (t) => {
  const root = fixture(t);
  put(root, "knip.json", config);
  put(root, "knip-baseline.json", baseline());
  put(root, "node_modules/knip/package.json", { version: KNIP_VERSION });
  const actual = { issues: [row(), row("new.ts", "types", [{ name: "brandNew" }])] };
  assert.throws(() => checkKnip(root, fakeTool(actual)), /new\/increased/);
  assert.doesNotThrow(() => checkKnip(root, fakeTool({ issues: [] })));
  assert.throws(() => checkKnip(root, fakeTool("not JSON")), SyntaxError);
  const missing = row();
  delete missing.unresolved;
  assert.throws(() => checkKnip(root, fakeTool({ issues: [missing] })), /unresolved/);
});

test("installed Knip catches a replacement unused file and rejects invalid configuration", (t) => {
  const root = fixture(t);
  put(root, "package.json", { name: "knip-regression", private: true, type: "module" });
  put(root, ".gitignore", "node_modules/\n");
  put(root, "knip.json", { entry: ["index.js"], project: ["*.js"] });
  put(root, "index.js", "console.log('entry');\n");
  put(root, "old.js", "export const old = 1;\n");
  mkdirSync(join(root, "node_modules"));
  symlinkSync(join(repository, "node_modules/knip"), join(root, "node_modules/knip"), "dir");
  const original = runKnip(root);
  assert.equal(original[JSON.stringify(["files", "old.js", "old.js"])], 1);
  put(root, "knip-baseline.json", {
    ...baseline(original),
    configDigest: digest(JSON.parse(readFileSync(join(root, "knip.json"), "utf8"))),
  });
  rmSync(join(root, "old.js"));
  put(root, "new.js", "export const fresh = 1;\n");
  assert.throws(() => checkKnip(root), /new\/increased/);
  rmSync(join(root, "new.js"));
  assert.doesNotThrow(() => checkKnip(root));
  put(root, "knip.json", { workspaces: 42 });
  assert.throws(() => runKnip(root), /Knip failed \(2\)/);
});
