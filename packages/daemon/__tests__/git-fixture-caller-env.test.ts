/**
 * A git test file started on its own, without `scripts/test-env.mjs` (#1669).
 *
 * test-env drops a caller's GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE (#1668), but
 * only in processes that load it. `node --import tsx --test <file>` does not,
 * and git-archive.test.ts then ran its fixtures' git — `reset --hard` among
 * them — against the caller's repository. Every git test file now drops them
 * itself (`scripts/caller-git-env.mjs`). The caller here is a freshly created
 * decoy repository, compared byte for byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
// @ts-expect-error — plain .mjs script, no declarations
import { dropCallerGitEnv } from "../../../scripts/caller-git-env.mjs";

// #1669: started without test-env.mjs, this file's git must still not reach a caller's GIT_DIR/GIT_WORK_TREE.
dropCallerGitEnv();

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Every file of the tree, path and bytes — `.git` included. */
function fingerprint(dir: string): string {
  const hash = createHash("sha256");
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const child = join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else
        hash
          .update(`${child}\0`)
          .update(readFileSync(join(dir, child)))
          .update("\0");
    }
  };
  walk("");
  return hash.digest("hex");
}

test("a git test file run without test-env leaves the caller's repository byte-identical (#1669)", () => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "git-decoy-")));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=d", "-c", "user.email=d@example.invalid", ...args], {
        cwd: decoy,
        stdio: "ignore",
      });
    git("init", "-q");
    writeFileSync(join(decoy, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-qm", "decoy");
    writeFileSync(join(decoy, "a.txt"), "one\nuncommitted\n");
    const before = fingerprint(decoy);

    // This process's environment (run home, temp root) minus test-env itself:
    // no `--import scripts/test-env.mjs`, and the caller's git variables on top.
    const { NODE_TEST_CONTEXT: _child, ...env } = process.env;
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "--test", "--test-concurrency=1", "packages/daemon/__tests__/git-archive.test.ts"],
      {
        cwd: REPO,
        encoding: "utf8",
        timeout: 300_000,
        env: {
          ...env,
          GIT_DIR: join(decoy, ".git"),
          GIT_WORK_TREE: decoy,
          GIT_INDEX_FILE: join(decoy, ".git", "index"),
        },
      }
    );

    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-4000));
    assert.equal(fingerprint(decoy), before, "the caller's repository is byte-identical");
  } finally {
    rmSync(decoy, { recursive: true, force: true });
  }
});

/**
 * A git the file's own code starts: a literal "git" handed to a process
 * starter, passed on as a command argument (`run("git", [...])`,
 * `execute(root, "git", args)`), looked up (`findExecutable("git")`), kept in
 * a constant, or simple-git. Git reached only through product code is not
 * visible here; that is what the decoy runs above are for.
 */
const STARTS_GIT = [
  /\b(?:execFileSync|execFile|spawnSync|spawn|execa|execaSync)\(\s*["'`]git["'`]/,
  /\b(?:execSync|exec)\(\s*["'`]git\s/,
  /[(,][ \t]*["'`]git["'`][ \t]*,[ \t]*[[\w]/,
  /\(\s*["'`]git["'`]\s*\)/,
  /=\s*["'`]git["'`]\s*;/,
  /["'`]simple-git["'`]/,
];

/** Test files and the helpers beside them; test-env-less starts reach all of them. */
function testSources(): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(REPO, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(child);
      } else if (/\.[cm]?[jt]s$/.test(entry.name)) found.push(child);
    }
  };
  for (const pkg of readdirSync(join(REPO, "packages"))) {
    if (existsSync(join(REPO, "packages", pkg, "__tests__"))) walk(`packages/${pkg}/__tests__`);
    const scripts = join(REPO, "packages", pkg, "scripts");
    if (existsSync(scripts))
      for (const name of readdirSync(scripts))
        if (/\.test\.[cm]?[jt]s$/.test(name)) found.push(`packages/${pkg}/scripts/${name}`);
  }
  walk("tools/__tests__");
  return found.sort();
}

/**
 * Whether the module's first statement after its imports (and type-only
 * declarations) is a real top-level `dropCallerGitEnv()` call, imported from
 * scripts/caller-git-env.mjs. Read from the syntax tree, so a call in a comment,
 * inside a function or after anything else that runs at load time does not count.
 */
function dropsFirst(source: string, fileName: string): boolean {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  let imported = false;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const from = (statement.moduleSpecifier as ts.StringLiteral).text;
      const named = statement.importClause?.namedBindings;
      if (
        from.endsWith("/scripts/caller-git-env.mjs") &&
        named !== undefined &&
        ts.isNamedImports(named) &&
        named.elements.some((e) => e.name.text === "dropCallerGitEnv")
      )
        imported = true;
      continue;
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    return (
      imported &&
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.expression.text === "dropCallerGitEnv"
    );
  }
  return false;
}

test("the guard counts only an early, real top-level call (#1669)", () => {
  const head = `import { spawnSync } from "node:child_process";\nimport { dropCallerGitEnv } from "../../../scripts/caller-git-env.mjs";\n`;
  const cases: Array<[string, string, boolean]> = [
    ["right after the imports", `${head}type T = string;\ndropCallerGitEnv();\nspawnSync("git", ["status"]);\n`, true],
    [
      "only in a comment",
      `${head}// dropCallerGitEnv();\n/* dropCallerGitEnv(); */\nspawnSync("git", ["status"]);\n`,
      false,
    ],
    ["after a top-level git start", `${head}spawnSync("git", ["status"]);\ndropCallerGitEnv();\n`, false],
    [
      "inside a function",
      `${head}function setup() {\n  dropCallerGitEnv();\n}\nsetup();\nspawnSync("git", ["status"]);\n`,
      false,
    ],
    [
      "without the import",
      `import { spawnSync } from "node:child_process";\ndropCallerGitEnv();\nspawnSync("git", ["status"]);\n`,
      false,
    ],
  ];
  for (const [label, source, expected] of cases) assert.equal(dropsFirst(source, "case.test.ts"), expected, label);
});

test("every test file that starts git drops the caller's git variables first (#1669)", () => {
  const sources = testSources();
  const starting = sources.filter((rel) =>
    STARTS_GIT.some((pattern) => pattern.test(readFileSync(join(REPO, rel), "utf8")))
  );
  const unprotected = starting.filter((rel) => !dropsFirst(readFileSync(join(REPO, rel), "utf8"), rel));
  assert.ok(starting.length >= 30, `the scan found only ${starting.length} git-starting files`);
  assert.deepEqual(unprotected, [], "import dropCallerGitEnv and call it right after the imports");
});
