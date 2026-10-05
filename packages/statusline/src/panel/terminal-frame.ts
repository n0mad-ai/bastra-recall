/** Incremental, synchronized painting. Never erase a freshly painted corner. */
export class TerminalFrame {
  private previous: string[] = [];
  private columns = 0;
  private rows = 0;
  paint(lines: string[], columns: number, rows: number): string {
    const resized = columns !== this.columns || rows !== this.rows;
    let output = '';
    const visible = lines.slice(0, rows);
    for (let i = 0; i < Math.max(visible.length, this.previous.length); i++) {
      if (i >= rows) break;
      if (!resized && visible[i] === this.previous[i]) continue;
      output += `\x1b[${i + 1};1H` + (visible[i] ?? ' '.repeat(columns));
    }
    this.previous = visible; this.columns = columns; this.rows = rows;
    return output ? '\x1b[?2026h' + output + '\x1b[?2026l' : '';
  }
}
