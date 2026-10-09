import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/scrub.js";

// Invented values only. `Zx81Kartoffel` and `sommerhaus2019` are secret-shaped
// (letters with a digit); `blauer elefant tanzt` is a word-only passphrase.
const KEY = "Zx81Kartoffel";
const LOW = "sommerhaus2019";
const URL = "https://fixture.invalid/api";
const scrub = (text: string): string => redactSecrets(text).text;

test("harmless PSK, wpa_passphrase and curl sentences stay unchanged", () => {
  for (const text of [
    "Der PSK ist abgelaufen.",
    "The PSK is rotated every 90 days.",
    "Der Pre-Shared Key ist im Passwortmanager hinterlegt.",
    "Der PSK ist in 1Password hinterlegt",
    "Modus: PSK oder Enterprise",
    "Auth: PSK (WPA2)",
    "TODO: PSK rotieren",
    "Der PSK ist: siehe Tresor",
    "pre-shared-key rotation is planned for next quarter",
    "we use a pre-shared-key based tunnel between both sites",
    "wpa-psk und wpa-eap im Vergleich",
    "nmcli -s -g 802-11-wireless-security.psk connection show fixturenet",
    "nmcli -f wifi-sec.psk con show fixturenet",
    "wpa_passphrase fixturenet | sudo tee -a /etc/wpa.conf",
    "wpa_passphrase fixturenet < /run/secrets/wifi",
    "wpa_passphrase ist ein Werkzeug zum Erzeugen des Hashes",
    "<keyMaterial>{{ psk }}</keyMaterial>",
    "Mit curl testen und danach docker run -u 1000:1000 alpine starten",
    "curl -fsSL https://fixture.invalid/install.sh -o i.sh, danach docker run --user 1000:1000 img",
    "curl -o out.txt https://fixture.invalid  docker exec -u 0:0 web sh",
    "Nach dem curl -Aufruf bitte docker run -u 33:33 nextcloud ausführen",
    "Erst curl https://fixture.invalid/health prüfen, dann git push -u origin feature:main",
    "curl -u : --negotiate https://fixture.invalid",
    "curl -u fixture https://fixture.invalid",
    'curl -u "$API_USER:$API_PASS" https://fixture.invalid',
    'curl --user-agent "bot:1.0" https://fixture.invalid',
    "Der PSK ist abgelaufen und muss im Büro Amberfeld bis Freitag vom Quarzfeld-Team erneuert werden.",
  ]) assert.equal(scrub(text), text, text);
});

test("prose and command forms without = redact a quoted or secret-shaped value", () => {
  for (const [text, expected] of [
    [`Der PSK lautet ${LOW}, bitte so eintragen.`, "Der PSK lautet [REDACTED], bitte so eintragen."],
    [`the PSK is ${KEY}`, "the PSK is [REDACTED]"],
    [`PSK lautet: ${LOW}`, "PSK lautet: [REDACTED]"],
    ["Der PSK lautet SommerHausBlau", "Der PSK lautet [REDACTED]"],
    ["PSK ist 12345678", "PSK ist [REDACTED]"],
    ['Der PSK fürs Gäste-WLAN ist "blauer elefant tanzt".', 'Der PSK fürs Gäste-WLAN ist "[REDACTED]".'],
    [`@fixture.invalid : PSK ${LOW}`, "@fixture.invalid : PSK [REDACTED]"],
    [`vpn -psk ${LOW}`, "vpn -psk [REDACTED]"],
    [`wpa-psk ${LOW}`, "wpa-psk [REDACTED]"],
    [`nmcli con modify fixturenet wifi-sec.psk ${LOW}`, "nmcli con modify fixturenet wifi-sec.psk [REDACTED]"],
    [`wpa_passphrase fixturenet ${LOW} | sudo tee -a /etc/wpa.conf`, "wpa_passphrase fixturenet [REDACTED] | sudo tee -a /etc/wpa.conf"],
    // A fixed key position is redacted whatever its shape.
    ["wpa_passphrase fixturenet kartoffelsalat", "wpa_passphrase fixturenet [REDACTED]"],
  ]) {
    assert.equal(scrub(text), expected, text);
    assert.equal(scrub(expected), expected, text);
  }
});

test("chosen limit: a word-only passphrase in a prose or loose form stays readable", () => {
  for (const text of [
    "Der PSK lautet kartoffelsalat",
    "the PSK is blauer elefant tanzt",
    "PSK lautet: blauer elefant tanzt",
    ": PSK kartoffelsalat",
    "vpn -psk kartoffelsalat",
    // Only the token directly after the binding word is inspected.
    `Der PSK ist jetzt ${LOW}`,
  ]) assert.equal(scrub(text), text, text);
  // Assignment forms at the key name still redact to the end of the value.
  assert.equal(scrub("psk=blauer elefant tanzt"), "psk=[REDACTED]");
  assert.equal(scrub("PSK_KEY=kartoffelsalat"), "PSK_KEY=[REDACTED]");
  assert.equal(scrub('psk: "blauer elefant tanzt"'), 'psk: "[REDACTED]"');
  assert.equal(scrub("<psk>blauer elefant tanzt</psk>"), "<psk>[REDACTED]</psk>");
});

test("pre-shared-key keeps vendor sub-keywords and redacts the key", () => {
  assert.equal(scrub(`pre-shared-key ${LOW}`), "pre-shared-key [REDACTED]");
  assert.equal(scrub(`pre-shared-key local ${LOW}`), "pre-shared-key local [REDACTED]");
  assert.equal(scrub(`pre-shared-key address 0.0.0.0 0.0.0.0 key ${KEY}`), "pre-shared-key address 0.0.0.0 0.0.0.0 key [REDACTED]");
  assert.equal(scrub(`set security ike policy p1 pre-shared-key ascii-text "${KEY}"`), 'set security ike policy p1 pre-shared-key ascii-text "[REDACTED]"');
});

test("curl userinfo is redacted in attached, bundled, multi-line and wrapped calls", () => {
  for (const text of [
    `curl -u fixture:${KEY} ${URL}`,
    `curl -ufixture:${KEY} ${URL}`,
    `curl -su fixture:${KEY} ${URL}`,
    `curl -sSLu fixture:${KEY} ${URL}`,
    `curl -sS ${URL} \\\n  -u fixture:${KEY} \\\n  -H 'Accept: application/json'`,
    `curl.exe -u fixture:${KEY} ${URL}`,
    `curl --user=fixture:${KEY} ${URL}`,
    `curl ${URL} -X POST -d '{"a": "b c"}' -u fixture:${KEY}`,
    `curl localhost -u fixture:${KEY}`,
    `curl --proxy-user fixture:${KEY} ${URL}`,
    `curl -x http://proxy.invalid:3128 -U fixture:${KEY} ${URL}`,
    `TOKEN=$(curl -u fixture:${KEY} ${URL})`,
    "X=`curl -u fixture:" + KEY + " " + URL + "`",
    `sh -c "curl -u fixture:${KEY} ${URL}"`,
    `cd /tmp && sudo curl -u fixture:${KEY} ${URL}`,
  ]) {
    const out = scrub(text);
    assert.ok(!out.includes(KEY), text);
    assert.ok(out.includes("fixture.invalid") || out.includes("localhost"), text);
    assert.equal(scrub(out), out, text);
  }
  // Recorded limits: a value attached to a bundle, and other clients' flags.
  for (const text of [`curl -sufixture:${KEY} ${URL}`, `http -a fixture:${KEY} GET ${URL}`]) assert.equal(scrub(text), text, text);
});

// Each shape was quadratic at some point or sits on a scan added with these
// forms. Bounds are generous because the suite runs in parallel; quadrupling the
// input costs about 4x when linear and 16x when quadratic.
test("redaction time grows linearly on repeated PSK and curl shapes", () => {
  const shapes: Record<string, (size: number) => string> = {
    "psk=a lines": (n) => "psk=a\n".repeat(n / 6),
    "PSK ist a": (n) => "PSK ist a ".repeat(n / 10),
    ": PSK a": (n) => ": PSK a ".repeat(n / 8),
    "psk=a, spaces, b": (n) => ("psk=a" + " ".repeat(300) + "b\n").repeat(n / 307),
    "tabs after psk": (n) => "psk=fixture" + "\t".repeat(n) + "end",
    "<psk> run": (n) => "<psk>".repeat(n / 5),
    "dots": (n) => ".".repeat(n),
    "< run": (n) => "<".repeat(n),
    "pre-shared-key a": (n) => "pre-shared-key a ".repeat(n / 17),
    "wpa_passphrase n k": (n) => "wpa_passphrase n k ".repeat(n / 19),
    "curl -u a:b": (n) => "curl " + "-u a:b ".repeat(n / 7),
    'curl "a': (n) => 'curl "a '.repeat(n / 8),
  };
  const best = (text: string): number => {
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      redactSecrets(text);
      ms = Math.min(ms, performance.now() - started);
    }
    return ms;
  };
  for (const [name, make] of Object.entries(shapes)) {
    const small = best(make(50_000)), large = best(make(200_000));
    assert.ok(large < 2000, `${name}: 200 KB took ${large.toFixed(0)} ms`);
    assert.ok(large < 8 * small + 100, `${name}: 50 KB ${small.toFixed(0)} ms, 200 KB ${large.toFixed(0)} ms`);
  }
});

test("sentence punctuation after a loose token is trimmed in linear time and is not a secret shape", () => {
  assert.equal(scrub(`Der PSK lautet ${LOW}!`), "Der PSK lautet [REDACTED]");
  assert.equal(scrub("Der PSK ist abgelaufen!"), "Der PSK ist abgelaufen!");
  assert.equal(scrub("Der PSK lautet kartoffelsalat?"), "Der PSK lautet kartoffelsalat?");
  const started = performance.now();
  redactSecrets(`Der PSK ist ${"!".repeat(200_000)}a`);
  assert.ok(performance.now() - started < 1_000);
});
