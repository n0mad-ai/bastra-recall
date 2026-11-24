// #1446: the memory browser's own writes (POST /ui/memory/edit | archive |
// restore) against a temporary vault — access, validation, file + recall
// state, revision conflicts, private memories, archive/undo and rule memories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { existsSync, promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, AUTO_RELATED_START } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { readSettings, mutateSettings, settingsFilePath } from "../src/settings-file.js";
import { resetSaveFailures, saveMemoryHandler } from "../src/tool-handlers.js";
import { createServer } from "node:http";
import { handleUiMemoryEdit } from "../src/webui-memory-edit.js";
import { chatHistory, storedConversationId } from "../src/chat-history.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function memory(id: string, extra: string[] = [], body = `Body fixture ${id}.\n`): string {
  return [
    "---",
    `id: ${id}`,
    `title: Fixture ${id}`,
    "type: lesson",
    `summary: Summary of ${id}`,
    "topic_path: [test]",
    "tags: [alpha, beta]",
    "scope: edit-fixture",
    "recall_when: [fixture]",
    "created: 2026-11-14",
    "updated: 2026-11-14",
    ...extra,
    "---",
    body,
  ].join("\n");
}

const AUTO = `${AUTO_RELATED_START}\n- [[note]]\n<!-- bastra:auto-related:end -->\n`;

interface Res {
  status: number;
  body: any;
}
function call(port: number, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) {
  return new Promise<Res>((resolve, reject) => {
    const raw = payload === undefined ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { ...(raw !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      },
      (res) => {
        let out = "";
        res.on("data", (b) => (out += b));
        res.on("end", () => {
          let body: any = out;
          try {
            body = JSON.parse(out);
          } catch {
            /* plain */
          }
          resolve({ status: res.statusCode!, body });
        });
      }
    );
    req.on("error", reject);
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ui-memory-edit-"));
  const files: Record<string, string> = {
    note: memory("note", ["write_origin: agent-session"], `\nBody fixture note.\n\n${AUTO}`),
    "user-note": memory("user-note", ["write_origin: user-directed"]),
    secret: memory("secret", ["sensitivity: private"]),
    rule: memory("rule", ["rulebook: on-demand", "applies_when: Before writing fixtures."]),
    proposal: memory("proposal", [
      "write_origin: agent-session",
      "rulebook_proposed:",
      "  rulebook: always",
      "  applies_when: In every fixture session.",
    ]),
  };
  for (const [id, text] of Object.entries(files)) await writeFile(join(dir, `${id}.md`), text);
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry(),
    original = await readSettings();
  await mutateSettings(settingsFilePath(), (s) => ({ ...s, ui: { ...s.ui, enabled: true } }));
  const owner = (await stat(dir)).uid;
  const handles: Array<Awaited<ReturnType<typeof startHttpServer>>> = [];
  const start = async (
    platform: NodeJS.Platform = "darwin",
    embeddingVectors?: () => ReadonlyMap<string, Float32Array> | null
  ) => {
    const handle = await startHttpServer({
      port: 0,
      vault,
      search,
      telemetry,
      version: "test",
      toolDeps: { vault, search, telemetry, vaultPath: dir },
      documentWriteEnabled: false,
      embedding: { on: false, providerId: null, source: "none" },
      embeddingVectors,
      localAccount: { platform, euid: () => owner, lookup: async () => owner },
    });
    handles.push(handle);
    return handle.port!;
  };
  return {
    dir,
    vault,
    search,
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    start,
    file: (id: string) => readFile(join(dir, `${id}.md`), "utf8"),
    async node(port: number, id: string) {
      return (await call(port, "GET", `/ui/graph/node?id=${id}`)).body;
    },
    async close() {
      for (const h of handles) await h.close();
      search.stop();
      await vault.stop();
      await mutateSettings(settingsFilePath(), () => original);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("edit: access — UI off is 404, a foreign browser origin is refused, a forwarded request needs the token", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    const { revision } = await f.node(port, "note");
    const edit = { id: "note", expected_revision: revision, scope: "other-area" };
    for (const path of ["/ui/memory/edit", "/ui/memory/archive", "/ui/memory/restore"]) {
      const foreign = await call(port, "POST", path, edit, { origin: "https://attacker.example" });
      assert.equal(foreign.status, 403, `${path} from a foreign origin`);
      const forwarded = await call(port, "POST", path, edit, { "X-Forwarded-For": "203.0.113.1" });
      assert.equal(forwarded.status, 401, `${path} through a proxy`);
    }
    await mutateSettings(settingsFilePath(), (s) => ({ ...s, ui: { ...s.ui, enabled: false } }));
    assert.equal((await call(port, "POST", "/ui/memory/edit", edit)).status, 404);
    assert.match(await f.file("note"), /scope: edit-fixture/, "nothing written");
  } finally {
    await f.close();
  }
});

test("edit: strict validation — nothing written, nothing shortened", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    const { revision } = await f.node(port, "note");
    const before = await f.file("note");
    const bad: Array<[unknown, RegExp | null]> = [
      ["{not json", null],
      [{ id: "note", summary: "x" }, /expected_revision/],
      [{ id: "note", expected_revision: "updated-today", summary: "x" }, /expected_revision/],
      [{ id: "note", expected_revision: revision, write_origin: "user-directed" }, /Unrecognized/],
      [{ id: "note", expected_revision: revision, title: "  " }, /title/],
      [{ id: "note", expected_revision: revision, title: "Two\nlines" }, /title/],
      [{ id: "note", expected_revision: revision, scope: "   " }, /scope/],
      [{ id: "note", expected_revision: revision, scope: "../other-area" }, /scope/],
      [{ id: "note", expected_revision: revision, scope: "two\nlines" }, /scope/],
      [{ id: "note", expected_revision: revision, scope: " edit-fixture " }, /nothing to change/],
      [{ id: "note", expected_revision: revision, rule_decision: "accept", scope: "other-area" }, /stands alone/],
      [{ id: "note", expected_revision: revision, type: "doc" }, /type/],
      [{ id: "note", expected_revision: revision, type: "novel" }, /type/],
      [{ id: "note", expected_revision: revision, sensitivity: "secret" }, /sensitivity/],
      [{ id: "note", expected_revision: revision, recall_mode: "always" }, /recall_mode/],
      [{ id: "note", expected_revision: revision, title: "Fixture note", type: "lesson" }, /nothing to change/],
      [{ id: "note", expected_revision: revision, rule_decision: "accept", title: "x" }, /stands alone/],
      [{ id: "note", expected_revision: revision, summary: "y".repeat(401) }, /at most 400/],
      [{ id: "note", expected_revision: revision, summary: "   " }, /summary/],
      [{ id: "note", expected_revision: revision, tags: [] }, /tags/],
      [{ id: "note", expected_revision: revision, tags: ["ok", " "] }, /tags/],
      [{ id: "note", expected_revision: revision, rule: { rulebook: "always", applies_when: " " } }, /applies_when/],
      [{ id: "note", expected_revision: revision, rule: { rulebook: "sometimes", applies_when: "x" } }, /rulebook/],
      [{ id: "note", expected_revision: revision, summary: "Summary of note" }, /nothing to change/],
      [{ id: "note", expected_revision: revision, rule_decision: "accept", summary: "x" }, /stands alone/],
    ];
    for (const [payload, error] of bad) {
      const r = await call(port, "POST", "/ui/memory/edit", payload);
      assert.equal(r.status, 400, JSON.stringify(payload));
      if (error) assert.match(r.body.error, error);
    }
    const huge = await call(port, "POST", "/ui/memory/edit", {
      id: "note",
      expected_revision: revision,
      body: "z".repeat(300 * 1024),
    });
    assert.equal(huge.status, 413, "over the general body limit: refused, not cut");
    assert.equal(await f.file("note"), before, "no request above wrote anything");
  } finally {
    await f.close();
  }
});

test("edit: body, summary and tags land in the file and in recall; the auto-related block stays", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    const node = await f.node(port, "note");
    assert.match(node.revision, /^sha256:[0-9a-f]{16}$/);
    assert.deepEqual(node.rule, { state: "note" });
    const r = await call(port, "POST", "/ui/memory/edit", {
      id: "note",
      expected_revision: node.revision,
      body: "Rewritten by the user: zebracorn appears here.\r\n\r\n- with a list",
      summary: "  New summary  ",
      tags: [" alpha", "gamma "],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(r.body.revision, node.revision);
    const text = await f.file("note");
    assert.match(text, /\nRewritten by the user: zebracorn appears here\.\n\n- with a list\n/);
    assert.doesNotMatch(text, /Body fixture note/);
    assert.ok(text.includes(AUTO_RELATED_START), "the generated block is untouched");
    assert.match(text, /summary: New summary/);
    assert.match(text, /- alpha\n\s*- gamma/);
    assert.match(text, /write_origin: agent-session/, "origin and other fields are not rewritten");
    const after = await f.node(port, "note");
    assert.equal(after.revision, r.body.revision, "the reader's next edit uses the new revision");
    assert.match(after.body, /zebracorn/);
    const hits = await f.search.recallHybrid("zebracorn", { k: 5, allow_private: false });
    assert.equal(hits[0]?.id, "note", "recall finds the new text");
    const audit = await readFile(join(f.dir, ".bastra", "audit-log.ndjson"), "utf8");
    const last = JSON.parse(audit.trim().split("\n").pop()!);
    assert.equal(last.actor, "user");
    assert.equal(last.actor_detail, "ui:memory-browser");
  } finally {
    await f.close();
  }
});

test("edit: a stale revision is a conflict — nothing overwritten", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    const { revision } = await f.node(port, "user-note");
    const first = await call(port, "POST", "/ui/memory/edit", {
      id: "user-note",
      expected_revision: revision,
      body: "First writer wins.",
    });
    assert.equal(first.status, 200);
    const second = await call(port, "POST", "/ui/memory/edit", {
      id: "user-note",
      expected_revision: revision,
      body: "Second writer with the old revision.",
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.conflict, true);
    assert.match(await f.file("user-note"), /First writer wins\./);
    // An edit on disk the index has not seen yet is refused the same way.
    const fresh = (await f.node(port, "user-note")).revision;
    const newer = memory("user-note", ["write_origin: user-directed"], "Edited in Obsidian.\n");
    await writeFile(join(f.dir, "user-note.md"), newer);
    const third = await call(port, "POST", "/ui/memory/edit", {
      id: "user-note",
      expected_revision: fresh,
      scope: "other-area",
    });
    assert.equal(third.status, 409);
    assert.equal(await f.file("user-note"), newer);
    const archive = await call(port, "POST", "/ui/memory/archive", { id: "note", expected_revision: revision });
    assert.equal(archive.status, 409, "archive with a revision of another state is refused");
    assert.ok(existsSync(join(f.dir, "note.md")));
  } finally {
    await f.close();
  }
});

test("archive refuses an on-disk revision newer than the reader even before index refresh", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    const { revision } = await f.node(port, "note");
    const updated = memory("note", ["write_origin: user-directed"], "Newer work saved in another editor.\n");
    await writeFile(join(f.dir, "note.md"), updated);
    const r = await call(port, "POST", "/ui/memory/archive", { id: "note", expected_revision: revision });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.conflict, true);
    assert.equal(await f.file("note"), updated, "the unseen newer version remains active");
  } finally {
    await f.close();
  }
});

test("private memories: editable and archivable only where the UI shows them", async () => {
  const f = await fixture();
  try {
    const owner = await f.start("darwin"),
      unproven = await f.start("linux");
    const { revision } = await f.node(owner, "secret");
    const edit = { id: "secret", expected_revision: revision, summary: "Leaked?" };
    for (const path of ["/ui/memory/edit", "/ui/memory/archive"]) {
      const r = await call(
        unproven,
        "POST",
        path,
        path.endsWith("edit") ? edit : { id: "secret", expected_revision: revision }
      );
      assert.equal(r.status, 404, `${path} without a proven account`);
      assert.doesNotMatch(JSON.stringify(r.body), /Summary of secret|Body fixture/);
    }
    assert.match(await f.file("secret"), /summary: Summary of secret/);
    const ok = await call(owner, "POST", "/ui/memory/edit", edit);
    assert.equal(ok.status, 200);
    assert.match(await f.file("secret"), /summary: Leaked\?/);
    assert.match(await f.file("secret"), /sensitivity: private/, "sensitivity survives the edit");
    const archived = await call(owner, "POST", "/ui/memory/archive", {
      id: "secret",
      expected_revision: ok.body.revision,
    });
    assert.equal(archived.status, 200);
    assert.equal((await call(unproven, "POST", "/ui/memory/restore", { id: "secret" })).status, 404, "nor restorable");
    assert.equal(f.vault.get("secret"), undefined);
  } finally {
    await f.close();
  }
});

test("archive moves into the vault trash, restore brings it back", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    const { revision } = await f.node(port, "note");
    const r = await call(port, "POST", "/ui/memory/archive", { id: "note", expected_revision: revision });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.archived_to, /^\.bastra\/trash\//);
    assert.ok(!existsSync(join(f.dir, "note.md")));
    assert.ok((await readdir(join(f.dir, ".bastra", "trash"))).some((n) => n.startsWith("note")));
    assert.equal(f.vault.get("note"), undefined, "out of the index at once");
    assert.equal((await call(port, "GET", "/ui/graph/node?id=note")).status, 404);
    const back = await call(port, "POST", "/ui/memory/restore", { id: "note" });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.ok(existsSync(join(f.dir, "note.md")));
    assert.ok(f.vault.get("note"));
    assert.equal((await call(port, "POST", "/ui/memory/restore", { id: "note" })).status, 404, "trash is empty again");
    assert.equal((await call(port, "POST", "/ui/memory/restore", { id: "never-was" })).status, 404);
  } finally {
    await f.close();
  }
});

test("care annotations hide private notes and reject edits like unknown IDs while public ghosts remain writable", async () => {
  const f = await fixture();
  try {
    const publicPath = join(f.dir, "user-note.md");
    await writeFile(publicPath, memory("user-note", ["related: [public-ghost]"]));
    await f.vault.reindexFile(publicPath);
    const carePath = join(f.dir, "vault-care.md");
    const initial = [
      "- [ ] 2026-11-16 · note · [[secret]] — Private care text.",
      "- [ ] 2026-11-16 · note · [[note]] — Public care text.",
      "- [ ] 2026-11-16 · write · [[public-ghost]] — Public unwritten note.",
      "- [ ] 2026-11-16 · note · [[unknown]] — Orphan care text.",
      "",
    ].join("\n");
    await writeFile(carePath, initial);
    const unproven = await f.start("linux");
    const owner = await f.start("darwin");
    const skill = await call(unproven, "POST", "/ui/skills", { id: "secret" });
    assert.equal(skill.status, 200, "a skill alias cannot grant access to a private memory with that ID");
    const list = await call(unproven, "GET", "/ui/annotations");
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.annotations.map((a: { id: string }) => a.id),
      ["note", "public-ghost"]
    );
    const full = await call(owner, "GET", "/ui/annotations");
    assert.equal(full.body.annotations.length, 4, "a proven owner sees the complete care list");
    const edit = (id: string, note: string) => ({
      id,
      kind: "note",
      note: "Unauthorized change.",
      previous: { kind: "note", date: "2026-11-16", note },
    });
    const hidden = await call(unproven, "POST", "/ui/annotate", edit("secret", "Private care text."));
    const absent = await call(unproven, "POST", "/ui/annotate", edit("unknown", "Orphan care text."));
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden, absent, "hidden and unknown targets have the same generic response");
    assert.equal(await readFile(carePath, "utf8"), initial, "neither denied request edits the care file");
    const ghost = await call(unproven, "POST", "/ui/annotate", {
      id: "public-ghost",
      kind: "write",
      note: "Edited public ghost.",
      previous: { kind: "write", date: "2026-11-16", note: "Public unwritten note." },
    });
    assert.equal(ghost.status, 200, JSON.stringify(ghost.body));
    assert.match(await readFile(carePath, "utf8"), /Private care text/);
  } finally {
    await f.close();
  }
});

test("save-memory hides private collision and source metadata without a proven account", async () => {
  const f = await fixture();
  try {
    const port = await f.start("linux");
    const base = { type: "reference", scope: "save-privacy", body: "Synthetic answer." };
    const secretBefore = await f.file("secret"),
      filesBefore = (await readdir(f.dir, { recursive: true })).sort();
    // Reference: what the public save path (/api/v1, stdio — no access) answers for the same title.
    resetSaveFailures();
    const publicRefusal = await saveMemoryHandler(f.toolDeps, {
      ...base,
      title: "Secret",
      summary: "Synthetic answer.",
      topic_path: ["save-privacy"],
      tags: ["save-privacy"],
      recall_when: ["Secret"],
    }).then(
      () => assert.fail("the public save path must refuse a hidden target"),
      (error: Error) => error.message
    );
    resetSaveFailures();
    const collision = await call(port, "POST", "/ui/save-memory", { ...base, title: "Secret" });
    assert.deepEqual(
      collision,
      { status: 500, body: { error: `save failed: ${publicRefusal}` } },
      "a hidden collision is a plain save failure, worded like the public save path: no code, no existing, no 409"
    );
    assert.equal(await f.file("secret"), secretBefore, "the private memory is untouched");
    assert.deepEqual((await readdir(f.dir, { recursive: true })).sort(), filesBefore, "no new file, no duplicate");
    const proven = await call(await f.start("darwin"), "POST", "/ui/save-memory", { ...base, title: "Secret" });
    assert.equal(proven.status, 409, "a proven account keeps the named collision");
    assert.equal(proven.body.code, "exists");
    assert.deepEqual(proven.body.existing, [{ id: "secret", title: "Fixture secret" }]);
    resetSaveFailures();
    const held = await call(port, "POST", "/ui/save-memory", {
      ...base,
      title: "Fixture",
      type: "lesson",
      scope: "edit-fixture",
    });
    assert.equal(held.status, 409);
    assert.ok(
      held.body.existing.every((item: { id: string }) => item.id !== "secret"),
      "claim metadata hides private memories"
    );
    const saved = await call(port, "POST", "/ui/save-memory", {
      ...base,
      title: "Answer from a protected source",
      sources: ["secret"],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(f.vault.get(saved.body.id)?.fm.sensitivity, "private", "the stored protection is never reduced");
    assert.equal(saved.body.private_sources, undefined, "source classifications require a proven account");
    assert.equal(saved.body.sensitivity, undefined, "source classification cannot be inferred from the saved metadata");
  } finally {
    await f.close();
  }
});

test("the user's explicit rule declaration binds on a proposed note without accepting an archive proposal", async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, "proposal.md");
    await writeFile(
      path,
      memory("proposal", [
        "write_origin: agent-session",
        "rulebook_proposed:",
        "  rulebook: always",
        "  applies_when: In every fixture session.",
        "  archive: true",
      ])
    );
    await f.vault.reindexFile(path);
    const port = await f.start();
    const { revision } = await f.node(port, "proposal");
    const r = await call(port, "POST", "/ui/memory/edit", {
      id: "proposal",
      expected_revision: revision,
      rule: { rulebook: "on-demand", applies_when: "When the user edits a fixture." },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.rule.state, "rule", "the user's explicit declaration is binding");
    const fm = f.vault.get("proposal")!.fm;
    assert.equal(fm.write_origin, "user-directed");
    assert.equal(fm.rulebook, "on-demand");
    assert.equal(fm.applies_when, "When the user edits a fixture.");
    assert.equal(fm.rulebook_proposed?.archive, true, "an unrelated archive proposal is not accepted");
    assert.ok(existsSync(path), "the memory stays active");
  } finally {
    await f.close();
  }
});

test("rule memories: state shown, a rule's applies_when edits directly, the user's declaration binds", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    const rule = await f.node(port, "rule");
    assert.deepEqual(rule.rule, {
      state: "rule",
      rulebook: "on-demand",
      applies_when: "Before writing fixtures.",
      delivered: true,
    });
    const edited = await call(port, "POST", "/ui/memory/edit", {
      id: "rule",
      expected_revision: rule.revision,
      rule: { rulebook: "always", applies_when: "Before any fixture work." },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.rule.state, "rule");
    assert.equal(edited.body.rule.rulebook, "always");
    assert.match(await f.file("rule"), /applies_when: Before any fixture work\./);

    // An agent's note the user turns into a rule in the browser: a rule, not a proposal.
    const note = await f.node(port, "note");
    const declared = await call(port, "POST", "/ui/memory/edit", {
      id: "note",
      expected_revision: note.revision,
      rule: { rulebook: "on-demand", applies_when: "When fixtures change." },
    });
    assert.equal(declared.status, 200, JSON.stringify(declared.body));
    assert.equal(declared.body.rule.state, "rule");
    const text = await f.file("note");
    assert.match(text, /rulebook: on-demand/);
    assert.match(text, /write_origin: user-directed/);
    assert.doesNotMatch(text, /rulebook_proposed/);
    assert.equal((await f.node(port, "note")).revision, declared.body.revision);

    // A pending agent proposal: shown as such, the user accepts or rejects it.
    const proposal = await f.node(port, "proposal");
    assert.equal(proposal.rule.state, "proposal");
    assert.equal(proposal.rule.rulebook, "always");
    const accepted = await call(port, "POST", "/ui/memory/edit", {
      id: "proposal",
      expected_revision: proposal.revision,
      rule_decision: "accept",
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.rule.state, "rule");
    const rejected = await call(port, "POST", "/ui/memory/edit", {
      id: "user-note",
      expected_revision: (await f.node(port, "user-note")).revision,
      rule_decision: "reject",
    });
    assert.equal(rejected.status, 400, "no pending proposal to decide");
  } finally {
    await f.close();
  }
});

// ── #1558: the user's fields from the reader ──

const GITHUB_TOKEN = ["gh", "p_", "a1B2c3D4e5F6", "g7H8i9J0k1L2", "m3N4o5P6q7R8"].join("");

test("user fields: editing the area updates the reader and recall at the same file path", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    const node = await f.node(port, "note");
    const r = await call(port, "POST", "/ui/memory/edit", {
      id: "note",
      expected_revision: node.revision,
      scope: "  Neue Planung  ",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await f.node(port, "note");
    assert.equal(after.revision, r.body.revision);
    assert.equal(after.scope, "Neue Planung");
    assert.equal(after.file, node.file);
    assert.deepEqual(after.topic_path, node.topic_path);
    const text = await f.file("note");
    assert.match(text, /scope: Neue Planung\n/);
    assert.match(text, /write_origin: agent-session\n/);
    const hits = await f.search.recallHybrid("Fixture note", { scope: "Neue Planung" });
    assert.equal(hits.find((h) => h.id === "note")?.scope, "Neue Planung");
    const old = await f.search.recallHybrid("Fixture note", { scope: node.scope });
    assert.ok(!old.some((h) => h.id === "note"));
  } finally {
    await f.close();
  }
});

test("user fields: title, type and recall mode land in the file and in recall; the file stays put", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    const node = await f.node(port, "note");
    const r = await call(port, "POST", "/ui/memory/edit", {
      id: "note",
      expected_revision: node.revision,
      title: "  Renamed quokkafield  ",
      type: "decision",
      recall_mode: "reflex",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const text = await f.file("note");
    assert.match(text, /title: Renamed quokkafield\n/);
    assert.match(text, /type: decision/);
    assert.match(text, /scope: edit-fixture/, "the area is not changed here");
    assert.match(text, /recall_mode: reflex/);
    assert.match(text, /write_origin: agent-session/, "origin is not rewritten");
    assert.match(text, /summary: Summary of note/, "untouched fields stay");
    assert.deepEqual(await readdir(f.dir).then((x) => x.filter((n) => n.endsWith(".md")).sort()), [
      "note.md",
      "proposal.md",
      "rule.md",
      "secret.md",
      "user-note.md",
    ]);
    const after = await f.node(port, "note");
    assert.equal(after.revision, r.body.revision);
    assert.equal(after.title, "Renamed quokkafield");
    assert.equal(after.type, "decision");
    assert.equal(after.recall_mode, "reflex");
    const hits = await f.search.recallHybrid("quokkafield", { k: 5, allow_private: false });
    assert.equal(hits[0]?.id, "note", "recall finds the new title");
    const audit = await readFile(join(f.dir, ".bastra", "audit-log.ndjson"), "utf8");
    const last = JSON.parse(audit.trim().split("\n").pop()!);
    assert.equal(last.actor, "user");
    assert.match(last.reason, /fields/);
    // a user-directed memory set to reflex becomes a rule, as after a save
    const user = await f.node(port, "user-note");
    const reflex = await call(port, "POST", "/ui/memory/edit", {
      id: "user-note",
      expected_revision: user.revision,
      recall_mode: "reflex",
    });
    assert.equal(reflex.status, 200, JSON.stringify(reflex.body));
    assert.equal(reflex.body.rule.state, "rule");
  } finally {
    await f.close();
  }
});

test("user fields: a stale revision is a conflict, a credential in the title is redacted", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    const { revision } = await f.node(port, "user-note");
    const first = await call(port, "POST", "/ui/memory/edit", {
      id: "user-note",
      expected_revision: revision,
      body: "x",
    });
    assert.equal(first.status, 200);
    const before = await f.file("user-note");
    const stale = await call(port, "POST", "/ui/memory/edit", {
      id: "user-note",
      expected_revision: revision,
      title: "Stale rename",
      sensitivity: "public",
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.conflict, true);
    assert.equal(await f.file("user-note"), before, "nothing written");
    const secret = await call(port, "POST", "/ui/memory/edit", {
      id: "user-note",
      expected_revision: first.body.revision,
      title: `Deploy key ${GITHUB_TOKEN}`,
    });
    assert.equal(secret.status, 200, JSON.stringify(secret.body));
    const text = await f.file("user-note");
    assert.ok(!text.includes(GITHUB_TOKEN), "the token never reaches the file");
    assert.match(text, /title: .*\[REDACTED\]/);
  } finally {
    await f.close();
  }
});

test("user fields: to private leaves the unproven views at once; from private only where it is shown", async () => {
  const f = await fixture();
  try {
    const owner = await f.start("darwin"),
      unproven = await f.start("linux");
    // public → private from a view that cannot show private memories: allowed (it only hides more)
    const note = await f.node(unproven, "note");
    const hide = await call(unproven, "POST", "/ui/memory/edit", {
      id: "note",
      expected_revision: note.revision,
      sensitivity: "private",
    });
    assert.equal(hide.status, 200, JSON.stringify(hide.body));
    assert.match(await f.file("note"), /sensitivity: private/);
    assert.equal((await call(unproven, "GET", "/ui/graph/node?id=note")).status, 404);
    const graph = (await call(unproven, "GET", "/ui/graph")).body;
    assert.ok(!graph.nodes.some((n: { id: string }) => n.id === "note"), "gone from the unproven graph");
    const hits = await f.search.recallHybrid("Fixture note", { k: 10, allow_private: false });
    assert.ok(!hits.some((h) => h.id === "note"), "recall without private access no longer finds it");
    assert.equal((await f.node(owner, "note")).sensitivity, "private", "the owner still sees it");
    // private → public: only where the memory is shown
    const secret = await f.node(owner, "secret");
    const blind = await call(unproven, "POST", "/ui/memory/edit", {
      id: "secret",
      expected_revision: secret.revision,
      sensitivity: "public",
      scope: "other-area",
    });
    assert.equal(blind.status, 404);
    assert.doesNotMatch(JSON.stringify(blind.body), /Summary of secret/);
    assert.match(await f.file("secret"), /sensitivity: private/);
    assert.equal((await f.node(owner, "secret")).scope, secret.scope);
    const shown = await call(owner, "POST", "/ui/memory/edit", {
      id: "secret",
      expected_revision: secret.revision,
      sensitivity: "public",
    });
    assert.equal(shown.status, 200);
    assert.equal((await call(unproven, "GET", "/ui/graph/node?id=secret")).status, 200);
  } finally {
    await f.close();
  }
});

test("user fields: a sensitivity change drops the cached semantic layouts", async () => {
  const f = await fixture();
  const layout = () => ({ at: Date.now(), body: { nodes: [{ id: "note", title: "Fixture note" }] } as never });
  const server = {
    semanticCache: layout(),
    uiSemanticCache: layout(),
    semanticInflight: null,
    uiSemanticInflight: null,
  };
  const ctx = { toolDeps: f.toolDeps, privateGraph: true, server };
  const http = createServer((req, res) => void handleUiMemoryEdit(req, res, ctx));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const port = (http.address() as { port: number }).port;
    const revision = () => f.vault.get("note")!.revision;
    const title = await call(port, "POST", "/", { id: "note", expected_revision: revision(), title: "Renamed" });
    assert.equal(title.status, 200, JSON.stringify(title.body));
    assert.ok(server.semanticCache && server.uiSemanticCache, "other fields keep the caches");
    const hide = await call(port, "POST", "/", { id: "note", expected_revision: revision(), sensitivity: "private" });
    assert.equal(hide.status, 200, JSON.stringify(hide.body));
    assert.equal(server.semanticCache, null, "the filtered layout must not keep the now private memory");
    assert.equal(server.uiSemanticCache, null);
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await f.close();
  }
});

test("a layout in progress cannot re-publish a memory the reader made private", { timeout: 5000 }, async () => {
  const f = await fixture();
  const vectors = new Map([
    ["note", new Float32Array([1, 0, 0])],
    ["user-note", new Float32Array([0, 1, 0])],
  ]);
  const held = deferred<() => void>();
  const getVector = vectors.get.bind(vectors);
  const immediate = globalThis.setImmediate;
  let intercepted = false;
  vectors.get = (id) => {
    if (id === "note" && !intercepted) {
      intercepted = true;
      // The graph is already snapshotted. Hold only the layout's first PCA yield,
      // then restore the scheduler before the UI sends its write.
      globalThis.setImmediate = ((continuation: () => void) => {
        globalThis.setImmediate = immediate;
        held.resolve(continuation);
      }) as typeof setImmediate;
    }
    return getVector(id);
  };
  try {
    const port = await f.start("darwin", () => vectors);
    const path = "/api/v1/graph/semantic";
    const pending = call(port, "GET", path);
    const resume = await held.promise;
    let hidden: Res;
    try {
      const expected_revision = f.vault.get("note")!.revision;
      hidden = await call(port, "POST", "/ui/memory/edit", { id: "note", expected_revision, sensitivity: "private" });
    } finally {
      resume();
    }
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    for (const response of [await pending, await call(port, "GET", path)]) {
      assert.equal(response.status, 200);
      assert.deepEqual(
        response.body.positions.map((p: { id: string }) => p.id),
        ["user-note"]
      );
      assert.deepEqual(response.body.edges, []);
    }
    const owner = await call(port, "GET", "/ui/graph/semantic");
    assert.equal(owner.status, 200);
    assert.deepEqual(owner.body.positions.map((p: { id: string }) => p.id).sort(), ["note", "user-note"]);
  } finally {
    globalThis.setImmediate = immediate;
    await f.close();
  }
});

test("graph reads in progress use the visibility in effect when they answer", { timeout: 5000 }, async () => {
  const f = await fixture();
  const readDir = fs.readdir;
  const entered = deferred<void>();
  const resume = deferred<void>();
  let pending = 0;
  try {
    const port = await f.start();
    fs.readdir = (async (...args: Parameters<typeof readDir>) => {
      const [path] = args;
      if (path === process.env.BASTRA_LOG_PATH) {
        if (++pending === 2) entered.resolve();
        await resume.promise;
      }
      return readDir(...args);
    }) as typeof fs.readdir;
    syncBuiltinESMExports();
    const graph = call(port, "GET", "/api/v1/graph");
    const node = call(port, "GET", "/api/v1/graph/node?id=note");
    await entered.promise;
    try {
      const expected_revision = f.vault.get("note")!.revision;
      const hidden = await call(port, "POST", "/ui/memory/edit", {
        id: "note",
        expected_revision,
        sensitivity: "private",
      });
      assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    } finally {
      resume.resolve();
    }
    const [detail, result] = await Promise.all([node, graph]);
    assert.deepEqual(
      {
        detail: detail.status,
        graph: result.status,
        published: result.body.nodes.some((n: { id: string }) => n.id === "note"),
      },
      { detail: 404, graph: 200, published: false }
    );
  } finally {
    fs.readdir = readDir;
    syncBuiltinESMExports();
    resume.resolve();
    await f.close();
  }
});

test("rule state names, per type and recall mode, where those fields decide the rule", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    // a user-directed lesson: a note now, a rule as a preference or in reflex mode
    const user = (await f.node(port, "user-note")).rule;
    assert.equal(user.state, "note");
    assert.equal(user.by_type_mode["lesson deliberate"], false);
    assert.equal(user.by_type_mode["user-preference deliberate"], true);
    assert.equal(user.by_type_mode["lesson reflex"], true);
    // a declared rule and an agent's note: type and recall mode change nothing
    assert.equal((await f.node(port, "rule")).rule.by_type_mode, undefined);
    assert.equal((await f.node(port, "note")).rule.by_type_mode, undefined);
    // the save answers with the new state, the map still there
    const { revision } = await f.node(port, "user-note");
    const saved = await call(port, "POST", "/ui/memory/edit", {
      id: "user-note",
      expected_revision: revision,
      type: "user-preference",
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.rule.state, "rule", "the type change made it a rule");
    assert.equal(saved.body.rule.by_type_mode["lesson deliberate"], false);
  } finally {
    await f.close();
  }
});

test("#1469/#1496: the web UI's save, edit, rule decision, archive and restore name the web UI", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    const webui = { transport: "webui", client: "bastra-web-ui", session: null };
    const evidenceOf = (id: string) => {
      const { at, ...rest } = f.vault.get(id)!.fm.write_origin_evidence ?? ({} as { at?: string });
      assert.ok(!Number.isNaN(Date.parse(at ?? "")), "with the time of the call");
      return rest;
    };
    const saved = await call(port, "POST", "/ui/save-memory", {
      title: "Weekly planning on Monday",
      type: "reference",
      scope: "planning",
      body: "## Weekly planning\n\nPlan the week on Monday morning.",
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(f.vault.get(saved.body.id)!.fm.write_origin, "user-directed");
    assert.deepEqual(evidenceOf(saved.body.id), webui, "the UI save carries its origin evidence");

    const edited = await call(port, "POST", "/ui/memory/edit", {
      id: "note",
      expected_revision: (await f.node(port, "note")).revision,
      summary: "Edited in the reader",
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const accepted = await call(port, "POST", "/ui/memory/edit", {
      id: "proposal",
      expected_revision: (await f.node(port, "proposal")).revision,
      rule_decision: "accept",
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(f.vault.get("proposal")!.fm.write_origin, "user-directed");
    assert.deepEqual(evidenceOf("proposal"), webui, "an accepted proposal carries the evidence of the decision");

    const archived = await call(port, "POST", "/ui/memory/archive", {
      id: "note",
      expected_revision: (await f.node(port, "note")).revision,
    });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal((await call(port, "POST", "/ui/memory/restore", { id: "note" })).status, 200);

    const rows = (await readFile(join(f.dir, ".bastra", "audit-log.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      rows.map((r) => [r.memory_id, r.transport, r.client, r.caller_session]),
      [
        [saved.body.id, "webui", "bastra-web-ui", null],
        ["note", "webui", "bastra-web-ui", null],
        ["proposal", "webui", "bastra-web-ui", null],
        ["note", "webui", "bastra-web-ui", null],
        ["note", "webui", "bastra-web-ui", null],
      ],
      "save, edit, decision, archive and restore: one row each, all from the web UI"
    );
  } finally {
    await f.close();
  }
});

test("#1496: a Web UI save records its stored conversation in the memory and audit", async (t) => {
  const dbDir = await mkdtemp(join(tmpdir(), "ui-save-chat-db-"));
  const previousDbPath = process.env.BASTRA_DB_PATH;
  const dbPath = join(dbDir, "recall.db");
  process.env.BASTRA_DB_PATH = dbPath;
  t.after(async () => {
    if (previousDbPath === undefined) delete process.env.BASTRA_DB_PATH;
    else process.env.BASTRA_DB_PATH = previousDbPath;
    await rm(dbDir, { recursive: true, force: true });
  });
  assert.equal(storedConversationId("not-a-conversation"), null);
  assert.equal(existsSync(dbPath), false, "a malformed id must not open the chat store");

  // Settings use the app database too. Enable the UI in the same database
  // as the chat history so the platform's default does not affect this test.
  const f = await fixture();
  try {
    assert.equal((await readSettings()).ui?.enabled, true);
    const port = await f.start();
    async function assertSave(title: string, conversation_id: string, expectedSession: string | null) {
      const saved = await call(port, "POST", "/ui/save-memory", {
        title,
        type: "reference",
        scope: "planning",
        body: `My edited notes about ${title}.`,
        conversation_id,
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const evidence = f.vault.get(saved.body.id)?.fm.write_origin_evidence;
      assert.equal(evidence?.session, expectedSession);
      const row = (await readFile(join(f.dir, ".bastra", "audit-log.ndjson"), "utf8")).trim().split("\n").at(-1)!;
      assert.equal(JSON.parse(row).caller_session, expectedSession);
    }
    const history = chatHistory();
    const conversationId = history.append(null, "When do I plan the week?", "On Monday morning.", []);
    const deletedId = history.append(null, "When do I review the month?", "On the first day.", []);
    history.remove(deletedId);
    await assertSave("Archive routine", "not-a-conversation", null);
    await assertSave("Week planning", conversationId, conversationId);
    await assertSave("Month review", deletedId, null);
    t.mock.method(history, "has", () => {
      throw new Error("history unavailable");
    });
    await assertSave("Planning routine", conversationId, null);
  } finally {
    await f.close();
  }
});
