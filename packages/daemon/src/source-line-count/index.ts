import { ScanCursor } from "./cursor.js";
import { LiteralScanner } from "./literals.js";
import { MarkupScanner } from "./markup.js";

/** A lexical estimate: source/literal data count, comments and blank lines do not.
 * Literal heuristics deliberately retain the hook's existing language behavior. */
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

  constructor(ext: string) {
    this.cursor = new ScanCursor(ext);
    this.literals = new LiteralScanner(this.cursor);
    this.markup = new MarkupScanner(this.cursor, this.literals);
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
    if (this.literals.scanActive()) return;
    if (this.markup.scanText()) return;
    if (this.markup.scanBoundary()) return;
    if (this.literals.scanComment(this.markup.tag, this.markup.embedded)) return;
    if (/\s/.test(s.c)) {
      s.index++;
      return;
    }
    s.code = true;
    if (this.literals.scanStart()) return;
    if (this.literals.startRegex(this.markup.tag, this.markup.embedded)) return;
    if (!this.markup.active) {
      if (this.literals.scanTemplateBrace()) return;
      this.markup.scanExpressionBrace();
      this.scanSourceToken();
    } else s.index++;
  }

  private scanSourceToken(): void {
    const s = this.cursor;
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
