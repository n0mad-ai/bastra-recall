import { ScanCursor } from "./cursor.js";
import { LiteralScanner } from "./literals.js";

/** JSX and component markup, including returns from nested source expressions. */
export class MarkupScanner {
  active: boolean;
  tag = false;
  embedded = "";
  private tagName = "";
  private closingTag = false;
  private depth = 0;
  private readonly expressions: { depth: number; tag: boolean; doubleBrace?: boolean }[] = [];
  private readonly jsxReturns: number[] = [];

  constructor(
    private readonly cursor: ScanCursor,
    private readonly literals: LiteralScanner
  ) {
    this.active = cursor.component;
  }

  scanText(): boolean {
    const s = this.cursor;
    if (!this.active || this.tag) return false;
    if (s.line.startsWith("<!--", s.index)) {
      this.literals.beginBlock("-->");
      s.index += 4;
      return true;
    }
    if (s.jsx && s.line.startsWith("{/*", s.index)) {
      this.literals.beginBlock("*/}");
      s.index += 3;
      return true;
    }
    if (s.c === "{" && (s.ext !== ".vue" || s.next === "{")) {
      this.enterTextExpression();
      return true;
    }
    if (s.c === "<") return false;
    if (/\S/.test(s.c)) s.code = true;
    s.index++;
    return true;
  }

  private enterTextExpression(): void {
    const s = this.cursor;
    s.code = true;
    const doubleBrace = s.ext === ".vue";
    this.expressions.push({ depth: 1, tag: false, doubleBrace });
    this.active = false;
    // Svelte's closing directive is markup control rather than a regex.
    const closingDirective = s.ext === ".svelte" && s.next === "/";
    s.canRegex = !closingDirective;
    s.index += doubleBrace || closingDirective ? 2 : 1;
  }

  scanBoundary(): boolean {
    const s = this.cursor;
    if (this.embedded && s.line.startsWith(`</${this.embedded}`, s.index)) {
      this.embedded = "";
      this.active = true;
    }
    if (this.startsTag()) {
      this.openTag();
      return true;
    }
    if (this.tag && s.c === ">") {
      this.closeTag();
      return true;
    }
    if (this.tag && s.c === "{" && s.ext !== ".vue") {
      this.expressions.push({ depth: 1, tag: true });
      this.tag = this.active = false;
      s.canRegex = s.code = true;
      s.index++;
      return true;
    }
    return false;
  }

  private startsTag(): boolean {
    const s = this.cursor;
    return (
      (!this.active && s.jsx && s.canRegex && s.c === "<" && /[A-Za-z/>]/.test(s.next ?? "")) ||
      (this.active && !this.tag && s.c === "<")
    );
  }

  private openTag(): void {
    const s = this.cursor;
    if (!this.active) this.jsxReturns.push(this.depth);
    const match = /^<(\/?)([\w:.-]*)/.exec(s.line.slice(s.index));
    this.closingTag = match?.[1] === "/";
    this.tagName = (match?.[2] ?? "").toLowerCase();
    this.active = this.tag = s.code = true;
    s.index += match?.[0].length ?? 1;
  }

  private closeTag(): void {
    const s = this.cursor;
    if (this.closingTag) this.depth--;
    else if (s.line[s.index - 1] !== "/") this.depth++;
    this.tag = false;
    if (s.component && !this.closingTag && /^(script|style)$/.test(this.tagName)) {
      this.embedded = this.tagName;
      this.active = false;
    } else if (this.jsxReturns.length > 0 && this.depth === this.jsxReturns[this.jsxReturns.length - 1]) {
      this.jsxReturns.pop();
      this.active = false;
      s.canRegex = false;
    }
    s.code = true;
    s.index++;
  }

  scanExpressionBrace(): void {
    const s = this.cursor;
    const expression = this.expressions[this.expressions.length - 1];
    if (expression && s.c === "{") expression.depth++;
    if (expression && s.c === "}" && --expression.depth === 0) {
      this.expressions.pop();
      this.active = true;
      this.tag = expression.tag;
      if (expression.doubleBrace && s.next === "}") s.index++;
    }
  }
}
