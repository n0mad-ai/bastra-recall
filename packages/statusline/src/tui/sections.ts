import type { PowerlineConfig } from "../config/loader";
import type { PowerlineColors } from "../themes";
import type { TuiData, SymbolSet, RenderCtx, SegmentTemplate, JustifyValue } from "./types";
import { visibleLength } from "../utils/terminal";

import { formatDuration, formatModelName, formatResponseTime, abbreviateFishStyle } from "../utils/formatters";
import { colorize } from "./primitives";
import { resolveIconVisibility } from "../utils/icon-visibility";
import { resolveThresholdStyle, getDirectoryDisplay } from "./sections-shared";
import { buildContextLine } from "./sections-bars";
import {
  formatContextParts,
  formatBlockParts,
  formatBlockSegment,
  formatWeeklyParts,
  formatWeeklySegment,
  formatSessionParts,
  formatSessionSegment,
  formatTodayParts,
  formatTodaySegment,
  formatMetricsParts,
  formatMetricsSegment,
  formatActivityParts,
  formatActivitySegment,
  formatGitParts,
  formatGitSegment,
  formatDirParts,
  formatDirValue,
  formatVersionParts,
  formatVersionSegment,
  formatAgentParts,
  formatAgentSegment,
  formatThinkingParts,
  formatThinkingSegment,
  formatCacheTimerParts,
  formatCacheTimerSegment,
  cacheTimerTtl,
  cacheTimerStyle,
  formatTmuxParts,
  formatTmuxSegment,
  formatEnvParts,
  formatEnvSegment,
} from "./sections-parts";

// #680: bar renderers live in sections-bars.ts, part formatters in
// sections-parts.ts; this module keeps the public surface and re-exports them.
export {
  resolveTitleToken,
  buildTitleBar,
  buildContextBar,
  buildBlockBar,
  buildWeeklyBar,
  buildContextLine,
} from "./sections-bars";
export {
  formatContextParts,
  formatBlockParts,
  formatBlockSegment,
  formatWeeklyParts,
  formatWeeklySegment,
  formatSessionParts,
  formatSessionSegment,
  formatTodayParts,
  formatTodaySegment,
} from "./sections-parts";

export function collectMetricSegments(
  data: TuiData,
  sym: SymbolSet,
  config: PowerlineConfig,
  reset: string,
  colors: PowerlineColors
): string[] {
  const segments: string[] = [];

  if (data.blockInfo) {
    segments.push(
      colorize(
        formatBlockSegment(data.blockInfo, sym, config, resolveIconVisibility(config, "block")),
        colors.blockFg,
        reset,
        colors.blockBold
      )
    );
  }
  const sevenDay = data.hookData.rate_limits?.seven_day;
  if (sevenDay) {
    segments.push(
      colorize(
        formatWeeklySegment(sevenDay, sym, resolveIconVisibility(config, "weekly")),
        colors.weeklyFg,
        reset,
        colors.weeklyBold
      )
    );
  }
  if (data.usageInfo) {
    const sessionStr = formatSessionSegment(data.usageInfo, sym, config, resolveIconVisibility(config, "session"));
    if (sessionStr) {
      segments.push(colorize(sessionStr, colors.sessionFg, reset, colors.sessionBold));
    }
  }
  if (data.todayInfo) {
    const todayStr = formatTodaySegment(data.todayInfo, sym, config, resolveIconVisibility(config, "today"));
    if (todayStr) {
      segments.push(colorize(todayStr, colors.todayFg, reset, colors.todayBold));
    }
  }

  const activityParts = collectActivityParts(data, sym);
  if (activityParts.length > 0) {
    segments.push(colorize(activityParts.join(" · "), colors.metricsFg, reset, colors.metricsBold));
  }

  return segments;
}

export function collectActivityParts(data: TuiData, sym: SymbolSet): string[] {
  const parts: string[] = [];
  if (data.metricsInfo) {
    if (data.metricsInfo.sessionDuration !== null && data.metricsInfo.sessionDuration > 0) {
      parts.push(`${sym.metrics_duration} ${formatDuration(data.metricsInfo.sessionDuration)}`);
    }
    if (data.metricsInfo.messageCount !== null && data.metricsInfo.messageCount > 0) {
      parts.push(`${sym.metrics_messages} ${data.metricsInfo.messageCount}`);
    }
  }
  return parts;
}

export function collectWorkspaceParts(
  data: TuiData,
  sym: SymbolSet,
  reset: string,
  colors: PowerlineColors,
  config: PowerlineConfig
): string[] {
  const parts: string[] = [];

  const gitStr = formatGitSegment(data, sym, resolveIconVisibility(config, "git"));
  if (gitStr) parts.push(colorize(gitStr, colors.gitFg, reset, colors.gitBold));

  const dir = abbreviateFishStyle(getDirectoryDisplay(data.hookData));
  parts.push(colorize(dir, colors.modeFg, reset, colors.modeBold));

  return parts;
}

export function collectFooterParts(
  data: TuiData,
  sym: SymbolSet,
  config: PowerlineConfig,
  reset: string,
  colors: PowerlineColors
): string[] {
  const parts: string[] = [];

  const versionText = formatVersionSegment(data, sym, resolveIconVisibility(config, "version"));
  if (versionText) {
    parts.push(colorize(versionText, colors.versionFg, reset, colors.versionBold));
  }

  const thinkingSegConfig = config.display.lines.map((line) => line.segments.thinking).find((t) => t?.enabled);
  const thinkingText = formatThinkingSegment(data, sym, thinkingSegConfig, resolveIconVisibility(config, "thinking"));
  if (thinkingText) {
    parts.push(colorize(thinkingText, colors.thinkingFg, reset, colors.thinkingBold));
  }

  const cacheTimerEnabled = config.display.lines.some((line) => line.segments.cacheTimer?.enabled);
  if (cacheTimerEnabled && data.cacheTimerInfo) {
    const cacheTimerText = formatCacheTimerSegment(data, sym, resolveIconVisibility(config, "cacheTimer"));
    if (cacheTimerText) {
      const { fg, bold } = cacheTimerStyle(data.cacheTimerInfo.elapsedSeconds, colors, cacheTimerTtl(config, data));
      parts.push(colorize(cacheTimerText, fg, reset, bold));
    }
  }

  if (data.tmuxSessionId) {
    parts.push(colorize(`tmux:${data.tmuxSessionId}`, colors.tmuxFg, reset, colors.tmuxBold));
  }

  if (data.metricsInfo) {
    const metricParts: string[] = [];
    if (
      data.metricsInfo.responseTime !== null &&
      !isNaN(data.metricsInfo.responseTime) &&
      data.metricsInfo.responseTime > 0
    ) {
      metricParts.push(`${sym.metrics_response} ${formatResponseTime(data.metricsInfo.responseTime)}`);
    }
    if (data.metricsInfo.linesAdded !== null && data.metricsInfo.linesAdded > 0) {
      metricParts.push(`${sym.metrics_lines_added}${data.metricsInfo.linesAdded}`);
    }
    if (data.metricsInfo.linesRemoved !== null && data.metricsInfo.linesRemoved > 0) {
      metricParts.push(`${sym.metrics_lines_removed}${data.metricsInfo.linesRemoved}`);
    }
    if (metricParts.length > 0) {
      parts.push(colorize(metricParts.join(" · "), colors.metricsFg, reset, colors.metricsBold));
    }
  }

  const envConfig = config.display.lines.map((line) => line.segments.env).find((env) => env?.enabled);

  if (envConfig && envConfig.variable) {
    const envVal = globalThis.process?.env?.[envConfig.variable];
    if (envVal) {
      const prefix = envConfig.prefix ?? envConfig.variable;
      parts.push(colorize(prefix ? `${prefix}:${envVal}` : envVal, colors.envFg, reset, colors.envBold));
    }
  }

  // #53: bastra parity with the powerline path — shown whenever the
  // per-session feed answers (BastraProvider fail-opens to null).
  const bastraText = formatBastraText(data);
  if (bastraText) {
    parts.push(colorize(bastraText, colors.bastraFg, reset, colors.bastraBold));
  }

  return parts;
}

/** #53: compact TUI mirror of renderBastra's three states (idle / running /
 *  done snapshot); banter phrases stay powerline-only to keep the panel calm. */
function formatBastraText(data: TuiData): string | null {
  const info = data.bastraInfo;
  if (!info) return null;
  if (info.state === "idle" || info.recallCount === 0) {
    return `bastra · ${info.vaultSize} memories`;
  }
  if (info.currentStage && info.currentStageStartedAt) {
    const live =
      info.currentRecallStartedAt !== null
        ? info.totalMs + Math.max(0, Date.now() - info.currentRecallStartedAt)
        : info.totalMs;
    return `bastra · ${info.recallCount} ${info.recallCount === 1 ? "call" : "calls"} · ${info.totalHits} ${info.totalHits === 1 ? "hit" : "hits"} · ${live}ms · ${info.currentStage}`;
  }
  const hits = info.totalHits > 0 ? ` · ${info.totalHits} ${info.totalHits === 1 ? "hit" : "hits"}` : "";
  const ms = info.totalMs > 0 ? ` · ${info.totalMs}ms` : "";
  return `✓ bastra · ${info.recallCount} ${info.recallCount === 1 ? "call" : "calls"}${hits}${ms}`;
}

function addParts(
  result: Record<string, string>,
  segment: string,
  parts: Record<string, string>,
  color: string,
  reset: string,
  partFg?: Record<string, string>,
  bold = false
): void {
  for (const [key, value] of Object.entries(parts)) {
    const partKey = `${segment}.${key}`;
    const partColor = partFg?.[partKey] ?? partFg?.[segment] ?? color;
    result[partKey] = value ? colorize(value, partColor, reset, bold) : "";
  }
}

// --- Template Composition ---

export interface ResolvedTemplate {
  items: string[];
  gap: number;
  justify: JustifyValue;
}

function resolveTemplateItems(
  template: SegmentTemplate,
  segmentRef: string,
  resolvedData: Record<string, string>
): string[] {
  const dotIdx = segmentRef.indexOf(".");
  const baseSegment = dotIdx !== -1 ? segmentRef.slice(0, dotIdx) : segmentRef;

  return template.items
    .map((item) => {
      const match = item.match(/^\{(.+)\}$/);
      if (!match) return item ? colorize(item, "", "") : "";
      const partName = match[1]!;
      const key = `${baseSegment}.${partName}`;
      return resolvedData[key] ?? "";
    })
    .filter(Boolean);
}

export function composeTemplate(items: string[], gap: number, justify: JustifyValue, cellWidth?: number): string {
  if (items.length === 0) return "";

  if (justify === "between" && cellWidth !== undefined && items.length > 1) {
    const totalContent = items.reduce((sum, item) => sum + visibleLength(item), 0);
    const totalGap = Math.max(gap * (items.length - 1), cellWidth - totalContent);
    const baseGap = Math.floor(totalGap / (items.length - 1));
    const extraSpaces = totalGap % (items.length - 1);

    let result = items[0]!;
    for (let i = 1; i < items.length; i++) {
      result += " ".repeat(baseGap + (i <= extraSpaces ? 1 : 0)) + items[i];
    }
    return result;
  }

  return items.join(" ".repeat(gap));
}

export interface ResolvedSegments {
  data: Record<string, string>;
  templates: Record<string, ResolvedTemplate>;
}

interface PartStyle {
  fg: string;
  bold: boolean;
}

/** Writes a segment's whole value and its parts. The whole value takes the
 *  segment's part colour if one is configured; each part its own, then the
 *  segment's, then the theme colour. */
function putSegment(
  result: Record<string, string>,
  ctx: RenderCtx,
  segment: string,
  text: string,
  parts: Record<string, string>,
  style: PartStyle
): void {
  const pf = ctx.colors.partFg;
  result[segment] = text ? colorize(text, pf?.[segment] ?? style.fg, ctx.reset, style.bold) : "";
  addParts(result, segment, parts, style.fg, ctx.reset, pf, style.bold);
}

function resolveHeadSegments(result: Record<string, string>, data: TuiData, ctx: RenderCtx): void {
  const { sym, config, reset, colors } = ctx;
  // Model
  const modelName = formatModelName(data.hookData.model?.display_name || "Claude").toLowerCase();
  const modelIcon = resolveIconVisibility(config, "model") ? sym.model : "";
  putSegment(
    result,
    ctx,
    "model",
    modelIcon ? `${modelIcon} ${modelName}` : modelName,
    { icon: modelIcon, value: modelName },
    { fg: colors.modelFg, bold: colors.modelBold }
  );

  // Context (bar is width-dependent, resolved later via lateResolve)
  result.context = buildContextLine(data, ctx.contentWidth, sym, reset, colors) ?? "";
  const ctxParts = formatContextParts(data, sym, resolveIconVisibility(config, "context"));
  const ctxStyle = data.contextInfo
    ? resolveThresholdStyle(data.contextInfo.usablePercentage, colors.contextFg, colors.contextBold, colors)
    : { fg: colors.contextFg, bold: colors.contextBold };
  addParts(result, "context", ctxParts, ctxStyle.fg, reset, colors.partFg, ctxStyle.bold);
}

/** Block, session, today and weekly exist only with their usage data; without it they stay empty. */
function resolveUsageSegments(result: Record<string, string>, data: TuiData, ctx: RenderCtx): void {
  const { sym, config, colors } = ctx;
  const icon = (segment: "block" | "session" | "today" | "weekly") => resolveIconVisibility(config, segment);
  const block = data.blockInfo;
  if (block)
    putSegment(
      result,
      ctx,
      "block",
      formatBlockSegment(block, sym, config, icon("block")),
      formatBlockParts(block, sym, config, icon("block")),
      { fg: colors.blockFg, bold: colors.blockBold }
    );
  else result.block = "";

  const usage = data.usageInfo;
  if (usage)
    putSegment(
      result,
      ctx,
      "session",
      formatSessionSegment(usage, sym, config, icon("session")),
      formatSessionParts(usage, sym, config, icon("session")),
      { fg: colors.sessionFg, bold: colors.sessionBold }
    );
  else result.session = "";

  const today = data.todayInfo;
  if (today)
    putSegment(
      result,
      ctx,
      "today",
      formatTodaySegment(today, sym, config, icon("today")),
      formatTodayParts(today, sym, config, icon("today")),
      { fg: colors.todayFg, bold: colors.todayBold }
    );
  else result.today = "";

  const sevenDay = data.hookData.rate_limits?.seven_day;
  if (sevenDay)
    putSegment(
      result,
      ctx,
      "weekly",
      formatWeeklySegment(sevenDay, sym, icon("weekly")),
      formatWeeklyParts(sevenDay, sym, icon("weekly")),
      { fg: colors.weeklyFg, bold: colors.weeklyBold }
    );
  else result.weekly = "";
}

function resolveWorkspaceSegments(result: Record<string, string>, data: TuiData, ctx: RenderCtx): void {
  const { sym, config, colors } = ctx;
  const gitIcon = resolveIconVisibility(config, "git");
  putSegment(result, ctx, "git", formatGitSegment(data, sym, gitIcon), formatGitParts(data, sym, gitIcon), {
    fg: colors.gitFg,
    bold: colors.gitBold,
  });
  putSegment(
    result,
    ctx,
    "dir",
    formatDirValue(data, config),
    formatDirParts(data, config, sym, resolveIconVisibility(config, "directory")),
    { fg: colors.modeFg, bold: colors.modeBold }
  );
  const versionIcon = resolveIconVisibility(config, "version");
  putSegment(
    result,
    ctx,
    "version",
    formatVersionSegment(data, sym, versionIcon),
    formatVersionParts(data, sym, versionIcon),
    { fg: colors.versionFg, bold: colors.versionBold }
  );
  putSegment(result, ctx, "tmux", formatTmuxSegment(data), formatTmuxParts(data), {
    fg: colors.tmuxFg,
    bold: colors.tmuxBold,
  });
}

function resolveActivitySegments(result: Record<string, string>, data: TuiData, ctx: RenderCtx): void {
  const { sym, config, colors } = ctx;
  const metricsStyle = { fg: colors.metricsFg, bold: colors.metricsBold };
  putSegment(result, ctx, "metrics", formatMetricsSegment(data, sym), formatMetricsParts(data, sym), metricsStyle);
  putSegment(result, ctx, "activity", formatActivitySegment(data, sym), formatActivityParts(data, sym), metricsStyle);
  putSegment(result, ctx, "env", formatEnvSegment(config), formatEnvParts(config), {
    fg: colors.envFg,
    bold: colors.envBold,
  });
  const agentIcon = resolveIconVisibility(config, "agent");
  putSegment(
    result,
    ctx,
    "agent",
    formatAgentSegment(data, sym, config, agentIcon),
    formatAgentParts(data, sym, agentIcon),
    { fg: colors.agentFg, bold: colors.agentBold }
  );

  // Thinking (combined enabled + effort)
  const thinkingSegConfig = config.display.lines.map((line) => line.segments.thinking).find((t) => t?.enabled);
  const thinkingIcon = resolveIconVisibility(config, "thinking");
  putSegment(
    result,
    ctx,
    "thinking",
    formatThinkingSegment(data, sym, thinkingSegConfig, thinkingIcon),
    formatThinkingParts(data, sym, thinkingSegConfig, thinkingIcon),
    { fg: colors.thinkingFg, bold: colors.thinkingBold }
  );

  // CacheTimer: colour follows the elapsed share of the cache TTL
  const cacheTimerIcon = resolveIconVisibility(config, "cacheTimer");
  putSegment(
    result,
    ctx,
    "cacheTimer",
    formatCacheTimerSegment(data, sym, cacheTimerIcon),
    formatCacheTimerParts(data, sym, cacheTimerIcon),
    cacheTimerStyle(data.cacheTimerInfo?.elapsedSeconds ?? 0, colors, cacheTimerTtl(config, data))
  );
}

/** Applies segment templates: resolves their items and composes the default value. */
function resolveTemplates(result: Record<string, string>, config: PowerlineConfig): Record<string, ResolvedTemplate> {
  const templates: Record<string, ResolvedTemplate> = {};
  for (const [segRef, tmpl] of Object.entries(config.display.tui?.segments ?? {})) {
    const items = resolveTemplateItems(tmpl, segRef, result);
    const gap = tmpl.gap ?? 1;
    const justify = tmpl.justify ?? "start";
    templates[segRef] = { items, gap, justify };
    // Compose default (without cell width for "between")
    result[segRef] = composeTemplate(items, gap, justify === "between" ? "start" : justify);
  }
  return templates;
}

export function resolveSegments(data: TuiData, ctx: RenderCtx): ResolvedSegments {
  const result: Record<string, string> = {};
  resolveHeadSegments(result, data, ctx);
  resolveUsageSegments(result, data, ctx);
  resolveWorkspaceSegments(result, data, ctx);
  resolveActivitySegments(result, data, ctx);
  return { data: result, templates: resolveTemplates(result, ctx.config) };
}
