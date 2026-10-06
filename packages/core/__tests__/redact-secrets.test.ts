import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/scrub.js";

const fixtures = [
  "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",

  "sk-proj-AbCdeFgHiJkLmNoPqRsT1234", "ghp_abcdefghijklmno1234567890",
  "github_pat_abcdefghijklmno1234567890", "AKIA1234567890ABCDEF",
  "xoxb-1234567890-abcdefghijk", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
  "a1b2c3d4e5f67890123456789abcdef00", "AbCdEfGhIjKlMnOpQrStUv12",
];
for (const secret of fixtures) {
  test(`redact secret fixture ${fixtures.indexOf(secret)}`, () => {
    const result = redactSecrets(`before ${secret} after`);
    assert.equal(result.text, "before [REDACTED] after");
    assert.equal(result.redactedChars, secret.length);
  });
}

test("URL credentials and high entropy assignment values keep their syntax", () => {
  assert.equal(redactSecrets("ssh://user:pass@box.internal/path").text, "ssh://[REDACTED]@box.internal/path");
  for (const input of ['KEY="aB3dE5fG7hI9jK1m"', "key: 'aB3dE5fG7hI9jK1m'", "KEY=aB3dE5fG7hI9jK1m", 'ключ: aB3dE5fG7hI9jK1m']) {
    const result = redactSecrets(input);
    assert.ok(result.text.includes("[REDACTED]"));
    assert.ok(!result.text.includes("aB3dE5fG7hI9jK1m"));
    assert.equal(result.redactedChars, 16);
  }
});

test("normal multilingual text, commands and low entropy settings survive", () => {
  const text = "VPN für build-box nötig. ключ находится там. ssh box.internal\nMODE=development PORT=6723 REPEAT=aaaaaaaaaaaaaaaaaaaaaaaa";
  assert.deepEqual(redactSecrets(text), { text, redactedChars: 0 });
});

test("overlapping matches count original characters once and redaction is idempotent", () => {
  const text = `KEY=${fixtures[2]}`;
  const result = redactSecrets(text);
  assert.equal(result.redactedChars, fixtures[2].length);
  assert.deepEqual(redactSecrets(result.text), { text: result.text, redactedChars: 0 });
});

test("home abbreviation only replaces a full directory prefix", () => {
  assert.equal(redactSecrets('cd /Users/test/project; /Users/test-other /Users/test', '/Users/test').text, 'cd ~/project; /Users/test-other ~');
});

test("unterminated PEM blocks redact the remaining text", () => {
  assert.equal(redactSecrets("before -----BEGIN RSA PRIVATE KEY-----\nabc123 after").text, "before [REDACTED]");
});


test("home prefixes are abbreviated before generic token matching", () => {
  assert.equal(redactSecrets("cd /Users/n0mad/project-with-a-long-name/file", "/Users/n0mad").text, "cd ~/project-with-a-long-name/file");
});

test("long ordinary words need no secret and do not cause repeated prefix scans", () => {
  for (const char of ["z", "-"]) {
    const text = char.repeat(50_000);
    const started = performance.now();
    assert.deepEqual(redactSecrets(text), { text, redactedChars: 0 });
    assert.ok(performance.now() - started < 1000, "plain text must not take a second to scan");
  }
});
