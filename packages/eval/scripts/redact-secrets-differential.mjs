// #1528 independent counter-review: does `redactSecrets` after the split redact
// exactly what it redacted before? Runs the v1.2.1 source (taken from git, not
// from a copy in the tree) and the current source side by side on
//   1. every string literal of the core redaction/scrub tests and their corpora,
//   2. seeded mutations of those strings (edit, splice, separator, case, invisible),
//   3. seeded random strings built from the characters the patterns care about,
// with and without a home directory, and compares `text` and `redactedChars`.
// Usage (repo root): node --import tsx packages/eval/scripts/redact-secrets-differential.mjs [--seed N] [--cases N] [--base REF]
// Exit 0 = no difference; exit 1 = differences, the first ones are printed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const seed = Number(option("--seed", "1528"));
const cases = Number(option("--cases", "100000"));
const base = option("--base", "v1.2.1");
const root = resolve(import.meta.dirname, "../../..");
const HOME = "/Users/n0mad";

/** The old source as git holds it; the module graph of scrub.ts at that ref. */
function loadOld() {
  const dir = mkdtempSync(join(tmpdir(), "redact-differential-"));
  const files = execFileSync("git", ["ls-tree", "--name-only", base, "packages/core/src/"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => /\/scrub[^/]*\.ts$/.test(f));
  for (const file of files) {
    const text = execFileSync("git", ["show", `${base}:${file}`], { cwd: root, encoding: "utf8", maxBuffer: 16 << 20 });
    writeFileSync(join(dir, file.split("/").pop()), text);
  }
  return { dir, files: files.map((f) => f.split("/").pop()) };
}

/** Every double-quoted, single-quoted or plain template literal of the corpus files. */
function corpusStrings() {
  const testDir = join(root, "packages/core/__tests__");
  const sources = readdirSync(testDir)
    .filter((f) => /^(?:redact|scrub)[^/]*\.test\.ts$/.test(f))
    .map((f) => join(testDir, f));
  sources.push(join(testDir, "fixtures/network-redaction-corpus.ts"));
  const out = new Set();
  for (const file of sources) {
    const src = readFileSync(file, "utf8");
    // Corpus rows store provider-shaped inputs as JSON string arrays joined at runtime.
    for (const m of src.matchAll(/(\[(?:"(?:[^"\\\n]|\\.)*",?\s*)+\])\.join\(""\)/g))
      out.add(JSON.parse(m[1]).join(""));
    for (const m of src.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
      try {
        out.add(JSON.parse(m[0]));
      } catch {
        /* not JSON-compatible escaping; the single-quote pass may still catch it */
      }
    }
    for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
      try {
        out.add(JSON.parse(`"${m[1].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`));
      } catch {
        /* skip */
      }
    }
    for (const m of src.matchAll(/`((?:[^`\\$]|\\.)*)`/g)) out.add(m[1].replace(/\\n/g, "\n"));
  }
  return [...out].filter((s) => s.length > 0);
}

/** mulberry32: small, seeded, reproducible across Node versions. */
function prng(s) {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" +
  "-_=:/.@?&+$#%!*'\"`{}[]()<>\\| \n\t~,;" +
  "​‍‮﻿ äöüßжщяйé";
const SEPARATORS = ["=", ": ", " ", "\n", '"', "'", "&", "?", "@", "/", "\\\n", "-", "_", "--", " -p"];
const INVISIBLE = ["​", "‌", "‍", "⁠", "‮", "﻿", "­"];

function generator(corpus, rnd) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const int = (n) => Math.floor(rnd() * n);
  const randomString = () => {
    let s = "";
    for (let n = 1 + int(80); n > 0; n--) s += ALPHABET[int(ALPHABET.length)];
    return s;
  };
  const mutate = (s) => {
    const chars = Array.from(s);
    for (let n = 1 + int(4); n > 0; n--) {
      const at = int(chars.length + 1);
      switch (int(8)) {
        case 0:
          chars.splice(at, 1);
          break;
        case 1:
          chars.splice(at, 0, ALPHABET[int(ALPHABET.length)]);
          break;
        case 2:
          chars.splice(at, 1, ALPHABET[int(ALPHABET.length)]);
          break;
        case 3:
          chars.splice(at, 0, ...Array.from(pick(SEPARATORS)));
          break;
        case 4:
          chars.splice(at, 0, pick(INVISIBLE));
          break;
        case 5:
          if (chars[at]) chars[at] = rnd() < 0.5 ? chars[at].toUpperCase() : chars[at].toLowerCase();
          break;
        case 6:
          chars.splice(at, 0, ...Array.from(pick(corpus)).slice(0, 1 + int(40)));
          break;
        default:
          chars.splice(at, int(6));
      }
    }
    return chars.join("");
  };
  return () => {
    const r = rnd();
    if (r < 0.15) return randomString();
    if (r < 0.3) return pick(corpus) + pick(SEPARATORS) + pick(corpus);
    if (r < 0.4) return `${HOME}/${mutate(pick(corpus))}`;
    return mutate(pick(corpus));
  };
}

const old = loadOld();
try {
  const before = (await import(pathToFileURL(join(old.dir, "scrub.ts")).href)).redactSecrets;
  const after = (await import(pathToFileURL(join(root, "packages/core/src/scrub.ts")).href)).redactSecrets;
  const corpus = corpusStrings();
  const differences = [];
  let compared = 0;
  const check = (input, home) => {
    compared++;
    let a, b;
    try {
      a = JSON.stringify(before(input, home));
    } catch (error) {
      a = `throws ${error?.message}`;
    }
    try {
      b = JSON.stringify(after(input, home));
    } catch (error) {
      b = `throws ${error?.message}`;
    }
    if (a !== b && differences.length < 20) differences.push({ input, home, before: a, after: b });
    return a === b;
  };
  let different = 0;
  for (const input of corpus) for (const home of [undefined, HOME]) if (!check(input, home)) different++;
  const corpusCompared = compared;
  const next = generator(corpus, prng(seed));
  const rnd = prng(seed ^ 0x5eed);
  for (let i = 0; i < cases; i++) if (!check(next(), rnd() < 0.5 ? undefined : HOME)) different++;
  const summary = {
    base,
    head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    oldFiles: old.files,
    seed,
    corpusStrings: corpus.length,
    corpusComparisons: corpusCompared,
    generatedComparisons: compared - corpusCompared,
    differences: different,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  for (const d of differences) process.stdout.write(JSON.stringify(d) + "\n");
  process.exitCode = different === 0 ? 0 : 1;
} finally {
  rmSync(old.dir, { recursive: true, force: true });
}
