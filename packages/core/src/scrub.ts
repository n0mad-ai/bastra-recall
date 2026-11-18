import { scanNetworkForms } from "./scrub-network.js";
import { pskLineEnd, scanPskForms, secretShaped } from "./scrub-psk.js";

// Injected-context scrubbing lives in scrub-injected.ts; this entry point keeps
// both halves of the public "@bastra-recall/core/scrub" surface.
export {
  scrubInjectedBlocks,
  containsInjectedBlock,
  stripFenceMarkers,
  INJECTED_BLOCK_TAGS,
  HINT_FRAME_NOTE,
  FROZEN_FRAME_NOTES,
} from "./scrub-injected.js";
export type { InjectedBlockTag, ScrubResult } from "./scrub-injected.js";

// Secret redaction (#1084) is independent of injected-context scrubbing.
export interface SecretRedactionResult {
  text: string;
  /** Original secret characters hidden, excluding home-directory abbreviation. */
  redactedChars: number;
}

type SecretSpan = [number, number];

/** Technical credential names, not words used to classify a conversation. */
function credentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[\p{Cf}\s_-]/gu, "");
  if (/usepsk$|psk(?:enabled|mode|identity)$/.test(normalized)) return false;
  if (pskKey(key)) return true;
  return (
    /(?:password|passwd|passphrase|psk|presharedkey|cookie|token|secret|apikey|accesskey|accesskeyid|secretkey|privatekey|accountkey|authorization|credential)$/.test(
      normalized
    ) ||
    normalized === "key" ||
    /(?:^|[_.\s-])(?:pwd|pass)$/i.test(key) ||
    /(?:Pwd|Pass)$/.test(key)
  );
}

function pskKey(key: string): boolean {
  const raw = key.replace(/\p{Cf}/gu, ""),
    normalized = raw.toLowerCase().replace(/[\s_-]/g, "");
  return (
    /(?:psk(?:\d+|key|value)?|presharedkey|wifikey)$/.test(normalized) ||
    (/^psk(?:_[a-z0-9]+)+$/i.test(raw) && !/^psk(?:enabled|mode|identity)$/.test(normalized))
  );
}

/** Locations and identifiers are the useful content of a draft, not access values. */
function isLocator(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:(?=\S)/i.test(value)) return true;
  if (/^(?:[~.]?[\/\\]|\.\.[\/\\]|[a-z]:[\/\\])/i.test(value)) return true;
  if (/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(value)) return true;
  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) return true;
  if (/^(?:[\p{L}\p{N}_-]+\.)+[\p{L}\p{N}_-]{2,}(?::\d+)?$/u.test(value)) return true;
  if (value.includes("@") && isLocator(value.slice(value.lastIndexOf("@") + 1))) return true;
  if (value.includes("/")) {
    const parts = value.split("/");
    // Relative file/image/vault paths have named components; opaque base64
    // with slashes has no file extension or word separators in those parts.
    if (parts.length > 1 && parts.some((p) => /[._-]/.test(p)) && parts.every((p) => /^[\p{L}\p{N}_.:@-]*$/u.test(p)))
      return true;
  }
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) return true;
  if (value.includes("-") || value.includes("_")) {
    const parts = value.split(/[-_]/);
    if (parts.length > 1 && parts.every((p) => /^(?:[A-Z]?[a-z]{2,}|[A-Z]{1,4}|[0-9]+)$/.test(p))) return true;
  }
  // Ordinary camelCase code symbols carry several readable word segments.
  return codeSymbol(value);
}

// Disjoint character runs keep symbol recognition linear; nested uppercase
// alternatives in a repeated regexp could backtrack on long acronym runs.
function codeSymbol(value: string): boolean {
  const runs = value.match(/[A-Z]+|[a-z]+|[0-9]+|[^A-Za-z0-9]+/g) ?? [];
  let segments = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (/^[a-z]+$/.test(run)) {
      if (i !== 0 || run.length < 2) return false;
      segments++;
    } else if (/^[A-Z]+$/.test(run)) {
      const next = runs[i + 1] ?? "";
      if (/^[a-z]+$/.test(next)) {
        if (next.length < 2 || (i === 0 && run.length === 2)) return false;
        segments += Math.ceil((run.length - 1) / 2) + 1;
        i++;
      } else if (/^[0-9]+$/.test(next)) {
        if (run.length === 2 || (i === 0 && run.length < 3)) return false;
        segments += Math.floor((run.length - 1) / 2) + 1;
        i++;
      } else {
        if (run.length < 2) return false;
        segments += Math.floor(run.length / 2);
      }
    } else return false;
  }
  return segments >= 3;
}

function isReference(value: string): boolean {
  return (
    /^(?:[a-z][a-z0-9+.-]*:\/\/|[~.]?[\/\\]|\.\.[\/\\]|[a-z]:[\/\\])/i.test(value) ||
    /^\$(?:[a-z_][a-z0-9_]*|\{[a-z_][a-z0-9_]*\})$/i.test(value)
  );
}

function opaqueValue(value: string, minimum: number): boolean {
  if (value.length < minimum || isLocator(value) || !/^[a-z0-9_+\/=.\-\p{Cf}]+$/iu.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length;
  const mixed = (value.match(/[A-Z]/g)?.length ?? 0) >= 4 && (value.match(/[a-z]/g)?.length ?? 0) >= 4;
  return classes >= 2 && (/[0-9+\/=]/.test(value) || mixed) && entropy(value) >= 3.5;
}

/** Value spans preserve quotes and support quoted concatenation and continuations. */
function valueSpans(text: string, start: number, query = false): { spans: SecretSpan[]; end: number } {
  const spans: SecretSpan[] = [];
  let pos = start;
  const readPart = (): void => {
    let escapes = 0;
    while (text[pos + escapes] === "\\") escapes++;
    const quote = text[pos + escapes];
    if (quote === '"' || quote === "'" || quote === "`") {
      const begin = (pos += escapes + 1);
      while (pos < text.length) {
        if (text[pos] === "\\") {
          let stop = pos;
          while (text[stop] === "\\") stop++;
          if (text[stop] === quote && escapes > 0 && stop - pos === escapes) break;
          if (text[stop] === quote && escapes === 0 && (stop - pos) % 2 === 0) {
            pos = stop;
            break;
          }
          pos = stop;
          if (text[pos] === quote) pos++;
          continue;
        }
        if (escapes === 0 && text[pos] === quote) break;
        pos++;
      }
      spans.push([begin, pos]);
      if (pos < text.length) pos += escapes + 1;
    } else {
      const begin = pos;
      if (text.startsWith("[REDACTED]", pos)) pos += "[REDACTED]".length;
      else
        while (pos < text.length) {
          if (text.startsWith("${", pos)) {
            const variable = /^\$\{[a-z_][a-z0-9_]*\}/i.exec(text.slice(pos));
            if (variable) {
              pos += variable[0].length;
              continue;
            }
          }
          if (text[pos] === "\\" && pos + 1 < text.length && !/[\r\n]/.test(text[pos + 1])) {
            pos += 2;
            continue;
          }
          if (/[\s,;'"`<>}\]]/.test(text[pos]) || (query && /[&#]/.test(text[pos]))) break;
          pos++;
        }
      spans.push([begin, pos]);
    }
  };
  readPart();
  for (;;) {
    const rest = text.slice(pos);
    const continued = /^[ \t]*\r?\n[ \t]*/.exec(rest);
    if (continued && spans.length && text.slice(...spans[spans.length - 1]).endsWith("\\")) {
      pos += continued[0].length;
      readPart();
      continue;
    }
    const concat = /^[ \t\r\n]*\+[ \t\r\n]*(?=\\*["'`])/.exec(rest);
    if (concat) {
      pos += concat[0].length;
      readPart();
      continue;
    }
    const continuation = /^[ \t]*\r?\n[ \t]*([a-z0-9_+\/=.\-]+)(?=[ \t]*(?:\r?\n|$))/i.exec(rest);
    if (continuation && opaqueValue(continuation[1], 8)) {
      const begin = pos + continuation[0].length - continuation[1].length;
      spans.push([begin, begin + continuation[1].length]);
      pos += continuation[0].length;
      continue;
    }
    break;
  }
  return { spans, end: pos };
}

/** curl/HTTPie userinfo: curl `-u`, `--user`, `--proxy-user`, bundled/attached
 * (`-sSLu`, `-sufixture:pw`), or HTTPie `-a`/`--auth`. The walk from each
 * command passes only options, one operand per option, quoted strings and
 * URL-like operands, so auth flags of a later command are not borrowed. */
function scanUserAuth(text: string, mark: (start: number, length: number) => void): void {
  const calls = /(?<![\p{L}\p{N}_.-])(curl(?:\.exe)?|http)(?=[ \t])/giu;
  const gap = /(?:[ \t]|\\\r?\n)*/y,
    bare = /[^\s;&|"'`]+/y;
  let call: RegExpExecArray | null;
  while ((call = calls.exec(text))) {
    let pos = call.index + call[0].length,
      operand = true;
    for (;;) {
      gap.lastIndex = pos;
      pos += gap.exec(text)![0].length;
      let end = pos;
      for (;;) {
        if (text[end] === '"' || text[end] === "'") {
          const close = text.indexOf(text[end], end + 1);
          if (close < 0) break;
          end = close + 1;
        } else {
          bare.lastIndex = end;
          const part = bare.exec(text);
          if (!part) break;
          end += part[0].length;
        }
      }
      if (end === pos) break;
      const word = text.slice(pos, end);
      const user = (
        call[1].toLowerCase() === "http" ? /^(?:--auth(?:=|$)|-a)/i : /^(?:--(?:proxy-)?user(?:=|$)|-[a-z]*?u)/i
      ).exec(word);
      if (user) {
        let start = pos + user[0].length;
        if (start === end && !user[0].endsWith("=")) {
          gap.lastIndex = start;
          start += gap.exec(text)![0].length;
        }
        const parsed = valueSpans(text, start);
        const value = parsed.spans.map(([a, b]) => text.slice(a, b)).join("");
        const colon = value.indexOf(":");
        if (colon >= 0 && colon < value.length - 1 && !isReference(value.slice(colon + 1)))
          for (const [a, b] of parsed.spans) mark(a, b - a);
        pos = Math.max(parsed.end, end);
        operand = false;
      } else if (word.startsWith("-")) {
        operand = true;
        pos = end;
      } else if (operand || /[.:\/]|^["'$]/.test(word)) {
        operand = false;
        pos = end;
      } else break;
    }
    calls.lastIndex = Math.max(calls.lastIndex, pos);
  }
}

/**
 * The text under scan and the credential spans found in it (#1528: split out
 * of one 85-branch function). Every step below only adds spans and keeps its
 * own position state, so the step order does not change the output: spans are
 * sorted and merged once at the end.
 */
class SecretScan {
  readonly spans: SecretSpan[] = [];

  constructor(readonly text: string) {}

  /** ssh/kubectl operands and host/target/model positions name things, not secrets. */
  namedContext(start: number): boolean {
    return /(?:^|\s)(?:ssh|kubectl[ \t]+logs|(?:model|target|host)[ \t]*[:=])[ \t]+$/.test(
      this.text.slice(Math.max(0, start - 128), start)
    );
  }

  mark(start: number, length: number): void {
    if (length > 0 && this.text.slice(start, start + length) !== "[REDACTED]") this.spans.push([start, start + length]);
  }

  /** Mark the value that starts at `start`; returns where it ends. */
  markValue(start: number, strong: boolean, query = false, reference = true): number {
    const scalar = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*\r?\n/.exec(this.text.slice(start));
    if (strong && scalar) return this.markBlockScalar(start, scalar[0].length, reference);
    const parsed = valueSpans(this.text, start, query);
    const joined = parsed.spans
      .map(([a, b]) => this.text.slice(a, b))
      .join("")
      .replace(/\p{Cf}/gu, "");
    // A reference names where a credential comes from; it is not the value.
    if (reference && isReference(joined)) strong = false;
    if (!strong && this.namedContext(start)) return parsed.end;
    if (strong || opaqueValue(joined, 16)) for (const [a, b] of parsed.spans) this.mark(a, b - a);
    return parsed.end;
  }

  /** A YAML block scalar (`|` / `>`): every line indented below its key. */
  private markBlockScalar(start: number, headerLength: number, reference: boolean): number {
    const text = this.text;
    const lineStart = text.lastIndexOf("\n", start) + 1;
    const baseIndent = /^[ \t]*/.exec(text.slice(lineStart))![0].length;
    const body: SecretSpan[] = [];
    let end = start + headerLength;
    while (end < text.length) {
      const stop = text.indexOf("\n", end);
      const lineEnd = stop < 0 ? text.length : stop;
      const line = text.slice(end, lineEnd).replace(/\r$/, "");
      const indent = /^[ \t]*/.exec(line)![0].length;
      if (line.trim() && indent <= baseIndent) break;
      if (line.trim()) body.push([end + indent, end + line.length]);
      end = stop < 0 ? text.length : stop + 1;
    }
    const contents = body.map(([a, b]) => text.slice(a, b)).join("\n");
    if (!(reference && body.length === 1 && isReference(contents))) {
      for (const [a, b] of body) this.mark(a, b - a);
    }
    return end;
  }

  // Bare PSK assignment passphrases may contain spaces. Stop at a line/field/flag
  // boundary; quoted values, references and block scalars keep the existing parser.
  markPsk(start: number): number {
    const text = this.text;
    const tail = text.slice(start);
    if (tail.startsWith("[REDACTED]")) return start + "[REDACTED]".length;
    if (valueSpans(text, start).spans.length > 1) return this.markValue(start, true);
    if (/^(?:true|false|[01]|WPA[23])(?=\s|[,;}]|$)/i.test(tail) || /^(?:bitte|siehe)\b/i.test(tail)) return start;
    if (/^["'`$|>\\]/.test(tail) || isReference(/^\S*/.exec(tail)![0])) return this.markValue(start, true);
    const value = text.slice(start, pskLineEnd(text, start)).trimEnd();
    if (value && value !== "[REDACTED]") this.mark(start, value.length);
    return start + value.length;
  }

  // Prose and command forms without `=` name no value boundary, so only a quoted
  // value or a secret-shaped token is redacted; plain words stay readable.
  markLoose(start: number, tokens = 1): void {
    const text = this.text;
    for (let pos = start, i = 0; i < tokens; i++) {
      if (/["'`]/.test(text[pos] ?? "")) pos = this.markValue(pos, true);
      else {
        LOOSE_TOKEN.lastIndex = pos;
        const raw = LOOSE_TOKEN.exec(text)?.[0];
        if (!raw) return;
        // Sentence punctuation after the token; a loop, not a `+$` pattern.
        let end = raw.length;
        while (end > 0 && ".:!?".includes(raw[end - 1])) end--;
        const value = raw.slice(0, end);
        if (secretShaped(value) && !isReference(value) && !/^WPA[23]$/i.test(value)) this.mark(pos, raw.length);
        pos += raw.length;
      }
      while (text[pos] === " " || text[pos] === "\t") pos++;
    }
  }
}

/** Sticky; `lastIndex` is set before every use. */
const LOOSE_TOKEN = /[^\s,;"'`<>|&()]+/y;

function markPemBlocks(scan: SecretScan): void {
  for (const m of scan.text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?(?:-----END \1-----|$)/g))
    scan.mark(m.index!, m[0].length);
}

/** Locator-shaped words and named-context operands; opaque runs inside them stay. */
function locationSpans(scan: SecretScan): SecretSpan[] {
  const locations: SecretSpan[] = [];
  for (const m of scan.text.matchAll(/[^\s"'`<>]+/g)) {
    let end = m[0].length;
    while (end > 0 && "(),;".includes(m[0][end - 1])) end--;
    const value = m[0].slice(0, end);
    if (isLocator(value) || scan.namedContext(m.index!)) locations.push([m.index!, m.index! + value.length]);
  }
  return locations;
}

// Find the first @ followed by a host boundary, rather than the last @ in
// the entire URL (a path or query may contain more). A literal @ in the
// password is not a host boundary when another @ follows it directly.
function markUrlUserinfo(scan: SecretScan): void {
  for (const m of scan.text.matchAll(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi)) {
    const offset = m[0].indexOf("://") + 3;
    const rest = m[0].slice(offset);
    const delimiter = rest.search(/[/?#]/);
    const authority = delimiter < 0 ? rest : rest.slice(0, delimiter);
    if (/:(?:\d+)$/.test(authority) && !authority.includes("@")) continue;
    const colon = rest.indexOf(":");
    let at = rest.indexOf("@");
    if (delimiter >= 0 && delimiter < at && (colon < 0 || colon > delimiter)) continue;
    while (at >= 0) {
      if (/^(?:[\p{L}\p{N}_.-]+|\[[a-f0-9:]+\])(?::\d+)?(?=[/?#]|$)/iu.test(rest.slice(at + 1))) {
        scan.mark(m.index! + offset, at);
        break;
      }
      at = rest.indexOf("@", at + 1);
    }
  }
}

// Provider-issued prefixes remain decisive even inside an otherwise useful URL.
function markProviderTokens(scan: SecretScan): void {
  for (const m of scan.text.matchAll(
    /\b(?:sk-[a-z0-9_\-\p{Cf}]{8,}|sk_(?:live|test)_[a-z0-9_\p{Cf}]{8,}|gh[pousr]_[a-z0-9_\p{Cf}]{8,}|github_pat_[a-z0-9_\p{Cf}]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[a-z0-9\-\p{Cf}]{8,}|AIza[a-z0-9_\-]{20,}|glpat-[a-z0-9_\-]{8,}|npm_[a-z0-9_]{8,}|hf_[a-z0-9_]{8,}|dckr_pat_[a-z0-9_]{8,}|SG\.[a-z0-9_\-]+\.[a-z0-9_\-]+|[0-9]{6,12}:[a-z0-9_\-]{30,})/giu
  ))
    scan.mark(m.index!, m[0].length);
}

// Scan complete dotted tokens once. Looking for eyJ within the first
// segment permits a hyphen prefix without retrying every eyJ in a long run.
function markJwts(scan: SecretScan): void {
  for (const m of scan.text.matchAll(/(?<![a-z0-9_.-])[a-z0-9_-]+(?:\.[a-z0-9_-]+){2}/gi)) {
    const first = m[0].slice(0, m[0].indexOf("."));
    const jwt = /(?:^|[^a-z0-9_])(eyJ[a-z0-9_-]+)/i.exec(first);
    if (jwt)
      scan.mark(
        m.index! + jwt.index + jwt[0].length - jwt[1].length,
        m[0].length - jwt.index - jwt[0].length + jwt[1].length
      );
  }
}

// URL query credentials are scanned separately, including inside an env URL.
function markQueryCredentials(scan: SecretScan): void {
  let queryEnd = 0;
  for (const m of scan.text.matchAll(/[?&]([a-z0-9_-]+)=/gi))
    if (m.index! >= queryEnd && credentialKey(m[1])) queryEnd = scan.markValue(m.index! + m[0].length, true, true);
}

/** Where an assignment's value starts, or undefined when the line break after
 * the separator leads to the next binding instead of a value. */
function assignmentValueStart(text: string, assignment: RegExpExecArray): number | undefined {
  let start = assignment.index + assignment[0].length;
  if (/[\r\n]/.test(text[start] ?? "")) {
    while (start < text.length && /\s/.test(text[start])) start++;
    if (/^(?:"[^"\r\n]{1,80}"|'[^'\r\n]{1,80}'|[\p{L}\p{N}_.-]{1,128})[ \t]*[=:]/u.test(text.slice(start)))
      return undefined;
  }
  return start;
}

/** The value spans of an authorization binding: quoted, inside an enclosing
 * quote, or to the end of the header (Digest parameters included). */
function authorizationValue(text: string, index: number, start: number): { spans: SecretSpan[]; end: number } {
  if (/^\\*["'`]/.test(text.slice(start))) return valueSpans(text, start);
  if (/^["'`]/.test(text[index - 1] ?? "")) {
    const enclosing = valueSpans(text, index - 1);
    return { spans: [[start, enclosing.spans[0][1]]], end: enclosing.end };
  }
  let end = start;
  const digest = /^Digest[ \t]/i.test(text.slice(start));
  while (end < text.length && !(digest ? /[\r\n<>}]/ : /[\r\n"'`<>}]/).test(text[end])) end++;
  return { spans: [[start, end]], end };
}

/** Marks an authorization value without its scheme; returns where it ends. */
function markAuthorization(scan: SecretScan, index: number, start: number): number {
  const text = scan.text;
  const parsed = authorizationValue(text, index, start);
  for (let i = 0; i < parsed.spans.length; i++) {
    let [a, b] = parsed.spans[i];
    if (i === 0) {
      const scheme = /^[a-z][a-z0-9._-]*[ \t]+(?=\S)/i.exec(text.slice(a, b));
      if (scheme) a += scheme[0].length;
    }
    const value = text.slice(a, b);
    if (!isReference(value)) scan.mark(a, b - a);
  }
  return parsed.end;
}

/** Marks a PSK binding; returns where it ends. The words before the key do not
 * decide (INV-LANG-01): a protocol-mode value (`WPA2`, `true`) is left by
 * `markPsk`, in every language. */
function markPskAssignment(scan: SecretScan, index: number, start: number): number {
  const text = scan.text;
  const query = /[?&]/.test(text[index - 1] ?? "");
  return query ? scan.markValue(start, true, true) : scan.markPsk(start);
}

// A key in an object with a separate value field names that field, and a
// lower-case key after another word can name a sort/database key.
function namesKeyField(text: string, key: string, assignment: RegExpExecArray, start: number): boolean {
  return (
    key === "key" &&
    (/\p{L}[ \t]+$/u.test(text.slice(Math.max(0, assignment.index - 80), assignment.index)) ||
      (/^"key"[ \t]*:/.test(assignment[0]) && /^[^}\r\n]{0,200}"value"[ \t]*:/.test(text.slice(start))))
  );
}

function markAssignments(scan: SecretScan): void {
  const text = scan.text;
  const assignments =
    /(?<![\p{L}\p{N}_.-])(?:"([^"\r\n]{1,80})"|'([^'\r\n]{1,80})'|([\p{L}\p{N}_.\-\p{Cf}]{1,128}))[ \t]*[=:][ \t]*(?!\/\/)/gu;
  let assignment: RegExpExecArray | null;
  let neutralEnd = 0;
  while ((assignment = assignments.exec(text))) {
    const key = (assignment[1] ?? assignment[2] ?? assignment[3]).replace(/\\/g, "");
    const start = assignmentValueStart(text, assignment);
    if (start === undefined) continue;
    let end: number | undefined;
    if (key.toLowerCase().endsWith("authorization")) end = markAuthorization(scan, assignment.index, start);
    else if (pskKey(key)) end = markPskAssignment(scan, assignment.index, start);
    else {
      const strong = credentialKey(key) && !namesKeyField(text, key, assignment, start);
      if (!strong && start < neutralEnd) continue;
      end = scan.markValue(start, strong, /[?&]/.test(text[assignment.index - 1] ?? ""));
      // Cache a neutral wrapper's end, so its inner neutral bindings do not
      // rescan the same suffix. Credential bindings inside it still run.
      if (!strong) {
        neutralEnd = end;
        continue;
      }
    }
    if (end !== undefined) assignments.lastIndex = Math.max(assignments.lastIndex, end);
  }
}

function markCredentialFlags(scan: SecretScan): void {
  let flagEnd = 0;
  for (const m of scan.text.matchAll(/(?<![a-z0-9_-])--([a-z][a-z0-9_-]*)(?:=|[ \t]+)/gi))
    if (m.index! >= flagEnd && credentialKey(m[1])) flagEnd = scan.markValue(m.index! + m[0].length, true);
}

/** `-p` is a password only for sshpass and docker login, and for mysql/mariadb
 * when attached or mixed with digits; elsewhere it is a port or a path. */
function takesPasswordOption(text: string, m: RegExpExecArray, command: string | undefined): boolean {
  const attached = m[0] === "-p" && !!text[m.index + 2] && !/\s/.test(text[m.index + 2]);
  const separated = /^[a-z][a-z0-9]*(?=\s|$)/i.exec(text.slice(m.index + m[0].length));
  const mixed = separated !== null && /[0-9]/.test(separated[0]);
  return (
    command === "sshpass" ||
    command === "docker login" ||
    ((command === "mysql" || command === "mariadb") && (attached || mixed))
  );
}

// Track command context once, rather than repeatedly rescanning a long line.
function markPasswordOptions(scan: SecretScan): void {
  const text = scan.text;
  const commands = [
    ...text.matchAll(/(?:^|[ \t\/])(mysql|mariadb|sshpass|docker[ \t]+login|ssh|curl)(?=[ \t]|$)|[;&|\r\n]/gim),
  ];
  let commandIndex = 0;
  let passwordCommand: string | undefined;
  for (const m of text.matchAll(/(?<![a-z0-9_-])-p[ \t]*/g)) {
    while (commandIndex < commands.length && commands[commandIndex].index! < m.index!) {
      const command = commands[commandIndex++][1]?.toLowerCase().replace(/[ \t]+/g, " ");
      passwordCommand = command;
    }
    if (takesPasswordOption(text, m as RegExpExecArray, passwordCommand)) scan.markValue(m.index! + m[0].length, true);
  }
}

/** Long opaque runs outside every location: hex of 32+ or a high-entropy token. */
function markOpaqueRuns(scan: SecretScan, locations: SecretSpan[]): void {
  let locationIndex = 0;
  for (const m of scan.text.matchAll(/[a-z0-9_+\/.\-\p{Cf}]{24,}={0,2}/giu)) {
    while (locationIndex < locations.length && locations[locationIndex][1] <= m.index!) locationIndex++;
    const location = locations[locationIndex];
    if (location && m.index! >= location[0] && m.index! + m[0].length <= location[1]) continue;
    const value = m[0].replace(/\p{Cf}/gu, "");
    if (isLocator(value)) continue;
    if (/^[a-f0-9]{32,}$/i.test(value) || opaqueValue(value, 24)) scan.mark(m.index!, m[0].length);
  }
}

/** Replace the merged spans with one placeholder each. */
function renderSpans(text: string, spans: SecretSpan[]): SecretRedactionResult {
  spans.sort((a, b) => a[0] - b[0]);
  const merged: SecretSpan[] = [];
  for (const span of spans) {
    const prev = merged.at(-1);
    if (prev && span[0] <= prev[1]) prev[1] = Math.max(prev[1], span[1]);
    else merged.push([...span]);
  }
  let out = "";
  let end = 0;
  let redactedChars = 0;
  for (const [start, stop] of merged) {
    out += text.slice(end, start) + "[REDACTED]";
    redactedChars += stop - start;
    end = stop;
  }
  out += text.slice(end);
  return { text: out, redactedChars };
}

function abbreviateHome(text: string, home: string | undefined): string {
  if (!home || home === "/") return text;
  return text
    .split(home)
    .map((part, i) => (i === 0 ? part : (/^(?:[\\/\s'"`),;:]|$)/.test(part) ? "~" : home) + part))
    .join("");
}

/** Structural credential syntax plus explicitly supported DE/EN PSK bindings.
 * This is not a language-dependent classification of owner intent. */
export function redactSecrets(text: string, home?: string): SecretRedactionResult {
  const scan = new SecretScan(text);
  const mark = (start: number, length: number): void => scan.mark(start, length);
  markPemBlocks(scan);
  const locations = locationSpans(scan);
  markUrlUserinfo(scan);
  markProviderTokens(scan);
  markJwts(scan);
  markQueryCredentials(scan);
  markAssignments(scan);
  markCredentialFlags(scan);
  scanUserAuth(text, mark);
  scanNetworkForms(text, mark, isReference);
  scanPskForms(
    text,
    (start, tokens) => scan.markLoose(start, tokens),
    (start) => {
      scan.markValue(start, true);
    },
    mark,
    isReference
  );
  markPasswordOptions(scan);
  markOpaqueRuns(scan, locations);
  const rendered = renderSpans(text, scan.spans);
  return { text: abbreviateHome(rendered.text, home), redactedChars: rendered.redactedChars };
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    result -= p * Math.log2(p);
  }
  return result;
}
