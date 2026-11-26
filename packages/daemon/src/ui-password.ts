/**
 * #1198 — password check values for the web UI sign-in.
 *
 * Argon2id from node:crypto (m=64 MiB, t=3, p=1, 16-byte salt, 32-byte tag),
 * stored in the PHC string format, which names algorithm, version and
 * parameters: `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<tag>` (unpadded base64).
 * Only exactly these parameters are accepted; a different or malformed value
 * verifies as false and never throws (#1403: byte lengths are compared before
 * timingSafeEqual).
 *
 * Input rules: at most 1024 UTF-8 bytes, at least 15 Unicode code points, no
 * lone surrogates. The password is hashed as typed — never trimmed or
 * normalized.
 */
import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

export const UI_PASSWORD_MAX_BYTES = 1024;
const UI_PASSWORD_MIN_CHARS = 15;

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const MEMORY_KIB = 65536;
const PASSES = 3;
const PARALLELISM = 1;
const PREFIX = `$argon2id$v=19$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$`;
// 16 bytes = 22 unpadded base64 characters, 32 bytes = 43.
const STORED_RE = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

export type UiPasswordProblem = "not-text" | "too-short" | "too-long";

/** null when the password may be set; otherwise the rule it breaks. */
export function uiPasswordProblem(password: unknown): UiPasswordProblem | null {
  if (typeof password !== "string") return "not-text";
  // UTF-16 code units never exceed UTF-8 bytes: cheap bound before scanning.
  if (password.length > UI_PASSWORD_MAX_BYTES) return "too-long";
  // A lone surrogate would be hashed as U+FFFD and collide with other inputs.
  if (/\p{Cs}/u.test(password)) return "not-text";
  if (Buffer.byteLength(password, "utf8") > UI_PASSWORD_MAX_BYTES) return "too-long";
  if ([...password].length < UI_PASSWORD_MIN_CHARS) return "too-short";
  return null;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: Buffer.from(password, "utf8"),
        nonce: salt,
        parallelism: PARALLELISM,
        tagLength: TAG_BYTES,
        memory: MEMORY_KIB,
        passes: PASSES,
      },
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });
}

const b64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");

/** Stored check value for a password that satisfies uiPasswordProblem. */
export async function hashUiPassword(password: string): Promise<string> {
  const problem = uiPasswordProblem(password);
  if (problem) throw new Error(`Password rejected: ${problem}`);
  const salt = randomBytes(SALT_BYTES);
  return `${PREFIX}${b64(salt)}$${b64(await derive(password, salt))}`;
}

function parseStored(stored: unknown): { salt: Buffer; tag: Buffer } | null {
  if (typeof stored !== "string") return null;
  const match = STORED_RE.exec(stored);
  if (!match) return null;
  const salt = Buffer.from(match[1]!, "base64");
  const tag = Buffer.from(match[2]!, "base64");
  return salt.length === SALT_BYTES && tag.length === TAG_BYTES ? { salt, tag } : null;
}

/** true when the stored value has this module's exact format and parameters. */
export function isUiPasswordHash(stored: unknown): boolean {
  return parseStored(stored) !== null;
}

/** Whether a password could ever match: a string within the byte limit and without lone surrogates. */
function comparable(password: unknown): password is string {
  const problem = uiPasswordProblem(password);
  return problem === null || problem === "too-short";
}

/**
 * Same Argon2id cost as a real check, always false: for an unknown user name
 * or a missing/damaged account, so the answer time does not reveal which.
 */
export async function dummyVerifyUiPassword(password: unknown): Promise<false> {
  try {
    const key = await derive(comparable(password) ? password : "", randomBytes(SALT_BYTES));
    timingSafeEqual(key, randomBytes(TAG_BYTES));
  } catch {
    // Fails closed like every other path here.
  }
  return false;
}

/**
 * Constant-time check. Wrong, oversized or non-text input and malformed stored
 * values give false, never an exception — after the same Argon2id cost, so an
 * oversized password does not tell a known user name from an unknown one.
 */
export async function verifyUiPassword(password: unknown, stored: unknown): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed || !comparable(password)) return dummyVerifyUiPassword(password);
  try {
    const key = await derive(password, parsed.salt);
    return key.length === parsed.tag.length && timingSafeEqual(key, parsed.tag);
  } catch {
    return false;
  }
}
