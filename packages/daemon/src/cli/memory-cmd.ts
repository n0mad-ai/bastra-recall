/**
 * `bastra recall` and `bastra save` (#1492) — search, read and save from
 * the terminal. They call /api/v1/recall, /api/v1/load_memory and /api/v1/save_memory, the same
 * handlers MCP and REST use, so validation, claim gate, redaction, audit and
 * indexing stay where they are.
 *
 * A save typed in the terminal is the user's own instruction, so it carries
 * `write_origin: user-directed` — the same as "Save as memory" in the web UI,
 * and with the same derived fields (user-save-input.ts).
 *
 * `bastra save --dry-run` sends the same input with `dry_run: true`: the
 * daemon runs every check and writes nothing (INV-VAULT-10); the terminal
 * shows what would be stored.
 */
import { readStdin } from "../hook-transport.js";
import { USER_SAVE_TYPES, userDirectedSaveInput, type UserSaveType } from "../user-save-input.js";
import { memoryCmdWords, type MemoryCmdWords } from "./memory-cmd-words.js";
import { rulebookCliCall } from "./helpers.js";

/** Value options of these two commands (flag-spec.ts registers them). */
export const MEMORY_VALUE_FLAGS = [
  "--load",
  "--limit",
  "--scope",
  "--type",
  "--title",
  "--summary",
  "--recall-when",
  "--tag",
  "--topic",
] as const;

const REPEATABLE = new Set(["--recall-when", "--tag"]);

type Call = typeof rulebookCliCall;

interface Options {
  values: Map<string, string[]>;
  json: boolean;
  dryRun: boolean;
  words: string[];
}

/** argv as the user typed it after `bastra` (argv[0] is the command). Unknown
 *  options never get here: validateArgs rejects them before dispatch. */
function readOptions(argv: string[], w: MemoryCmdWords): Options {
  const values = new Map<string, string[]>();
  const words: string[] = [];
  let json = false;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq > 0 ? token.slice(0, eq) : token;
    if (name === "--json") json = true;
    else if (name === "--dry-run") dryRun = true;
    else if ((MEMORY_VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = name === token ? argv[++i] : token.slice(eq + 1);
      const list = values.get(name) ?? [];
      if (list.length && !REPEATABLE.has(name)) throw new Error(w.givenTwice(name));
      values.set(name, [...list, value]);
    } else words.push(token);
  }
  return { values, json, dryRun, words };
}

const one = (o: Options, name: string): string | undefined => o.values.get(name)?.[0]?.trim() || undefined;

interface Hit {
  id: string;
  title: string;
  type?: string;
  scope?: string;
  summary?: string;
  score?: number;
}

/** The recall input, or a usage problem to print. */
function recallInput(o: Options, w: MemoryCmdWords): Record<string, unknown> | string {
  const query = o.words.join(" ").trim();
  if (!query) return w.usage.recall;
  const limit = one(o, "--limit");
  const k = limit === undefined ? undefined : Number(limit);
  if (k !== undefined && !(Number.isInteger(k) && k >= 1 && k <= 20)) return `${w.limitRange}\n${w.usage.recall}`;
  const scope = one(o, "--scope");
  const type = one(o, "--type");
  return { query, ...(k !== undefined ? { k } : {}), ...(scope ? { scope } : {}), ...(type ? { type } : {}) };
}

function printHits(out: { hits: Hit[]; weak_result?: boolean }, w: MemoryCmdWords): void {
  if (out.hits.length === 0) {
    console.log(w.noMatches);
    return;
  }
  if (out.weak_result) console.log(w.weakResult);
  for (const h of out.hits) {
    const where = [h.type, h.scope].filter(Boolean).join(" · ");
    console.log(`${h.id}${where ? `  [${where}]` : ""}`);
    console.log(`  ${h.title}`);
    if (h.summary) console.log(`  ${h.summary}`);
  }
}

async function loadNote(o: Options, w: MemoryCmdWords, call: Call): Promise<number> {
  const id = one(o, "--load");
  if (!id || o.words.length || o.values.size > 1) {
    console.error(`${id ? w.loadMixed : w.loadValueMissing}\n${w.usage.recallLoad}`);
    return 2;
  }
  try {
    const out = await call("load_memory", { id, verbosity: "full" });
    if (o.json) console.log(JSON.stringify(out));
    else process.stdout.write(out.body);
    return 0;
  } catch (e) {
    const message = (e as Error).message;
    console.error(w.loadFailed(id, message === `memory not found: ${id}` ? w.loadNotFound : message));
    return 1;
  }
}

export async function cmdRecall(argv: string[], call: Call = rulebookCliCall): Promise<number> {
  const w = await memoryCmdWords();
  let input: Record<string, unknown> | string;
  let json = false;
  try {
    const o = readOptions(argv, w);
    if (o.values.has("--load")) return loadNote(o, w, call);
    json = o.json;
    input = recallInput(o, w);
  } catch (e) {
    const message = (e as Error).message;
    input = `${message}\n${message === w.givenTwice("--load") ? w.usage.recallLoad : w.usage.recall}`;
  }
  if (typeof input === "string") {
    console.error(input);
    return 2;
  }
  try {
    const out = (await call("recall", input)) as { hits: Hit[]; weak_result?: boolean };
    if (json) console.log(JSON.stringify(out));
    else printHits(out, w);
    return 0;
  } catch (e) {
    console.error(w.recallFailed((e as Error).message));
    return 1;
  }
}

export interface SaveIo {
  /** The memory text when none is given as words; undefined on a terminal. */
  stdin: () => Promise<string | undefined>;
}

const processIo: SaveIo = {
  stdin: async () => (process.stdin.isTTY ? undefined : readStdin()),
};

interface SaveOutcome {
  id: string;
  file_path?: string;
  created?: boolean;
  summary_note?: string;
  claim_gate?: { claimed: { id: string; title?: string }[] };
  /** Set on a preview (--dry-run): nothing was written. */
  dry_run?: true;
  /** Rule state of the memory: rule, proposal or note (rulebook-status.ts). */
  delivery?: string;
  /** Credential values replaced per field before writing. */
  secrets_redacted?: Record<string, number>;
}

/** Prints the daemon's answer; exit code 1 when the save was held at the claim gate. */
function printSaveOutcome(out: SaveOutcome, o: Options, w: MemoryCmdWords): number {
  if (o.dryRun && out.dry_run !== true) {
    console.error(w.dryRunUnconfirmed);
    return 1;
  }
  if (o.json) {
    console.log(JSON.stringify(out));
    return out.claim_gate ? 1 : 0;
  }
  if (out.claim_gate) {
    console.error(w.claimed(o.dryRun));
    for (const c of out.claim_gate.claimed) console.error(`  ${c.id}${c.title ? `  ${c.title}` : ""}`);
    return 1;
  }
  if (o.dryRun) printPreview(out, w);
  else {
    console.log(w.saved(out.id, out.file_path));
    if (out.summary_note) console.log(out.summary_note);
  }
  return 0;
}

/** What a preview would store: target, rule state and redactions. */
function printPreview(out: SaveOutcome, w: MemoryCmdWords): void {
  console.log(w.previewOnly);
  console.log(`${w.previewId}${out.id}`);
  if (out.file_path) console.log(`${w.previewFile}${out.file_path}`);
  if (out.delivery) console.log(`${w.previewKind}${out.delivery}`);
  const redacted = Object.entries(out.secrets_redacted ?? {}).map(([field, n]) => `${field} (${n})`);
  console.log(`${w.previewRedacted}${redacted.length ? redacted.join(", ") : w.nothing}`);
  if (out.summary_note) console.log(out.summary_note);
}

/** The save_memory input, or a usage problem to print. */
async function saveInput(
  o: Options,
  io: SaveIo,
  w: MemoryCmdWords
): Promise<ReturnType<typeof userDirectedSaveInput> | string> {
  const title = one(o, "--title");
  const type = one(o, "--type");
  const scope = one(o, "--scope");
  if (!title || !type || !scope) return w.required;
  if (!(USER_SAVE_TYPES as readonly string[]).includes(type)) return w.typeOneOf(USER_SAVE_TYPES.join(", "));
  const typed = o.words.join(" ");
  const body = (typed || (await io.stdin()) || "").replace(/\r\n?/g, "\n").trim();
  if (!body) return w.textMissing;
  const list = (name: string) => (o.values.get(name) ?? []).map((v) => v.trim()).filter(Boolean);
  const topic = one(o, "--topic");
  return userDirectedSaveInput({
    title,
    type: type as UserSaveType,
    scope,
    body,
    summary: one(o, "--summary"),
    recall_when: list("--recall-when"),
    tags: list("--tag"),
    topic_path: topic
      ? topic
          .split("/")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  });
}

export async function cmdSave(argv: string[], call: Call = rulebookCliCall, io: SaveIo = processIo): Promise<number> {
  const w = await memoryCmdWords();
  let o: Options;
  try {
    o = readOptions(argv, w);
  } catch (e) {
    console.error(`${(e as Error).message}\n${w.usage.save}`);
    return 2;
  }
  const input = await saveInput(o, io, w);
  if (typeof input === "string") {
    console.error(`${input}\n${w.usage.save}`);
    return 2;
  }
  try {
    const out = (await call("save_memory", o.dryRun ? { ...input, dry_run: true } : input)) as SaveOutcome;
    return printSaveOutcome(out, o, w);
  } catch (e) {
    console.error(w.saveFailed((e as Error).message));
    return 1;
  }
}
