import { readAppRecord, writeAppRecord } from "../src/app-record-store.js";
import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, realpath, mkdir } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { readApprovalRegistry } from "../src/task-approval-keys.js";
import { getPrimaryLanguage, setPrimaryLanguage } from "../src/settings.js";
import { mutateSettings, settingsFilePath } from "../src/settings-file.js";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const py = `import os,pty,subprocess,select,time,sys
m,s=pty.openpty()
p=subprocess.Popen(sys.argv[1:],stdin=s,stdout=s,stderr=s,start_new_session=True,preexec_fn=lambda: __import__('fcntl').ioctl(s,__import__('termios').TIOCSCTTY,0))
os.close(s);out=b'';sent=set();deadline=time.time()+20
while p.poll() is None and time.time()<deadline:
 if select.select([m],[],[],0.1)[0]:
  try:out+=os.read(m,65536)
  except OSError:break
 for label,reply in [('Owner-Aufgaben-Token (verborgen): '.encode(),os.environ['SYNTHETIC_OWNER'].encode()+b'\\n'),(b'Backup wiederherstellen?',b'\\n' if os.environ['CASE']=='decline' else b'yes\\n'),(b'Auch unbekannte Sperre privat sichern?',b'yes\\n'),(b'Dieses lokale Ziel',b'\\n' if os.environ['CASE']=='target-decline' else b'yes\\n'),(b'Ziel entfernen?',b'yes\\n'),('Owner task token (hidden): '.encode(),os.environ['SYNTHETIC_OWNER'].encode()+b'\\n'),(b'Restore the backup?',b'\\n' if os.environ['CASE']=='decline' else b'yes\\n'),(b'Also store an unknown lock privately?',b'yes\\n')]:
  if label in out and label not in sent:os.write(m,reply);sent.add(label)
if p.poll() is None:p.kill()
p.wait()
try:
 drain=time.time()+1
 while time.time()<drain and select.select([m],[],[],0.05)[0]:
  chunk=os.read(m,65536)
  if not chunk:break
  out+=chunk
except OSError:pass
os.close(m);sys.stdout.buffer.write(out);sys.stdout.write('\\nCLI_EXIT='+str(p.returncode)+'\\n')
`;
/** #1594, #1602: one dialog, one language — questions and errors follow language.primary. */
async function assertOneDialogLanguage(run: (mode: string) => Promise<string>) {
  const before = await getPrimaryLanguage();
  for (const language of ["en", "de"]) {
    await setPrimaryLanguage(language);
    try {
      const denied = await run("live");
      if (language === "de") {
        assert.match(denied, /Owner-Aufgaben-Token/);
        assert.match(denied, /recover: Ein anderer Vorgang hält den Aufgabenspeicher gesperrt/, language);
        assert.doesNotMatch(denied, /Another operation|Owner task token/, language);
      } else {
        assert.match(denied, /Owner task token/);
        assert.match(denied, /recover: Another operation holds the task store lock/, language);
        assert.doesNotMatch(denied, /Aufgabenspeicher|Owner-Aufgaben-Token/, language);
      }
      assert.match(denied, /CLI_EXIT=1/);
    } finally {
      await mutateSettings(
        settingsFilePath(),
        (s) => ({ ...s, language: { ...s.language, primary: before } }) as typeof s
      );
    }
  }
}
test("real owner CLI recover --lock refuses live owner, repairs unknown owner, and reports No honestly", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-recovery-cli-")),
    ctx = { path: join(root, "tasks.json"), authPath: join(root, "task-auth.json") };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", role: "owner", domains: ["personal"] }),
    auth = `Bearer ${owner.token}`;
  const t = (await callTaskCrud(ctx, auth, "task_create", {
    idempotency_key: "fixture",
    original_request: "Demo",
    goal: "Demo",
    resolution_condition: "Owner",
    timezone: "Europe/Madrid",
    scope: { kind: "personal", name: "fixture" },
    owner_domains: ["personal"],
    arm: true,
    schedule: { kind: "instant", at: Date.now() + 600000 },
  })) as any;
  await callTaskCrud(ctx, auth, "task_snooze", {
    id: t.id,
    expected_revision: t.expected_revision,
    until: Date.now() + 700000,
  });
  const run = async (mode: string, args = ["recover", "--lock"]) => {
    const p = spawn("python3", ["-c", py, process.execPath, cli, "tasks", ...args], {
      env: { ...process.env, BASTRA_TASKS_PATH: ctx.path, SYNTHETIC_OWNER: owner.token, CASE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      errors = "";
    p.stdout.on("data", (c) => {
      output += c;
    });
    p.stderr.on("data", (c) => {
      errors += c;
    });
    const [code] = await once(p, "exit");
    assert.equal(code, 0, errors);
    assert.ok(!output.includes(owner.token));
    assert.ok(!output.includes("unknown option"));
    return output;
  };
  await writeAppRecord("tasks", ctx.path, "broken");
  const live = JSON.stringify({ pid: process.pid, host: hostname(), token: "live" });
  await writeFile(ctx.path + ".lock", live, { mode: 0o600 });
  const previousLanguage = await getPrimaryLanguage();
  await setPrimaryLanguage("de");
  try {
    await germanOwnerDialog(run, ctx, live);
  } finally {
    await mutateSettings(
      settingsFilePath(),
      (s) => ({ ...s, language: { ...s.language, primary: previousLanguage } }) as typeof s
    );
  }
  const registry = await readApprovalRegistry(join(root, "task-action-registry.json"));
  assert.equal(registry?.targets.length, 0);
  assert.equal(registry?.protected_boundary, false);
});
/** The rest of the owner dialog, driven through its German prompts. */
async function germanOwnerDialog(
  run: (mode: string, args?: string[]) => Promise<string>,
  ctx: { path: string },
  live: string
) {
  await assertOneDialogLanguage(run);
  const denied = await run("live");
  assert.match(denied, /Aufgabenspeicher gesperrt/);
  assert.match(denied, /CLI_EXIT=1/);
  assert.equal(await readFile(ctx.path + ".lock", "utf8"), live);
  assert.equal(await readAppRecord("tasks", ctx.path), "broken");
  await writeFile(ctx.path + ".lock", "unknown interrupted owner");
  const repaired = await run("unknown");
  assert.match(repaired, /Älteres Backup/);
  assert.match(repaired, /Änderungen seit dem Backup können fehlen/);
  assert.match(repaired, /CLI_EXIT=0/);
  assert.equal((await readTaskStore(ctx.path)).tasks[0].armed, false);
  assert.equal((await readTaskStore(ctx.path)).controls.execution_stopped, true);
  const bytes = await readAppRecord("tasks", ctx.path),
    declined = await run("decline");
  assert.match(declined, /Nicht bestätigt. Nichts geändert/);
  assert.match(declined, /CLI_EXIT=1/);
  assert.equal(await readAppRecord("tasks", ctx.path), bytes);
  const work = await realpath(await mkdtemp(join(tmpdir(), "task-cli-work-")));
  await writeFile(join(work, "artifact.txt"), "old\n");
  await writeFile(join(work, "second.txt"), "second\n");
  const args = ["targets", "register", "artifact", "--root", work, "--path", "artifact.txt", "--domain", "personal"];
  const no = await run("target-decline", args);
  assert.match(no, /Nicht bestätigt. Nichts geändert/);
  assert.match(no, /WARNUNG/);
  assert.ok(no.includes(join(work, "artifact.txt")));
  const syntax = await run("syntax", ["targets", "register", "artifact"]);
  assert.match(syntax, /Syntax: bastra tasks targets/);
  assert.ok(!syntax.includes("--after"));
  const missing = await run("missing", [...args.slice(0, 4), join(work, "missing"), ...args.slice(5)]);
  assert.match(missing, /Wurzel oder Zieldatei fehlt/);
  assert.ok(!missing.includes("Daemon oder Zugang"));
  assert.match(await run("register", args), /Ziel artifact registriert/);
  assert.match(
    await run("update", [
      "targets",
      "update",
      "artifact",
      "--root",
      work,
      "--path",
      "second.txt",
      "--domain",
      "personal",
    ]),
    /Ziel artifact geändert/
  );
  assert.match(await run("remove", ["targets", "remove", "artifact"]), /Ziel entfernt/);
}

test("instructed agent CLI registers, lists and removes a target without an owner terminal or confirmation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "task-target-agent-cli-"))),
    data = join(root, "data"),
    work = join(root, "work");
  await mkdir(work);
  await writeFile(join(work, "artifact.txt"), "synthetic before\n");
  const path = join(data, "tasks.json"),
    authPath = join(data, "task-auth.json"),
    credential = await mintTaskCredential(authPath, {
      actor_id: "instructed-agent",
      role: "agent",
      domains: ["personal"],
    });
  const run = async (args: string[]) => {
    const p = spawn(process.execPath, [cli, "tasks", "targets", ...args, "--agent"], {
      env: { ...process.env, BASTRA_TASKS_PATH: path, BASTRA_TASK_TOKEN: credential.token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (c) => {
      out += c;
    });
    p.stderr.on("data", (c) => {
      err += c;
    });
    const [code] = await once(p, "exit");
    assert.equal(code, 0, err);
    assert.ok(!out.includes(credential.token));
    return out;
  };
  assert.match(
    await run(["register", "artifact", "--root", work, "--path", "artifact.txt", "--domain", "personal"]),
    /Target artifact registered/
  );
  const registry = await readApprovalRegistry(join(data, "task-action-registry.json"));
  assert.deepEqual(registry?.keys, []);
  assert.equal(registry?.protected_boundary, false);
  assert.match(await run(["list"]), /artifact/);
  assert.match(await run(["remove", "artifact"]), /Target removed/);
  assert.equal((await readApprovalRegistry(join(data, "task-action-registry.json")))?.targets.length, 0);
});
