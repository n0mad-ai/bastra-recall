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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "inline script must stay forbidden");
  // Index.html carries no style="" attributes any more — 'unsafe-inline'
  // on style-src would now be unused permission, not a documented exception.
  assert.ok(!/style-src[^;]*unsafe-inline/.test(csp), "no style= attribute justifies unsafe-inline any more");

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

test("CSP: the shipped web UI writes no inline style attribute that style-src 'self' would block", async () => {
  // style-src has no 'unsafe-inline'. A style="" in markup or in an HTML string
  // assigned via innerHTML is then dropped by the browser; colour and layout set
  // through the CSSOM (el.style.x = …) are not governed by the directive.
  // vendor/ctxmenu.js can set a style attribute only from an item's `style`
  // field, which nothing in this app populates; its injected <style> element
  // is covered by the two tests below.
  const root = resolveWebUiDir();
  const files: string[] = [join(root, "index.html")];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "vendor") await walk(p);
      } else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  await walk(join(root, "js"));
  const hits: string[] = [];
  for (const f of files) {
    const lines = (await readFile(f, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (/\sstyle\s*=\s*["'$]|setAttribute\(\s*["']style["']/.test(line)) hits.push(`${f.slice(root.length)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], "an inline style attribute is blocked by style-src 'self'");
});

test("CSP: the app injects no <style> element that style-src 'self' would block", async () => {
  // A <style> element created at runtime is inline style too. The only one the
  // shipped UI ever had is vendor/ctxmenu.js's; its rules live in overlays.css
  // (next test), the vendor file stays untouched and is skipped here.
  const root = resolveWebUiDir();
  const files: string[] = [join(root, "index.html")];
  // The local-only recording choreography (.gitignore: not shipped, loaded
  // behind ?demo=1) is not part of the UI this pins.
  const localDemo = join(root, "js", "demo.js");
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "vendor") await walk(p);
      } else if (e.name.endsWith(".js") && p !== localDemo) files.push(p);
    }
  };
  await walk(join(root, "js"));
  const hits: string[] = [];
  for (const f of files) {
    const lines = (await readFile(f, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (/createElement\(\s*["'`]style["'`]|<style[\s>]/i.test(line)) hits.push(`${f.slice(root.length)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], "an injected <style> element is blocked by style-src 'self'");
});

test("CSP: overlays.css carries every base rule ctxmenu.js would inject", async () => {
  // vendor/ctxmenu.js injects its base stylesheet as a <style> element, which
  // style-src 'self' blocks. Without these rules the right-click menu loses
  // position:fixed and its z-index and lands in the page flow. The test reads
  // the rules out of the vendor file, so a vendor update cannot drift past it.
  const root = resolveWebUiDir();
  const vendor = await readFile(join(root, "vendor", "ctxmenu.js"), "utf8");
  const injected = /var styles = '([^']*)'/.exec(vendor)?.[1];
  assert.ok(injected, "ctxmenu.js no longer carries its styles string — re-check what it injects");

  const norm = (d: string): string => d.trim().replace(/\s*([:,])\s*/g, "$1").replace(/\s+/g, " ");
  const rulesOf = (css: string): Map<string, Set<string>> => {
    const rules = new Map<string, Set<string>>();
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, " ");
      const decls = rules.get(sel) ?? new Set<string>();
      for (const d of m[2].split(";")) if (d.trim()) decls.add(norm(d));
      rules.set(sel, decls);
    }
    return rules;
  };
  const shipped = rulesOf(await readFile(join(root, "css", "overlays.css"), "utf8"));
  const missing: string[] = [];
  for (const [sel, decls] of rulesOf(injected)) {
    if (sel === "html") continue; // html{min-height:100%}: base.css gives html height:100%
    for (const d of decls) if (!shipped.get(sel)?.has(d)) missing.push(`${sel} { ${d} }`);
  }
  assert.deepEqual(missing, [], "a ctxmenu base rule is missing from overlays.css");
});


test("CSP exclusion: the local demo is excluded from the npm package, not just git", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-demo-pack-"));
  try {
    await mkdir(join(dir, "webui", "js"), { recursive: true });
    await writeFile(join(dir, "package.json"), await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const ignore = await readFile(new URL("../webui/js/.npmignore", import.meta.url), "utf8").catch(() => "");
    await writeFile(join(dir, "webui", "js", ".npmignore"), ignore);
    await writeFile(join(dir, "webui", "js", "main.js"), "export const shipped = true;");
    await writeFile(join(dir, "webui", "js", "demo.js"), 'document.createElement("style");');
    const { stdout } = await promisify(execFile)("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], {
      cwd: dir, env: { ...process.env, npm_config_cache: join(dir, "cache") },
    });
    const paths = (JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>)[0].files.map((f) => f.path);
    assert.ok(paths.includes("webui/js/main.js"), "the regular web UI must still ship");
    assert.ok(!paths.includes("webui/js/demo.js"), "a file skipped by the shipped-code CSP test must not ship");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
