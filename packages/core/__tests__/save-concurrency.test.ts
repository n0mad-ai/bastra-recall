/**
 * #285 — ownership-aware saveMemory commit.
 *
 * The precondition and commit claim are separate invariants:
 * - expectedTarget closes a caller ownership-check → writer-commit window;
 * - the O_EXCL claim serializes saveMemory writers across processes;
 * - create publishes without replacement, so a late creator is never clobbered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  symlink,
  readFile,
  readdir,
  rm,
  writeFile,
  utimes,
} from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { saveMemory } from "../src/save.js";
import { acquireCommitClaim, commitLockPathFor } from "../src/save-commit.js";
import { scanVaultForId } from "../src/memory-locator.js";
import { MEMORY_WRITE_CONFLICT, MemoryWriteConflictError } from "../src/save-schema.js";
import type { SaveMemoryInput } from "../src/save-schema.js";

const ID = "shared-memory";

function input(body: string, over: Partial<SaveMemoryInput> = {}): SaveMemoryInput {
  return {
    id: ID,
    title: "Shared Memory",
    type: "lesson",
    summary: `summary ${body.slice(0, 12)}`,
    body,
    topic_path: ["concurrency"],
    tags: ["save"],
    scope: "race",
    recall_when: ["when testing concurrent saves"],
    overwrite: true,
    ...over,
  } as SaveMemoryInput;
}

function targetFor(vault: string, folder = "memories/projects/race"): string {
  return path.join(vault, folder, `${ID}.md`);
}

async function harness(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "bastra-save-concurrency-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  return vault;
}

/**
 * Was ein sauberer Save NICHT hinterlässt: Zwischendateien neben dem Memory
 * und Commit-Claims. Der Claim liegt seit dem Umzug auf den ID-Lock nicht mehr
 * neben der Datei, sondern unter `.bastra/locks/` — ohne diesen zweiten Ort
 * würden die Lock-Leichen-Assertions unten still nichts mehr prüfen.
 */
async function artifacts(vault: string, file: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of [path.dirname(file), path.join(vault, ".bastra", "locks")]) {
    try {
      found.push(
        ...(await readdir(dir)).filter(
          (name) => name.endsWith(".tmp") || name.endsWith(".bastra-write.lock"),
        ),
      );
    } catch {
      // Ordner gibt es nicht → nichts hinterlassen.
    }
  }
  return found;
}

async function runWorker(
  vault: string,
  body: string,
  expectedFile: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const worker = fileURLToPath(
    new URL("./fixtures/save-concurrency-worker.ts", import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", worker, vault, body, expectedFile],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assertConflict(reason: unknown): asserts reason is MemoryWriteConflictError {
  assert.ok(reason instanceof MemoryWriteConflictError);
  assert.equal(reason.name, "MemoryWriteConflictError");
  assert.equal(reason.code, MEMORY_WRITE_CONFLICT);
  assert.equal(reason.id, ID);
  assert.match(reason.message, /Retry from the current file/);
}

test("concurrent creates: exactly one wins and the loser reports a stable conflict", async (t) => {
  const vault = await harness(t);
  const file = targetFor(vault);

  const settled = await Promise.allSettled([
    saveMemory(vault, input("writer A"), { expectedTarget: null }),
    saveMemory(vault, input("writer B"), { expectedTarget: null }),
  ]);

  const winners = settled.filter((result) => result.status === "fulfilled");
  const losers = settled.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assertConflict((losers[0] as PromiseRejectedResult).reason);

  const raw = await readFile(file, "utf8");
  assert.ok(raw.includes("writer A") || raw.includes("writer B"));
  assert.deepEqual(await artifacts(vault, file), []);
});

test("concurrent overwrites from one preimage: exactly one patch wins", async (t) => {
  const vault = await harness(t);
  const first = await saveMemory(vault, input("original", { sensitivity: "private" }));
  const preimage = await readFile(first.file_path, "utf8");

  const settled = await Promise.allSettled([
    saveMemory(vault, input("writer A"), { expectedTarget: preimage }),
    saveMemory(vault, input("writer B"), { expectedTarget: preimage }),
  ]);

  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const loser = settled.find((result) => result.status === "rejected");
  assert.ok(loser && loser.status === "rejected");
  assertConflict(loser.reason);

  const raw = await readFile(first.file_path, "utf8");
  assert.ok(raw.includes("writer A") || raw.includes("writer B"));
  assert.equal(matter(raw).data.sensitivity, "private", "the winning overwrite remains a patch");
  assert.deepEqual(await artifacts(vault, first.file_path), []);
});

test("overlapping ordinary overwrites are serialized even without a caller precondition", async (t) => {
  const vault = await harness(t);
  const first = await saveMemory(vault, input("original"));

  const settled = await Promise.allSettled([
    saveMemory(vault, input("writer A")),
    saveMemory(vault, input("writer B")),
  ]);

  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const loser = settled.find((result) => result.status === "rejected");
  assert.ok(loser && loser.status === "rejected");
  assertConflict(loser.reason);
  const raw = await readFile(first.file_path, "utf8");
  assert.ok(raw.includes("writer A") || raw.includes("writer B"));
  assert.deepEqual(await artifacts(vault, first.file_path), []);
});

test("an expected-free save refuses a target that appeared before entry", async (t) => {
  const vault = await harness(t);
  const landed = await saveMemory(vault, input("landed first"));
  const before = await readFile(landed.file_path, "utf8");

  await assert.rejects(
    saveMemory(vault, input("must lose"), { expectedTarget: null }),
    (err) => {
      assertConflict(err);
      return true;
    },
  );
  assert.equal(await readFile(landed.file_path, "utf8"), before);
  assert.deepEqual(await artifacts(vault, landed.file_path), []);
});

test("an expected preimage refuses a byte change and preserves the newcomer", async (t) => {
  const vault = await harness(t);
  const seeded = await saveMemory(vault, input("original"));
  const expected = await readFile(seeded.file_path, "utf8");
  const newcomer = expected.replace("original", "external edit");
  await writeFile(seeded.file_path, newcomer, "utf8");

  await assert.rejects(
    saveMemory(vault, input("must lose"), { expectedTarget: expected }),
    MemoryWriteConflictError,
  );
  assert.equal(await readFile(seeded.file_path, "utf8"), newcomer);
  assert.deepEqual(await artifacts(vault, seeded.file_path), []);
});

test("a held commit claim fails visibly without touching the target or claim", async (t) => {
  const vault = await harness(t);
  const seeded = await saveMemory(vault, input("original"));
  const expected = await readFile(seeded.file_path, "utf8");
  const lock = commitLockPathFor(vault, ID);
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, "other writer", "utf8");

  await assert.rejects(
    saveMemory(vault, input("must lose"), { expectedTarget: expected }),
    (err) => {
      assertConflict(err);
      assert.match((err as Error).message, /another save is committing/);
      return true;
    },
  );
  assert.equal(await readFile(seeded.file_path, "utf8"), expected);
  assert.equal(await readFile(lock, "utf8"), "other writer");
  assert.deepEqual(
    (await artifacts(vault, seeded.file_path)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("ordinary sequential overwrites stay compatible and both succeed", async (t) => {
  const vault = await harness(t);
  const created = await saveMemory(vault, input("v1"));
  const second = await saveMemory(vault, input("v2"));
  const third = await saveMemory(vault, input("v3"));

  assert.equal(created.created, true);
  assert.equal(second.created, false);
  assert.equal(third.created, false);
  assert.match(await readFile(created.file_path, "utf8"), /v3/);
  assert.deepEqual(await artifacts(vault, created.file_path), []);
});

test("unrelated ids do not share a commit claim", async (t) => {
  const vault = await harness(t);
  const [a, b] = await Promise.all([
    saveMemory(vault, input("A", { id: "memory-a" }), { expectedTarget: null }),
    saveMemory(vault, input("B", { id: "memory-b" }), { expectedTarget: null }),
  ]);

  assert.equal(a.created, true);
  assert.equal(b.created, true);
});

/**
 * Dieser Test stand vorher auf dem Kopf: Er hieß „the same id in distinct
 * folders commits independently" und verlangte, dass BEIDE Saves gelingen.
 * Genau das war der Defekt — der Commit-Claim lag auf dem Zielpfad, also
 * nahmen zwei gleichzeitige Saves derselben id in verschiedenen Regalen zwei
 * verschiedene Locks, und danach trugen zwei Dateien eine id. Der Vault lädt
 * beim nächsten Start still nur eine davon; das Memory verliert die Hälfte
 * seiner Geschichte, ohne dass irgendwo ein Fehler auftaucht.
 *
 * Ein Save je id — die zwei Regale sind kein zweiter Platz, sondern zwei
 * Anwärter auf denselben.
 */
test("zwei gleichzeitige Saves derselben id: genau einer gewinnt", async (t) => {
  const vault = await harness(t);
  const outcomes = await Promise.allSettled([
    saveMemory(vault, input("A", { folder: "memories/projects/a" }), {
      expectedTarget: null,
    }),
    saveMemory(vault, input("B", { folder: "memories/projects/b" }), {
      expectedTarget: null,
    }),
  ]);

  const won = outcomes.filter((o) => o.status === "fulfilled");
  assert.equal(won.length, 1, `genau ein Save darf gelingen, es gelangen ${won.length}`);

  // Und auf der Platte liegt auch wirklich nur eine Datei mit dieser id — der
  // Verlierer darf sein Regal nicht doch noch gefüllt haben.
  const onDisk = [
    path.join(vault, "memories/projects/a", `${ID}.md`),
    path.join(vault, "memories/projects/b", `${ID}.md`),
  ].filter((p) => existsSync(p));
  assert.deepEqual(onDisk, [(won[0] as PromiseFulfilledResult<{ file_path: string }>).value.file_path]);
  assert.deepEqual(await artifacts(vault, onDisk[0]), []);
});

/**
 * Der Konkurrent, den ein VERALTETER Index nie meldet.
 *
 * Codex-Gegenreview (P0): Der id-Lock allein genügte nicht — unter ihm wurde
 * derselbe Locator ein zweites Mal gefragt, aus dem die Vorabprüfung schon
 * ihre Antwort hatte. Stammt der aus einem Vault-Index, den ein anderer
 * Prozess längst überholt hat, meldet auch die zweite Frage `none`, und zwei
 * Saves derselben id in verschiedene Regale gelingen beide.
 *
 * Der Locator hier ist genau das: dauerhaft veraltet. Er antwortet immer mit
 * dem Stand VON VOR dem fremden Write und pflanzt das fremde File nach seiner
 * ersten Antwort. Erkannt werden muss die Kollision trotzdem — von der Platte,
 * unter dem Lock.
 */
test("ein veralteter Locator verhindert die Kollisionserkennung nicht", async (t) => {
  const vault = await harness(t);
  const rivalDir = path.join(vault, "memories/projects/rival");
  const rival = path.join(rivalDir, `${ID}.md`);
  let calls = 0;

  const locator = {
    locate(wanted: string) {
      calls++;
      // Der Stand VON VOR dem Pflanzen — für diesen Locator ist die id frei,
      // heute und für immer.
      const answer = scanVaultForId(vault, wanted);
      if (calls === 1) {
        mkdirSync(rivalDir, { recursive: true });
        writeFileSync(rival, matter.stringify("\nrival\n", {
          id: ID,
          title: "Shared Memory",
          type: "lesson",
          summary: "rival",
          topic_path: ["concurrency"],
          tags: ["save"],
          scope: "race",
          recall_when: ["rival"],
          created: "2026-08-26",
          updated: "2026-08-26",
        }), "utf8");
      }
      return answer;
    },
  };

  await assert.rejects(
    saveMemory(vault, input("mine", { folder: "memories/projects/mine", overwrite: false }), {
      locator,
    }),
    /would create a second file with the same id/,
  );
  assert.equal(
    existsSync(path.join(vault, "memories/projects/mine", `${ID}.md`)),
    false,

    "kein zweites File neben dem Konkurrenten",
  );
  assert.deepEqual(await artifacts(vault, rival), []);
});

test("non-ENOENT inspection failures fail closed before temp or lock creation", async (t) => {
  const vault = await harness(t);
  const file = targetFor(vault);
  await mkdir(file, { recursive: true });

  await assert.rejects(saveMemory(vault, input("must not write")), (err: unknown) => {
    assert.equal((err as NodeJS.ErrnoException).code, "EISDIR");
    return true;
  });
  assert.deepEqual(await artifacts(vault, file), []);
});

test("the same preimage is claimed exactly once across Node processes", async (t) => {
  const vault = await harness(t);
  const seeded = await saveMemory(vault, input("original"));
  const expectedFile = path.join(vault, "approved-preimage.txt");
  await writeFile(expectedFile, await readFile(seeded.file_path, "utf8"), "utf8");

  const results = await Promise.all([
    runWorker(vault, "process A", expectedFile),
    runWorker(vault, "process B", expectedFile),
  ]);

  assert.deepEqual(
    results.map((result) => result.code).sort(),
    [0, 2],
    results.map((result) => result.stderr).join("\n"),
  );
  const loser = results.find((result) => result.code === 2);
  assert.ok(loser);
  const report = JSON.parse(loser.stdout) as { code: string; name: string };
  assert.equal(report.code, MEMORY_WRITE_CONFLICT);
  assert.equal(report.name, "MemoryWriteConflictError");
  const raw = await readFile(seeded.file_path, "utf8");
  assert.ok(raw.includes("process A") || raw.includes("process B"));
  assert.deepEqual(await artifacts(vault, seeded.file_path), []);
});

// ── reclaiming a claim whose owner died ──────────────────────────────
//
// `finally` does not run on SIGKILL, OOM or power loss. Without a way back,
// one such death makes the id permanently unwritable — the failure the claim
// was meant to prevent, in a form no retry can clear.

test("a claim from a dead process on this host is reclaimed", async (t) => {
  const vault = await harness(t);
  const seeded = await saveMemory(vault, input("original"));
  const lock = commitLockPathFor(vault, ID);
  await mkdir(path.dirname(lock), { recursive: true });
  // A pid this process can prove is gone: spawn a child, wait for its exit.
  const dead = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("exit", () => resolve(child.pid as number));
  });
  await writeFile(
    lock,
    JSON.stringify({ pid: dead, host: os.hostname(), ts: Date.now() }),
    "utf8",
  );

  const result = await saveMemory(vault, input("after reclaim"));

  assert.equal(result.created, false);
  assert.match(await readFile(seeded.file_path, "utf8"), /after reclaim/);
  assert.deepEqual(await artifacts(vault, seeded.file_path), []);
});

test("a claim older than the stale window is reclaimed whatever it says", async (t) => {
  const vault = await harness(t);
  const seeded = await saveMemory(vault, input("original"));
  const lock = commitLockPathFor(vault, ID);
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, "not json, from another machine", "utf8");
  // Age it past the window without waiting for it.
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);

  const result = await saveMemory(vault, input("after reclaim"));

  assert.match(await readFile(seeded.file_path, "utf8"), /after reclaim/);
  assert.deepEqual(await artifacts(vault, seeded.file_path), []);
});

test("a fresh claim from an unknown host is left alone", async (t) => {
  const vault = await harness(t);
  const seeded = await saveMemory(vault, input("original"));
  const expected = await readFile(seeded.file_path, "utf8");
  const lock = commitLockPathFor(vault, ID);
  await mkdir(path.dirname(lock), { recursive: true });
  const claim = JSON.stringify({
    pid: process.pid,
    host: "some-other-machine",
    ts: Date.now(),
  });
  await writeFile(lock, claim, "utf8");

  await assert.rejects(saveMemory(vault, input("must lose")), (err) => {
    assert.equal((err as { code?: string }).code, MEMORY_WRITE_CONFLICT);
    return true;
  });
  assert.equal(await readFile(seeded.file_path, "utf8"), expected);
  assert.equal(await readFile(lock, "utf8"), claim);
});

/**
 * Codex-Gegenreview (P0): Der Reclaim verletzte die Exklusivität.
 *
 * Mehrere Writer konnten denselben verwaisten Claim gleichzeitig als verwaist
 * erkennen und ihn danach jeweils blind löschen — einer entfernte dabei den
 * gerade neu angelegten Lock des anderen. Gemessen: 200 Runden mit je 16
 * Reclaimern, 85 Runden mit mehr als einem Gewinner, bis zu drei gleichzeitig.
 *
 * Geprüft wird deshalb der Claim SELBST, nicht der Save darüber: Der
 * Byte-Vergleich vor dem Commit fängt zwei Gewinner auf DENSELBEN Pfad ohnehin
 * ab und verdeckt damit genau den Defekt, um den es hier geht. Zwei Gewinner
 * auf verschiedene Regale fängt er nicht.
 */
test("nur einer kann einen verwaisten Claim übernehmen", async (t) => {
  const ROUNDS = 30;
  const RECLAIMERS = 16;
  const vault = await harness(t);
  const lock = commitLockPathFor(vault, ID);
  await mkdir(path.dirname(lock), { recursive: true });

  for (let round = 0; round < ROUNDS; round++) {
    // Ein Claim von einem fremden Host, alt genug für die Übernahme: keine
    // PID auf dieser Maschine kann ihn retten, also versuchen es ALLE.
    await writeFile(
      lock,
      JSON.stringify({ pid: 999999, host: "andere-maschine", ts: 0, token: `stale-${round}` }),
      "utf8",
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    const results = await Promise.allSettled(
      Array.from({ length: RECLAIMERS }, () =>
        acquireCommitClaim(lock, ID, path.join(vault, "x.md")),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    assert.equal(won.length, 1, `Runde ${round}: ${won.length} Gewinner statt einem`);

    // Und der Lock gehört genau dem Gewinner — nicht einem Nachzügler, der
    // ihn nach dem Löschen des Vorgängers neu angelegt hat.
    const held = JSON.parse(await readFile(lock, "utf8")) as { token: string };
    assert.equal(
      held.token,
      (won[0] as PromiseFulfilledResult<string>).value,
      `Runde ${round}: der Lock trägt nicht das Token des Gewinners`,
    );
    await rm(lock, { force: true });
  }
});

/**
 * Sicherheitsrunde: Dieselbe Grenze für das Lock-Verzeichnis.
 *
 * Zeigt `.bastra` auf ein AKTIVES Regal, entstehen die Lock-Dateien mitten im
 * Bestand — sichtbar in Obsidian, mitsynchronisiert, und ein Aufräumen dort
 * öffnet den Lock für einen zweiten Writer. Der Symlink verlässt den Vault
 * nicht, die vaultweite Prüfung sah ihn deshalb nicht.
 */
test("ein .bastra, das in ein aktives Regal zeigt, trägt keine Locks", async (t) => {
  const vault = await harness(t);
  const shelf = path.join(vault, "memories", "projects", "aktiv");
  await mkdir(shelf, { recursive: true });
  await rm(path.join(vault, ".bastra"), { recursive: true, force: true });
  await symlink(shelf, path.join(vault, ".bastra"));

  await assert.rejects(saveMemory(vault, input("nope")), /not .*own \.bastra/);
  assert.deepEqual(await readdir(shelf), [], "keine Lock-Datei im aktiven Regal");
});
