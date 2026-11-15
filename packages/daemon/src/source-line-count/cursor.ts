/** Physical line position and language facts shared by the lexical scanners. */
export class ScanCursor {
  readonly python: boolean;
  readonly javascript: boolean;
  readonly component: boolean;
  readonly jsx: boolean;
  line = "";
  index = 0;
  c = "";
  next: string | undefined;
  code = false;
  canRegex = true;

  constructor(readonly ext: string) {
    this.python = ext === ".py";
    this.javascript = /\.(?:[cm]?js|jsx|tsx?|vue|svelte)$/.test(ext);
    this.component = ext === ".vue" || ext === ".svelte";
    this.jsx = ext === ".jsx" || ext === ".tsx";
  }

  readCharacter(): void {
    this.c = this.line[this.index];
    this.next = this.line[this.index + 1];
  }
}
