// #1446: the memory browser's own writes (POST /ui/memory/edit | archive |
// restore) against a temporary vault — access, validation, file + recall
// state, revision conflicts, private memories, archive/undo and rule memories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, AUTO_RELATED_START } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { readSettings, mutateSettings, settingsFilePath } from "../src/settings-file.js";

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
  const start = async (platform: NodeJS.Platform = "darwin") => {
    const handle = await startHttpServer({
      port: 0,
      vault,
      search,
      telemetry,
      version: "test",
      toolDeps: { vault, search, telemetry, vaultPath: dir },
      documentWriteEnabled: false,
      embedding: { on: false, providerId: null, source: "none" },
      localAccount: { platform, euid: () => owner, lookup: async () => owner },
    });
    handles.push(handle);
    return handle.port!;
  };
  return {
    dir,
    vault,
    search,
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
    const edit = { id: "note", expected_revision: revision, summary: "Changed" };
    for (const path of ["/ui/memory/edit", "/ui/memory/archive", "/ui/memory/restore"]) {
      const foreign = await call(port, "POST", path, edit, { origin: "https://attacker.example" });
      assert.equal(foreign.status, 403, `${path} from a foreign origin`);
      const forwarded = await call(port, "POST", path, edit, { "X-Forwarded-For": "203.0.113.1" });
      assert.equal(forwarded.status, 401, `${path} through a proxy`);
    }
    await mutateSettings(settingsFilePath(), (s) => ({ ...s, ui: { ...s.ui, enabled: false } }));
    assert.equal((await call(port, "POST", "/ui/memory/edit", edit)).status, 404);
    assert.match(await f.file("note"), /summary: Summary of note/, "nothing written");
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
      [{ id: "note", expected_revision: revision, title: "Renamed" }, /title|Unrecognized/],
      [{ id: "note", expected_revision: revision, sensitivity: "private" }, /sensitivity|Unrecognized/],
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
    await writeFile(
      join(f.dir, "user-note.md"),
      memory("user-note", ["write_origin: user-directed"], "Edited in Obsidian.\n")
    );
    const third = await call(port, "POST", "/ui/memory/edit", { id: "user-note", expected_revision: fresh, body: "x" });
    assert.equal(third.status, 409);
    assert.match(await f.file("user-note"), /Edited in Obsidian\./);
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
    const collision = await call(port, "POST", "/ui/save-memory", { ...base, title: "Secret" });
    assert.equal(collision.status, 409);
    assert.deepEqual(collision.body.existing, [], "a hidden collision exposes no private id or title");
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
