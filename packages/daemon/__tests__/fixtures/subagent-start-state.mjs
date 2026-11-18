import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bastra-subagent-state-"));
for (const key of Object.keys(process.env)) {
  if (/^(BASTRA|NEXUS)_/.test(key)) delete process.env[key];
}
for (const [key, value] of Object.entries({
  HOME: "home", TMPDIR: "tmp", BASTRA_ROOT: "root", BASTRA_DB_PATH: "app/recall.db",
  BASTRA_HOOK_STATE_DIR: "hook-state", BASTRA_VAULT_PATH: "vault", BASTRA_LOG_DIR: "logs",
})) process.env[key] = path.join(root, value);
for (const key of ["HOME", "TMPDIR", "BASTRA_ROOT", "BASTRA_VAULT_PATH", "BASTRA_LOG_DIR"])
  fs.mkdirSync(process.env[key], { recursive: true, mode: 0o700 });
process.env.BASTRA_TELEMETRY = "off";
const mode = process.argv[2];
const dir = process.env.BASTRA_HOOK_STATE_DIR;
const dbPath = process.env.BASTRA_DB_PATH;
const active = [{ id: "parent-session-rule", revision: "sha256:fixture-revision", setAt: 1 }];
const state = { shown: {}, activeConventions: active, toolCalls: 7, agentToolCalls: { ["a".repeat(64)]: 24 },
  constants: { kernel: "original-fingerprint" }, rulebookCheck: "original-round", draftShown: ["unclaimed-draft"] };
let writer;

function seedSqlite() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  writer = new DatabaseSync(dbPath);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE app_records(namespace TEXT,key TEXT,value TEXT,PRIMARY KEY(namespace,key));");
  const suffix = createHash("sha256").update(path.resolve(dir)).digest("hex");
  const insert = writer.prepare("INSERT INTO app_records VALUES(?,?,?)");
  insert.run(`hook-session:${suffix}`, "parent-session", JSON.stringify({ raw: JSON.stringify(state), at: 1 }));
  insert.run(`hook-loaded:${suffix}`, "unrelated", "123");
  insert.run(`hook-throttle:${suffix}`, "unrelated", "456");
  if (mode === "cold") { writer.close(); writer = undefined; }
}

function snapshot() {
  const files = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const key = path.relative(root, file);
      if (entry.isDirectory()) { files[key] = "directory"; visit(file); }
      else files[key] = { mode: fs.statSync(file).mode & 0o777, hash: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
    }
  }
  visit(root);
  return files;
}

try {
  const { runSubagentStartLane } = await import("../../src/subagent-start-lane.ts");
  if (mode === "warm") {
    const { saveSessionState } = await import("../../src/session-state.ts");
    await saveSessionState("parent-session", state);
  } else if (mode === "cold" || mode === "wal") seedSqlite();
  else if (mode !== "missing") {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (mode !== "corrupt-db") fs.writeFileSync(path.join(dir, "parent-session.json"), mode === "corrupt-legacy" ? "{broken" : JSON.stringify(state), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "loaded-unrelated.touch"), "original marker", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "fail-throttle-unrelated.ts"), "original throttle", { mode: 0o600 });
    if (mode === "corrupt" || mode === "corrupt-db") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dbPath, "corrupt database", { mode: 0o600 });
    }
  }
  if (mode === "wal") assert.ok(fs.statSync(`${dbPath}-wal`).size > 0, "committed rows remain in WAL");
  const before = snapshot();
  const expected = ["missing", "corrupt-legacy", "corrupt-db"].includes(mode) ? [] : active;
  const output = await runSubagentStartLane({ hook_event_name: "SubagentStart", session_id: "parent-session",
    agent_id: "worker", cwd: "/fixture" }, async (membership) => {
    assert.deepEqual(membership, expected, "parent conventions and exact revision reach the catalog");
    const entries = [{ id: "full-rule", title: "Full fixture rule", group: "explicit",
      body: "Complete always-rule kernel body.", updated: null, revision: "sha256:fixture-revision", rulebook: "always" }];
    if (membership.length) entries.push({ id: active[0].id, title: "Parent active rule", group: "active-convention",
      body: "Full active-rule body from the parent session.", updated: null, revision: active[0].revision, rulebook: "always" });
    return { entries, omitted: 0 };
  });
  const context = JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.match(context, /Complete always-rule kernel body\./);
  if (expected.length) assert.match(context, /Full active-rule body from the parent session\./);
  const after = snapshot();
  const coordination = Object.keys(after).filter((file) => /recall\.db-(wal|shm)$/.test(file));
  // SHM read marks (and newly created sidecars) are SQLite reader coordination.
  // Existing committed WAL bytes, DB bytes, legacy files, markers and backups
  // remain identical. No sidecar exception can hide a new application DB.
  for (const file of coordination) {
    if (file.endsWith("-wal") && before[file]) assert.deepEqual(after[file], before[file], "committed WAL unchanged");
    delete before[file]; delete after[file];
  }
  assert.deepEqual(after, before, "no application storage, migration, backups or marker changes");
  console.log(`${mode}: application state unchanged; SQLite coordination sidecars: ${coordination.join(",") || "none"}`);
} finally {
  writer?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
