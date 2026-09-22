/**
 * Tests für die Content-Security-Policy der Vault-Map (#217).
 *
 * Die Map ist ein local-first-Werkzeug; das Versprechen „der Vault verlässt
 * die Maschine nicht" ist erst dann prüfbar, wenn der Browser es durchsetzt.
 * Diese Tests pinnen genau das: WELCHE Ziele erlaubt sind, dass Inline-Skript
 * und eval NICHT erlaubt sind, und dass die Policy am Dokument hängt.
 *
 * Der wichtigste Test ist der letzte: er liest die echten fetch-Aufrufe der
 * ausgelieferten WebUI und verlangt, dass jeder externe Host in connect-src
 * steht. Ein neues Feature, das irgendwohin telefoniert, kann damit nicht
 * still an der Policy vorbeirutschen — der Test bricht, bevor der Browser es
 * stumm blockiert.
 *
 * Runner: `tsx --test __tests__/webui-csp.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { handleWebUi, resolveWebUiDir } from "../src/webui.js";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
}

/** Serviert einen Mini-Asset-Ordner über handleWebUi und holt EINEN Pfad. */
async function fetchAsset(path: string): Promise<Res> {
  const assets = await mkdtemp(join(tmpdir(), "csp-assets-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "csp-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } }));
  await writeFile(join(assets, "index.html"), "<!doctype html><title>t</title>");
  await mkdir(join(assets, "css"), { recursive: true });
  await writeFile(join(assets, "css", "app.css"), "body{}");

  const server = createServer((req, res) => {
    void handleWebUi(req, res, req.url ?? "/", assets, settingsPath);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  try {
    return await new Promise<Res>((resolve, reject) => {
      const rq = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      });
      rq.on("error", reject);
      rq.end();
    });
  } finally {
    server.close();
    await rm(assets, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
}

test("CSP: the document carries a policy that bounds where the map may talk", async () => {
  const res = await fetchAsset("/ui/");
  const csp = String(res.headers["content-security-policy"] ?? "");
  assert.ok(csp.length > 0, "the html response must carry a CSP");

  // Alles ohne eigene Direktive fällt auf same-origin zurück.
  assert.match(csp, /default-src 'self'/);

  // Die Egress-Liste ist der eigentliche Punkt: der Daemon + die drei
  // Wetter-Dienste, und sonst niemand.
  // Token-Vergleich statt Teilstring-Match: `https://api.open-meteo.com` als
  // Muster würde auch auf `https://api.open-meteo.com.angreifer.tld` passen —
  // ausgerechnet der Test, der die Egress-Liste bewacht, hätte den Tippfehler
  // durchgelassen, gegen den er schützt.
  const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? "";
  const sources = connect.trim().split(/\s+/);
  for (const src of [
    "'self'",
    "https://api.open-meteo.com",
    "https://geocoding-api.open-meteo.com",
    "https://api.bigdatacloud.net",
  ]) {
    assert.ok(sources.includes(src), `connect-src must list exactly ${src}`);
  }
  assert.ok(!connect.includes("*"), "a wildcard would make the whole policy decorative");

  // Der Viewer hat weder eval noch inline-script — wer das aufweicht, muss
  // diesen Test bewusst anfassen.
  assert.ok(!csp.includes("unsafe-eval"), "the viewer needs no eval");
  assert.match(csp, /script-src 'self'/);
  assert.ok(
    !/script-src[^;]*unsafe-inline/.test(csp),
    "inline script must stay forbidden — style attributes are the only inline exception",
  );

  // Kein Einbetten, kein Plugin, kein umgebogener <base>.
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
});

test("CSP: rides on the document only, not on stylesheets or scripts", async () => {
  const css = await fetchAsset("/ui/css/app.css");
  assert.equal(css.status, 200);
  assert.equal(
    css.headers["content-security-policy"],
    undefined,
    "a CSP on a stylesheet is ignored by the browser — shipping it there only pretends to protect",
  );
});

test("CSP: every host the shipped web UI fetches from is declared", async () => {
  // Liest die ECHTEN Assets, nicht die Test-Fixtures: der Sinn ist, ein neu
  // eingebautes fetch-Ziel zu fangen, das niemand in die Policy eingetragen
  // hat. Nur fetch() zählt — <a href> ist Navigation und wird von connect-src
  // nicht berührt, sonst würden die GitHub-Feedback-Links hier falsch feuern.
  const jsDir = join(resolveWebUiDir(), "js");
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  await walk(jsDir);
  assert.ok(files.length > 0, "expected to find the shipped web UI sources");

  const hosts = new Set<string>();
  for (const f of files) {
    const src = await readFile(f, "utf8");
    // Nur Hosts in STRING-LITERALEN — das voranstehende Anführungszeichen ist
    // der Unterschied zwischen einem echten Ziel und einer Doku-URL in einem
    // Kommentar (`@see https://open-meteo.com/en/docs`), die nie gefetcht wird.
    for (const m of src.matchAll(/["'`]https:\/\/([a-z0-9.-]+)/gi)) {
      // Navigations-Ziele (Issue-Links) sind kein connect-src-Fall.
      if (m[1] === "github.com") continue;
      hosts.add(m[1].toLowerCase());
    }
  }
  assert.ok(hosts.size > 0, "found no outbound hosts at all — the scan is broken, not the UI clean");

  const res = await fetchAsset("/ui/");
  const connect = /connect-src ([^;]+)/.exec(String(res.headers["content-security-policy"]))?.[1] ?? "";
  // Exakter Token-Vergleich, KEIN includes(): als Teilstring würde ein
  // deklariertes `api.open-meteo.com` auch ein fremdes `open-meteo.com`
  // durchwinken — und `evil.com` ein `notevil.com`.
  const declared = new Set(connect.trim().split(/\s+/));
  for (const host of hosts) {
    assert.ok(
      declared.has(`https://${host}`),
      `${host} is fetched by the web UI but missing from connect-src — the browser would block it silently`,
    );
  }
});
