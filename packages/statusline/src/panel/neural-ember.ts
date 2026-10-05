import { codePointWidth, visibleLength } from '../utils/terminal';
import { resetCountdown } from './reset-time';
import { contextRemaining } from './context-remaining';
import { gitLabel, timingLabel } from './details';
import { CONTEXT_STOPS, contextLevel, contextWarning } from './context-level';
import type { NeuralData } from './types';
import type { PanelView } from './view';
export { toggleHit } from './view';

type RGB = readonly [number, number, number];
interface Skin { INK: RGB; BONE: RGB; ASH: RGB; DUSK: RGB; BAND: RGB; HOT: RGB; VIOLET: RGB; MAGENTA: RGB; EMBER: RGB; GOLD: RGB;
  GREEN: RGB; YELLOW: RGB; ORANGE: RGB; RED: RGB;
  /** Per heat family, the light and the deep tone the big numerals shade between. */
  SHADES: readonly (readonly [RGB, RGB])[] }
const DARK: Skin = { INK: [13, 10, 20], BONE: [243, 236, 223], ASH: [143, 134, 163], DUSK: [62, 52, 80], BAND: [36, 23, 50], HOT: [255, 92, 112],
  VIOLET: [109, 75, 255], MAGENTA: [224, 72, 155], EMBER: [255, 122, 69], GOLD: [255, 210, 122],
  GREEN: [86, 212, 140], YELLOW: [245, 214, 80], ORANGE: [255, 150, 60], RED: [255, 82, 96],
  SHADES: [[[176, 242, 150], [28, 168, 132]], [[255, 240, 140], [232, 164, 38]], [[255, 204, 112], [240, 94, 40]], [[255, 156, 124], [214, 38, 92]]] };
/** Warm paper with the same hues, darkened until they carry on a light ground. */
const LIGHT: Skin = { INK: [247, 242, 233], BONE: [38, 29, 48], ASH: [112, 101, 126], DUSK: [186, 176, 192], BAND: [236, 226, 238], HOT: [208, 36, 66],
  VIOLET: [96, 66, 232], MAGENTA: [204, 48, 136], EMBER: [228, 92, 36], GOLD: [196, 134, 14],
  GREEN: [22, 150, 84], YELLOW: [186, 142, 0], ORANGE: [214, 104, 10], RED: [200, 32, 56],
  SHADES: [[[70, 176, 96], [8, 108, 92]], [[208, 164, 16], [158, 104, 0]], [[232, 128, 34], [188, 68, 10]], [[222, 76, 74], [162, 18, 62]]] };
// The active skin, set at the start of every render. INK is the canvas.
let { INK, BONE, ASH, DUSK, BAND, HOT, VIOLET, MAGENTA, EMBER, GOLD, GREEN, YELLOW, ORANGE, RED, SHADES } = DARK;
/** The light skin's canvas, for the CLI to tint the pane around the panel. */
export { LIGHT_CANVAS } from './view';
/** What the CLI controls: the terminal's own background as the dark canvas, the compact view, the light skin. */
export type EmberView = PanelView;
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map(i => Math.round(a[i]! + (b[i]! - a[i]!) * Math.min(1, Math.max(0, t)))) as unknown as RGB;
/** Cold storage (violet) warms up on its way into the context (gold). */
function spectrum(t: number): RGB {
  const stops = [VIOLET, MAGENTA, EMBER, GOLD], p = Math.min(1, Math.max(0, t)) * 3, i = Math.min(2, Math.floor(p));
  return mix(stops[i]!, stops[i + 1]!, p - i);
}
/** 0..1 fades in from the background, 1..2 overdrives towards white. */
const glow = (c: RGB, level: number): RGB => level <= 1 ? mix(INK, c, level) : mix(c, BONE, level - 1);
const clean = (v: string) => v.replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, '');
const number = (n: number | null | undefined) => typeof n === 'number' ? new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(n)) : '—';

interface Cell { ch: string; fg: RGB; bg: RGB; bold: boolean }
/** Fixed-size cell canvas: every row is exactly `w` columns, whatever is drawn. */
class Grid {
  private cells: Cell[][];
  private seams = new Set<number>();
  constructor(readonly w: number, readonly h: number) {
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: ' ', fg: ASH, bg: INK, bold: false })));
  }
  /** Tints a whole row; later drawing keeps the tint. */
  band(y: number, bg: RGB): void { for (const cell of this.cells[y] ?? []) cell.bg = bg; }
  /** Sub-row padding: the row above continues into the upper part, the row below starts `eighths`/8 from the bottom. */
  seam(y: number, upper: RGB, lower: RGB, eighths = 4): void {
    this.seams.add(y);
    for (const cell of this.cells[y] ?? []) { cell.ch = '▁▂▃▄▅▆▇'[eighths - 1]!; cell.fg = lower; cell.bg = upper; }
  }
  /** A hairline inside one tint. A cell holds two colours, so a line can only separate rows that share their background. */
  rule(y: number, bg: RGB): void {
    this.seams.add(y); this.band(y, bg);
    for (let x = 0; x < this.w; x++) this.put(x, y, '─', mix(bg, ASH, 0.3));
  }
  put(x: number, y: number, ch: string, fg: RGB, bold = false): void {
    const row = this.cells[y];
    if (row && x >= 0 && x < this.w) row[x] = { ch, fg, bg: row[x]!.bg, bold };
  }
  /** Returns the column after the text. Wide glyphs occupy two cells; `limit` truncates with an ellipsis. */
  text(x: number, y: number, value: string, fg: RGB, bold = false, limit = this.w): number {
    limit = Math.min(limit, this.w);
    const chars = [...clean(value)].filter(ch => codePointWidth(ch.codePointAt(0)!) > 0);
    const fits = x + chars.reduce((sum, ch) => sum + codePointWidth(ch.codePointAt(0)!), 0) <= limit;
    for (const ch of chars) {
      const width = codePointWidth(ch.codePointAt(0)!);
      if (x + width > limit - (fits ? 0 : 1)) { if (!fits && x < limit) this.put(x++, y, '…', fg, bold); return x; }
      this.put(x, y, ch, fg, bold);
      if (width === 2) this.put(x + 1, y, '', fg, bold);
      x += width;
    }
    return x;
  }
  textRight(end: number, y: number, value: string, fg: RGB, bold = false): number {
    const start = Math.max(0, end - visibleLength(clean(value)));
    this.text(start, y, value, fg, bold);
    return start;
  }
  lines(color: boolean): string[] {
    return this.cells.map((row, y) => {
      if (!color) return this.seams.has(y) ? ' '.repeat(this.w) : row.map(c => c.ch).join('');
      let out = '', fg = '', bg = '', bold: boolean | null = null;
      for (const c of row) {
        if (c.bold !== bold) { bold = c.bold; out += `\x1b[${bold ? 1 : 22}m`; }
        if (c.bg.join(';') !== bg) { bg = c.bg.join(';'); out += `\x1b[48;2;${bg}m`; }
        if (c.ch !== ' ' && c.fg.join(';') !== fg) { fg = c.fg.join(';'); out += `\x1b[38;2;${fg}m`; }
        out += c.ch;
      }
      return out + '\x1b[0m';
    });
  }
}

/** Braille sub-pixels: 2×4 dots per cell, one brightness per cell. */
class Dots {
  private bits: Uint8Array; private level: Float32Array;
  constructor(readonly w: number, readonly h: number) { this.bits = new Uint8Array(w * h); this.level = new Float32Array(w * h); }
  set(dx: number, dy: number, level: number): void {
    dx = Math.round(dx); dy = Math.round(dy);
    if (dx < 0 || dy < 0 || dx >= this.w * 2 || dy >= this.h * 4) return;
    const i = (dy >> 2) * this.w + (dx >> 1);
    this.bits[i]! |= [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]][dy & 3]![dx & 1]!;
    this.level[i] = Math.max(this.level[i]!, level);
  }
  blit(grid: Grid, left: number, top: number): void {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const i = y * this.w + x;
      if (this.bits[i]) grid.put(left + x, top + y, String.fromCodePoint(0x2800 + this.bits[i]!), glow(spectrum(x / Math.max(1, this.w - 1)), this.level[i]!));
    }
  }
}

/** Deterministic, so an idle panel renders the identical picture every frame. */
function random(seed: number): () => number {
  return () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

const FONT: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'], '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '001', '001', '001'], '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'], '—': ['000', '000', '111', '000', '000'],
};
/** Blends four family colours along the fill level: green, yellow from 40 %, orange from 60 %, red from 70 % (see context-level.ts). */
function scale(percent: number, [green, yellow, orange, red]: readonly RGB[]): RGB {
  const { caution, warning, critical } = CONTEXT_STOPS;
  return percent >= critical ? red! : percent >= warning ? mix(orange!, red!, (percent - warning) / (critical - warning))
    : percent >= caution ? mix(yellow!, orange!, (percent - caution) / (warning - caution)) : mix(green!, yellow!, (percent - caution + 10) / 10);
}
/** How full the context is, as one colour. */
const heat = (percent: number): RGB => scale(percent, [GREEN, YELLOW, ORANGE, RED]);
/** The context bar is its own scale: every cell carries the colour of its share, the part not yet used faintly. */
function heatBar(grid: Grid, x: number, y: number, width: number, value: number | null): void {
  const filled = value === null ? 0 : Math.round(Math.min(100, Math.max(0, value)) / 100 * width);
  for (let i = 0; i < width; i++) {
    const tone = heat((i + 0.5) / width * 100);
    grid.put(x + i, y, i < filled ? '━' : '─', value === null ? DUSK : i < filled ? tone : mix(INK, tone, 0.3));
  }
}
/** Solid block numerals, five rows tall, shaded from the light to the deep tone of the context's heat family. Returns the column after them. */
function numerals(grid: Grid, x: number, y: number, value: number | null): number {
  const chars = value === null ? ['—'] : String(Math.round(Math.min(100, Math.max(0, value)))).split('');
  for (const ch of chars) {
    FONT[ch]!.forEach((line, py) => [...line].forEach((bit, px) => {
      if (bit === '1') for (let i = 0; i < 2; i++) grid.put(x + px * 2 + i, y + py, '█', value === null ? mix(DUSK, ASH, 0.4) :
        mix(scale(value, SHADES.map(pair => pair[0])), scale(value, SHADES.map(pair => pair[1])), py / 4));
    }));
    x += 8;
  }
  return x;
}
function bar(grid: Grid, x: number, y: number, width: number, value: number | null | undefined, from: RGB, to: RGB): void {
  const filled = typeof value === 'number' ? Math.round(Math.min(100, Math.max(0, value)) / 100 * width) : 0;
  for (let i = 0; i < width; i++) grid.put(x + i, y, i < filled ? '━' : '─', i < filled ? mix(from, to, i / Math.max(1, width - 1)) : DUSK);
}

/**
 * Recall as a sieve, in one visual language: every dot is a memory. The cloud is
 * the vault; under "gefunden" and "geladen" sits exactly one large dot per memory.
 * During Recall activity the cloud shimmers and sparks fly from stage to stage.
 */
function funnel(grid: Grid, left: number, top: number, w: number, data: NeuralData, frame: number): void {
  const h = 5, dots = new Dots(w, h), dw = w * 2, dh = h * 4;
  const cloud = Math.floor(w * 0.3), found = Math.floor(w * 0.42), loaded = Math.floor(w * 0.74);
  const moving = data.mode === 'demo' || Boolean(data.active || data.recent), searching = data.mode === 'demo' || Boolean(data.active);
  // A search is a round shockwave through the vault, never a scan bar.
  const cx = cloud, cyc = (dh - 1) / 2, ring = searching ? frame * 1.6 % (cloud + 10) : -100;

  if (data.vault !== null) {
    const rnd = random(1368), shimmer = random(frame + 1), count = Math.min(Math.floor(cloud * dh * 0.8), Math.round(Math.sqrt(data.vault) * 5));
    for (let i = 0; i < count; i++) {
      const x = rnd() * rnd() ** 0.35 * cloud * 2, y = rnd() * dh, level = 0.5 + rnd() * 0.4;
      dots.set(x, y, Math.abs(Math.hypot(x - cx, y - cyc) - ring) < 2.2 ? 1.9 : moving && shimmer() < 0.12 ? 1.5 : level);
    }
    for (let a = 0; ring > 0 && a < 48; a++) {
      const x = cx + Math.cos(a / 48 * Math.PI * 2) * ring, y = cyc + Math.sin(a / 48 * Math.PI * 2) * ring;
      if (x < cloud * 2) dots.set(x, y, 1.1);
    }
  }
  // Slots fill column by column, middle row first, so a single memory sits centred.
  const slot = (x: number, i: number) => ({ x: x + Math.floor(i / h) * 2, y: [2, 1, 3, 0, 4][i % h]! });
  const cluster = (x: number, room: number, value: number | null, tone: RGB, from: (i: number) => { x: number; y: number }) => {
    const shown = Math.min(value ?? 0, Math.max(1, Math.floor(room / 2)) * h);
    if (value === 0) for (let i = 0; i < h; i++) grid.put(left + x, top + 2 + i, '·', DUSK); // known, but nothing landed here
    for (let i = 0; i < shown; i++) {
      const target = slot(x, i);
      if (moving) {
        const start = from(i), t = (frame * 0.08 + i * 0.37) % 1.5;
        for (let k = 0; k < 4 && t <= 1; k++) {
          const u = Math.max(0, t - k * 0.035), e = u * u * (3 - 2 * u);
          dots.set(start.x + (target.x * 2 - start.x) * e, start.y + (target.y * 4 + 1.5 - start.y) * e - Math.sin(u * Math.PI) * 3, 1.9 - k * 0.35);
        }
      }
    }
    return shown;
  };
  const origin = random(6723);
  const hits = cluster(found, loaded - found - 2, data.hits, EMBER, () => ({ x: origin() * cloud * 1.6, y: origin() * dh }));
  const loads = cluster(loaded, w - loaded, data.loads, GOLD, i => { const s = slot(found, hits ? i % hits : 0); return { x: hits ? s.x * 2 : cloud, y: s.y * 4 + 1.5 }; });
  dots.blit(grid, left, top + 2);
  for (let i = 0; i < hits; i++) { const s = slot(found, i); grid.put(left + s.x, top + 2 + s.y, '●', EMBER); }
  for (let i = 0; i < loads; i++) { const s = slot(loaded, i); grid.put(left + s.x, top + 2 + s.y, '●', GOLD, true); }

  const stage = (x: number, value: number | null, word: string, tone: RGB, limit: number) => {
    grid.text(left + x, top, number(value), value ? tone : ASH, true, left + limit);
    grid.text(left + x, top + 1, word, ASH, false, left + limit);
  };
  stage(0, data.vault, 'Erinnerungen', mix(VIOLET, BONE, 0.45), found - 1);
  stage(found, data.hits, 'gefunden', EMBER, loaded - 1);
  stage(loaded, data.loads, 'geladen', GOLD, w);
  grid.text(left, top + 7, 'im Vault', DUSK, false, left + found - 1);
  grid.text(left + found, top + 7, 'seit deiner letzten Nachricht', DUSK, false, left + w);
}

const mode = (data: NeuralData): string => data.mode === 'demo' ? 'Demo mit Beispieldaten'
  : data.mode === 'live' ? (data.fresh ? `● ${data.client ?? 'claude'} live` : '○ wartet auf Daten') : 'Snapshot';
const reset = (at: number | null | undefined, now: number | undefined) => {
  const text = resetCountdown(at, now).replace('RESET IN ', 'Reset ');
  return text.slice(0, 1) + text.slice(1).toLowerCase();
};
const duration = (ms: number) => { const mins = Math.floor(ms / 60000); return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`; };
const tokens = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2).replace('.', ',') + ' Mio.' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n));
const DEMO_EXTRAS: Partial<NeuralData> = { usage5h: 38, loadedTitles: ['Beispiel: Deploy-Kette lokal', 'Beispiel: klare Borders statt Box-in-Box', 'Beispiel: Statusline-Mechanik'] };

/**
 * Borderless truecolor panel: tinted bands for structure, dots for what Recall did.
 * Without `compact` it draws the full view and no switches; true/false draws the switches and that view.
 */
export function renderNeural(data: NeuralData, width = 120, frame = 0, color = true, { paper, compact, light }: EmberView = {}): string[] {
  width = Math.max(1, Math.floor(width));
  ({ INK, BONE, ASH, DUSK, BAND, HOT, VIOLET, MAGENTA, EMBER, GOLD, GREEN, YELLOW, ORANGE, RED, SHADES } = light ? LIGHT : DARK);
  // Dark canvas is the terminal's own background, so pane padding and leftover pixels are part of the panel.
  if (!light && paper?.length === 3) INK = paper as unknown as RGB;
  if (data.mode === 'demo') data = { ...DEMO_EXTRAS, ...data };
  const [free = '—', total = '—'] = contextRemaining(data.contextFree, data.contextTotal).split(' FREI / ');
  if (width < 90) {
    const g = new Grid(width, 7);
    g.text(0, 0, '▂▄▆ bastra recall', GOLD, true);
    g.text(0, 1, mode(data), MAGENTA);
    g.text(0, 2, `${data.model} / ${data.project}`, BONE);
    g.text(0, 3, `Kontext ${number(data.context)} %, ${free} frei`, GOLD);
    g.text(0, 4, `5 Std ${number(data.usage5h)} %, 7 Tage ${number(data.usage)} %, ${reset(data.usageResetsAt, data.now)}`, EMBER);
    g.text(0, 5, `${number(data.vault)} Erinnerungen, ${number(data.hits)} gefunden, ${number(data.loads)} geladen`, BONE);
    g.text(0, 6, `${number(data.searches)} Suchen, ${number(data.saves)} gespeichert`, ASH);
    return g.lines(color);
  }
  const g = new Grid(width, compact ? 6 : 19), m = 3, end = width - m, panel = 44, px = end - panel;
  const live = data.mode === 'live' && data.fresh;

  // Header; the compact view has no blank row above it
  const top = compact ? 0 : 1;
  ['▂', '▄', '▆'].forEach((ch, i) => g.put(m + i, top, ch, [MAGENTA, EMBER, GOLD][i]!));
  let x = g.text(m + 4, top, 'bastra recall', BONE, true);
  x = g.text(x + 3, top, data.model + (data.effort ? ' ' + data.effort : ''), GOLD);
  g.text(x + 3, top, data.project, ASH);
  if (compact !== undefined) {
    g.put(end - 1, top, compact ? '▴' : '▾', ASH); // view: compact or full
    g.put(end - 5, top, light ? '◑' : '◐', ASH); // skin: light or dark
  }
  g.textRight(compact === undefined ? end : end - 7, top, '   ' + mode(data), live ? GOLD : data.mode === 'demo' ? MAGENTA : ASH, live);
  for (let i = m; i < end; i++) g.put(i, top + 1, '─', glow(spectrum((i - m) / (end - m - 1)), 0.55));

  const row = compact ? 4 : 14; // the Recall row
  if (compact) {
    // One line: the three gauges, then the Recall chain as far as it fits
    let gx = m;
    gx = g.text(gx, 2, 'Kontext ', ASH);
    gx = g.text(gx, 2, `${number(data.context)} %`, data.context === null ? BONE : heat(data.context), true) + 2;
    heatBar(g, gx, 2, 10, data.context); gx += 14;
    const gauge = (name: string, value: number | null | undefined, from: RGB, to: RGB) => {
      gx = g.text(gx, 2, name + ' ', ASH);
      gx = g.text(gx, 2, `${number(value)} %`, typeof value === 'number' && value >= 90 ? HOT : BONE, true) + 2;
      bar(g, gx, 2, 10, value, from, to); gx += 14;
    };
    gauge('5 Std', data.usage5h, MAGENTA, EMBER); gauge('7 Tage', data.usage, VIOLET, MAGENTA);
    const chain: [string, string, RGB][] = [['Erinnerungen', number(data.vault), mix(VIOLET, BONE, 0.45)], ['gefunden', number(data.hits), EMBER], ['geladen', number(data.loads), GOLD]];
    let cx = end;
    for (const [word, value, tone] of chain.reverse()) {
      if (cx - word.length - value.length - 6 < gx) break;
      if (cx < end) cx = g.textRight(cx, 2, '  ›  ', DUSK);
      cx = g.textRight(cx, 2, ' ' + word, ASH); cx = g.textRight(cx, 2, value, tone, true);
    }
  } else {
    // What Recall did: funnel, then the titles it put into the context
    const area = px - 3 - m, titles = data.loadedTitles, list = titles && area >= 64 ? Math.min(46, Math.floor(area * 0.42)) : 0;
    funnel(g, m, 4, Math.min(72, area - (list ? list + 3 : 0)), data, frame);
    if (list && titles) {
      const lx = px - 3 - list;
      g.text(lx, 4, 'Zuletzt geladen', ASH);
      if (!titles.length) g.text(lx, 6, 'Noch nichts seit deiner letzten Nachricht', DUSK, false, lx + list);
      titles.slice(-6).reverse().forEach((title, i) => {
        g.put(lx, 6 + i, '◆', mix(GOLD, MAGENTA, i / 5));
        g.text(lx + 2, 6 + i, title, i ? ASH : BONE, false, lx + list);
      });
    }

    // Context and limits
    const tx = numerals(g, px, 4, data.context);
    g.text(tx, 4, '% Kontext belegt', BONE, true);
    g.text(tx, 5, `${free} frei`, ASH);
    g.text(tx, 6, `von ${total}`, ASH);
    const warning = contextWarning(data.context);
    if (warning) g.text(tx, 7, warning, heat(data.context!), contextLevel(data.context) === 3, end);
    heatBar(g, tx, 8, end - tx, data.context);
    const limit = (y: number, name: string, value: number | null | undefined, at: number | null | undefined, from: RGB, to: RGB) => {
      g.text(px, y, name, ASH);
      g.textRight(px + 12, y, `${number(value)} %`, typeof value === 'number' && value >= 90 ? HOT : BONE, true);
      const start = g.textRight(end, y, reset(at, data.now), ASH);
      bar(g, px + 14, y, start - 2 - (px + 14), value, from, to);
    };
    limit(10, '5 Std', data.usage5h, data.usage5hResetsAt, MAGENTA, EMBER);
    limit(11, '7 Tage', data.usage, data.usageResetsAt, VIOLET, MAGENTA);
  }

  // Recall band: what is happening now, and this turn's side counts
  g.seam(row - 1, INK, BAND); g.band(row, BAND);
  if (compact) g.seam(row + 1, BAND, INK); else g.rule(row + 1, BAND);
  const busy = data.mode === 'demo' || (data.mode === 'live' && Boolean(data.agentActive || data.active || data.recent));
  const head = busy ? frame % 15 : -9;
  for (let i = 0; i < 12; i++) {
    const tail = head - i, lit = tail >= 0 && tail < 3;
    g.put(m + i, row, lit ? (tail === 0 ? '╸' : '━') : '·', lit ? mix(GOLD, MAGENTA, tail / 2) : DUSK);
  }
  const pairs = (y: number, right: number, items: [string, string, RGB?][], dim: RGB, bright: RGB): number => {
    for (const [name, value, tone] of items.reverse()) {
      right = g.textRight(right, y, value, tone ?? bright, tone !== undefined);
      right = g.textRight(right, y, name + ' ', dim) - 3;
    }
    return right;
  };
  const counts: [string, string, RGB?][] = [['Suchen', number(data.searches), BONE], ['gespeichert', number(data.saves), BONE]];
  if (data.errors) counts.push(['Fehler', number(data.errors), HOT]);
  const stageEnd = pairs(row, end, [...counts, ['', timingLabel(data)]], ASH, ASH);
  x = g.text(m + 14, row, data.stage, data.errors ? HOT : GOLD, false, stageEnd);
  if (data.mode === 'demo') g.text(x + 3, row, 'keine Live-Messung', ASH, false, stageEnd);

  if (compact) return g.lines(color);

  // Repository row in the same band below a hairline, then the session's cost on the plain canvas
  g.band(16, BAND); g.seam(17, BAND, INK, 3);
  const dim = mix(INK, ASH, 0.6), session: [string, string][] = [];
  if (typeof data.durationMs === 'number') session.push(['Session', duration(data.durationMs)]);
  session.push(['davon API', typeof data.apiDurationMs === 'number' ? duration(data.apiDurationMs) : '—']);
  if (typeof data.linesAdded === 'number' && typeof data.linesRemoved === 'number') session.push(['Zeilen', `+${data.linesAdded} −${data.linesRemoved}`]);
  const cost: [string, string][] = [];
  if (typeof data.costUsd === 'number') cost.push(['Kosten', data.costUsd > 0 && data.costUsd < 0.01 ? '<$0.01' : `≈$${data.costUsd.toFixed(2)}`]);
  else if (data.client === 'codex' && data.mode === 'live') cost.push(['Kosten', '—']);
  if (typeof data.cacheHitRatio === 'number') cost.push(['Cache', `${Math.round(data.cacheHitRatio * 100)} %`]);
  if (typeof data.cachedInputRatio === 'number') cost.push(['Cache-Eingabe', `${Math.round(data.cachedInputRatio * 100)} %`]);
  if (typeof data.tokens === 'number') cost.push(['Gesamt', tokens(data.tokens) + ' Tokens']);
  g.text(m, 16, gitLabel(data), data.git?.conflicts ? HOT : ASH, false, pairs(16, end, session, dim, ASH));
  pairs(18, end, cost, dim, ASH);
  return g.lines(color);
}
