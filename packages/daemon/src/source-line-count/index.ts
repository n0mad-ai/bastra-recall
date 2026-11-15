import { ScanCursor } from "./cursor.js";
import { LiteralScanner } from "./literals.js";
import { MarkupScanner } from "./markup.js";

/** A lexical estimate, not a compiler: source/literal data count, comments and
 * blank lines do not. Nonblank literal contents remain data, even Python triple
 * quotes used as docstrings. Regex starts and JSX tags use lexical heuristics;
 * ambiguous grammar (including JSX versus generic arrows at expression start)
 * and preprocessor branches are not parsed. Retain literal data rather than
 * discarding it as documentation. */
export function countCodeLines(raw: string, ext: string): number {
  const scanner = new SourceLineScanner(ext);
  let count = 0;
  let firstLine = true;
  for (const line of raw.split(/\r\n|\n|\r/)) {
    count += scanner.scanLine(line, firstLine);
    firstLine = false;
  }
  return count;
}

class SourceLineScanner {
  private readonly cursor: ScanCursor;
  private readonly literals: LiteralScanner;
  private readonly markup: MarkupScanner;
  private readonly markupEnabled: boolean;

  constructor(ext: string) {
    this.cursor = new ScanCursor(ext);
    this.literals = new LiteralScanner(this.cursor);
    this.markup = new MarkupScanner(this.cursor, this.literals);
    this.markupEnabled = this.cursor.jsx || this.cursor.component;
  }

  scanLine(line: string, firstLine: boolean): number {
    const s = this.cursor;
    if (firstLine && s.javascript && line.startsWith("#!")) return 0;
    s.line = line;
    s.index = 0;
    s.code = this.literals.inQuote;
    while (s.index < line.length) this.scanCharacter();
    const count = s.code && line.trim().length > 0 ? 1 : 0;
    this.literals.finishLine();
    return count;
  }

  private scanCharacter(): void {
    const s = this.cursor;
    s.readCharacter();
    // Existing literals own their contents before comment or markup openers.
    // Markup text must yield '<' to boundaries before source comments are read;
    // tags and their expressions in turn precede ordinary source token handling.
    if (this.literals.scanActive()) return;
    // Other language families cannot enter markup: avoid those dead phases on
    // every character without changing the ordered rules in the markup scanner.
    if (this.markupEnabled && (this.markup.scanText() || this.markup.scanBoundary())) return;
    if (this.literals.scanComment(this.markup.tag, this.markup.embedded)) return;
    if (/\s/.test(s.c)) {
      s.index++;
      return;
    }
    s.code = true;
    if (this.literals.scanStart()) return;
    if (s.javascript && s.c === "/" && this.literals.startRegex(this.markup.tag, this.markup.embedded)) return;
    if (!this.markup.active) this.scanSourceToken();
    else s.index++;
  }

  private scanSourceToken(): void {
    const s = this.cursor;
    // Only braces can return from an interpolation; ordinary source characters
    // need neither suspended-template nor markup-expression state inspected.
    if (s.c === "{" || s.c === "}") {
      if (this.literals.scanTemplateBrace()) return;
      if (this.markupEnabled) this.markup.scanExpressionBrace();
    }
    if (/[A-Za-z_$]/.test(s.c)) {
      const word = /^[\w$]+/.exec(s.line.slice(s.index))![0];
      s.canRegex = /^(return|throw|case|delete|void|typeof|yield|await|in|of|instanceof|new)$/.test(word);
      s.index += word.length;
      return;
    }
    // Preserve the existing block-vs-object-literal regex heuristic.
    s.canRegex = /[({[}=,:;!?&|+*%~^<>-]/.test(s.c);
    s.index++;
  }
}
