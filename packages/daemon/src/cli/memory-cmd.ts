/**
 * `bastra recall "<question>"` and `bastra save` (#1492) — search and save
 * from the terminal, without an agent. Both are thin: they send the call to
 * the running daemon's /api/v1/recall and /api/v1/save_memory, the same
 * handlers MCP and REST use, so validation, claim gate, redaction, audit and
 * indexing stay where they are.
 *
 * A save typed in the terminal is the user's own instruction, so it carries
 * `write_origin: user-directed` — the same as "Save as memory" in the web UI,
 * and with the same derived fields (user-save-input.ts).
 */
import { readStdin } from "../hook-transport.js";
import { USER_SAVE_TYPES, userDirectedSaveInput, type UserSaveType } from "../user-save-input.js";
import { rulebookCliCall } from "./rulebook-proposals-cmd.js";

/** Value options of these two commands (flag-spec.ts registers them). */
export const MEMORY_VALUE_FLAGS = [
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

const RECALL_USAGE = 'usage: bastra recall "<question>" [--limit N] [--scope S] [--type T] [--json]';
const SAVE_USAGE =
  "usage: bastra save --title T --type T --scope S [--summary S] [--recall-when W]... [--tag X]... [--topic a/b] [text | stdin] [--json]";

type Call = typeof rulebookCliCall;

interface Options {
  values: Map<string, string[]>;
  json: boolean;
  words: string[];
}

/** argv as the user typed it after `bastra` (argv[0] is the command). Unknown
 *  options never get here: validateArgs rejects them before dispatch. */
function readOptions(argv: string[]): Options {
  const values = new Map<string, string[]>();
  const words: string[] = [];
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq > 0 ? token.slice(0, eq) : token;
    if (name === "--json") json = true;
    else if ((MEMORY_VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = name === token ? argv[++i] : token.slice(eq + 1);
      const list = values.get(name) ?? [];
      if (list.length && !REPEATABLE.has(name)) throw new Error(`${name} given twice`);
      values.set(name, [...list, value]);
    } else words.push(token);
  }
  return { values, json, words };
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
function recallInput(o: Options): Record<string, unknown> | string {
  const query = o.words.join(" ").trim();
  if (!query) return RECALL_USAGE;
  const limit = one(o, "--limit");
  const k = limit === undefined ? undefined : Number(limit);
  if (k !== undefined && !(Number.isInteger(k) && k >= 1 && k <= 20))
    return `--limit must be a whole number from 1 to 20\n${RECALL_USAGE}`;
  const scope = one(o, "--scope");
  const type = one(o, "--type");
  return { query, ...(k !== undefined ? { k } : {}), ...(scope ? { scope } : {}), ...(type ? { type } : {}) };
}

function printHits(out: { hits: Hit[]; weak_result?: boolean }): void {
  if (out.hits.length === 0) {
    console.log("no matching memories");
    return;
  }
  if (out.weak_result) console.log("(weak result: no hit matches the question's words or triggers)");
  for (const h of out.hits) {
    const where = [h.type, h.scope].filter(Boolean).join(" · ");
    console.log(`${h.id}${where ? `  [${where}]` : ""}`);
    console.log(`  ${h.title}`);
    if (h.summary) console.log(`  ${h.summary}`);
  }
}

export async function cmdRecall(argv: string[], call: Call = rulebookCliCall): Promise<number> {
  let input: Record<string, unknown> | string;
  let json = false;
  try {
    const o = readOptions(argv);
    json = o.json;
    input = recallInput(o);
  } catch (e) {
    input = `${(e as Error).message}\n${RECALL_USAGE}`;
  }
  if (typeof input === "string") {
    console.error(input);
    return 2;
  }
  try {
    const out = (await call("recall", input)) as { hits: Hit[]; weak_result?: boolean };
    if (json) console.log(JSON.stringify(out));
    else printHits(out);
    return 0;
  } catch (e) {
    console.error(`bastra recall: ${(e as Error).message}`);
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
}

/** The save_memory input, or a usage problem to print. */
async function saveInput(o: Options, io: SaveIo): Promise<ReturnType<typeof userDirectedSaveInput> | string> {
  const title = one(o, "--title");
  const type = one(o, "--type");
  const scope = one(o, "--scope");
  if (!title || !type || !scope) return "--title, --type and --scope are required";
  if (!(USER_SAVE_TYPES as readonly string[]).includes(type))
    return `--type must be one of ${USER_SAVE_TYPES.join(", ")}`;
  const typed = o.words.join(" ");
  const body = (typed || (await io.stdin()) || "").replace(/\r\n?/g, "\n").trim();
  if (!body) return "the memory text is missing: give it as words or pipe it in";
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
  let o: Options;
  try {
    o = readOptions(argv);
  } catch (e) {
    console.error(`${(e as Error).message}\n${SAVE_USAGE}`);
    return 2;
  }
  const input = await saveInput(o, io);
  if (typeof input === "string") {
    console.error(`${input}\n${SAVE_USAGE}`);
    return 2;
  }
  const json = o.json;
  try {
    const out = (await call("save_memory", input)) as SaveOutcome;
    if (json) console.log(JSON.stringify(out));
    if (out.claim_gate) {
      if (!json) {
        console.error("not saved: another memory already covers this situation");
        for (const c of out.claim_gate.claimed) console.error(`  ${c.id}${c.title ? `  ${c.title}` : ""}`);
      }
      return 1;
    }
    if (!json) {
      console.log(`saved ${out.id}${out.file_path ? ` → ${out.file_path}` : ""}`);
      if (out.summary_note) console.log(out.summary_note);
    }
    return 0;
  } catch (e) {
    console.error(`bastra save: ${(e as Error).message}`);
    return 1;
  }
}
