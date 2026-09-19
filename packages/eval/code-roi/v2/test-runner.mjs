/**
 * Running a repository's own test suite and reading what it reports (#582).
 *
 * This half is mechanical: which runner the repository uses, how to invoke it
 * over a chosen set of files, how to get a case-level pass/fail map back out
 * of four different report formats, and how to answer "which cases passed
 * before and fail now". The RULE that turns those failures into a truth set
 * lives next door in `test-truth.mjs`.
 *
 * Nothing here knows about the code graph, and nothing here may learn: the
 * population is built blind to the tool under measurement.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { isTestFile } from "./test-truth.mjs";

/** Default ceiling for ONE suite run. A slower repository raises it explicitly. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.CODE_ROI_TEST_TIMEOUT_MS ?? 600_000);

// ─── Runner detection ────────────────────────────────────────────

/**
 * Which test runner a repository uses, read off its own manifest rather than
 * configured. The `test` script is the authority: it is what the repository's
 * own CI runs, so it is the only command whose green is meaningful.
 *
 * @returns {{kind: string, reporter: string, script: string}|null}
 */
export function detectRunner(root) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const script = typeof pkg?.scripts?.test === "string" ? pkg.scripts.test : "";
  const deps = { ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
  const mentions = (name) => script.includes(name) || Object.hasOwn(deps, name);

  // Order matters: a repository can carry jest in its lockfile and still run
  // vitest, so the script wins over the dependency list for every one of them.
  if (/\bvitest\b/.test(script) || (script === "" && Object.hasOwn(deps, "vitest"))) {
    return { kind: "vitest", reporter: "json", script };
  }
  if (/\bjest\b/.test(script) || (script === "" && Object.hasOwn(deps, "jest"))) {
    return { kind: "jest", reporter: "json", script };
  }
  if (/\bmocha\b/.test(script) || (script === "" && Object.hasOwn(deps, "mocha"))) {
    return { kind: "mocha", reporter: "json", script };
  }
  // `node … --test …` with anything in between: bastra-recall's own script is
  // `node --import tsx --import ./scripts/test-env.mjs --test …`, where the
  // loader arguments are not flags, so a pattern that only allows `--flag`
  // between `node` and `--test` does not match it.
  if (/\bnode\b[^|&;]*\s--test\b/.test(script)) {
    return { kind: "node-test", reporter: "tap", script };
  }
  if (mentions("vitest")) return { kind: "vitest", reporter: "json", script };
  if (mentions("jest")) return { kind: "jest", reporter: "json", script };
  if (mentions("mocha")) return { kind: "mocha", reporter: "json", script };
  return null;
}

/**
 * The argv for one run. `files` restricts the run to those test files — used by
 * the confirmation step, which must not pay for the whole suite.
 */
export function runnerCommand(dir, runner, files = []) {
  const bin = (name) => join(dir, "node_modules", ".bin", name);
  switch (runner.kind) {
    case "jest":
      return { cmd: bin("jest"), args: ["--json", "--ci", "--watchAll=false", ...files] };
    case "vitest":
      return { cmd: bin("vitest"), args: ["run", "--reporter=json", ...files] };
    case "mocha":
      return { cmd: bin("mocha"), args: ["--reporter", "json", ...files] };
    case "node-test": {
      // The repository's own `--test` flags are reused (`--experimental-strip-types`
      // and friends), because without them the suite does not even parse; only
      // the reporter and the file list are ours.
      const extra = (runner.script.match(/--experimental-\S+|--import\s+\S+|--loader\s+\S+/g) ?? []).flatMap(
        (f) => f.split(/\s+/),
      );
      const targets = files.length > 0 ? files : testFilesOf(dir, runner);
      return { cmd: process.execPath, args: ["--test", "--test-reporter=tap", ...extra, ...targets] };
    }
    default:
      throw new Error(`unknown runner ${runner.kind}`);
  }
}

/**
 * Test files in a tree, for the runners that want an explicit list.
 *
 * EVERY glob in the script is used, not just the first: bastra-recall's script
 * names four of them (core, daemon, eval, tools), and taking only the first
 * would run a quarter of the suite while reporting it as the whole thing.
 */
export function testFilesOf(dir, runner) {
  const bases = [];
  for (const token of runner.script.match(/\S*\*\S*/g) ?? []) {
    if (!token.includes("/")) continue;
    const base = token.slice(0, token.indexOf("*")).replace(/\/$/, "");
    if (base !== "" && !bases.includes(base) && existsSync(join(dir, base))) bases.push(base);
  }
  const roots = bases.length > 0 ? bases : ["test", "tests", "__tests__", "src"];
  const found = [];
  const walk = (rel, depth) => {
    if (depth > 6 || found.length >= 2000) return;
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const child = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child, depth + 1);
      else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name) || /^(test|spec)_.*\.[cm]?[jt]sx?$/.test(e.name)) {
        found.push(child);
      }
    }
  };
  for (const r of roots) if (existsSync(join(dir, r))) walk(r, 0);
  return found.sort();
}

// ─── Running ─────────────────────────────────────────────────────

/**
 * One suite run. Resolves to `{status, cases}` where `cases` maps a stable case
 * id to "pass" | "fail" | "skip".
 *
 * A timeout resolves with `status: "timeout"` rather than throwing, and the
 * caller turns that into "not evaluable". It is never allowed to look like an
 * empty failure set: a candidate whose suite hangs is a candidate we could not
 * judge, not a candidate that broke nothing.
 */
export async function runSuite(dir, runner, { files = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { cmd, args } = runnerCommand(dir, runner, files);
  if (!existsSync(cmd) && cmd !== process.execPath) {
    return { status: "error", cases: new Map(), detail: `runner binary missing: ${cmd}` };
  }
  const result = await new Promise((resolveRun) => {
    // CI=1 keeps watch modes and interactive prompts out; a run that waits for
    // a keypress is indistinguishable from a hang.
    //
    // NODE_TEST_CONTEXT and NODE_OPTIONS are REMOVED, not passed through: when
    // the miner is itself run from inside a `node --test` process — which is
    // exactly what happens in this package's own tests — the child sees that
    // marker, decides it is a recursive run, and prints "skipping running
    // files" instead of any results. A truth built from that is a truth built
    // from an empty suite.
    const env = { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const child = spawn(cmd, args, { cwd: dir, env });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      child.kill("SIGKILL");
      resolveRun({ timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveRun({ spawnError: String(e?.message ?? e), stdout, stderr });
    });
    child.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveRun({ timedOut: false, stdout, stderr });
    });
  });

  if (result.timedOut === true) return { status: "timeout", cases: new Map(), detail: "time budget exceeded" };
  if (result.spawnError !== undefined) {
    return { status: "error", cases: new Map(), detail: result.spawnError };
  }
  const parsed =
    runner.reporter === "tap"
      ? parseTap(result.stdout)
      : parseJsonReport(runner.kind, result.stdout, result.stderr);
  if (parsed === null || parsed.cases.size === 0) {
    return {
      status: "error",
      cases: new Map(),
      files: new Map(),
      ambiguous: new Set(),
      detail: `no test results parsed: ${(result.stderr || result.stdout).slice(0, 300)}`,
    };
  }
  return { status: "ok", ...parsed };
}

/**
 * TAP, as `node --test --test-reporter=tap` writes it.
 *
 * Two properties of that output shape the parser and were both measured, not
 * assumed (Node 24):
 *
 *   - Test files are NOT a level of nesting. Every file's top-level test is a
 *     top-level TAP point, and the points of several files are interleaved in
 *     completion order. So a case id is the test's own name path and nothing
 *     more, and two files that use the same test name collide — those ids are
 *     returned in `ambiguous` and excluded from the truth rather than guessed.
 *   - The owning FILE appears only for failures, in the YAML `location:` of
 *     the failing point. That is exactly where it is needed: attribution only
 *     ever asks which file a BROKEN case came from.
 *
 * A parent point is emitted after its children, so a point that is the prefix
 * of another is a suite, not a case, and is dropped at the end.
 */
export function parseTap(out) {
  const cases = new Map();
  const files = new Map();
  const seen = new Map();
  // The nesting comes from the `# Subtest:` announcements, NOT from the point
  // lines: TAP emits a parent's `ok` AFTER its children, so when a child is
  // read the parent's point does not exist yet and only its announcement does.
  const open = [];
  let current = null;
  for (const raw of out.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    const subtest = /^#\s*Subtest:\s*(.*)$/.exec(line);
    if (subtest !== null) {
      while (open.length > 0 && open[open.length - 1].indent >= indent) open.pop();
      open.push({ indent, name: subtest[1].trim() });
      continue;
    }

    const point = /^(not ok|ok)\s+\d+\s*-?\s*(.*)$/.exec(line);
    if (point !== null) {
      const name = point[2].replace(/\s*#\s*(SKIP|TODO).*$/i, "").trim();
      const ancestors = open.filter((o) => o.indent < indent).map((o) => o.name);
      current = [...ancestors, name].join(" > ");
      const skipped = /#\s*(SKIP|TODO)/i.test(point[2]);
      cases.set(current, skipped ? "skip" : point[1] === "ok" ? "pass" : "fail");
      seen.set(current, (seen.get(current) ?? 0) + 1);
      continue;
    }

    const where = /^location:\s*'(.+)'$/.exec(line);
    if (where !== null && current !== null) files.set(current, where[1].replace(/:\d+:\d+$/, ""));
  }
  for (const id of [...cases.keys()]) {
    if ([...cases.keys()].some((other) => other.startsWith(`${id} > `))) cases.delete(id);
  }
  return { cases, files, ambiguous: new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id)) };
}

/** jest / vitest / mocha JSON, reduced to the same case map. */
export function parseJsonReport(kind, stdout, stderr = "") {
  const text = pickJson(stdout) ?? pickJson(stderr);
  if (text === null) return null;
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return null;
  }
  // These three name the file in the report, so the id carries it and no case
  // is ever ambiguous — the `ambiguous` set exists for TAP alone.
  const cases = new Map();
  const files = new Map();
  const put = (file, title, status) => {
    const id = `${file} > ${title}`;
    cases.set(id, status);
    if (file !== "") files.set(id, file);
  };
  if (kind === "mocha") {
    for (const [bucket, status] of [
      ["passes", "pass"],
      ["failures", "fail"],
      ["pending", "skip"],
    ]) {
      for (const t of report?.[bucket] ?? []) put(t.file ?? "", t.fullTitle ?? t.title ?? "", status);
    }
    return { cases, files, ambiguous: new Set() };
  }
  // jest and vitest share the shape: testResults[] with assertionResults[].
  for (const file of report?.testResults ?? []) {
    const name = file.name ?? file.testFilePath ?? "";
    for (const a of file.assertionResults ?? []) {
      const title = (a.ancestorTitles ?? []).concat(a.title ?? "").join(" > ");
      put(name, title, a.status === "passed" ? "pass" : a.status === "failed" ? "fail" : "skip");
    }
  }
  return { cases, files, ambiguous: new Set() };
}

/**
 * The JSON object inside a runner's output. Every one of these prints warnings
 * and progress around its report, so the stream is scanned for the outermost
 * balanced object rather than parsed whole.
 */
function pickJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Cases that passed in `before` and fail in `after`.
 *
 * An id that was ambiguous in EITHER run is skipped: under TAP two files can
 * use the same test name, and then "this passed and now fails" may be a
 * statement about two different tests. An ambiguous case is dropped from the
 * evidence rather than attributed to a file it might not belong to.
 */
export function brokenCases(before, after, ambiguous = new Set()) {
  const broke = [];
  for (const [id, status] of after) {
    if (ambiguous.has(id)) continue;
    if (status === "fail" && before.get(id) === "pass") broke.push(id);
  }
  return broke.sort();
}

/**
 * The test file a case id belongs to, as a repo-relative path: from the run's
 * own file map where the runner reported one (jest, vitest, mocha always; TAP
 * for failures), otherwise from the id's head for the runners that put the
 * file in front of the title.
 */
export function testFileOfCase(id, dir, files = new Map()) {
  const head = files.get(id) ?? id.split(" > ")[0];
  if (head === undefined || head === "") return null;
  const abs = head.startsWith("/") ? head : join(dir, head);
  if (!existsSync(abs)) return null;
  // Both sides are resolved through their symlinks first. A runner reports the
  // path it actually opened, and on macOS a tree under /var is reached through
  // /private/var — comparing the two spellings makes every case look like it
  // lies outside the tree, and the truth set comes out empty.
  const rel = relative(realPath(dir), realPath(abs));
  return rel.startsWith("..") || rel === "" ? null : rel;
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

