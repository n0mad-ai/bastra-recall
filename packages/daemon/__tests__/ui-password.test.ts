/**
 * #1198 S1 — Argon2id check values for the web UI sign-in (ui-password.ts):
 * round trip, wrong/oversized/multi-byte input, malformed stored values
 * (#1403: never an exception), dummy check.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/ui-password.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UI_PASSWORD_MAX_BYTES,
  dummyVerifyUiPassword,
  hashUiPassword,
  isUiPasswordHash,
  uiPasswordProblem,
  verifyUiPassword,
} from "../src/ui-password.js";

const PASSWORD = "correct horse battery staple";

test("hash has the versioned PHC format and verifies in both directions", async () => {
  const stored = await hashUiPassword(PASSWORD);
  assert.match(stored, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.equal(isUiPasswordHash(stored), true);
  assert.equal(await verifyUiPassword(PASSWORD, stored), true);
  assert.equal(await verifyUiPassword(`${PASSWORD} `, stored), false, "nothing is trimmed");
  assert.equal(await verifyUiPassword("Correct horse battery staple", stored), false);
  assert.notEqual(await hashUiPassword(PASSWORD), stored, "fresh salt per hash");
});

test("input rules: byte limit, code-point minimum, no lone surrogates, no normalization", async () => {
  assert.equal(uiPasswordProblem("a".repeat(14)), "too-short");
  assert.equal(uiPasswordProblem("a".repeat(15)), null);
  assert.equal(uiPasswordProblem("a".repeat(UI_PASSWORD_MAX_BYTES)), null);
  assert.equal(uiPasswordProblem("a".repeat(UI_PASSWORD_MAX_BYTES + 1)), "too-long");
  // 15 emoji = 15 code points, 30 UTF-16 units, 60 bytes; 14 are too short.
  assert.equal(uiPasswordProblem("😀".repeat(15)), null);
  assert.equal(uiPasswordProblem("😀".repeat(14)), "too-short");
  // 342 × "ж" (2 bytes) = 684 units but 684 bytes; 513 × "ж" = 1026 bytes.
  assert.equal(uiPasswordProblem("ж".repeat(512)), null);
  assert.equal(uiPasswordProblem("ж".repeat(513)), "too-long");
  assert.equal(uiPasswordProblem("€".repeat(342)), "too-long", "3-byte characters: 1026 bytes");
  assert.equal(uiPasswordProblem(`${"a".repeat(20)}\uD800`), "not-text");
  assert.equal(uiPasswordProblem(42), "not-text");
  assert.equal(uiPasswordProblem(undefined), "not-text");
  await assert.rejects(hashUiPassword("short"), /too-short/);
  await assert.rejects(hashUiPassword("€".repeat(342)), /too-long/);

  const nfc = "Grüße aus Köln, café ☕";
  const nfd = nfc.normalize("NFD");
  const stored = await hashUiPassword(nfc);
  assert.equal(await verifyUiPassword(nfc, stored), true);
  assert.equal(await verifyUiPassword(nfd, stored), false, "password bytes are not normalized");
  const multi = "密码密码密码密码密码密码密码密码 🔐";
  assert.equal(await verifyUiPassword(multi, await hashUiPassword(multi)), true);
});

test("oversized, non-text and malformed values are rejected without an exception", async () => {
  const stored = await hashUiPassword(PASSWORD);
  for (const input of [
    "x".repeat(UI_PASSWORD_MAX_BYTES + 1),
    "€".repeat(342),
    "x".repeat(1_000_000),
    null,
    7,
    {},
    "\uDC00",
  ])
    assert.equal(await verifyUiPassword(input, stored), false);

  const [, , , params, salt, tag] = stored.split("$");
  const malformed: unknown[] = [
    undefined,
    null,
    "",
    42,
    Buffer.from(stored),
    "plaintext-password",
    stored.slice(0, -1), // tag one character short
    `${stored}A`, // tag one character long
    stored.replace("argon2id", "argon2i"),
    stored.replace("m=65536", "m=1024"),
    stored.replace("v=19", "v=16"),
    `$argon2id$v=19$${params}$${salt}$${tag!.slice(0, 40)}===`,
    `$argon2id$v=19$${params}$${salt}==$${tag}`,
    `$argon2id$v=19$${params}$${salt}$${tag!.replace(/./, "*")}`,
    `$argon2id$v=19$${params}$${salt}`,
    `${stored}\n`,
  ];
  for (const value of malformed) {
    assert.equal(isUiPasswordHash(value), false, String(value));
    assert.equal(await verifyUiPassword(PASSWORD, value), false, String(value));
  }
});

test("dummy check costs one Argon2id derivation and is always false", async () => {
  const stored = await hashUiPassword(PASSWORD);
  const time = async (run: () => Promise<boolean>) => {
    const start = process.hrtime.bigint();
    assert.equal(await run(), false);
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  const real = await time(() => verifyUiPassword("wrong password, long enough", stored));
  const dummy = await time(() => dummyVerifyUiPassword(PASSWORD));
  const malformed = await time(() => verifyUiPassword(PASSWORD, "garbage"));
  const oversized = await time(() => verifyUiPassword("x".repeat(5000), stored));
  // Coarse: a skipped derivation would take well under a millisecond.
  assert.ok(dummy > real / 4, `dummy ${dummy} ms vs real ${real} ms`);
  assert.ok(malformed > real / 4, `malformed ${malformed} ms vs real ${real} ms`);
  assert.ok(oversized > real / 4, `oversized ${oversized} ms vs real ${real} ms`);
  assert.equal(await dummyVerifyUiPassword(undefined), false);
  assert.equal(await dummyVerifyUiPassword("x".repeat(5000)), false);
});
