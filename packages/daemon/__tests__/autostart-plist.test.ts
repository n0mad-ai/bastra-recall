/**
 * `bastra autostart` — der plist, den bastra selbst schreibt.
 *
 * Die eine Entscheidung, die hier schiefgehen darf und nicht schiefgehen soll:
 * Ein LaunchAgent, den der NUTZER geschrieben hat, wird nicht angefasst. Er
 * zeigt in aller Regel absichtlich woandershin — auf einen Entwicklungs-
 * Checkout, auf eine eigene Modellkonfiguration —, und ein `autostart on`, das
 * ihn überschreibt, schießt beim ersten Ausprobieren eine fremde Umgebung ab.
 *
 * Erkannt wird der eigene über eine Marke IM plist. Getestet wird deshalb genau
 * das: erkennt der Code fremd als fremd, auch wenn die Datei kaputt ist?
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/autostart-plist.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autostartEnv, plistPath, readState, renderPlist } from "../src/cli/autostart.js";

const onMac = process.platform === "darwin";

async function dir(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "bastra-autostart-"));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test("der plist-Pfad hängt am Label, das der Rest des Codes kennt", () => {
  assert.equal(
    plistPath("/Users/x"),
    "/Users/x/Library/LaunchAgents/ai.n0mad.bastra-recall.plist",
  );
});

test("was bastra schreibt, ist ein gültiger plist — auch mit Sonderzeichen im Vault-Pfad", { skip: !onMac }, async (t) => {
  const d = await dir(t);
  const p = join(d, "own.plist");
  // Ein Vault-Pfad mit `&` und `<` ist erlaubt und war der klassische Weg,
  // eine XML-Datei kaputtzuschreiben.
  const vault = join(d, "Ablage & <Notizen>");
  await writeFile(p, renderPlist(autostartEnv(vault, "/opt/homebrew/bin/node"), ["/opt/homebrew/bin/node", p]), "utf8");

  const lint = spawnSync("/usr/bin/plutil", ["-lint", p], { encoding: "utf8" });
  assert.equal(lint.status, 0, `plutil -lint: ${lint.stdout}${lint.stderr}`);

  const state = await readState(p);
  assert.equal(state.exists, true);
  assert.equal(state.managed, true, "der eigene plist trägt die Marke");
  assert.deepEqual(state.program, ["/opt/homebrew/bin/node", p]);
});

test("ein handgeschriebener plist gilt als fremd", { skip: !onMac }, async (t) => {
  const d = await dir(t);
  const p = join(d, "foreign.plist");
  // Genau die Form, die Leute sich selbst bauen: ohne unsere Marke, mit einem
  // Programmpfad auf einen Source-Checkout.
  await writeFile(
    p,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key><string>ai.n0mad.bastra-recall</string>
\t<key>ProgramArguments</key>
\t<array><string>/opt/homebrew/bin/node</string><string>${d}/checkout/index.js</string></array>
\t<key>EnvironmentVariables</key>
\t<dict><key>BASTRA_VAULT_PATH</key><string>${d}/vault</string></dict>
\t<key>RunAtLoad</key><true/>
</dict>
</plist>
`,
    "utf8",
  );

  const state = await readState(p);
  assert.equal(state.exists, true);
  assert.equal(state.managed, false, "ohne Marke ist er fremd — bastra fasst ihn nicht an");
  assert.equal(state.danglingProgram, true, "und sein Programm gibt es hier nicht");
});

test("ein unlesbarer plist gilt als fremd, nicht als eigener", { skip: !onMac }, async (t) => {
  const d = await dir(t);
  const p = join(d, "broken.plist");
  await writeFile(p, "das ist kein plist", "utf8");

  const state = await readState(p);
  assert.equal(state.exists, true);
  assert.equal(
    state.managed,
    false,
    "fail-closed: was nicht gelesen werden kann, darf nicht überschrieben werden",
  );
});

test("ein fehlender plist ist einfach 'aus'", async (t) => {
  const d = await dir(t);
  const state = await readState(join(d, "nichts.plist"));
  assert.equal(state.exists, false);
  assert.equal(state.managed, false);
  assert.equal(state.danglingProgram, false);
});
