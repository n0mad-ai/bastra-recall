/**
 * #242 — the vault watcher must actually emit events.
 *
 * From 2026-05-31 (chokidar 5 bump) until this test existed, `startWatching()`
 * emitted nothing at all: `chokidar.watch()` was handed a glob, and chokidar
 * dropped glob support in v4, so it watched a literal path that never existed.
 * No events, no error. A type check and a green suite cannot catch a silent
 * no-op — only an end-to-end event assertion can, which is why this file
 * asserts on delivered events rather than on configuration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault, type VaultEvent } from "../src/vault.js";

function memoryMd(id: string, body = "Body."): string {
  return `---
id: ${id}
title: Title ${id}
type: lesson
summary: summary for ${id}
topic_path: [test]
tags: [test]
scope: test
recall_when: ["when ${id}"]
created: 2026-05-01
updated: 2026-05-01
---

${body}
`;
}

/** Wait until `predicate` sees a matching event, or fail after `ms`. */
async function waitFor(
  events: VaultEvent[],
  predicate: (e: VaultEvent) => boolean,
  ms = 8000,
): Promise<VaultEvent> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `no matching watcher event within ${ms}ms — saw: ${JSON.stringify(
      events.map((e) => `${e.kind}:${"memory" in e && e.memory ? e.memory.fm.id : ""}`),
    )}`,
  );
}

async function watchedVault(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-vault-watcher-"));
  const vault = new Vault(dir);
  await vault.init();
  const events: VaultEvent[] = [];
  vault.on((e) => events.push(e));
  vault.startWatching();
  // chokidar needs a beat to finish its initial scan before writes register.
  await new Promise((r) => setTimeout(r, 300));
  t.after(async () => {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dir, vault, events };
}

test("a new .md file at the vault root produces an add event", async (t) => {
  const { dir, vault, events } = await watchedVault(t);

  await writeFile(path.join(dir, "alpha.md"), memoryMd("alpha"), "utf8");

  await waitFor(events, (e) => e.kind === "add" && e.memory?.fm.id === "alpha");
  assert.equal(vault.get("alpha")?.fm.title, "Title alpha");
});

test("a nested .md file is watched too", async (t) => {
  const { dir, vault, events } = await watchedVault(t);

  await mkdir(path.join(dir, "memories", "projects", "demo"), { recursive: true });
  await writeFile(
    path.join(dir, "memories", "projects", "demo", "beta.md"),
    memoryMd("beta"),
    "utf8",
  );

  await waitFor(events, (e) => e.kind === "add" && e.memory?.fm.id === "beta");
  assert.equal(vault.get("beta")?.fm.id, "beta");
});

test("editing and deleting a watched file produces change and remove", async (t) => {
  const { dir, vault, events } = await watchedVault(t);
  const file = path.join(dir, "gamma.md");

  await writeFile(file, memoryMd("gamma"), "utf8");
  await waitFor(events, (e) => e.kind === "add" && e.memory?.fm.id === "gamma");

  await writeFile(file, memoryMd("gamma", "Edited body."), "utf8");
  await waitFor(events, (e) => e.kind === "change" && e.memory?.fm.id === "gamma");

  await unlink(file);
  await waitFor(events, (e) => e.kind === "remove");
  assert.equal(vault.get("gamma"), undefined);
});

test("the cloud-mount polling path delivers events too", async (t) => {
  // The usePolling branch exists because fsevents/kqueue do not fire for
  // files written into a GoogleDrive/iCloud/Dropbox provider mount. It was
  // configuring a watcher that never fired, so nothing exercised it —
  // a vault path containing the marker selects that branch.
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-CloudStorage-watch-"));
  const vault = new Vault(dir);
  await vault.init();
  const events: VaultEvent[] = [];
  vault.on((e) => events.push(e));
  vault.startWatching();
  await new Promise((r) => setTimeout(r, 300));
  t.after(async () => {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  await writeFile(path.join(dir, "delta.md"), memoryMd("delta"), "utf8");

  // Polling interval is 1.5 s on cloud mounts, so allow for it.
  await waitFor(events, (e) => e.kind === "add" && e.memory?.fm.id === "delta", 12000);
  assert.equal(vault.get("delta")?.fm.id, "delta");
});

test("a file the save path already indexed must not arrive as a second add", async (t) => {
  // The save path writes the file and indexes it itself (reindexFile), because
  // the watcher is unreliable on cloud mounts. The watcher then reports the
  // very same file as a fresh "add" — and the vault used to pass that kind
  // through unchanged, so one new memory produced TWO add events. The map's
  // topbar counter follows those (+1 per add), so every save counted double
  // and only a reload put the number straight.
  const { dir, vault, events } = await watchedVault(t);
  const file = path.join(dir, "zeta.md");

  await writeFile(file, memoryMd("zeta"), "utf8");
  await vault.reindexFile(file);
  const addsOf = (): VaultEvent[] =>
    events.filter((e) => e.kind === "add" && e.memory?.fm.id === "zeta");
  assert.equal(addsOf().length, 1, "the save path itself announces the newborn once");

  // the watcher's own report for the same file must land as a change
  await waitFor(events, (e) => e.kind === "change" && e.memory?.fm.id === "zeta");
  assert.equal(addsOf().length, 1, "a second add would count the memory twice");
});

test("a watcher error is survivable — it must not take the process down", async (t) => {
  const { dir, vault, events } = await watchedVault(t);

  // FSWatcher is an EventEmitter: an unhandled "error" event terminates the
  // process, and there is no uncaughtException handler in core or daemon.
  // EMFILE is reachable for a launchd-spawned daemon at the macOS default of
  // 256 descriptors, so this has to degrade to the periodic reconcile.
  const watcher = (vault as unknown as { watcher?: { emit: (ev: string, err: Error) => void } })
    .watcher;
  assert.ok(watcher, "startWatching must have created a watcher");
  assert.doesNotThrow(() => watcher!.emit("error", new Error("EMFILE: simulated")));

  // …and the vault keeps working afterwards.
  await writeFile(path.join(dir, "epsilon.md"), memoryMd("epsilon"), "utf8");
  await waitFor(events, (e) => e.kind === "add" && e.memory?.fm.id === "epsilon");
});

test("non-markdown files and dotfolders stay out of the vault", async (t) => {
  const { dir, vault, events } = await watchedVault(t);

  await writeFile(path.join(dir, "notes.txt"), "not a memory", "utf8");
  await mkdir(path.join(dir, ".obsidian"), { recursive: true });
  await writeFile(path.join(dir, ".obsidian", "hidden.md"), memoryMd("hidden"), "utf8");

  // Anchor on a file that MUST arrive, so this isn't just a race we won.
  await writeFile(path.join(dir, "anchor.md"), memoryMd("anchor"), "utf8");
  await waitFor(events, (e) => e.kind === "add" && e.memory?.fm.id === "anchor");

  assert.equal(vault.get("hidden"), undefined, "dotfolders must stay ignored");
  assert.equal(vault.size(), 1, "only the anchor memory may be indexed");
});

test("a vault living under a dot-directory is watched — the ignore filter is relative to the root", async (t) => {
  // #365/2: the ignore predicate split the ABSOLUTE path, so a vault under
  // ~/.local/share/bastra/vault, ~/.bastra/vault or ~/.config/… matched on a
  // parent segment it does not own — chokidar ignored the entire tree and the
  // watcher emitted nothing at all, silently and forever. `init()` looks
  // perfectly healthy in that state (walkDir starts INSIDE the root and never
  // sees the parent), so only an event assertion from a dot-rooted vault
  // catches it. Every other test here lives under /var/folders/… — not one
  // dot segment among them, which is exactly how this survived.
  const base = await mkdtemp(path.join(tmpdir(), "bastra-dotroot-"));
  const dir = path.join(base, ".local", "share", "bastra", "vault");
  await mkdir(dir, { recursive: true });
  const vault = new Vault(dir);
  await vault.init();
  const events: VaultEvent[] = [];
  vault.on((e) => events.push(e));
  vault.startWatching();
  await new Promise((r) => setTimeout(r, 300));
  t.after(async () => {
    await vault.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // A dotfolder INSIDE the vault must still be ignored — the filter moved,
  // it did not go away.
  await mkdir(path.join(dir, ".obsidian"), { recursive: true });
  await writeFile(path.join(dir, ".obsidian", "hidden.md"), memoryMd("hidden"), "utf8");
  await writeFile(path.join(dir, "theta.md"), memoryMd("theta"), "utf8");

  await waitFor(events, (e) => e.kind === "add" && e.memory?.fm.id === "theta");
  assert.equal(vault.get("hidden"), undefined, "dotfolders under the root stay ignored");
  assert.equal(vault.size(), 1, "only the plain memory may be indexed");
});

test("a dot-child of the root is still ignored — a leading '..' is only an escape as a whole segment", async (t) => {
  // The relative filter has to tell "outside the root" from "a child whose
  // name happens to begin with two dots": `relative(root, root + "/..sync/x")`
  // is `"..sync/x"`, and a plain `startsWith("..")` reads that as an escape and
  // waves it through. The watcher would then index `..sync/hidden.md` while
  // `walkDir` and `reconcile` keep filtering it — one add per watcher event,
  // one remove per 60-second reconcile, forever.
  const { dir, vault, events } = await watchedVault(t);

  // "sub" is created and proven-watched *before* any other top-level entry
  // lands next to it. chokidar has no native recursive watch on any platform
  // here (it never passes `recursive: true` to fs.watch) — recursion is
  // manual, one `fs.watch` per directory, discovered via a readdir of the
  // parent that chokidar throttles to one pass/second per directory
  // (chokidar/handler.js `_handleRead`). Two brand-new top-level directories
  // created back-to-back would both compete for that single readdir of the
  // vault root; on a loaded Linux/inotify CI runner that race can cost the
  // second directory's discovery outright rather than merely delay it, which
  // is what made this test see zero events for the full 8s window. Anchoring
  // on "sub" alone first — the same shape as the earlier "a nested .md file
  // is watched too" test, which never races — sidesteps the collision
  // instead of papering over it with a longer timeout.
  await mkdir(path.join(dir, "sub"), { recursive: true });
  await writeFile(path.join(dir, "sub", "seen.md"), memoryMd("seen"), "utf8");
  await waitFor(events, (e) => e.kind === "add" && e.memory?.fm.id === "seen");

  // Now layer the dot-prefixed entries on: "sub" is already watched, so
  // writes into it no longer depend on discovering a new top-level directory.
  await mkdir(path.join(dir, "..sync"), { recursive: true });
  await writeFile(path.join(dir, "..sync", "hidden.md"), memoryMd("dotdot-child"), "utf8");
  await mkdir(path.join(dir, "sub", ".hidden"), { recursive: true });
  await writeFile(path.join(dir, "sub", ".hidden", "deep.md"), memoryMd("nested-dot"), "utf8");

  // Second anchor, so the ignored writes above are proven to have been
  // considered (and rejected) by the watcher — not just not yet reached.
  await writeFile(path.join(dir, "sub", "seen-after.md"), memoryMd("seen-after"), "utf8");
  await waitFor(events, (e) => e.kind === "add" && e.memory?.fm.id === "seen-after");

  assert.equal(vault.get("dotdot-child"), undefined, "`..sync/` is a dotfolder, not an escape");
  assert.equal(vault.get("nested-dot"), undefined, "a dotfolder deeper in the tree stays ignored");
  assert.equal(vault.size(), 2, "only the two plain nested memories may be indexed");
});
