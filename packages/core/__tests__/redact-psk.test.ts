import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/scrub.js";

// Invented low-entropy values expose gaps generic entropy scanning cannot catch.
for (const key of ["$psk", "PSK", "vpn_psk", "pre-shared-key", "preSharedKey"]) {
  for (const value of ["'fixture vpn'", '"fixture vpn"', "fixture-vpn"]) {
    test(`PSK credential binding ${key} with ${value[0]}`, () => {
      const input = `${key}=${value}; MODE=development`;
      const result = redactSecrets(input);
      assert.ok(!result.text.includes("fixture"));
      assert.ok(result.text.includes("[REDACTED]"));
      assert.ok(result.text.includes("MODE=development"));
      assert.equal(result.redactedChars, "fixture vpn".length);
      assert.deepEqual(redactSecrets(result.text), { text: result.text, redactedChars: 0 });
    });
  }
}

test("PSK JSON, query and flag forms redact while references and technical prose survive", () => {
  for (const input of ['{"PSK":"fixture vpn"}', "https://vpn.example/?PSK=fixture-vpn&mode=test", "vpn --psk 'fixture vpn'"]) {
    assert.ok(!redactSecrets(input).text.includes("fixture"));
  }
  for (const input of ["PSK=$VPN_PSK", "PSK=${VPN_PSK}", "PSK=<your-psk>", "PSK negotiation uses the configured secret", "PSK_ENABLED=true MODE=development"]) {
    assert.equal(redactSecrets(input).text, input);
  }
});
