import { readRuntimeSettingsRecord } from "./runtime-feature-settings.js";
import { bastraDataDir } from "./platform-paths.js";
/**
 * Deterministic file-size check in the PreToolUse hook (Daniel, 19.07.2026).
 *
 * The convention (~500 code lines as a guide, >800 for critical review;
 * tests 700/1000) previously depended on the agent remembering it while
 * writing. Feature work repeatedly displaced that consideration, so the hook
 * measures source lines without comments or blank lines before each edit.
 *
 * A compact `<file-size-check>` block makes the measurement available without
 * relying on recall. Pure stdlib, bounded input, kill switch BASTRA_SIZE_CHECK=off.
 *
 * The guide is not a limit: a coherent, justified larger file is fine. The
 * note asks for a modularization review before substantial growth, never
 * an automatic split or a blanket growth ban.
 */
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { envOff } from "./env.js";
import { escapeAttr } from "./escape-attr.js";

const CODE_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".swift",
  ".rs",
  ".go",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
]);
/** Generated blobs / bundles are none of the convention's business. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Throwaway contexts the convention does not apply to (#280).
 *
 * Reported case: `webui/mindspace-lab-anims.js` sits at ~1299 lines, so every
 * single edit to it got "over the 800-line ceiling — do NOT grow this file
 * further". Arithmetically correct, wrong advice: it is an animation sandbox
 * that gets deleted, not a module anyone will maintain. The only escape was
 * the all-or-nothing BASTRA_SIZE_CHECK=off, which also silences the check for
 * the real files edited in the same session.
 *
 * Segments are matched WHOLE, so `collaboration/` or `labels/` keep the
 * convention. The basename rule is delimiter-bounded for the same reason —
 * `collab-view.ts` and `foo-labels.ts` must not slip through.
 *
 * They are also matched only BELOW the project anchor (the hook's `cwd`):
 * meant are project-internal throwaway directories. A checkout that merely
 * lives under `~/labs/myapp` or `~/scratch/myapp` would otherwise exempt every
 * file it contains — a silent, un-overridable off switch for the whole project.
 */
const SANDBOX_SEGMENT = /^(sandbox(es)?|labs?|prototypes?|scratch|experiments?)$/;

/** Deliberately WITHOUT `prototype`: as a directory it means throwaway, as a
 *  file-name token it is usually production code about `Object.prototype`
 *  (`prototype-utils.ts`), and exempting that silently would be the one way
 *  this change could hurt. */
const SANDBOX_BASENAME = /(^|[-_.])(sandbox|lab|scratch|experiments?)([-_.]|$)/;

/**
 * True when a path sits in a throwaway context and the size convention should
 * not fire at all. Full exemption, not a raised ceiling: a bigger number would
 * only postpone the same wrong advice, and the agent would still have to argue
 * with a block it cannot act on. Sandbox code has no future readers, which is
 * the entire cost the convention is protecting against.
 *
 * `exemptPaths` comes from cli-settings `size.exemptPaths` (see
 * readSizeSettings) and is matched as a plain case-insensitive substring of
 * the normalized path — no glob engine on purpose, the hook has a 250 ms
 * budget and "webui/mindspace" is the shape users actually write.
 *
 * `cwd` is the project anchor the hook already passes to its skip gate; the
 * directory-segment rule only looks below it (see SANDBOX_SEGMENT).
 */
export function isSizeExemptPath(filePath: string, exemptPaths: string[] = [], cwd?: string): boolean {
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  for (const raw of exemptPaths) {
    const needle = raw.replace(/\\/g, "/").trim().toLowerCase();
    if (needle.length > 0 && norm.includes(needle)) return true;
  }
  const segments = norm.split("/");
  if (SANDBOX_BASENAME.test(segments[segments.length - 1] ?? "")) return true;
  return dirSegmentsBelow(norm, cwd).some((seg) => SANDBOX_SEGMENT.test(seg));
}

/** Directory segments of an already normalized (lowercase, forward-slash) path
 *  that lie strictly below the project anchor. Without an anchor — or for a
 *  file outside it — every directory segment is used: there is nothing to tell
 *  a project directory from one of its ancestors. */
function dirSegmentsBelow(norm: string, cwd?: string): string[] {
  const anchor = (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const below = anchor.length > 0 && norm.startsWith(`${anchor}/`) ? norm.slice(anchor.length + 1) : norm;
  return below.split("/").slice(0, -1);
}

export interface SizeThresholds {
  guide: number;
  critical: number;
}

/** Convention thresholds for a path, or null when the path is exempt — by file
 *  type (docs, configs, lockfiles, generated code — anything non-code) or by
 *  throwaway context (#280, see isSizeExemptPath).
 *  Guide value resolves env > cli-settings (size.guide — written by the
 *  onboarding interview / `bastra config set size.guide N`) > built-in 500.
 *  `settings` is the pre-read settings size block (see readSizeSettings),
 *  `cwd` the project anchor for the throwaway-directory rule. */
export function thresholdsFor(
  filePath: string,
  settings: { guide?: number; critical?: number; exemptPaths?: string[] } = {},
  cwd?: string
): SizeThresholds | null {
  const ext = extname(filePath).toLowerCase();
  if (!CODE_EXTS.has(ext)) return null;
  // Before the test-file branch: a sandbox test file is just as throwaway.
  if (isSizeExemptPath(filePath, settings.exemptPaths, cwd)) return null;
  const base = basename(filePath).toLowerCase();
  const isTest = /\.(test|spec)\./.test(base) || filePath.includes("__tests__");
  if (isTest) return { guide: 700, critical: 1000 }; // test files keep the fixed convention
  const guide = envNum("BASTRA_SIZE_GUIDE", numOr(settings.guide, 500));
  const critical = Math.max(guide, envNum("BASTRA_SIZE_CRITICAL", numOr(settings.critical, 800)));
  return { guide, critical };
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 100 && v <= 5000 ? Math.round(v) : fallback;
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}

/** Der User-Richtwert aus ~/.bastra/cli-settings.json — bewusst ein eigener
 *  Mini-Read (pure stdlib, DB zuerst) statt settings.ts-Import: der Hook hat 250 ms
 *  Budget und braucht exakt zwei Zahlen. Fehler → leeres Objekt. */
export async function readSizeSettings(
  settingsPath: string = join(bastraDataDir(), "cli-settings.json")
): Promise<{ guide?: number; critical?: number; exemptPaths?: string[] }> {
  try {
    const fromDatabase = readRuntimeSettingsRecord(settingsPath);
    const parsed = JSON.parse(
      fromDatabase === undefined ? await readFile(settingsPath, "utf8") : (fromDatabase ?? "{}")
    ) as {
      size?: { guide?: unknown; critical?: unknown; exemptPaths?: unknown };
    };
    // Non-strings and blanks are dropped rather than rejected: a broken entry
    // must not take the two numbers down with it (#280).
    const exemptPaths = Array.isArray(parsed.size?.exemptPaths)
      ? parsed.size.exemptPaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    return {
      ...(typeof parsed.size?.guide === "number" ? { guide: parsed.size.guide } : {}),
      ...(typeof parsed.size?.critical === "number" ? { critical: parsed.size.critical } : {}),
      ...(exemptPaths.length > 0 ? { exemptPaths } : {}),
    };
  } catch {
    return {};
  }
}

/** The injected note, or null while the file is comfortably under the guide.
 * Fires from ~90 % so responsibilities can be reviewed before substantial growth. */
export function formatSizeNote(filePath: string, lines: number, t: SizeThresholds): string | null {
  if (lines < Math.floor(t.guide * 0.9)) return null;
  const level = lines > t.critical ? "critical" : "guide";
  const msg =
    level === "critical"
      ? `over the ~${t.critical} code-line review threshold (comments and blank lines excluded) — review whether coherent responsibilities should become separate modules before substantial growth; explain why splitting or keeping this file is appropriate. This is a review prompt, not a growth ban.`
      : `at/near the ~${t.guide} code-line guide (comments and blank lines excluded) — before noticeable growth, review modularization; a coherent, justified larger file is fine. Split by responsibilities, not line counts.`;
  return `<file-size-check file="${escapeAttr(basename(filePath))}" lines="${lines}" level="${level}">${msg}</file-size-check>`;
}

/** A small lexical estimate, not a compiler: count each line containing source
 * or literal data once. Comments and blank source lines contribute nothing.
 * Nonblank literal contents remain data, even Python triple
 * quotes used as docstrings. Regex starts and JSX tags use lexical heuristics;
 * ambiguous grammar (including JSX versus generic arrows at expression start)
 * and preprocessor branches are not parsed. Prefer retaining literal data over
 * discarding it as documentation. */
function countCodeLines(raw: string, ext: string): number {
  const python = ext === ".py";
  const javascript = /\.(?:[cm]?js|jsx|tsx?|vue|svelte)$/.test(ext);
  const component = ext === ".vue" || ext === ".svelte";
  const jsx = ext === ".jsx" || ext === ".tsx";
  let markup = component;
  let tag = false;
  let tagName = "";
  let closingTag = false;
  let markupDepth = 0;
  let embedded = "";
  const expressions: { depth: number; tag: boolean; doubleBrace?: boolean }[] = [];
  const jsxReturns: number[] = [];
  // Each interpolation owns its brace depth; nested templates suspend the
  // surrounding interpolation until their closing backtick.
  const templates: number[] = [];
  let block = "";
  let blockDepth = 0;
  let quote = "";
  let literalRaw = false;
  let regex = false;
  let regexClass = false;
  let canRegex = true;
  let count = 0;
  let firstLine = true;

  for (const line of raw.split(/\r\n|\n|\r/)) {
    const shebang = firstLine && javascript && line.startsWith("#!");
    firstLine = false;
    if (shebang) continue;
    let code = quote.length > 0;
    for (let i = 0; i < line.length;) {
      const c = line[i];
      const next = line[i + 1];
      if (block) {
        if (block === "*/" && (ext === ".rs" || ext === ".swift") && line.startsWith("/*", i)) {
          blockDepth++;
          i += 2;
        } else if (line.startsWith(block, i)) {
          i += block.length;
          if (--blockDepth === 0) block = "";
        } else i++;
        continue;
      }
      if (quote) {
        code = true;
        if (javascript && quote === "`" && c === "$" && next === "{") {
          templates.push(1);
          quote = "";
          canRegex = true;
          i += 2;
        } else if (line.startsWith(quote, i)) {
          i += quote.length;
          quote = "";
          canRegex = false;
        } else if (!literalRaw && c === "\\") i += 2;
        else i++;
        continue;
      }
      if (regex) {
        code = true;
        if (c === "\\") i += 2;
        else {
          if (c === "[") regexClass = true;
          if (c === "]") regexClass = false;
          if (c === "/" && !regexClass) {
            regex = false;
            canRegex = false;
          }
          i++;
        }
        continue;
      }
      if (markup && !tag) {
        if (line.startsWith("<!--", i)) {
          block = "-->";
          blockDepth = 1;
          i += 4;
          continue;
        }
        if (jsx && line.startsWith("{/*", i)) {
          block = "*/}";
          blockDepth = 1;
          i += 3;
          continue;
        }
        if (c === "{" && (ext !== ".vue" || next === "{")) {
          code = true;
          const doubleBrace = ext === ".vue";
          expressions.push({ depth: 1, tag: false, doubleBrace });
          markup = false;
          // A Svelte closing directive is markup control, not a regex literal.
          const closingDirective = ext === ".svelte" && next === "/";
          canRegex = !closingDirective;
          i += doubleBrace || closingDirective ? 2 : 1;
          continue;
        }
        if (c !== "<") {
          if (/\S/.test(c)) code = true;
          i++;
          continue;
        }
      }
      if (embedded && line.startsWith(`</${embedded}`, i)) {
        embedded = "";
        markup = true;
      }
      if ((!markup && jsx && canRegex && c === "<" && /[A-Za-z/>]/.test(next ?? "")) || (markup && !tag && c === "<")) {
        if (!markup) jsxReturns.push(markupDepth);
        const match = /^<(\/?)([\w:.-]*)/.exec(line.slice(i));
        closingTag = match?.[1] === "/";
        tagName = (match?.[2] ?? "").toLowerCase();
        markup = true;
        tag = true;
        code = true;
        i += match?.[0].length ?? 1;
        continue;
      }
      if (tag && c === ">") {
        if (closingTag) markupDepth--;
        else if (line[i - 1] !== "/") markupDepth++;
        tag = false;
        if (component && !closingTag && /^(script|style)$/.test(tagName)) {
          embedded = tagName;
          markup = false;
        } else if (jsxReturns.length > 0 && markupDepth === jsxReturns[jsxReturns.length - 1]) {
          jsxReturns.pop();
          markup = false;
          canRegex = false;
        }
        code = true;
        i++;
        continue;
      }
      if (tag && c === "{" && ext !== ".vue") {
        expressions.push({ depth: 1, tag: true });
        tag = markup = false;
        canRegex = true;
        code = true;
        i++;
        continue;
      }
      if (
        !tag &&
        ((python && c === "#") || (!python && c === "/" && next === "/" && ext !== ".css" && embedded !== "style"))
      )
        break;
      if (!tag && !python && c === "/" && next === "*") {
        block = "*/";
        blockDepth = 1;
        i += 2;
        continue;
      }
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      code = true;
      // Rust raw strings allow arbitrary hash delimiters; Go backticks and
      // Python/Swift triple quotes keep comment-looking text intact as well.
      const rustRaw = ext === ".rs" && /[rbc]/.test(c) ? /^(?:b|c)?r(#+|)"/.exec(line.slice(i)) : null;
      if (rustRaw) {
        quote = `"${rustRaw[1]}`;
        literalRaw = true;
        i += rustRaw[0].length;
        continue;
      }
      if (ext === ".swift" && c === "#") {
        const start = i;
        while (line[i] === "#") i++;
        if (line[i] === '"') {
          const delimiter = line.startsWith('"""', i) ? '"""' : '"';
          quote = delimiter + line.slice(start, i);
          literalRaw = true;
          i += delimiter.length;
        }
        // Also consume failed raw-string prefixes once: retrying each suffix
        // of a long hash run makes Swift directives quadratic.
        continue;
      }
      if (c === '"' || c === "'" || (c === "`" && (javascript || ext === ".go"))) {
        // Rust lifetimes ('a, 'static) are identifiers, not unterminated strings.
        const lifetime = ext === ".rs" && c === "'" ? /^'[A-Za-z_]\w*/.exec(line.slice(i)) : null;
        if (lifetime && line[i + lifetime[0].length] !== "'") {
          i += lifetime[0].length;
          continue;
        }
        quote = (python || ext === ".swift") && line.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
        literalRaw = ext === ".go" && c === "`";
        i += quote.length;
        continue;
      }
      if (javascript && embedded !== "style" && !tag && c === "/" && canRegex) {
        regex = true;
        regexClass = false;
        i++;
        continue;
      }
      if (!markup) {
        if (templates.length > 0) {
          const top = templates.length - 1;
          if (c === "{") templates[top]++;
          if (c === "}" && --templates[top] === 0) {
            templates.pop();
            quote = "`";
            literalRaw = false;
            i++;
            continue;
          }
        }
        const expression = expressions[expressions.length - 1];
        if (expression && c === "{") expression.depth++;
        if (expression && c === "}" && --expression.depth === 0) {
          expressions.pop();
          markup = true;
          tag = expression.tag;
          if (expression.doubleBrace && next === "}") i++;
        }
        if (/[A-Za-z_$]/.test(c)) {
          const word = /^[\w$]+/.exec(line.slice(i))![0];
          canRegex = /^(return|throw|case|delete|void|typeof|yield|await|in|of|instanceof|new)$/.test(word);
          i += word.length;
          continue;
        }
        // A closing block can precede a regex statement. Object literals and
        // blocks remain lexically ambiguous without parsing JavaScript grammar.
        canRegex = /[({[}=,:;!?&|+*%~^<>-]/.test(c);
      }
      i++;
    }
    if (code && line.trim().length > 0) count++;
    // JS regex literals cannot span physical lines. Other unterminated
    // literals are kept conservatively because multiline data is common.
    regex = false;
    if (javascript && (quote === "'" || quote === '"') && !line.endsWith("\\")) quote = "";
  }
  return count;
}

/** Measure + format in one step — the hook's entry point. Never throws:
 *  a new/unreadable file simply has nothing to warn about. */
export async function fileSizeNote(filePath: string, settingsPath?: string, cwd?: string): Promise<string | null> {
  if (envOff("BASTRA_SIZE_CHECK")) return null;
  const t = thresholdsFor(filePath, await readSizeSettings(settingsPath), cwd);
  if (!t) return null;
  try {
    const raw = await readFile(filePath, "utf8");
    if (raw.length > MAX_BYTES) return null;
    return formatSizeNote(filePath, countCodeLines(raw, extname(filePath).toLowerCase()), t);
  } catch {
    return null;
  }
}
