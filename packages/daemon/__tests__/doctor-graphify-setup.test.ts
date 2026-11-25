/**
 * `bastra doctor` names an existing Graphify setup (#573) — read-only.
 *
 * Pinned: no signal → no note; each of the three signals alone → the note naming
 * that path; German words by language; nothing on disk changes; the note never
 * touches the exit code (it only writes text). Runs against a synthetic home and
 * repo — the developer's real ~/.claude is never read.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/doctor-graphify-setup.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findGraphifySetup, printGraphifySetupNote } from "../src/cli/graphify-setup-note.js";

async function withDirs(run: (home: string, repo: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "graphify-note-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(repo, ".claude"), { recursive: true });
  try {
    await run(home, repo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function capture(language: string, home: string, repo: string): Promise<string> {
  let out = "";
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await printGraphifySetupNote(language, { home, repo });
  } finally {
    process.stdout.write = original;
  }
  return out;
}

test("no Graphify signal: no note", async () => {
  await withDirs(async (home, repo) => {
    await writeFile(join(home, ".claude", "settings.json"), '{"hooks":{}}');
    await writeFile(join(home, ".claude", "CLAUDE.md"), "# my rules\n");
    assert.deepEqual(await findGraphifySetup(repo, home), []);
    assert.equal(await capture("en", home, repo), "");
  });
});

test("hook-guard in the repo settings is reported", async () => {
  await withDirs(async (home, repo) => {
    const file = join(repo, ".claude", "settings.json");
    await writeFile(
      file,
      '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"graphify hook-guard search"}]}]}}'
    );
    assert.deepEqual(await findGraphifySetup(repo, home), [file]);
    const out = await capture("en", home, repo);
    assert.match(out, /existing Graphify setup found/);
    assert.ok(out.includes(file));
  });
});

test("hook-guard in the home settings is reported", async () => {
  await withDirs(async (home, repo) => {
    const file = join(home, ".claude", "settings.json");
    await writeFile(
      file,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "command", command: '"C:\\Program Files\\Graphify\\graphify.EXE" hook-guard read --strict' },
              ],
            },
          ],
        },
      })
    );
    assert.deepEqual(await findGraphifySetup(repo, home), [file]);
  });
});

test("a '# graphify' block in ~/.claude/CLAUDE.md is reported", async () => {
  await withDirs(async (home, repo) => {
    const file = join(home, ".claude", "CLAUDE.md");
    await writeFile(file, "# mine\n\n# graphify\nuse the graph first\n");
    assert.deepEqual(await findGraphifySetup(repo, home), [file]);
  });
});

test("the graphify skill directory is reported", async () => {
  await withDirs(async (home, repo) => {
    const dir = join(home, ".claude", "skills", "graphify");
    await mkdir(dir, { recursive: true });
    assert.deepEqual(await findGraphifySetup(repo, home), [dir]);
  });
});

test("German words by language, and nothing on disk changes", async () => {
  await withDirs(async (home, repo) => {
    const file = join(home, ".claude", "CLAUDE.md");
    const before = "# graphify\nx\n";
    await writeFile(file, before);
    const out = await capture("de", home, repo);
    assert.match(out, /vorhandene Graphify-Einrichtung gefunden/);
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("ordinary settings text and other tools' pre-tool commands do not declare Graphify", async () => {
  await withDirs(async (home, repo) => {
    const file = join(repo, ".claude", "settings.json");
    await writeFile(
      file,
      JSON.stringify({
        description: "hook-guard monitoring",
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "command", command: "node /tools/hook-guard.js" },
                { type: "command", command: 'echo "graphify hook-guard search"' },
              ],
            },
          ],
        },
      })
    );
    assert.deepEqual(await findGraphifySetup(repo, home), []);
    assert.equal(await capture("en", home, repo), "");
  });
});
