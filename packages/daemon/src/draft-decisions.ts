/** Hash-only promotion receipts beside vectors; small metadata, never quote data. */
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { draftDecisionsPath, listDrafts, withDraftPublication } from "./draft-store.js";
import { withPathLock } from "./path-lock.js";
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 1024 * 1024;

export async function readDraftDecisions(seed: ReadonlyMap<string,string> = new Map()): Promise<Map<string,string>> {
  let file;
  try {
    file = await open(draftDecisionsPath(), "r");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) return new Map();
    const raw: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    const entries = raw && typeof raw === "object" && "entries" in raw ? raw.entries : null;
    if (!Array.isArray(entries)) return new Map();
    return new Map(entries.slice(-1000).filter((entry): entry is [string,string] => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string" && HASH.test(entry[0]) && HASH.test(entry[1])));
  } catch { return new Map(seed); }
  finally { await file?.close(); }
}

/** One metadata commit per pass. Merge under the existing publication ordering,
 * so concurrent passes cannot lose decisions and purge cannot be resurrected. */
export async function recordDraftDecisions(changes: ReadonlyMap<string,string>, seed: ReadonlyMap<string,string> = new Map()): Promise<Set<string>> {
  if (!changes.size) return new Set();
  const path = draftDecisionsPath();
  return withDraftPublication(() => withPathLock(path, async () => {
    if (!(await listDrafts()).length) return new Set<string>();
    const decisions = await readDraftDecisions(seed), accepted = new Set<string>();
    for (const [key,signature] of changes) {
      if (decisions.get(key) === signature) continue;
      decisions.delete(key); decisions.set(key,signature); accepted.add(key);
    }
    if (!accepted.size) return accepted;
    while (decisions.size > 1000) decisions.delete(decisions.keys().next().value!);
    await mkdir(dirname(path), {recursive:true,mode:0o700});
    const tmp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp,JSON.stringify({version:1,entries:[...decisions]}),{mode:0o600});
    await rename(tmp,path); return accepted;
  }, {crossProcess:true}));
}
