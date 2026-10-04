// Progress-bar drawing shared by the gauge segments (context, block, weekly)
// of SegmentRenderer (#1039). Pure: the only renderer state a bar needs is the
// symbol set, passed in by the caller.

import type { BarDisplayStyle, PowerlineSymbols } from "./renderer-types";

interface BarStyleDef {
  filled: string;
  empty: string;
  cap?: string;
  marker?: string;
}

const BAR_STYLES: Record<string, BarStyleDef> = {
  ball: { filled: "─", empty: "─", marker: "●" },
  blocks: { filled: "█", empty: "░" },
  "blocks-line": { filled: "█", empty: "─" },
  capped: { filled: "━", empty: "┄", cap: "╸" },
  dots: { filled: "●", empty: "○" },
  filled: { filled: "■", empty: "□" },
  geometric: { filled: "▰", empty: "▱" },
  line: { filled: "━", empty: "┄" },
  squares: { filled: "◼", empty: "◻" },
};

export function buildBar(
  s: BarStyleDef,
  filledCount: number,
  emptyCount: number,
  barLength: number,
): string {
  if (s.marker) {
    const pos = Math.min(filledCount, barLength - 1);
    return (
      s.filled.repeat(pos) + s.marker + s.empty.repeat(barLength - pos - 1)
    );
  }
  if (s.cap) {
    if (filledCount === 0) {
      return s.cap + s.empty.repeat(barLength - 1);
    }
    if (filledCount >= barLength) {
      return s.filled.repeat(barLength);
    }
    return (
      s.filled.repeat(filledCount - 1) + s.cap + s.empty.repeat(emptyCount)
    );
  }
  return s.filled.repeat(filledCount) + s.empty.repeat(emptyCount);
}

export function resolveBarStyleDef(
  symbols: PowerlineSymbols,
  style: string,
): BarStyleDef | null {
  return style === "bar"
    ? { filled: symbols.bar_filled, empty: symbols.bar_empty }
    : (BAR_STYLES[style] ?? null);
}

export function formatPercentageWithBar(
  symbols: PowerlineSymbols,
  pct: number,
  displayStyle?: BarDisplayStyle,
  timeStr?: string | null,
): string {
  const style = displayStyle ?? "text";
  const barStyleDef = resolveBarStyleDef(symbols, style);
  const barLength = 10;

  if (barStyleDef) {
    const filledCount = Math.round((pct / 100) * barLength);
    const emptyCount = barLength - filledCount;
    const bar = buildBar(
      barStyleDef,
      filledCount,
      emptyCount,
      barLength,
    );
    return timeStr ? `${bar} ${pct}% (${timeStr})` : `${bar} ${pct}%`;
  }
  return timeStr ? `${pct}% (${timeStr})` : `${pct}%`;
}
