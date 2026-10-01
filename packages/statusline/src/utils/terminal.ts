export const ESC = String.fromCharCode(27);
const ANSI_REGEX = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
export const ANSI_SPLIT = new RegExp(`(${ESC}\\[[0-9;]*m)`);
const COMBINING_MARK = /[\p{Mn}\p{Me}]/u;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

/**
 * Terminal-Spaltenbreite eines Code-Points (praktisches wcwidth-Subset):
 * 0 für Combining Marks / Zero-Width-Joiner / Variation Selectors,
 * 2 für CJK/Hangul/Fullwidth/Emoji, sonst 1. Nerd-Font-/Powerline-Glyphen
 * (Private Use Area, z.B. U+E0B0) zählen als 1.
 */
export function codePointWidth(cp: number): number {
  if (
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff ||
    // Unicode mark categories avoid a fixed list of scripts. Mc spacing
    // marks still occupy a column; Mn/Me marks do not.
    (cp >= 0x0300 && cp <= 0x10ffff && COMBINING_MARK.test(String.fromCodePoint(cp)))
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extensions B+
  ) {
    return 2;
  }
  return 1;
}

/**
 * Sichtbare Terminal-Breite (Spalten), nicht UTF-16-Länge: `.length` zählt
 * CJK als 1 (real 2) und Combining Marks als 1 (real 0) — damit war jede
 * Spalten-/Padding-Rechnung für solche Inhalte um 1–2 Spalten daneben.
 */
export function visibleLength(str: string): number {
  let width = 0;
  for (const ch of stripAnsi(str)) {
    width += codePointWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}
