import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/scrub.js";

// Invented values only. A PSK assignment (`PSK=`, `PSK:`) is configuration
// syntax; the words around it must not decide whether its value is hidden, in
// any language (INV-LANG-01).
const scrub = (text: string): string => redactSecrets(text).text;

test("a PSK assignment inside a question is redacted whatever the sentence language", () => {
  for (const [text, expected] of [
    ["Is PSK='fixture vpn' the staging configuration?", "Is PSK='[REDACTED]' the staging configuration?"],
    ["Это PSK='fixture vpn' для стенда?", "Это PSK='[REDACTED]' для стенда?"],
    ["この PSK='fixture vpn' はステージング用ですか？", "この PSK='[REDACTED]' はステージング用ですか？"],
    ["¿Es PSK='fixture vpn' la configuración de staging?", "¿Es PSK='[REDACTED]' la configuración de staging?"],
    // German used to be the one language whose question word blinded the scan.
    ["Ist PSK='fixture vpn' die Staging-Konfiguration?", "Ist PSK='[REDACTED]' die Staging-Konfiguration?"],
    ["Ist PSK = sommerhaus2019?", "Ist PSK = [REDACTED]"],
    ["Zum PSK=sommerhaus2019", "Zum PSK=[REDACTED]"],
  ]) {
    assert.equal(scrub(text), expected, text);
    assert.equal(scrub(expected), expected, text);
  }
});

test("a protocol-mode comparison stays readable whatever the sentence language", () => {
  for (const text of [
    "Ist PSK = WPA2 Personal oder brauche ich Enterprise?",
    "Is PSK = WPA2 Personal or do I need Enterprise?",
    "Это PSK = WPA3 или Enterprise?",
    "¿Es PSK = WPA2 o Enterprise?",
    "psk: true",
    "PSK=$VPN_PSK",
  ])
    assert.equal(scrub(text), text, text);
});
