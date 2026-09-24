#!/usr/bin/env node
/**
 * test-map — which tests execute which source lines, so a one-line change
 * runs the tests that can see it instead of the whole suite.
 *
 *   node tools/test-map.mjs build   [--jobs N] [--only <glob-substring>]
 *   node tools/test-map.mjs select  [--base <ref>] [--run] [--json]
 *   node tools/test-map.mjs heatmap [--json] [--top N] [--html <file>]
 *
 * build   runs every test file of the root `npm test` script on its own, with
 *         Node's built-in coverage (source-mapped, so lines are .ts lines), and
 *         writes .test-map/map.json: per source file, which test files executed
 *         which lines, plus each test file's test count, result and duration.
 * select  diffs the working tree against the commit the map was built at and
 *         picks the test files that executed a changed line. It prints what it
 *         cannot vouch for instead of guessing: a change no test executes, a
 *         file the map has never seen, a global file (package.json, the test
 *         setup) that means "run everything".
 * heatmap every suite with its size and time; per source file the share of
 *         lines any test executes and how many test files do; the hottest
 *         lines (a change there re-runs the most) and the files no test loads.
 *         --html writes the same as one self-contained page (tools/test-map-heatmap.html
 *         with the numbers filled in) — generated, never committed.
 *
 * Why coverage and not the import graph: an import says a test CAN reach a
 * file, coverage says it DID run the line. A test that imports a 900-line
 * module to call one function does not need to re-run when line 700 changes.
 * The price: a line reached only through a path the recorded run did not take
 * (a branch taken on another OS, a timeout path) is invisible. `select` names
 * such lines as uncovered rather than claiming safety.
 *
 * Map staleness: line numbers are the map commit's. `select` diffs against that
 * commit, so hunks are read on the old side — the side the map knows.
 *
 * Known hole, not fixed here: a non-code file a test reads at runtime (a JSON/YAML
 * fixture under __tests__/fixtures, a .md a tool loads) shows up in `select`'s
 * `ignored` bucket the same as a truly irrelevant file (a .gitignore, a doc nobody
 * loads) — coverage only sees .ts/.js execution, never an fs.readFileSync of data.
 * A change to such a fixture picks no test. Catching it needs instrumenting reads,
 * not diffing; GLOBAL is not the fix (it would force the full suite on every
 * config/doc touch). Treat `ignored` as "the map has no opinion", not "safe".
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".test-map");
const MAP = join(OUT, "map.json");

/** Files whose change can move any test: selection gives up and says so. */
const GLOBAL = [/^package(-lock)?\.json$/, /^packages\/[^/]+\/package\.json$/, /^tsconfig/, /^packages\/[^/]+\/tsconfig/, /^scripts\/test-env\.mjs$/];
const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;
// A line that cannot change behaviour: blank, a "//" line, or a block comment that opens
// and closes on the same line with nothing else on it. Deliberately does NOT match a
// bare leading star (old regex did, unanchored at the end of the alternation — it
// matched "block-comment-opener eslint-disable block-comment-closer doSomething()" and
// "block-comment-closer realCode()" as inert too, since it never required the rest of
// the line to be checked): a star-led line is ambiguous between a JSDoc continuation and
// code (multiplication continuing on its own line, a chained generator method) with no
// cross-line state here, so it now falls through to "code" — over-cautious (an unrelated
// comment-wording tweak may get selected, or flagged uncovered) never under (a real line
// silently marked inert never reaches select's uncovered report at all: it was dropped
// from the map's tracked lines at build time, not just mislabeled at select time).
// Still blind to a "//"-shaped line that is template-literal/string CONTENT, not a
// comment — no tokenizer here; select's ignored/inert buckets are not proof for files
// with multi-line string literals, only a best-effort.
export const INERT = /^\s*(?:\/\/.*|\/\*.*\*\/\s*|\*\/\s*)?$/;

/**
 * Line numbers that carry code, by one pass over the whole text. A line on its own
 * cannot tell ` * 2;` (a continued product) from ` * explains x` (a JSDoc body) —
 * only the state "inside a block comment or not" can, so INERT above is the
 * fallback for text without its file, never the first choice. Strings and
 * template literals count as code (their content is behaviour); a regex literal
 * is skipped whole, so `/[/*]/` cannot open a comment and hide the code under it.
 */
export function codeLinesOf(text) {
  const code = new Set();
  let inBlock = false;
  let tpl = false;
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n];
    let prev = ""; // last non-space code char on this line, for regex-vs-division
    let i = 0;
    if (tpl) code.add(n + 1);
    while (i < l.length) {
      const c = l[i];
      if (inBlock) {
        if (c === "*" && l[i + 1] === "/") { inBlock = false; i += 2; } else i++;
        continue;
      }
      if (tpl) {
        if (c === "\\") { i += 2; continue; }
        if (c === "`") tpl = false;
        i++;
        continue;
      }
      if (c === " " || c === "\t" || c === "\r") { i++; continue; }
      if (c === "/" && l[i + 1] === "/") break;
      if (c === "/" && l[i + 1] === "*") { inBlock = true; i += 2; continue; }
      code.add(n + 1);
      if (c === "`") { tpl = true; i++; continue; }
      if (c === "'" || c === '"') {
        i++;
        while (i < l.length && l[i] !== c) i += l[i] === "\\" ? 2 : 1;
        i++; prev = c;
        continue;
      }
      if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
        // a regex literal: skip to its closing slash, character classes included
        i++;
        let cls = false;
        while (i < l.length && (cls || l[i] !== "/")) {
          if (l[i] === "\\") i++;
          else if (l[i] === "[") cls = true;
          else if (l[i] === "]") cls = false;
          i++;
        }
        i++; prev = "/";
        continue;
      }
      prev = c;
      i++;
    }
  }
  return code;
}

/** Line numbers of a source file that carry code — the rest is excluded from the map. */
function codeLines(file) {
  try {
    return codeLinesOf(readFileSync(join(ROOT, file), "utf8"));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ tests

/** The test files `npm test` runs — read from the root script, not re-listed here. */
export function testFiles(root = ROOT) {
  const script = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.test;
  const globs = script.split(/\s+/).filter((a) => /\*.*\.(test\.)?(ts|mjs|js)$/.test(a));
  const out = [];
  for (const g of globs) {
    const dir = dirname(g);
    // Escape every regex metacharacter (backslash included), then turn the glob's `*`
    // back into "any run of non-slash": escaping only `.` left a backslash, `+`, `(`… live.
    const rx = new RegExp("^" + g.slice(dir.length + 1).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&").replace(/\\\*/g, "[^/]*") + "$");
    if (!existsSync(join(root, dir))) continue;
    for (const f of readdirSync(join(root, dir)).sort()) if (rx.test(f)) out.push(join(dir, f));
  }
  return out;
}

/** Repo-relative path of a coverage source, whichever checkout node resolved it through.
 * Inside this checkout the real relative path is returned as-is — do NOT pattern-match
 * a "packages/<name>/src/..." tail here, or a vendored/nested copy reached through
 * node_modules (same layout, different code: `node_modules/x/packages/core/src/f.ts`)
 * collides with this repo's own `packages/core/src/f.ts` and its coverage gets merged
 * into the wrong file. Only a path OUTSIDE this checkout (another clone on disk, reached
 * by relative traversal) falls back to the tail match, since there is no `rel` for it. */
export function normalizeSource(sf, root = ROOT) {
  const abs = resolve(root, sf);
  const rel = relative(root, abs);
  if (!rel.startsWith("..")) return rel;
  const m = abs.match(/(?:^|\/)((?:packages\/[^/]+\/(?:src|scripts|__tests__)|tools|scripts)\/.+)$/);
  return m ? m[1] : null;
}

/** lcov → { source: Set<line> } for lines with a hit count > 0. */
export function parseLcov(text, root = ROOT) {
  const out = new Map();
  let cur = null;
  let all = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      const src = normalizeSource(line.slice(3), root);
      cur = src ? (out.get(src) ?? { hit: new Set(), all: new Set() }) : null;
      if (src) out.set(src, cur);
      all = cur;
    } else if (cur && line.startsWith("DA:")) {
      const [ln, count] = line.slice(3).split(",");
      all.all.add(Number(ln));
      if (Number(count) > 0) cur.hit.add(Number(ln));
    } else if (line === "end_of_record") {
      cur = null;
    }
  }
  return out;
}

function runOne(file, dir) {
  const lcov = join(dir, "cov.lcov");
  const tap = join(dir, "run.tap");
  const args = [
    "--enable-source-maps", "--experimental-test-coverage",
    "--test-reporter=lcov", `--test-reporter-destination=${lcov}`,
    "--test-reporter=tap", `--test-reporter-destination=${tap}`,
    "--import", "tsx", "--import", "./scripts/test-env.mjs", "--test", file,
  ];
  const t0 = Date.now();
  return new Promise((done) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: "ignore", env: process.env });
    p.on("close", (code) => {
      const t = existsSync(tap) ? readFileSync(tap, "utf8") : "";
      const num = (k) => Number((t.match(new RegExp(`^# ${k} (\\d+)`, "m")) ?? [])[1] ?? 0);
      done({
        file, code, wall_ms: Date.now() - t0,
        tests: num("tests"), pass: num("pass"), fail: num("fail"), skipped: num("skipped"),
        // Node drops the whole file's report when a covered script is gone by then (a test
        // that writes and deletes a temp .mjs): exit 1 with 0 failed tests, not a failure.
        coverage_lost: t.includes("Could not report code coverage"),
        lcov: existsSync(lcov) ? readFileSync(lcov, "utf8") : "",
      });
    });
  });
}

function toRanges(lines) {
  const s = [...lines].sort((a, b) => a - b);
  const r = [];
  for (const l of s) {
    const last = r[r.length - 1];
    if (last && l === last[1] + 1) last[1] = l;
    else r.push([l, l]);
  }
  return r;
}

async function build(opts) {
  const files = testFiles().filter((f) => !opts.only || f.includes(opts.only));
  const jobs = Math.max(1, opts.jobs ?? Math.min(4, Math.floor(cpus().length / 2)));
  const work = join(OUT, "work");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
  const results = new Array(files.length);
  let next = 0;
  let doneN = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const d = join(work, String(i));
      mkdirSync(d, { recursive: true });
      results[i] = await runOne(files[i], d);
      doneN++;
      if (doneN % 20 === 0 || doneN === files.length) process.stderr.write(`test-map: ${doneN}/${files.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));

  const sources = {};
  const codeCache = new Map();
  const isCode = (src, l) => {
    if (!codeCache.has(src)) codeCache.set(src, codeLines(src));
    const c = codeCache.get(src);
    return c ? c.has(l) : true;
  };
  const tests = results.map((r, i) => {
    const cov = parseLcov(r.lcov);
    let srcLines = 0;
    for (const [src, { hit, all }] of cov) {
      if (src === r.file || src.startsWith("scripts/test-env")) continue;
      const e = (sources[src] ??= { lines: new Set(), by: {} });
      for (const l of all) if (isCode(src, l)) e.lines.add(l);
      const codeHit = [...hit].filter((l) => isCode(src, l));
      if (codeHit.length) {
        e.by[i] = toRanges(codeHit);
        srcLines += codeHit.length;
      }
    }
    return { file: r.file, tests: r.tests, pass: r.pass, fail: r.fail, skipped: r.skipped, wall_ms: r.wall_ms, exit: r.code, src_lines: srcLines, ...(r.coverage_lost ? { coverage_lost: true } : {}) };
  });
  const map = {
    version: 1, commit, dirty, built_at: new Date().toISOString(), node: process.version, jobs,
    tests,
    sources: Object.fromEntries(Object.entries(sources).sort().map(([k, v]) => [k, { lines: toRanges(v.lines), by: v.by }])),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(MAP, JSON.stringify(map));
  rmSync(work, { recursive: true, force: true });
  const blind = tests.filter((t) => t.src_lines === 0).length;
  const failed = tests.filter((t) => t.exit !== 0 && !t.coverage_lost).length;
  const lost = tests.filter((t) => t.coverage_lost).length;
  console.log(`test-map: ${tests.length} test files, ${tests.reduce((a, t) => a + t.tests, 0)} tests, ` +
    `${Object.keys(map.sources).length} source files at ${commit.slice(0, 8)}${dirty ? " (dirty tree)" : ""}; ` +
    `${failed} files failed during the build, ${blind} executed no source line (coverage-blind${lost ? `, ${lost} of them because Node lost the report` : ""}).`);
}

// ------------------------------------------------------------------ select

export function loadMap() {
  if (!existsSync(MAP)) throw new Error("no .test-map/map.json — run `node tools/test-map.mjs build` first");
  return JSON.parse(readFileSync(MAP, "utf8"));
}

/** git's C-quoted path ("caf\303\251.ts", "q\"x.ts") → the real one; unquoted input as-is. */
function unquote(s) {
  if (!(s.length >= 2 && s[0] === '"' && s.at(-1) === '"')) return s;
  const named = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  // Octal escapes are UTF-8 bytes of one character, so bytes are collected and decoded once.
  const parts = s.slice(1, -1).match(/\\(?:[0-7]{1,3}|.)|[^\\]+/gs) ?? [];
  return Buffer.concat(parts.map((p) => {
    if (p[0] !== "\\") return Buffer.from(p, "utf8");
    const e = p.slice(1);
    return Buffer.from([/^[0-7]/.test(e) ? parseInt(e, 8) : (named[e] ?? e.charCodeAt(0))]);
  })).toString("utf8");
}

/** `git diff -U0 <base>` → { file: [[oldStart, oldEnd]] } on the OLD side, plus added files.
 * Also catches what a naive `---`/`+++` scan misses: a pathname with a space gets a
 * trailing tab appended by git on both marker lines (disambiguates the old diff format) —
 * left in, it corrupts the key so the file never matches the map or itself. A binary
 * file has no `---`/`+++`/`@@` at all ("Binary files a/x and b/x differ") and was
 * previously invisible to `select` — not reported anywhere, not even as ignored. A pure
 * rename (identical content) is still invisible on purpose: nothing changed to test. A
 * rename WITH an edit keeps the map's coverage under the OLD path, so its hunks are
 * attached under the new name with `renameFrom` for `select` to fall back to. */
export function parseDiff(text) {
  const files = {};
  let cur = null;
  let pendingRename = null;
  const stripTab = (s) => s.replace(/\t$/, "");
  // A path with a byte git calls unusual (non-ASCII under core.quotePath, a `"`, a
  // backslash, a control char) comes C-quoted: `--- "a/caf\303\251.ts"`. Unread, the
  // header matched nothing and the file vanished from every bucket.
  const side = (raw, prefix) => {
    const p = unquote(stripTab(raw));
    if (p === "/dev/null") return null;
    return p.startsWith(prefix) ? p.slice(prefix.length) : p;
  };
  for (const line of text.split("\n")) {
    if (/^diff --git /.test(line)) { pendingRename = null; cur = null; continue; }
    const rf = line.match(/^rename from (.+)$/);
    if (rf) { pendingRename = { from: unquote(stripTab(rf[1])), to: pendingRename?.to }; continue; }
    const rt = line.match(/^rename to (.+)$/);
    if (rt) { pendingRename = { from: pendingRename?.from, to: unquote(stripTab(rt[1])) }; continue; }
    const bin = line.match(/^Binary files ("?a\/.+?|\/dev\/null) and ("?b\/.+|\/dev\/null) differ$/);
    if (bin) {
      const from = side(bin[1], "a/");
      const to = side(bin[2], "b/");
      files[to ?? from] ??= { added: from === null, deleted: to === null, hunks: [], binary: true };
      continue;
    }
    const f = line.match(/^--- ("?a\/.+|\/dev\/null)$/);
    if (f) { cur = { old: side(f[1], "a/") }; continue; }
    const t = line.match(/^\+\+\+ ("?b\/.+|\/dev\/null)$/);
    if (t && cur) {
      const to = side(t[1], "b/");
      cur.name = to ?? cur.old;
      files[cur.name] ??= { added: cur.old === null, deleted: to === null, hunks: [] };
      if (pendingRename && pendingRename.to === cur.name) files[cur.name].renameFrom = pendingRename.from;
      continue;
    }
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h && cur) {
      const start = Number(h[1]);
      const n = h[2] === undefined ? 1 : Number(h[2]);
      // Pure insertion (n=0) sits AFTER old line `start`: the code around it is what it can change.
      const hunk = n === 0 ? [Math.max(1, start), start + 1] : [start, start + n - 1];
      const ns = Number(h[3]);
      const nn = h[4] === undefined ? 1 : Number(h[4]);
      hunk.old = n === 0 ? null : [start, start + n - 1];
      hunk.new = nn === 0 ? null : [ns, ns + nn - 1];
      hunk.inert = true;
      files[cur.name].hunks.push(hunk);
      continue;
    }
    // Body of the current hunk: one non-inert removed or added line makes it a code change.
    if (cur && cur.name && /^[-+]/.test(line) && !/^(---|\+\+\+) /.test(line)) {
      const hs = files[cur.name].hunks;
      if (hs.length && !INERT.test(line.slice(1))) hs[hs.length - 1].inert = false;
    }
  }
  return files;
}

/** The diff parseDiff reads, in the shape it reads, whatever the user's git config says.
 * diff.mnemonicPrefix (c/ w/ i/), diff.noprefix, diff.external and diff.relative each
 * change that shape; parseDiff matches none of it and silently returns {} — "0 test
 * files", nothing reported. So the prefixes and the internal differ are pinned here. */
export function gitDiff(base, root = ROOT) {
  return execFileSync("git", ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", base],
    { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 });
}

const overlaps = (ranges, [a, b]) => ranges.some(([x, y]) => x <= b && a <= y);

export function select(map, diffText, opts = {}) {
  const diff = parseDiff(diffText);
  // Comment-only or not: decided on whole texts (old side at the map commit, new side on
  // disk) with codeLinesOf; the line-local INERT verdict from parseDiff stays only where
  // a text cannot be read.
  const readOld = opts.readOld ?? ((f) => {
    try {
      return execFileSync("git", ["show", `${map.commit}:${f}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
    } catch {
      return null;
    }
  });
  const readNew = opts.readNew ?? ((f) => {
    try {
      return readFileSync(join(ROOT, f), "utf8");
    } catch {
      return null;
    }
  });
  const touches = (set, r) => {
    if (!r) return false;
    for (let l = r[0]; l <= r[1]; l++) if (set.has(l)) return true;
    return false;
  };
  for (const [file, d] of Object.entries(diff)) {
    if (d.binary || !CODE.test(file) || !d.hunks.length) continue;
    const oldText = d.added ? "" : readOld(d.renameFrom ?? file);
    const newText = d.deleted ? "" : readNew(file);
    if (oldText === null || newText === null) continue;
    const oc = codeLinesOf(oldText);
    const nc = codeLinesOf(newText);
    for (const h of d.hunks) h.inert = !touches(oc, h.old) && !touches(nc, h.new);
  }
  const byFile = new Map(map.tests.map((t, i) => [t.file, i]));
  const picked = new Map(); // test idx → reasons
  const add = (i, why) => { if (!picked.has(i)) picked.set(i, new Set()); picked.get(i).add(why); };
  const report = { global: [], uncovered: [], unmapped: [], ignored: [], inert: [], blind_included: [] };

  for (const [file, d] of Object.entries(diff)) {
    if (GLOBAL.some((rx) => rx.test(file))) { report.global.push(file); continue; }
    if (byFile.has(file)) { add(byFile.get(file), `${file} (the test itself)`); continue; }
    // Binary, or a non-code extension the map never tracks (.json/.yaml/.md/...): visible
    // here as "ignored", but if a test reads it as a runtime fixture rather than a source
    // module, no coverage run ever recorded that read — a change there selects nothing.
    if (d.binary || !CODE.test(file)) { report.ignored.push(file); continue; }
    const src = map.sources[file] ?? (d.renameFrom && map.sources[d.renameFrom]);
    if (!src) { report.unmapped.push(file); continue; }
    for (const h of d.hunks) {
      if (h.inert) { report.inert.push(`${file}:${h[0]}-${h[1]}`); continue; }
      let hit = false;
      for (const [i, ranges] of Object.entries(src.by)) {
        if (overlaps(ranges, h)) { add(Number(i), `${file}:${h[0]}-${h[1]}`); hit = true; }
      }
      // A code change no test ran — a regression here goes unseen. Not only on lines the map
      // tracks: code that replaced a comment, or was inserted between comments, lands on old
      // lines the map dropped as non-code, and fell out of every bucket.
      if (!hit) report.uncovered.push(`${file}:${h[0]}-${h[1]}`);
    }
  }
  // Coverage-blind test files execute no source line: they read sources as text
  // (hygiene, typecheck wiring, workflow pinning) or spawn a child with a scrubbed
  // env. The map cannot rule them out, and all of them together cost ~4 % of a
  // serial full run — so any code change includes every one of them.
  const codeChanged = Object.entries(diff).some(([f, d]) => CODE.test(f) && (d.added || d.deleted || d.hunks.some((h) => !h.inert)));
  if (codeChanged) {
    map.tests.forEach((t, i) => {
      if (t.src_lines === 0 && !picked.has(i)) { add(i, "coverage-blind"); report.blind_included.push(t.file); }
    });
  }
  const chosen = [...picked.keys()].sort((a, b) => a - b).map((i) => ({ ...map.tests[i], why: [...picked.get(i)] }));
  const all = map.tests.reduce((a, t) => ({ tests: a.tests + t.tests, wall: a.wall + t.wall_ms }), { tests: 0, wall: 0 });
  return {
    full_suite: report.global.length > 0,
    files: chosen,
    tests: chosen.reduce((a, t) => a + t.tests, 0),
    wall_ms: chosen.reduce((a, t) => a + t.wall_ms, 0),
    of_tests: all.tests, of_wall_ms: all.wall,
    ...report,
  };
}

function runSelected(files) {
  if (!files.length) return 0;
  const r = spawn(process.execPath, ["--import", "tsx", "--import", "./scripts/test-env.mjs", "--test", ...files], { cwd: ROOT, stdio: "inherit" });
  return new Promise((done) => r.on("close", (c) => done(c ?? 1)));
}

// ------------------------------------------------------------------ heatmap

export function heatmap(map, top = 25) {
  const rows = Object.entries(map.sources).map(([file, s]) => {
    const total = s.lines.reduce((a, [x, y]) => a + y - x + 1, 0);
    const heat = new Map();
    for (const ranges of Object.values(s.by)) for (const [x, y] of ranges) for (let l = x; l <= y; l++) heat.set(l, (heat.get(l) ?? 0) + 1);
    const covered = heat.size;
    let hot = 0;
    for (const v of heat.values()) hot = Math.max(hot, v);
    return { file, lines: total, covered, pct: total ? covered / total : 0, test_files: Object.keys(s.by).length, hottest_line_tests: hot, heat };
  });
  const src = rows.filter((r) => /\/src\//.test(r.file));
  const hotLines = [];
  for (const r of src) for (const [l, v] of r.heat) hotLines.push({ at: `${r.file}:${l}`, tests: v });
  hotLines.sort((a, b) => b.tests - a.tests);
  const suites = [...map.tests].sort((a, b) => b.wall_ms - a.wall_ms);
  const totalLines = src.reduce((a, r) => a + r.lines, 0);
  const coveredLines = src.reduce((a, r) => a + r.covered, 0);
  return {
    commit: map.commit, built_at: map.built_at,
    suites, files: src.map(({ heat, ...r }) => r).sort((a, b) => a.pct - b.pct || b.lines - a.lines),
    hot_lines: hotLines.slice(0, top), total_lines: totalLines, covered_lines: coveredLines,
    blind: map.tests.filter((t) => t.src_lines === 0).map((t) => t.file),
  };
}

// ------------------------------------------------------------------ cli

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i < 0 ? def : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(name);
const s = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function main() {
  const cmd = process.argv[2];
  if (cmd === "build") return build({ jobs: arg("--jobs") && Number(arg("--jobs")), only: arg("--only") });
  if (cmd === "select") {
    const map = loadMap();
    const base = arg("--base", map.commit);
    if (base !== map.commit) process.stderr.write(`test-map: --base ${base} is not the map commit ${map.commit.slice(0, 8)} — line numbers may be off\n`);
    const r = select(map, gitDiff(base));
    if (flag("--json")) console.log(JSON.stringify(r, null, 1));
    else {
      if (r.full_suite) console.log(`FULL SUITE — global file changed: ${r.global.join(", ")}`);
      console.log(`${r.files.length} test files, ${r.tests} of ${r.of_tests} tests, ~${s(r.wall_ms)} of ~${s(r.of_wall_ms)} serial`);
      for (const f of r.files) console.log(`  ${f.file}  (${f.tests})  ← ${f.why.slice(0, 3).join(", ")}${f.why.length > 3 ? ` +${f.why.length - 3}` : ""}`);
      if (r.uncovered.length) console.log(`NO TEST EXECUTES: ${r.uncovered.join(", ")}`);
      if (r.inert.length) console.log(`comment/blank only, no test needed: ${r.inert.join(", ")}`);
      if (r.unmapped.length) console.log(`NOT IN MAP (new, or never loaded by a test): ${r.unmapped.join(", ")}`);
      if (r.blind_included.length) console.log(`coverage-blind, included by package: ${r.blind_included.length}`);
      if (r.ignored.length) console.log(`ignored — non-code, binary, or a runtime-read file no coverage sees: ${r.ignored.join(", ")}`);
    }
    if (flag("--run")) process.exitCode = r.full_suite ? await runSelected(testFiles()) : await runSelected(r.files.map((f) => f.file));
    return;
  }
  if (cmd === "heatmap") {
    const map = loadMap();
    const h = heatmap(map, Number(arg("--top", 25)));
    if (flag("--json")) return console.log(JSON.stringify(h, null, 1));
    if (arg("--html")) {
      const data = {
        commit: map.commit.slice(0, 8), built: map.built_at.slice(0, 16).replace("T", " "),
        nfiles: map.tests.length, ntests: map.tests.reduce((a, t) => a + t.tests, 0),
        serial_s: Math.round(map.tests.reduce((a, t) => a + t.wall_ms, 0) / 1000),
        covered: h.covered_lines, total: h.total_lines,
        files: h.files.map((f) => ({ f: f.file, l: f.lines, c: Number(f.pct.toFixed(3)), t: f.test_files, x: f.hottest_line_tests })),
        suites: h.suites.slice(0, 20).map((t) => ({ f: t.file, w: t.wall_ms, n: t.tests, lost: !!t.coverage_lost, fail: t.exit !== 0 && !t.coverage_lost })),
        hot: h.hot_lines.slice(0, 15), blind: h.blind,
      };
      // The data goes into a <script>: no "<" may reach it raw ("</script>" closes it,
      // "<!--" flips the parser into a script-escape state). And the replacement is a
      // function: a string replacement reads `$'` / `$&` in a filename as a pattern and
      // pastes the template's own tail — "</script>" included — into the data.
      const json = JSON.stringify(data).replace(/</g, "\\u003c");
      const page = readFileSync(join(ROOT, "tools", "test-map-heatmap.html"), "utf8").replace("__DATA__", () => json);
      writeFileSync(arg("--html"), page);
      return console.log(`heatmap → ${arg("--html")}`);
    }
    console.log(`map ${h.commit.slice(0, 8)} · ${h.suites.length} suites · src lines executed by ≥1 test: ${h.covered_lines}/${h.total_lines} (${((100 * h.covered_lines) / h.total_lines).toFixed(1)} %)`);
    console.log("\nslowest suites:");
    for (const t of h.suites.slice(0, 15)) console.log(`  ${s(t.wall_ms).padStart(7)}  ${String(t.tests).padStart(4)} tests  ${t.file}${t.exit ? "  [failed]" : ""}`);
    console.log("\ncoldest source files (share of lines any test executes):");
    for (const f of h.files.slice(0, 25)) console.log(`  ${(100 * f.pct).toFixed(0).padStart(3)} %  ${String(f.lines).padStart(5)} lines  ${String(f.test_files).padStart(3)} test files  ${f.file}`);
    console.log("\nhottest lines (a change here re-runs the most test files):");
    for (const l of h.hot_lines.slice(0, 10)) console.log(`  ${String(l.tests).padStart(4)}  ${l.at}`);
    if (h.blind.length) console.log(`\ncoverage-blind test files (executed no source line): ${h.blind.length}`);
    return;
  }
  console.error("usage: test-map.mjs build [--jobs N] [--only S] | select [--base REF] [--run] [--json] | heatmap [--json] [--top N]");
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
