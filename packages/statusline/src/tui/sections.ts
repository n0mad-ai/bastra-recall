import type { PowerlineConfig } from "../config/loader";
import type { PowerlineColors } from "../themes";
import type {
  TuiData,
  SymbolSet,
  RenderCtx,
  SegmentTemplate,
  JustifyValue,
} from "./types";
import { visibleLength } from "../utils/terminal";

import {
  formatDuration,
  formatModelName,
  formatResponseTime,
  abbreviateFishStyle,
} from "../utils/formatters";
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
  colors: PowerlineColors,
): string[] {
  const segments: string[] = [];

  if (data.blockInfo) {
    segments.push(
      colorize(
        formatBlockSegment(
          data.blockInfo,
          sym,
          config,
          resolveIconVisibility(config, "block"),
        ),
        colors.blockFg,
        reset,
        colors.blockBold,
      ),
    );
  }
  const sevenDay = data.hookData.rate_limits?.seven_day;
  if (sevenDay) {
    segments.push(
      colorize(
        formatWeeklySegment(
          sevenDay,
          sym,
          resolveIconVisibility(config, "weekly"),
        ),
        colors.weeklyFg,
        reset,
        colors.weeklyBold,
      ),
    );
  }
  if (data.usageInfo) {
    const sessionStr = formatSessionSegment(
      data.usageInfo,
      sym,
      config,
      resolveIconVisibility(config, "session"),
    );
    if (sessionStr) {
      segments.push(
        colorize(sessionStr, colors.sessionFg, reset, colors.sessionBold),
      );
    }
  }
  if (data.todayInfo) {
    const todayStr = formatTodaySegment(
      data.todayInfo,
      sym,
      config,
      resolveIconVisibility(config, "today"),
    );
    if (todayStr) {
      segments.push(
        colorize(todayStr, colors.todayFg, reset, colors.todayBold),
      );
    }
  }

  const activityParts = collectActivityParts(data, sym);
  if (activityParts.length > 0) {
    segments.push(
      colorize(
        activityParts.join(" · "),
        colors.metricsFg,
        reset,
        colors.metricsBold,
      ),
    );
  }

  return segments;
}

export function collectActivityParts(data: TuiData, sym: SymbolSet): string[] {
  const parts: string[] = [];
  if (data.metricsInfo) {
    if (
      data.metricsInfo.sessionDuration !== null &&
      data.metricsInfo.sessionDuration > 0
    ) {
      parts.push(
        `${sym.metrics_duration} ${formatDuration(data.metricsInfo.sessionDuration)}`,
      );
    }
    if (
      data.metricsInfo.messageCount !== null &&
      data.metricsInfo.messageCount > 0
    ) {
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
  config: PowerlineConfig,
): string[] {
  const parts: string[] = [];

  const gitStr = formatGitSegment(
    data,
    sym,
    resolveIconVisibility(config, "git"),
  );
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
  colors: PowerlineColors,
): string[] {
  const parts: string[] = [];

  const versionText = formatVersionSegment(
    data,
    sym,
    resolveIconVisibility(config, "version"),
  );
  if (versionText) {
    parts.push(
      colorize(versionText, colors.versionFg, reset, colors.versionBold),
    );
  }

  const thinkingSegConfig = config.display.lines
    .map((line) => line.segments.thinking)
    .find((t) => t?.enabled);
  const thinkingText = formatThinkingSegment(
    data,
    sym,
    thinkingSegConfig,
    resolveIconVisibility(config, "thinking"),
  );
  if (thinkingText) {
    parts.push(
      colorize(thinkingText, colors.thinkingFg, reset, colors.thinkingBold),
    );
  }

  const cacheTimerEnabled = config.display.lines.some(
    (line) => line.segments.cacheTimer?.enabled,
  );
  if (cacheTimerEnabled && data.cacheTimerInfo) {
    const cacheTimerText = formatCacheTimerSegment(
      data,
      sym,
      resolveIconVisibility(config, "cacheTimer"),
    );
    if (cacheTimerText) {
      const { fg, bold } = cacheTimerStyle(
        data.cacheTimerInfo.elapsedSeconds,
        colors,
        cacheTimerTtl(config, data),
      );
      parts.push(colorize(cacheTimerText, fg, reset, bold));
    }
  }

  if (data.tmuxSessionId) {
    parts.push(
      colorize(
        `tmux:${data.tmuxSessionId}`,
        colors.tmuxFg,
        reset,
        colors.tmuxBold,
      ),
    );
  }

  if (data.metricsInfo) {
    const metricParts: string[] = [];
    if (
      data.metricsInfo.responseTime !== null &&
      !isNaN(data.metricsInfo.responseTime) &&
      data.metricsInfo.responseTime > 0
    ) {
      metricParts.push(
        `${sym.metrics_response} ${formatResponseTime(data.metricsInfo.responseTime)}`,
      );
    }
    if (
      data.metricsInfo.linesAdded !== null &&
      data.metricsInfo.linesAdded > 0
    ) {
      metricParts.push(
        `${sym.metrics_lines_added}${data.metricsInfo.linesAdded}`,
      );
    }
    if (
      data.metricsInfo.linesRemoved !== null &&
      data.metricsInfo.linesRemoved > 0
    ) {
      metricParts.push(
        `${sym.metrics_lines_removed}${data.metricsInfo.linesRemoved}`,
      );
    }
    if (metricParts.length > 0) {
      parts.push(
        colorize(
          metricParts.join(" · "),
          colors.metricsFg,
          reset,
          colors.metricsBold,
        ),
      );
    }
  }

  const envConfig = config.display.lines
    .map((line) => line.segments.env)
    .find((env) => env?.enabled);

  if (envConfig && envConfig.variable) {
    const envVal = globalThis.process?.env?.[envConfig.variable];
    if (envVal) {
      const prefix = envConfig.prefix ?? envConfig.variable;
      parts.push(
        colorize(
          prefix ? `${prefix}:${envVal}` : envVal,
          colors.envFg,
          reset,
          colors.envBold,
        ),
      );
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
  bold = false,
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
  resolvedData: Record<string, string>,
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

export function composeTemplate(
  items: string[],
  gap: number,
  justify: JustifyValue,
  cellWidth?: number,
): string {
  if (items.length === 0) return "";

  if (justify === "between" && cellWidth !== undefined && items.length > 1) {
    const totalContent = items.reduce(
      (sum, item) => sum + visibleLength(item),
      0,
    );
    const totalGap = Math.max(
      gap * (items.length - 1),
      cellWidth - totalContent,
    );
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

export function resolveSegments(
  data: TuiData,
  ctx: RenderCtx,
): ResolvedSegments {
  const { sym, config, reset, colors } = ctx;
  const pf = colors.partFg;

  const colorizeOrEmpty = (
    text: string,
    color: string,
    bold = false,
  ): string => (text ? colorize(text, color, reset, bold) : "");

  const result: Record<string, string> = {};

  const iconVisible = {
    model: resolveIconVisibility(config, "model"),
    context: resolveIconVisibility(config, "context"),
    block: resolveIconVisibility(config, "block"),
    session: resolveIconVisibility(config, "session"),
    today: resolveIconVisibility(config, "today"),
    weekly: resolveIconVisibility(config, "weekly"),
    git: resolveIconVisibility(config, "git"),
    directory: resolveIconVisibility(config, "directory"),
    version: resolveIconVisibility(config, "version"),
    agent: resolveIconVisibility(config, "agent"),
    thinking: resolveIconVisibility(config, "thinking"),
    cacheTimer: resolveIconVisibility(config, "cacheTimer"),
  };

  // Model
  const rawModelName = data.hookData.model?.display_name || "Claude";
  const modelName = formatModelName(rawModelName).toLowerCase();
  const modelColor = pf?.["model"] ?? colors.modelFg;
  const modelIcon = iconVisible.model ? sym.model : "";
  result.model = colorizeOrEmpty(
    modelIcon ? `${modelIcon} ${modelName}` : modelName,
    modelColor,
    colors.modelBold,
  );
  addParts(
    result,
    "model",
    { icon: modelIcon, value: modelName },
    colors.modelFg,
    reset,
    pf,
    colors.modelBold,
  );

  // Context (bar is width-dependent, resolved later via lateResolve)
  const contextLine = buildContextLine(
    data,
    ctx.contentWidth,
    sym,
    reset,
    colors,
  );
  result.context = contextLine ?? "";
  const ctxParts = formatContextParts(data, sym, iconVisible.context);
  const ctxStyle = data.contextInfo
    ? resolveThresholdStyle(
        data.contextInfo.usablePercentage,
        colors.contextFg,
        colors.contextBold,
        colors,
      )
    : { fg: colors.contextFg, bold: colors.contextBold };
  addParts(result, "context", ctxParts, ctxStyle.fg, reset, pf, ctxStyle.bold);

  // Block
  if (data.blockInfo) {
    const blockColor = pf?.["block"] ?? colors.blockFg;
    result.block = colorizeOrEmpty(
      formatBlockSegment(data.blockInfo, sym, config, iconVisible.block),
      blockColor,
      colors.blockBold,
    );
    addParts(
      result,
      "block",
      formatBlockParts(data.blockInfo, sym, config, iconVisible.block),
      colors.blockFg,
      reset,
      pf,
      colors.blockBold,
    );
  } else {
    result.block = "";
  }

  // Session
  if (data.usageInfo) {
    const sessionColor = pf?.["session"] ?? colors.sessionFg;
    result.session = colorizeOrEmpty(
      formatSessionSegment(data.usageInfo, sym, config, iconVisible.session),
      sessionColor,
      colors.sessionBold,
    );
    addParts(
      result,
      "session",
      formatSessionParts(data.usageInfo, sym, config, iconVisible.session),
      colors.sessionFg,
      reset,
      pf,
      colors.sessionBold,
    );
  } else {
    result.session = "";
  }

  // Today
  if (data.todayInfo) {
    const todayColor = pf?.["today"] ?? colors.todayFg;
    result.today = colorizeOrEmpty(
      formatTodaySegment(data.todayInfo, sym, config, iconVisible.today),
      todayColor,
      colors.todayBold,
    );
    addParts(
      result,
      "today",
      formatTodayParts(data.todayInfo, sym, config, iconVisible.today),
      colors.todayFg,
      reset,
      pf,
      colors.todayBold,
    );
  } else {
    result.today = "";
  }

  // Weekly
  const sevenDay = data.hookData.rate_limits?.seven_day;
  if (sevenDay) {
    const weeklyColor = pf?.["weekly"] ?? colors.weeklyFg;
    result.weekly = colorizeOrEmpty(
      formatWeeklySegment(sevenDay, sym, iconVisible.weekly),
      weeklyColor,
      colors.weeklyBold,
    );
    addParts(
      result,
      "weekly",
      formatWeeklyParts(sevenDay, sym, iconVisible.weekly),
      colors.weeklyFg,
      reset,
      pf,
      colors.weeklyBold,
    );
  } else {
    result.weekly = "";
  }

  // Git
  const gitColor = pf?.["git"] ?? colors.gitFg;
  result.git = colorizeOrEmpty(
    formatGitSegment(data, sym, iconVisible.git),
    gitColor,
    colors.gitBold,
  );
  addParts(
    result,
    "git",
    formatGitParts(data, sym, iconVisible.git),
    colors.gitFg,
    reset,
    pf,
    colors.gitBold,
  );

  // Dir
  const dirColor = pf?.["dir"] ?? colors.modeFg;
  result.dir = colorizeOrEmpty(
    formatDirValue(data, config),
    dirColor,
    colors.modeBold,
  );
  addParts(
    result,
    "dir",
    formatDirParts(data, config, sym, iconVisible.directory),
    colors.modeFg,
    reset,
    pf,
    colors.modeBold,
  );

  // Version
  const versionColor = pf?.["version"] ?? colors.versionFg;
  result.version = colorizeOrEmpty(
    formatVersionSegment(data, sym, iconVisible.version),
    versionColor,
    colors.versionBold,
  );
  addParts(
    result,
    "version",
    formatVersionParts(data, sym, iconVisible.version),
    colors.versionFg,
    reset,
    pf,
    colors.versionBold,
  );

  // Tmux
  const tmuxColor = pf?.["tmux"] ?? colors.tmuxFg;
  result.tmux = colorizeOrEmpty(
    formatTmuxSegment(data),
    tmuxColor,
    colors.tmuxBold,
  );
  addParts(
    result,
    "tmux",
    formatTmuxParts(data),
    colors.tmuxFg,
    reset,
    pf,
    colors.tmuxBold,
  );

  // Metrics
  const metricsColor = pf?.["metrics"] ?? colors.metricsFg;
  result.metrics = colorizeOrEmpty(
    formatMetricsSegment(data, sym),
    metricsColor,
    colors.metricsBold,
  );
  addParts(
    result,
    "metrics",
    formatMetricsParts(data, sym),
    colors.metricsFg,
    reset,
    pf,
    colors.metricsBold,
  );

  // Activity
  const activityColor = pf?.["activity"] ?? colors.metricsFg;
  result.activity = colorizeOrEmpty(
    formatActivitySegment(data, sym),
    activityColor,
    colors.metricsBold,
  );
  addParts(
    result,
    "activity",
    formatActivityParts(data, sym),
    colors.metricsFg,
    reset,
    pf,
    colors.metricsBold,
  );

  // Env
  const envColor = pf?.["env"] ?? colors.envFg;
  result.env = colorizeOrEmpty(
    formatEnvSegment(config),
    envColor,
    colors.envBold,
  );
  addParts(
    result,
    "env",
    formatEnvParts(config),
    colors.envFg,
    reset,
    pf,
    colors.envBold,
  );

  // Agent
  const agentColor = pf?.["agent"] ?? colors.agentFg;
  result.agent = colorizeOrEmpty(
    formatAgentSegment(data, sym, config, iconVisible.agent),
    agentColor,
    colors.agentBold,
  );
  addParts(
    result,
    "agent",
    formatAgentParts(data, sym, iconVisible.agent),
    colors.agentFg,
    reset,
    pf,
    colors.agentBold,
  );

  // Thinking (combined enabled + effort)
  const thinkingSegConfig = config.display.lines
    .map((line) => line.segments.thinking)
    .find((t) => t?.enabled);
  const thinkingColor = pf?.["thinking"] ?? colors.thinkingFg;
  result.thinking = colorizeOrEmpty(
    formatThinkingSegment(data, sym, thinkingSegConfig, iconVisible.thinking),
    thinkingColor,
    colors.thinkingBold,
  );
  addParts(
    result,
    "thinking",
    formatThinkingParts(data, sym, thinkingSegConfig, iconVisible.thinking),
    colors.thinkingFg,
    reset,
    pf,
    colors.thinkingBold,
  );

  // CacheTimer
  const cacheTimerElapsed = data.cacheTimerInfo?.elapsedSeconds ?? 0;
  const cacheTimerStyleResolved = cacheTimerStyle(
    cacheTimerElapsed,
    colors,
    cacheTimerTtl(config, data),
  );
  const cacheTimerColor = pf?.["cacheTimer"] ?? cacheTimerStyleResolved.fg;
  result.cacheTimer = colorizeOrEmpty(
    formatCacheTimerSegment(data, sym, iconVisible.cacheTimer),
    cacheTimerColor,
    cacheTimerStyleResolved.bold,
  );
  addParts(
    result,
    "cacheTimer",
    formatCacheTimerParts(data, sym, iconVisible.cacheTimer),
    cacheTimerStyleResolved.fg,
    reset,
    pf,
    cacheTimerStyleResolved.bold,
  );

  // Apply segment templates: resolve items and compose default value
  const templates: Record<string, ResolvedTemplate> = {};
  const segmentConfigs = config.display.tui?.segments;
  if (segmentConfigs) {
    for (const [segRef, tmpl] of Object.entries(segmentConfigs)) {
      const items = resolveTemplateItems(tmpl, segRef, result);
      const gap = tmpl.gap ?? 1;
      const justify = tmpl.justify ?? "start";
      templates[segRef] = { items, gap, justify };
      // Compose default (without cell width for "between")
      result[segRef] = composeTemplate(
        items,
        gap,
        justify === "between" ? "start" : justify,
      );
    }
  }

  return { data: result, templates };
}
