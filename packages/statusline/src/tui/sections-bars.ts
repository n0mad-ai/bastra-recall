import type { PowerlineConfig } from "../config/loader";
import type { PowerlineColors } from "../themes";
import type { TuiData, SymbolSet, BoxChars, TuiTitleConfig } from "./types";
import { visibleLength } from "../utils/terminal";
import { formatTokenCount, formatModelName } from "../utils/formatters";
import { colorize, truncateAnsi } from "./primitives";
import { resolveThresholdStyle } from "./sections-shared";

export function resolveTitleToken(
  template: string,
  data: TuiData,
  resolvedData?: Record<string, string>,
): string {
  const rawName = data.hookData.model?.display_name || "Claude";
  const modelName = formatModelName(rawName).toLowerCase();

  return template.replace(/\{([^}]+)\}/g, (_match, token: string) => {
    if (resolvedData) {
      const value = resolvedData[token];
      if (value !== undefined) return value;
    }
    if (token === "model") return modelName;
    return "";
  });
}

export function buildTitleBar(
  data: TuiData,
  box: BoxChars,
  innerWidth: number,
  titleConfig?: TuiTitleConfig,
  resolvedData?: Record<string, string>,
): string {
  const leftTemplate = titleConfig?.left ?? "{model}";
  const rightTemplate = titleConfig?.right;
  const leftResolved = resolveTitleToken(leftTemplate, data, resolvedData);
  const leftText = leftResolved ? ` ${leftResolved} ` : "";
  const leftLen = visibleLength(leftText);

  if (!rightTemplate) {
    const simpleFill = innerWidth - leftLen;
    return (
      box.topLeft +
      leftText +
      box.horizontal.repeat(Math.max(0, simpleFill)) +
      box.topRight
    );
  }

  const rightResolved = resolveTitleToken(rightTemplate, data, resolvedData);
  const rightText = rightResolved ? ` ${rightResolved} ` : "";
  const rightLen = visibleLength(rightText);

  // Truncate if combined text exceeds innerWidth
  let finalLeft = leftText;
  let finalLeftLen = leftLen;
  let finalRight = rightText;
  let finalRightLen = rightLen;

  if (finalLeftLen + finalRightLen > innerWidth) {
    const maxLeft = Math.max(0, innerWidth - finalRightLen);
    if (finalLeftLen > maxLeft) {
      finalLeft = truncateAnsi(finalLeft, maxLeft);
      finalLeftLen = visibleLength(finalLeft);
    }
    if (finalLeftLen + finalRightLen > innerWidth) {
      const maxRight = Math.max(0, innerWidth - finalLeftLen);
      finalRight = truncateAnsi(finalRight, maxRight);
      finalRightLen = visibleLength(finalRight);
    }
  }

  const fillCount = innerWidth - finalLeftLen - finalRightLen;

  if (fillCount < 2) {
    const simpleFill = innerWidth - finalLeftLen;
    return (
      box.topLeft +
      finalLeft +
      box.horizontal.repeat(Math.max(0, simpleFill)) +
      box.topRight
    );
  }

  return (
    box.topLeft +
    finalLeft +
    box.horizontal.repeat(fillCount) +
    finalRight +
    box.topRight
  );
}

function buildBarString(
  pct: number,
  barWidth: number,
  sym: SymbolSet,
  reset: string,
  fgColor: string,
  bold = false,
): string {
  barWidth = Math.max(5, barWidth);
  const filledCount = Math.max(
    0,
    Math.min(barWidth, Math.round((pct / 100) * barWidth)),
  );
  const emptyCount = barWidth - filledCount;
  const bar =
    sym.bar_filled.repeat(filledCount) + sym.bar_empty.repeat(emptyCount);
  return colorize(bar, fgColor, reset, bold);
}

export function buildContextBar(
  data: TuiData,
  barWidth: number,
  sym: SymbolSet,
  reset: string,
  colors: PowerlineColors,
  partFg?: Record<string, string>,
): string {
  if (!data.contextInfo) return "";
  const usedPct = data.contextInfo.usablePercentage;
  const defaultFg =
    partFg?.["context.bar"] ?? partFg?.["context"] ?? colors.contextFg;
  const { fg, bold } = resolveThresholdStyle(
    usedPct,
    defaultFg,
    colors.contextBold,
    colors,
  );
  return buildBarString(usedPct, barWidth, sym, reset, fg, bold);
}

export function buildBlockBar(
  data: TuiData,
  barWidth: number,
  sym: SymbolSet,
  reset: string,
  colors: PowerlineColors,
  config: PowerlineConfig,
  partFg?: Record<string, string>,
): string {
  if (!data.blockInfo) return "";

  const pct = data.blockInfo.nativeUtilization;
  const warningThreshold = config.budget?.block?.warningThreshold ?? 80;
  const defaultFg =
    partFg?.["block.bar"] ?? partFg?.["block"] ?? colors.blockFg;
  const { fg, bold } = resolveThresholdStyle(
    pct,
    defaultFg,
    colors.blockBold,
    colors,
    50,
    warningThreshold,
  );
  return buildBarString(pct, barWidth, sym, reset, fg, bold);
}

export function buildWeeklyBar(
  data: TuiData,
  barWidth: number,
  sym: SymbolSet,
  reset: string,
  colors: PowerlineColors,
  partFg?: Record<string, string>,
): string {
  const sevenDay = data.hookData.rate_limits?.seven_day;
  if (!sevenDay) return "";

  const pct = sevenDay.used_percentage;
  const defaultFg =
    partFg?.["weekly.bar"] ?? partFg?.["weekly"] ?? colors.weeklyFg;
  const { fg, bold } = resolveThresholdStyle(
    pct,
    defaultFg,
    colors.weeklyBold,
    colors,
  );
  return buildBarString(pct, barWidth, sym, reset, fg, bold);
}

export function buildContextLine(
  data: TuiData,
  contentWidth: number,
  sym: SymbolSet,
  reset: string,
  colors: PowerlineColors,
): string | null {
  if (!data.contextInfo) {
    return null;
  }

  const usedPct = data.contextInfo.usablePercentage;
  const tokenStr = formatTokenCount(data.contextInfo.totalTokens);
  const maxStr = formatTokenCount(data.contextInfo.maxTokens);
  const suffix = `  ${usedPct}%  ${tokenStr}/${maxStr}`;
  const barLen = Math.max(5, contentWidth - suffix.length);
  const filledCount = Math.max(
    0,
    Math.min(barLen, Math.round((usedPct / 100) * barLen)),
  );
  const emptyCount = barLen - filledCount;
  const bar =
    sym.bar_filled.repeat(filledCount) + sym.bar_empty.repeat(emptyCount);

  const { fg, bold } = resolveThresholdStyle(
    usedPct,
    colors.contextFg,
    colors.contextBold,
    colors,
  );

  return colorize(`${bar}${suffix}`, fg, reset, bold);
}
