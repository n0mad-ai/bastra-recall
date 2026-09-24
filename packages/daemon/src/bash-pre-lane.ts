/**
 * Bash tripwire lane, daemon-side (#343/#15 pattern, shared by Claude and Codex).
 *
 * The pipeline from `bash-pre-hook.ts`: pattern-match destructive/risky shell
 * commands, recall safety lessons, emit the STOP/CAUTION tripwire block.
 * Moved verbatim behind POST /hook/bash-pre; the hook file is a thin client.
 *
 * Unlike the write lane there is NO client-side content gate: the pattern
 * tables are the gate, and they are exactly the kind of logic that must stay
 * hot-swappable — a new risky command pattern should never require a stub
 * rebuild (#344's contract). A non-matching command costs the thin client one
 * loopback round trip (~5ms on the compiled stub) and returns `{}` without
 * any recall work.
 *
 * #161 CONSTRAINT carried over: this lane is fully EXEMPT from the
 * empty-streak backoff. The tripwire is a safety warning — the warning itself
 * is the point, and it must emit unconditionally.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";
import { envFirst, envInt } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { recordBudgetShadow } from "./session-budget.js";
import { reportHinted } from "./hook-hinted.js";
import { hookClient, hookClientEvidence, type HookClientEvidence } from "./hook-surface.js";
import { dimensionsFrom } from "./telemetry-dimensions.js";
import { governContext } from "./context-governor.js";
import { postLane } from "./thin-client.js";
import { isUnfused, type HookRecallHit, type HookRecallResponse } from "./hook-recall-response.js";
import { unfusedHeadline } from "./band-wording.js";
import { extractCommandHead, invokesOwnBinary } from "./bash-fail-lane.js";
import {
  bumpShown,
  getLoadedMarkerMtime,
  loadSessionState,
  mutateSessionState,
  shouldDropHit,
} from "./session-state.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 500, "NEXUS_HOOK_TIMEOUT_MS");
const HOOK_VERSION = "0.2.0"; // 0.2.0 = daemon-side lane (#343)
const SCORE_FLOOR = 50;

export interface BashHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

// P0: EIN gemeinsamer Response-Typ für alle Lanes. Die lokale Kopie hier
// kannte `score_kind`/`unfused` nicht — das Feld fiel beim Parsen still weg,
// und diese Lane bandete danach rohe BM25-Werte mit einem Cut, den nur die
// fusionierte Skala trägt.
type RecallHit = HookRecallHit;
type RecallResponse = HookRecallResponse;

/**
 * Destructive patterns — always need a recall.
 * Order matters: longer / more specific phrases first so the *match string*
 * we surface to the user is the meaningful one.
 */
const DESTRUCTIVE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "rm -rf", re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/ },
  { label: "rm -r", re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\b/ },
  { label: "rmdir", re: /\brmdir\b/ },
  { label: "git reset --hard", re: /\bgit\s+reset\s+--hard\b/ },
  { label: "git checkout --", re: /\bgit\s+checkout\s+--\s/ },
  { label: "git clean -f", re: /\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*\b/ },
  { label: "git branch -D", re: /\bgit\s+branch\s+-D\b/ },
  { label: "git push --force-with-lease", re: /\bgit\s+push\b[^\n]*--force-with-lease/ },
  { label: "git push --force", re: /\bgit\s+push\b[^\n]*--force\b/ },
  { label: "git push -f", re: /\bgit\s+push\b[^\n]*\s-f\b/ },
  { label: "git commit --amend", re: /\bgit\s+commit\b[^\n]*--amend\b/ },
  { label: "gh repo delete", re: /\bgh\s+repo\s+delete\b/ },
  { label: "gh release delete", re: /\bgh\s+release\s+delete\b/ },
  { label: "npm uninstall", re: /\bnpm\s+uninstall\b/ },
  { label: "npm rm", re: /\bnpm\s+rm\b/ },
  { label: "yarn remove", re: /\byarn\s+remove\b/ },
  { label: "pnpm rm", re: /\bpnpm\s+(?:rm|remove)\b/ },
  { label: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { label: "DROP DATABASE", re: /\bDROP\s+DATABASE\b/i },
  // #415: `TRUNCATE` alone is an English word. Requiring the object — the same
  // shape the two DROP patterns above already have — is what separates the
  // statement from a sentence that mentions truncating.
  { label: "TRUNCATE TABLE", re: /\bTRUNCATE\s+TABLE\b/i },
  { label: "docker rm", re: /\bdocker\s+rm\b/ },
  { label: "docker volume rm", re: /\bdocker\s+volume\s+rm\b/ },
  { label: "kubectl delete", re: /\bkubectl\s+delete\b/ },
];

/**
 * Risky patterns — surface a softer hint. Same code path, only the label
 * differs so the recall query can pick up the right lessons.
 */
const RISKY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "chmod -R", re: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\b/ },
  { label: "chown -R", re: /\bchown\s+-[a-zA-Z]*R[a-zA-Z]*\b/ },
  { label: "find ... -exec rm", re: /\bfind\b[^\n]*-exec\s+rm\b/ },
  // Overwrite redirect: `> file` (not `>>` append, not `2>` stderr, not `>&`).
  // Require a non-`>` char before `>` and at least one whitespace+filename after.
  // `> overwrite redirect` was a pattern here until 22.08.2026. Measured over
  // Jul–Aug: 90% of all tripwire calls, 1.1M injected tokens, the same three
  // unrelated memories in 99% of the hints, 12 loads in two months (0.4%).
  // A shell idiom, not a destructive act — it carried the noise, not the
  // value. Destructive patterns above keep the STOP warning.
];

/**
 * Command heads that only READ (#415).
 *
 * `grep -rn "DROP TABLE" .` and `rg "git reset --hard" docs/` carry a
 * destructive pattern as their SEARCH TERM. Matching them fired a STOP warning
 * at somebody looking something up — observed on legitimate work, and the same
 * shape of noise that got the `>` redirect pattern removed in August: a
 * tripwire that cries on reading gets ignored when it warns on writing.
 */
const SEARCH_ONLY_HEAD = /^(?:sudo\s+)?(?:grep|egrep|fgrep|rg|ag|ack|git\s+grep)\b/;

/**
 * Consumers that swallow a heredoc as DATA (#521).
 *
 * #415 deliberately kept heredoc bodies in scope, because `bash <<EOF`
 * executes them. That holds for a shell; it does not hold for `cat > file`.
 * Drafting a Discord reply, an issue body or a commit message through a
 * heredoc is routine work, and any of them can MENTION a destructive command
 * in prose — observed: `cat > dm5.txt <<'EOF' … On rm -rf: … EOF` produced a
 * STOP warning while nothing destructive ran.
 *
 * An allowlist and not a blocklist on purpose: an unknown consumer keeps
 * today's behaviour, so a miss here can only fall on the safe side. Each
 * entry is tested against the SEGMENT that carries the `<<`, so a data sink
 * next to a real command (`cat > f <<EOF … ; rm -rf x`) loses only its body.
 */
const DATA_SINK_HEREDOC: RegExp[] = [
  // `cat > file` / `cat >> file` — not `2>`, not `>&`, not `>|`.
  /^(?:sudo\s+)?cat\s[^|]*(?<![0-9&])>>?\s*(?![&|])\S/,
  /^(?:sudo\s+)?tee\b(?:\s+-a)?\s+\S/,
  // Issue/PR/release bodies and commit messages read from stdin.
  /^gh\s[^|]*\s(?:--body-file|-F)[=\s]+-(?:\s|$)/,
  /^git\s+commit\b[^|]*\s(?:-F|--file)[=\s]+-(?:\s|$)/,
];

/** `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD` — never `<<<`. */
const HEREDOC_OP = /<<(?!<)(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|(\\?[A-Za-z_][A-Za-z0-9_.-]*))/g;

interface HeredocSpec {
  delim: string;
  /** A quoted delimiter suppresses every expansion inside the body. */
  quoted: boolean;
  /** `<<-` strips leading tabs, including on the terminator line. */
  stripTabs: boolean;
  /** The consumer of this body is on the data-sink allowlist. */
  sink: boolean;
}

/** The heredocs opened by one physical line, in the order bash reads them. */
function headerHeredocs(line: string): HeredocSpec[] {
  if (!line.includes("<<")) return [];
  // A heredoc whose output feeds a pipeline can still land in a shell
  // (`cat <<'EOF' | bash`), so nothing on such a line counts as a sink.
  const piped = line.includes("|");
  const specs: HeredocSpec[] = [];
  for (const segment of line.split(/&&|;/)) {
    const sink = !piped && DATA_SINK_HEREDOC.some((re) => re.test(segment.trim()));
    HEREDOC_OP.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HEREDOC_OP.exec(segment)) !== null) {
      const word = m[2] ?? m[3] ?? m[4] ?? "";
      specs.push({
        delim: word.startsWith("\\") ? word.slice(1) : word,
        quoted: m[2] !== undefined || m[3] !== undefined || word.startsWith("\\"),
        stripTabs: m[1] === "-",
        sink,
      });
    }
  }
  return specs;
}

/**
 * Drop the heredoc bodies that are pure data (#521).
 *
 * Only the BODY goes; the header line stays in scope, so a command after the
 * heredoc on that line (`cat > f <<'EOF' … ; rm -rf x`) and every line after
 * the terminator are still matched. Nested heredocs need no recursion: a
 * `bash <<'OUTER'` is no sink, so its whole body — inner heredoc included —
 * stays in scope, and a sink's body is dropped wholesale.
 */
function stripDataSinkHeredocBodies(cmd: string): string {
  if (!cmd.includes("<<")) return cmd;
  const lines = cmd.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    kept.push(line);
    for (const spec of headerHeredocs(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const raw = lines[i++];
        const candidate = spec.stripTabs ? raw.replace(/^\t+/, "") : raw;
        if (candidate.trim() === spec.delim) break;
        body.push(raw);
      }
      // An unquoted delimiter expands the body: `$(…)` and backticks in it are
      // executed by the sink's own shell, so that body is a command, not data.
      const executable = !spec.sink || (!spec.quoted && /\$\(|`/.test(body.join("\n")));
      if (executable) kept.push(...body);
    }
  }
  return kept.join("\n");
}

/**
 * Flags whose quoted value is the message or body text (#540), per command
 * head. Everything these commands take is handed to git/gh as an argument and
 * never run by a shell, so the flag's value is data by POSITION — no attempt
 * is made to read the sentence. `git commit -am "…"` is a short-flag cluster
 * that ends in `-m`, which is why the git entry takes one.
 */
const GIT_MESSAGE_FLAG = /^(?:-[a-zA-Z]*m|--message)$/;
const GH_TEXT_FLAG = /^(?:-[tbn]|--(?:title|body|notes|comment|subject))$/;

function proseFlagFor(words: string[]): RegExp | null {
  if (words[0] === "git" && (words[1] === "commit" || words[1] === "tag")) return GIT_MESSAGE_FLAG;
  if (words[0] === "gh" && /^(?:issue|pr|release)$/.test(words[1] ?? "")) return GH_TEXT_FLAG;
  return null;
}

interface ShellWord {
  text: string;
  start: number;
  end: number;
  /** Where a single `'…'`/`"…"` part starts that runs to the word's end, with
   *  only plain characters before it (`"…"`, `--body="…"`); null otherwise. */
  quotedFrom: number | null;
}

const WORD_BREAK = " \t\n|&;()<>";

/**
 * Split a command into simple commands of words, honouring shell quoting.
 *
 * Returns null — "do not strip anything" — for every construct whose words it
 * cannot delimit exactly: a heredoc (its body is not shell text), command or
 * process substitution (`$(…)`, backticks, `<(…)`), `$'…'`/`$"…"` quoting, and
 * an unterminated quote. Bailing out keeps today's behaviour, so a gap in this
 * scanner can only fall on the safe side.
 */
function simpleCommands(cmd: string): Array<{ words: ShellWord[]; piped: boolean }> | null {
  const commands: Array<{ words: ShellWord[]; piped: boolean }> = [];
  let words: ShellWord[] = [];
  const close = (piped: boolean): void => {
    if (words.length > 0) commands.push({ words, piped });
    words = [];
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === " " || c === "\t") {
      i++;
    } else if (c === "#") {
      // A comment only starts at a word boundary; its quotes are not quotes.
      while (i < cmd.length && cmd[i] !== "\n") i++;
    } else if (c === "<" || c === ">") {
      if (cmd[i + 1] === "(") return null;
      if (c === "<" && cmd.startsWith("<<<", i)) i += 3;
      else if (c === "<" && cmd[i + 1] === "<") return null;
      else i += cmd[i + 1] === "&" || cmd[i + 1] === "|" || cmd[i + 1] === c ? 2 : 1;
    } else if (c === "&" && cmd[i + 1] === ">") {
      i += 2;
    } else if (c === "|") {
      const or = cmd[i + 1] === "|";
      close(!or);
      i += or || cmd[i + 1] === "&" ? 2 : 1;
    } else if (WORD_BREAK.includes(c)) {
      close(false);
      i++;
    } else {
      const start = i;
      let quotes = 0;
      let firstQuote = -1;
      let plainBefore = true;
      while (i < cmd.length && !WORD_BREAK.includes(cmd[i])) {
        const ch = cmd[i];
        if (ch === "'" || ch === '"') {
          if (firstQuote < 0) firstQuote = i;
          let j = i + 1;
          for (; j < cmd.length && cmd[j] !== ch; j++) {
            if (ch === "'") continue;
            if (cmd[j] === "\\") j++;
            else if (cmd[j] === "`" || (cmd[j] === "$" && cmd[j + 1] === "(")) return null;
          }
          if (j >= cmd.length) return null;
          quotes++;
          i = j + 1;
        } else if (ch === "`" || (ch === "$" && "('\"".includes(cmd[i + 1] ?? ""))) {
          return null;
        } else {
          if (firstQuote >= 0 || ch === "\\") plainBefore = false;
          i += ch === "\\" ? 2 : 1;
        }
      }
      const end = Math.min(i, cmd.length);
      words.push({
        text: cmd.slice(start, end),
        start,
        end,
        quotedFrom: quotes === 1 && plainBefore ? firstQuote : null,
      });
    }
  }
  close(false);
  return commands;
}

/**
 * Blank the quoted message/body values of git and gh (#540).
 *
 * #521 made heredoc bodies fed to a data sink out of scope; the same prose
 * reaches the tripwire as a quoted argument — `git commit -m "docs: why rm -rf
 * is blocked"`, `gh issue create --body "…git push --force…"`. Only the value
 * of a flag in `GIT_MESSAGE_FLAG`/`GH_TEXT_FLAG`, under the head it belongs
 * to, is blanked, and only when that value is exactly one quoted string.
 * Everything else keeps being matched: the command after the closing quote,
 * any other quoted argument, `bash -c "…"`/`eval "…"`, and every command whose
 * output feeds a pipe (it could land in a shell, as in #521).
 */
function stripProseArguments(cmd: string): string {
  if (!cmd.includes("'") && !cmd.includes('"')) return cmd;
  const commands = simpleCommands(cmd);
  if (!commands) return cmd;
  const spans: Array<[number, number]> = [];
  for (const { words, piped } of commands) {
    const flag = piped ? null : proseFlagFor(words.map((w) => w.text));
    if (!flag) continue;
    for (let k = 2; k < words.length; k++) {
      const w = words[k];
      const next = words[k + 1];
      if (flag.test(w.text) && next && next.quotedFrom === next.start) {
        spans.push([next.start, next.end]);
        k++;
      } else if (w.quotedFrom !== null && w.quotedFrom > w.start) {
        const prefix = w.text.slice(0, w.quotedFrom - w.start);
        if (prefix.startsWith("--") && prefix.endsWith("=") && flag.test(prefix.slice(0, -1))) {
          spans.push([w.quotedFrom, w.end]);
        }
      }
    }
  }
  let out = cmd;
  for (const [s, e] of spans.reverse()) out = out.slice(0, s) + "''" + out.slice(e);
  return out;
}

/**
 * The parts of a command line that actually run something (#415).
 *
 * Split on pipeline and sequence separators, then drop the segments that only
 * search. Per SEGMENT and not per command on purpose: `grep -rn "x" . | xargs
 * rm -rf` must still trip on its second half, and it does — only the `grep`
 * segment is dropped. A command with no separators is one segment, so the
 * common case costs a split of a short string.
 */
function executableSegments(cmd: string): string[] {
  return stripProseArguments(stripDataSinkHeredocBodies(cmd))
    .split(/\|\||&&|[|;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !SEARCH_ONLY_HEAD.test(s));
}

function matchPattern(cmd: string): { label: string; severity: "destructive" | "risky" } | null {
  // #540: quotes and backslashes inside a word do not change what runs —
  // `"rm" -rf /`, `rm "-rf" /` and `r\m -rf /` are `rm -rf /`. Each segment is
  // matched as written AND with them removed, so quoting cannot disguise a
  // command the patterns would catch unquoted.
  const segments = executableSegments(cmd).flatMap((s) => [s, s.replace(/["'\\]/g, "")]);
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (segments.some((s) => p.re.test(s))) return { label: p.label, severity: "destructive" };
  }
  for (const p of RISKY_PATTERNS) {
    if (segments.some((s) => p.re.test(s))) return { label: p.label, severity: "risky" };
  }
  return null;
}

/**
 * Run the tripwire pipeline; return the exact stdout document for the thin
 * client. Never throws — every failure degrades to `{}` plus telemetry.
 */
export async function runBashPreLane(payload: BashHookPayload, selfBaseUrl: string): Promise<string> {
  const startedAt = Date.now();
  const client = hookClient(payload);
  // #507 Nachbesserung: nur für die Telemetrie-Dimension — `client` oben bleibt
  // der surface-Default fürs Hint-Block-Attribut und den Recall-Loopback.
  const clientEvidence = hookClientEvidence(payload);

  if (payload.hook_event_name !== "PreToolUse") return "{}";
  if (payload.tool_name !== "Bash") return "{}";

  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  if (!command.trim()) return "{}";

  // Defensive: never recurse on our own hook binaries — checked on the
  // basename of the invoked program (bash-fail-lane's guard), NOT as a
  // substring. The substring form skipped every command that merely carried
  // the repo name in a path (/Users/…/bastra-recall/…, the session
  // scratchpad): 30 of 35 tripwire matches in one dogfood session went
  // silently unhinted and unlogged.
  if (invokesOwnBinary(command)) return "{}";

  const match = matchPattern(command);
  if (!match) return "{}";

  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));

  // The query is the command itself, not a label padded with filler words.
  // `${label} safety workflow user-preference` matched generic meta-working
  // memos via "workflow"/"user-preference" in every call (22.08.2026
  // measurement) — the command head is what a stored rule would name.
  const head = extractCommandHead(command);
  const query = head.startsWith(match.label) ? head : `${match.label} ${head}`.trim();

  let resp: RecallResponse | null = null;
  let status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" = "ok";
  let errMsg: string | null = null;
  try {
    resp = JSON.parse(
      await postLane(
        selfBaseUrl,
        "/hook/recall",
        {
          query,
          topics: ["bash", match.severity, "safety"],
          project: null,
          tool_name: "Bash",
          session_id: payload.session_id ?? null,
          tool_input_excerpt: command.slice(0, 4096),
          scope: "all-projects",
          k: 3,
          // #263: siehe bash-fail-lane — die Lane weist sich aus.
          client,
          hook_source: "bash-pre",
        },
        remainingMs,
      ),
    ) as RecallResponse;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH") {
      status = "daemon-unreachable";
    } else if (e.message === "timeout") {
      status = "timeout";
    } else {
      status = "error";
      errMsg = e.message ?? String(err);
    }
  }

  // P0: siehe bash-fail-lane.ts — auf der unfused Skala markiert der Floor
  // keinen Punkt. Die Warnung selbst hängt ohnehin nicht an einem Score.
  const unfused = isUnfused(resp);
  const hits: RecallHit[] = [];
  if (resp && Array.isArray(resp.hits)) {
    for (const h of resp.hits) {
      if (unfused || h.score >= SCORE_FLOOR) hits.push(h);
    }
  }
  if (resp && hits.length === 0) status = "no-hits";

  // Session dedup, same clock as the write lane (#106 MAX_SHOW inside the
  // 4h window, a load_memory marker resets it): the same memory was hinted
  // 2–9× per session before (22.08.2026 measurement). The backoff exemption
  // (#161) stays — dedup drops repeated memory LINES, never the warning.
  const sessionId = payload.session_id ?? "";
  let droppedDedupCount = 0;
  let emitted: RecallHit[] = hits;
  if (sessionId && hits.length > 0) {
    const state = await loadSessionState(sessionId);
    // #266: Die Entscheidung fällt der Context Governor — die Frage „darf ein
    // bereits gezeigtes Memory erneut erwähnt werden?" ist seine (§16.3). Was
    // „bereits gezeigt" HEISST, bleibt hier: `shouldDropHit` kennt das
    // 4h-Fenster, MAX_SHOW und den Load-Marker, der den Zähler zurücksetzt.
    // Der Governor bekommt das Ergebnis, nicht die Regel.
    //
    // Ohne Budget aufgerufen — das ist der heutige effektive Wert dieser Lane:
    // Es gibt keine Token- und keine Stückgrenze, nur `k` auf der Recall-Seite.
    // Ein Budget hier zu setzen wäre eine Verschärfung und keine
    // Vereinheitlichung; sie gehört in eine Konfigurationsentscheidung mit
    // gemessenen Zahlen (#354), nicht in diesen Umbau.
    const governed = governContext(
      await Promise.all(
        hits.map(async (h, i) => ({
          id: h.id,
          // Die Recall-Liste ist bereits gerankt: Position = Priorität.
          priority: i,
          // Was der Hint kosten würde. Bei fehlendem Budget folgenlos, aber
          // nicht erfunden — die Summary ist der Löwenanteil der Zeile.
          text: h.summary ?? "",
          alreadyShown: shouldDropHit(state.shown[h.id], await getLoadedMarkerMtime(h.id)),
        })),
      ),
      {},
    );
    droppedDedupCount = governed.dropped.filter((d) => d.reason === "already_shown").length;
    const keptIds = new Set(governed.kept.map((g) => g.id));
    const kept = hits.filter((h) => keptIds.has(h.id));
    emitted = kept;
    if (kept.length > 0) {
      const now = Date.now();
      // #539: bump against the state on disk, not against this snapshot —
      // four other lanes write the same file while the recall above runs.
      await mutateSessionState(sessionId, (s) => {
        for (const h of kept) bumpShown(s, h.id, now);
      });
    }
  }

  // Emit hint even if no memories match — the warning itself is the point.
  // #161 CONSTRAINT (see top of file): the tripwire is exempt from backoff.
  const block = formatHintBlock(match.label, match.severity, emitted, unfused, client);
  const stdout = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: block,
    },
  });

  // #458 (shadow): den fertigen Block ans Sitzungsbudget anrechnen und den
  // Governor-Entscheid loggen — nichts wird gekürzt.
  recordBudgetShadow(payload.session_id ?? null, "bash_hook_call", Math.ceil(block.length / 4));
  await writeTelemetry({
    session_id: payload.session_id ?? null,
    client: clientEvidence,
    matched_pattern: match.label,
    severity: match.severity,
    hint_kind:
      match.severity === "destructive" ? (reversibleDefault(match.label, client)?.kind ?? "stop") : null,
    daemon_url: selfBaseUrl,
    daemon_reachable: resp !== null,
    hint_count: emitted.length,
    dropped_dedup_count: droppedDedupCount,
    top_score: resp?.hits?.[0]?.score ?? null,
    latency_ms_total: Date.now() - startedAt,
    hint_tokens_est: Math.ceil(block.length / 4),
    hinted_ids: emitted.map((h) => h.id),
    hinted_types: emitted.map((h) => h.type),
    backoff_streak: 0,
    suppressed: false,
    suppressed_tokens_est: 0,
    status,
    error: errMsg,
  });
  // Usage sidecar (#154): only what was ACTUALLY injected counts as surfaced.
  await reportHinted(selfBaseUrl, emitted.map((h) => h.id), payload.session_id ?? null);

  return stdout;
}

function formatHintLine(h: RecallHit, hideScore = false): string {
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  // P0: gleiche Wahl wie in prompt-lane.ts — ohne Fusion keine Zahl.
  return hideScore
    ? `- ${h.id} (${h.type}): ${summary}`
    : `- ${h.id} (${h.type}, score ${Math.round(h.score)}): ${summary}`;
}

/**
 * Host opt-in: on a machine whose agent shell puts an archiving `rm` first in
 * PATH, "STOP — needs explicit confirmation" is false for rm and teaches the
 * model to fear a reversible move. Only the claude-code surface is covered —
 * that is where the shim is installed; other surfaces keep the STOP.
 */
function rmArchives(surface: string): boolean {
  return process.env.BASTRA_RM_ARCHIVES === "1" && surface === "claude-code";
}

/**
 * What the hint says instead of STOP when the act has an undo (#650 comment).
 *
 * - `receipt`: the command as typed is already recoverable — say how, no STOP.
 * - `reversible-form`: the bare command has no undo, but a form with the SAME
 *   observable result has one — name it; the bare form keeps the STOP.
 * - `stop`: no local undo (DROP TABLE, kubectl delete, gh repo delete, …).
 *
 * Invariant for every row: the undo changes HOW the act runs, never WHAT the
 * caller observes afterwards. A form that did less (or more) than the command
 * would be a lie the next step trips over — which is why `git clean` is not
 * offered `git stash -u` (that also reverts tracked edits).
 */
export type HintKind = "stop" | "receipt" | "reversible-form";

export function reversibleDefault(pattern: string, surface: string): { kind: HintKind; text: string } | null {
  switch (pattern) {
    case "rm -rf":
    case "rm -r":
      if (!rmArchives(surface)) return null;
      return {
        kind: "receipt",
        text:
          `\`${pattern}\` in this shell archives instead of deleting (host opt-in BASTRA_RM_ARCHIVES): ` +
          `targets move to ~/_archive/<date>/<full path>, \`agent-archive restore <path>\` puts them back; ` +
          `temp dirs are really removed; /, ~ and system dirs are refused.`,
      };
    case "git clean -f":
      if (!rmArchives(surface)) return null;
      return {
        kind: "reversible-form",
        text:
          `\`git clean\` unlinks directly and bypasses the archiving rm. Same result, reversible: ` +
          `list with \`git clean -n\` (same other flags), then remove exactly those paths with \`rm -r\` — ` +
          `it archives in this shell.`,
      };
    case "git branch -D":
      return {
        kind: "receipt",
        text:
          `the branch's commits usually stay recoverable: if it was ever checked out here they are in HEAD's ` +
          `reflog (\`git reflog\`, then \`git branch <name> <sha>\`). Its own reflog is deleted with it, so a ` +
          `branch never checked out here is recoverable only via \`git fsck --lost-found\` until gc — ` +
          `confirm only if it holds unmerged commits that exist nowhere else.`,
      };
    case "git commit --amend":
      return {
        kind: "receipt",
        text:
          `the pre-amend commit stays in HEAD's reflog: \`git reset --soft HEAD@{1}\` right after undoes the amend. ` +
          `If the old commit was already pushed, publishing the amend needs a force-push — that one is its own hint.`,
      };
    case "git push --force-with-lease":
      return {
        kind: "receipt",
        text:
          `the lease refuses if the remote branch moved since your last fetch, so only what you have seen is ` +
          `overwritten; the overwritten tip stays in the remote-tracking reflog (\`git reflog <remote>/<branch>\`) ` +
          `and can be pushed back.`,
      };
    case "git push --force":
    case "git push -f":
      return {
        kind: "reversible-form",
        text:
          `use \`git push --force-with-lease\` instead: same result when nobody else pushed, a refusal (not a ` +
          `silent overwrite) when someone did, and the overwritten tip stays in your remote-tracking reflog.`,
      };
    case "git reset --hard":
      return {
        kind: "reversible-form",
        text:
          `committed history is not at risk (the old HEAD stays in \`git reflog\`); what dies is uncommitted ` +
          `changes to tracked files. \`git stash push\` first, then the reset — same end state, and ` +
          `\`git stash pop\` brings the changes back (untracked files survive either way).`,
      };
    case "git checkout --":
      return {
        kind: "reversible-form",
        text:
          `what dies is the unstaged changes in those paths. \`git stash push --keep-index -- <paths>\` leaves ` +
          `exactly the same worktree and index; \`git restore --source=stash@{0} --worktree -- <paths>\` brings the ` +
          `changes back (not \`git stash pop\` — it conflicts when those paths also have staged changes).`,
      };
    default:
      return null;
  }
}

export function formatHintBlock(
  pattern: string,
  severity: "destructive" | "risky",
  hits: RecallHit[],
  unfused = false,
  surface = "claude-code",
): string {
  const head = `<recall-hints surface="${surface}" trigger="bash-${severity}">`;
  const tail = `</recall-hints>`;
  const lines: string[] = [];

  const undo = severity === "destructive" ? reversibleDefault(pattern, surface) : null;
  if (undo?.kind === "receipt") {
    lines.push(`NOTE — reversible (pattern: \`${pattern}\`): ${undo.text} No confirmation needed.`);
  } else if (undo?.kind === "reversible-form") {
    lines.push(
      `REVERSIBLE FORM — destructive Bash command detected (pattern: \`${pattern}\`), but it has an undo: ` +
        `${undo.text} Run that form — it needs no confirmation. ` +
        `The bare command keeps the rule: explicit user confirmation unless authorized in advance.`,
    );
  } else if (severity === "destructive") {
    lines.push(
      `STOP — destructive Bash command detected (pattern: \`${pattern}\`). ` +
        `Per user-preference this needs explicit user confirmation unless authorized in advance. ` +
        `Do not run blindly: confirm the target paths, the scope of effect, and that the user has asked for this exact action.`,
    );
  } else {
    lines.push(
      `CAUTION — risky Bash command detected (pattern: \`${pattern}\`). ` +
        `Check the target/scope before running — recursive/destructive side effects are easy to miss.`,
    );
  }

  if (hits.length > 0) {
    lines.push("");
    lines.push(
      unfused
        ? `Relevant lessons / preferences from the vault — load_memory(id) before deciding to run. ` +
          unfusedHeadline("this command")
        : `Relevant lessons / preferences from the vault — load_memory(id) before deciding to run:`,
    );
    for (const h of hits) lines.push(formatHintLine(h, unfused));
  }

  return [head, HINT_FRAME_NOTE, stripFenceMarkers(lines.join("\n")), tail].join("\n");
}

interface BashHookCallTelemetry {
  /** #356: the Claude Code session this call belongs to — the payload's
   *  session_id, so per-session aggregation (context tax, #354) is possible.
   *  A synthetic UUID is the fallback only when the payload carried none. */
  session_id?: string | null;
  /** #507: die aufrufende Oberfläche — NUR wenn belegt (`hookClientEvidence`),
   *  nie der surface-Default. */
  client: HookClientEvidence;
  matched_pattern: string;
  severity: "destructive" | "risky";
  /** #650/#614: what the block told the agent — STOP, a receipt, or the
   *  reversible form. Follow-through is only a question for `stop`. Null for
   *  risky (CAUTION). */
  hint_kind: HintKind | null;
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  /** Memory lines dropped by the session dedup (same clock as the write lane). */
  dropped_dedup_count: number;
  top_score: number | null;
  latency_ms_total: number;
  /** Geschätzte Tokens des injizierten Tripwire-Blocks (#72). */
  hint_tokens_est: number;
  hinted_ids: string[];
  /** #354: Memory-Typ je `hinted_ids`-Eintrag, gleiche Reihenfolge. */
  hinted_types: string[];
  /** #161: Tripwire ist backoff-EXEMPT — Felder bleiben fürs Stats-Schema,
   *  sind aber konstant „nie unterdrückt“ (streak 0, suppressed false, 0). */
  backoff_streak: 0;
  suppressed: false;
  suppressed_tokens_est: 0;
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
}

async function writeTelemetry(payload: BashHookCallTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // #356: the payload's session_id is real session state — synthetic UUID
    // only when the payload carried none.
    const { session_id: payloadSessionId, client, ...rest } = payload;
    const event = {
      kind: "bash_hook_call",
      ts,
      session_id: payloadSessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
      // #507: bash-pre is this lane's own hook_source — it never varies per call.
      dimensions: dimensionsFrom({ client, hook_source: "bash-pre", session_id: payloadSessionId }),
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the lane.
  }
}

// Export for testing.
export { matchPattern, DESTRUCTIVE_PATTERNS, RISKY_PATTERNS };
