import { canonicalTaskValue } from "./task-canonical.js";
/** Offline owner-held keys; transport credentials are never approval proof. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { uptime } from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicKey, generateKeyPairSync, createHash, scryptSync, randomBytes, createCipheriv, createDecipheriv, createPrivateKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { taskIdentitySchema as id } from "./task-schema.js";
import { tasksPath } from "./task-store.js";
const domains = z.array(id).min(1).max(32).refine(a => new Set(a).size === a.length);
export const taskTargetSchema = z.strictObject({ id, root: z.string().min(1).max(4096), path: z.string().min(1).max(4096), owner_domains: domains,
  sensitivity: z.enum(["public", "private", "restricted"]), adapter: z.literal("local-artifact-v1") });
export const approvalRegistrySchema = z.strictObject({ schema_version: z.literal(1), revision: z.number().int().nonnegative().safe(), protected_boundary: z.boolean(),
  keys: z.array(z.strictObject({ id, domain: id, public_key: z.string().max(4096), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })).max(32),
  targets: z.array(taskTargetSchema).max(100) }).refine(r => new Set(r.keys.map(k => k.domain)).size === r.keys.length && new Set(r.keys.map(k => k.id)).size === r.keys.length && new Set(r.targets.map(t => t.id)).size === r.targets.length);
export type ApprovalRegistry = z.infer<typeof approvalRegistrySchema>;
export const canonicalAction = canonicalTaskValue;
export const actionHash = (value: unknown) => createHash("sha256").update(canonicalAction(value)).digest("hex");
export const bytesHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const registryHash = (registry: ApprovalRegistry) => actionHash(["task-registry-v1", registry]);
export function approvalRegistryPath() { return join(dirname(tasksPath()), "task-approval-keys.json"); }
export async function privateJson(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await fd.stat(); if (!info.isFile() || info.mode & 0o077 || info.size > 1024 * 1024) throw new Error("unsafe owner file"); return JSON.parse(await fd.readFile("utf8")); }
  finally { await fd.close(); }
}
export async function readApprovalRegistry(path = approvalRegistryPath()): Promise<ApprovalRegistry | undefined> {
  try {
    const registry = approvalRegistrySchema.parse(await privateJson(path));
    for (const key of registry.keys) if (key.fingerprint !== bytesHash(key.public_key) || createPublicKey(key.public_key).asymmetricKeyType !== "ed25519") throw new Error("key fingerprint mismatch");
    return registry;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw Object.assign(new Error("Owner configuration unavailable"), { code: "corrupt" }); }
}
const pins = new Map<string, Promise<ApprovalRegistry | undefined>>();
export function pinnedApprovalRegistry(path = approvalRegistryPath()) {
  if (!pins.has(path)) pins.set(path, readApprovalRegistry(path).then(r => r ? structuredClone(r) : undefined).catch(() => undefined));
  return pins.get(path)!;
}
let bootId: string;
try { bootId = process.platform === "darwin" ? execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 1000 }).trim() : readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
catch { bootId = "unsupported"; }
export function actionClock() { return { boot_id: bootId, monotonic: uptime() * 1000 }; }
const envelopeSchema = z.strictObject({ schema_version: z.literal(1), algorithm: z.literal("scrypt-aes-256-gcm"), salt: z.string().regex(/^[a-f0-9]{32}$/), nonce: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/), ciphertext: z.string().max(8192), public_key: z.string().max(4096) });
export function newOwnerKey(passphrase: string) {
  if (passphrase.length < 12) throw Object.assign(new Error("Owner passphrase needs at least 12 characters"), { code: "validation" });
  const pair = generateKeyPairSync("ed25519"); const public_key = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const salt = randomBytes(16), nonce = randomBytes(12); const key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try { const cipher = createCipheriv("aes-256-gcm", key, nonce); const clear = pair.privateKey.export({ type: "pkcs8", format: "der" });
    try { const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]); return { schema_version: 1 as const, algorithm: "scrypt-aes-256-gcm" as const, salt: salt.toString("hex"), nonce: nonce.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("base64"), public_key }; }
    finally { clear.fill(0); }
  } finally { key.fill(0); }
}
export function unlockOwnerKey(raw: unknown, passphrase: string): KeyObject {
  const envelope = envelopeSchema.parse(raw); const key = scryptSync(passphrase, Buffer.from(envelope.salt, "hex"), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try { const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "hex")); decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
    const clear = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
    try { const privateKey = createPrivateKey({ key: clear, format: "der", type: "pkcs8" });
      if (privateKey.asymmetricKeyType !== "ed25519" || createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString() !== envelope.public_key) throw new Error("Owner key identity mismatch");
      return privateKey; } finally { clear.fill(0); }
  } finally { key.fill(0); }
}
export function signTaskApproval(key: KeyObject, binding: unknown) { return sign(null, Buffer.from(canonicalAction(binding)), key).toString("base64"); }
export function verifyTaskApproval(publicKey: string, binding: unknown, signature: string) {
  try { return verify(null, Buffer.from(canonicalAction(binding)), publicKey, Buffer.from(signature, "base64")); } catch { return false; }
}
