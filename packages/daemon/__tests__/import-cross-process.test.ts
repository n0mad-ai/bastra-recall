/**
 * #529, the cross-process half.
 *
 * Both import stores have a demonstrable second writer in another process:
 * `import-review.md` is staged by `bastra import` (cli/import-cmd.ts) AND by
 * the daemon's `POST /ui/import` (the map's import dialog, import-review.ts),
 * and the mining queue is written by one CLI run (`bastra import <export>`)
 * and then advanced/cleared by the next (`bastra import mine`). Two `bastra
 * import` invocations are two processes as well.
 *
 * A promise chain cannot see any of them. Measured on the process-local lock,
 * 20 concurrent PROCESSES each reporting success: 10 of 20 staged candidates
 * and 14 of 20 queued conversations survived. So this runs REAL node child
 * processes against one store and checks the durable union — the same shape as
 * skills-registry-cross-process.test.ts for #533.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVIEW_SRC = pathToFileURL(resolve(__dirname, "..", "src", "import-review.ts")).href;
const MINING_SRC = pathToFileURL(resolve(__dirname, "..", "src", "import-mining.ts")).href;

/** Runs a child script to completion; rejects on a non-zero exit. */
function runChild(script: string, args: string[]): Promise<void> {
  return new Promise((ok, ko) => {
    const child = spawn("npx", ["tsx", script, ...args], {
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", ko);
    child.on("close", (code) => (code === 0 ? ok() : ko(new Error(`child exited ${code}: ${stderr}`))));
  });
}

const WRITERS = 6;

test("#529 — concurrent stageImport PROCESSES keep every staged candidate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-import-xproc-"));
  try {
    const vault = join(dir, "vault");
    await mkdir(vault, { recursive: true });
    const script = join(dir, "stage.mts");
    await writeFile(
      script,
      `const [vault, i] = process.argv.slice(2);\n` +
        `const { stageImport } = await import(${JSON.stringify(REVIEW_SRC)});\n` +
        `await stageImport(vault, "text", ["independent import candidate number " + i]);\n`,
      "utf8",
    );
    await Promise.all(Array.from({ length: WRITERS }, (_, i) => runChild(script, [vault, String(i)])));

    const content = await readFile(join(vault, "import-review.md"), "utf8");
    const survived = content
      .split("\n")
      .filter((l) => l.includes("independent import candidate number "))
      .map((l) => l.slice(l.lastIndexOf(" ") + 1))
      .sort();
    assert.deepEqual(
      survived,
      Array.from({ length: WRITERS }, (_, i) => String(i)).sort(),
      `every staging process must survive: got ${survived.length} of ${WRITERS} candidates`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("#529 — concurrent buildQueue PROCESSES keep every queued conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-queue-xproc-"));
  try {
    const queueDir = join(dir, "queue");
    const script = join(dir, "queue.mts");
    await writeFile(
      script,
      `const [queueDir, i] = process.argv.slice(2);\n` +
        `const { buildQueue } = await import(${JSON.stringify(MINING_SRC)});\n` +
        `await buildQueue([{ title: "conv " + i, date: "2026-03-01", source: "chatgpt", messages: ["m" + i] }], queueDir);\n`,
      "utf8",
    );
    await Promise.all(Array.from({ length: WRITERS }, (_, i) => runChild(script, [queueDir, String(i)])));

    const raw = await readFile(join(queueDir, "import-queue.jsonl"), "utf8");
    const titles = raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { title: string }).title)
      .sort();
    assert.deepEqual(
      titles,
      Array.from({ length: WRITERS }, (_, i) => `conv ${i}`).sort(),
      `every queueing process must survive: got ${titles.length} of ${WRITERS} conversations`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
