import { ScanCursor } from "./cursor.js";

/** Comments, quoted data, regex literals and their suspended interpolations. */
export class LiteralScanner {
  private block = "";
  private blockDepth = 0;
  private quote = "";
  private literalRaw = false;
  private regex = false;
  private regexClass = false;
  // Nested templates suspend the surrounding interpolation until the backtick closes.
  private readonly templates: number[] = [];

  constructor(private readonly cursor: ScanCursor) {}

  get inQuote(): boolean {
    return this.quote.length > 0;
  }

  beginBlock(delimiter: string): void {
    this.block = delimiter;
    this.blockDepth = 1;
  }

  scanActive(): boolean {
    if (this.block) this.scanBlock();
    else if (this.quote) this.scanQuote();
    else if (this.regex) this.scanRegex();
    else return false;
    return true;
  }

  private scanBlock(): void {
    const s = this.cursor;
    const nested = this.block === "*/" && (s.ext === ".rs" || s.ext === ".swift");
    if (nested && s.line.startsWith("/*", s.index)) {
      this.blockDepth++;
      s.index += 2;
    } else if (s.line.startsWith(this.block, s.index)) {
      s.index += this.block.length;
      if (--this.blockDepth === 0) this.block = "";
    } else s.index++;
  }

  private scanQuote(): void {
    const s = this.cursor;
    s.code = true;
    if (s.javascript && this.quote === "`" && s.c === "$" && s.next === "{") {
      this.templates.push(1);
      this.quote = "";
      s.canRegex = true;
      s.index += 2;
    } else if (s.line.startsWith(this.quote, s.index)) {
      s.index += this.quote.length;
      this.quote = "";
      s.canRegex = false;
    } else if (!this.literalRaw && s.c === "\\") s.index += 2;
    else s.index++;
  }

  private scanRegex(): void {
    const s = this.cursor;
    s.code = true;
    if (s.c === "\\") s.index += 2;
    else {
      if (s.c === "[") this.regexClass = true;
      if (s.c === "]") this.regexClass = false;
      if (s.c === "/" && !this.regexClass) {
        this.regex = false;
        s.canRegex = false;
      }
      s.index++;
    }
  }

  scanComment(tag: boolean, embedded: string): boolean {
    const s = this.cursor;
    if (tag) return false;
    if (this.startsLineComment(embedded)) {
      s.index = s.line.length;
      return true;
    }
    if (!s.python && s.c === "/" && s.next === "*") {
      this.beginBlock("*/");
      s.index += 2;
      return true;
    }
    return false;
  }

  private startsLineComment(embedded: string): boolean {
    const s = this.cursor;
    return (
      (s.python && s.c === "#") ||
      (!s.python && s.c === "/" && s.next === "/" && s.ext !== ".css" && embedded !== "style")
    );
  }

  scanStart(): boolean {
    // Quote characters and raw-string prefixes are disjoint. Dispatch by the
    // actual opener/family instead of calling unrelated scanners per character.
    if (this.startsQuote()) return this.startQuoted();
    if (this.cursor.ext === ".rs") return this.startRustRaw();
    if (this.cursor.ext === ".swift") return this.startSwiftRaw();
    return false;
  }

  private startRustRaw(): boolean {
    const s = this.cursor;
    const match = /[rbc]/.test(s.c) ? /^(?:b|c)?r(#+|)"/.exec(s.line.slice(s.index)) : null;
    if (!match) return false;
    this.quote = `"${match[1]}`;
    this.literalRaw = true;
    s.index += match[0].length;
    return true;
  }

  private startSwiftRaw(): boolean {
    const s = this.cursor;
    if (s.c !== "#") return false;
    const start = s.index;
    while (s.line[s.index] === "#") s.index++;
    if (s.line[s.index] === '"') {
      const delimiter = s.line.startsWith('"""', s.index) ? '"""' : '"';
      this.quote = delimiter + s.line.slice(start, s.index);
      this.literalRaw = true;
      s.index += delimiter.length;
    }
    // Failed prefixes are consumed once; retrying their suffixes is quadratic.
    return true;
  }

  private startQuoted(): boolean {
    const s = this.cursor;
    if (this.consumeRustLifetime()) return true;
    this.quote = (s.python || s.ext === ".swift") && s.line.startsWith(s.c.repeat(3), s.index) ? s.c.repeat(3) : s.c;
    this.literalRaw = s.ext === ".go" && s.c === "`";
    s.index += this.quote.length;
    return true;
  }

  private startsQuote(): boolean {
    const s = this.cursor;
    return s.c === '"' || s.c === "'" || (s.c === "`" && (s.javascript || s.ext === ".go"));
  }

  private consumeRustLifetime(): boolean {
    const s = this.cursor;
    // Rust lifetimes ('a, 'static) are identifiers, not unterminated strings.
    const lifetime = s.ext === ".rs" && s.c === "'" ? /^'[A-Za-z_]\w*/.exec(s.line.slice(s.index)) : null;
    if (!lifetime || s.line[s.index + lifetime[0].length] === "'") return false;
    s.index += lifetime[0].length;
    return true;
  }

  startRegex(tag: boolean, embedded: string): boolean {
    const s = this.cursor;
    if (!s.javascript || embedded === "style" || tag || s.c !== "/" || !s.canRegex) return false;
    this.regex = true;
    this.regexClass = false;
    s.index++;
    return true;
  }

  scanTemplateBrace(): boolean {
    const s = this.cursor;
    if (!this.templates.length) return false;
    const top = this.templates.length - 1;
    if (s.c === "{") this.templates[top]++;
    if (s.c === "}" && --this.templates[top] === 0) {
      this.templates.pop();
      this.quote = "`";
      this.literalRaw = false;
      s.index++;
      return true;
    }
    return false;
  }

  finishLine(): void {
    const s = this.cursor;
    // JavaScript regex literals cannot contain physical line terminators, so an
    // unterminated regex must not hide the following source line. Other literal
    // data may be multiline and is therefore retained conservatively.
    this.regex = false;
    if (s.javascript && (this.quote === "'" || this.quote === '"') && !s.line.endsWith("\\")) this.quote = "";
  }
}
