import type { PowerlineConfig } from "../config/loader";
import type { PowerlineColors } from "../themes";
import type { TuiData, SymbolSet } from "./types";
import {
  formatCost,
  formatTokenCount,
  formatDuration,
  formatResponseTime,
  formatTimeRemaining,
  formatLongTimeRemaining,
  minutesUntilReset,
  abbreviateFishStyle,
  formatCacheTimerElapsed,
} from "../utils/formatters";
import { resolveBudgetDisplay } from "../utils/budget";
import { getEffortLevel, getThinkingEnabled } from "../utils/claude";
import { getDirectoryDisplay } from "./sections-shared";

export function formatContextParts(
  data: TuiData,
  sym: SymbolSet,
  iconVisible = true,
): Record<string, string> {
  if (!data.contextInfo)
    return { icon: "", label: "context", bar: "", pct: "", tokens: "" };

  const usedPct = data.contextInfo.usablePercentage;
  const tokenStr = formatTokenCount(data.contextInfo.totalTokens);
  const maxStr = formatTokenCount(data.contextInfo.maxTokens);

  return {
    icon: iconVisible ? sym.context_time : "",
    label: "context",
    bar: " ",
    pct: `${usedPct}%`,
    tokens: `${tokenStr}/${maxStr}`,
  };
}

export function formatBlockParts(
  blockInfo: TuiData["blockInfo"] & {},
  sym: SymbolSet,
  _config: PowerlineConfig,
  iconVisible = true,
): Record<string, string> {
  const value = `${Math.round(blockInfo.nativeUtilization)}%`;
  const time = formatTimeRemaining(blockInfo.timeRemaining);

  return {
    icon: iconVisible ? sym.block_cost : "",
    label: "block",
    value,
    time,
    budget: "",
    bar: " ",
  };
}

export function formatBlockSegment(
  blockInfo: TuiData["blockInfo"] & {},
  sym: SymbolSet,
  config: PowerlineConfig,
  iconVisible = true,
): string {
  const parts = formatBlockParts(blockInfo, sym, config, iconVisible);
  let text = parts.icon ? `${parts.icon} ${parts.value}` : (parts.value ?? "");
  if (parts.time) text += ` · ${parts.time}`;
  if (parts.budget) text += parts.budget;
  return text;
}

export function formatWeeklyParts(
  sevenDay: { used_percentage: number; resets_at: number },
  sym: SymbolSet,
  iconVisible = true,
): Record<string, string> {
  const pct = `${Math.round(sevenDay.used_percentage)}%`;
  const time = formatLongTimeRemaining(minutesUntilReset(sevenDay.resets_at));
  return {
    icon: iconVisible ? sym.weekly_cost : "",
    label: "weekly",
    pct,
    time,
    bar: " ",
  };
}

export function formatWeeklySegment(
  sevenDay: { used_percentage: number; resets_at: number },
  sym: SymbolSet,
  iconVisible = true,
): string {
  const parts = formatWeeklyParts(sevenDay, sym, iconVisible);
  let text = parts.icon ? `${parts.icon} ${parts.pct}` : (parts.pct ?? "");
  if (parts.time) text += ` · ${parts.time}`;
  return text;
}

export function formatSessionParts(
  usageInfo: TuiData["usageInfo"] & {},
  sym: SymbolSet,
  config: PowerlineConfig,
  iconVisible = true,
): Record<string, string> {
  const state = resolveBudgetDisplay(
    usageInfo.session.cost,
    usageInfo.session.tokens,
    config.budget?.session,
  );

  if (state.suppressAll) {
    return { icon: "", label: "", cost: "", tokens: "", budget: "" };
  }

  const sessionTokens = usageInfo.session.tokens;
  const tokenStr =
    state.showBase && sessionTokens !== null && sessionTokens > 0
      ? formatTokenCount(sessionTokens)
      : "";

  return {
    icon: iconVisible ? sym.session_cost : "",
    label: state.percentageOnly ? "" : "session",
    cost: state.showBase ? formatCost(usageInfo.session.cost) : "",
    tokens: tokenStr,
    budget: state.percentText ? ` ${state.percentText}` : "",
  };
}

export function formatSessionSegment(
  usageInfo: TuiData["usageInfo"] & {},
  sym: SymbolSet,
  config: PowerlineConfig,
  iconVisible = true,
): string {
  const state = resolveBudgetDisplay(
    usageInfo.session.cost,
    usageInfo.session.tokens,
    config.budget?.session,
  );
  if (state.suppressAll) return "";

  const icon = iconVisible ? sym.session_cost : "";

  if (!state.showBase) {
    return icon ? `${icon} ${state.percentText}` : state.percentText;
  }

  const costStr = formatCost(usageInfo.session.cost);
  const sessionTokens = usageInfo.session.tokens;
  let text = icon ? `${icon} ${costStr}` : costStr;
  if (sessionTokens !== null && sessionTokens > 0) {
    text += ` · ${formatTokenCount(sessionTokens)}`;
  }
  if (state.percentText) text += ` ${state.percentText}`;
  return text;
}

export function formatTodayParts(
  todayInfo: TuiData["todayInfo"] & {},
  sym: SymbolSet,
  config: PowerlineConfig,
  iconVisible = true,
): Record<string, string> {
  const state = resolveBudgetDisplay(
    todayInfo.cost,
    todayInfo.tokens,
    config.budget?.today,
  );

  if (state.suppressAll) {
    return { icon: "", label: "", cost: "", budget: "" };
  }

  return {
    icon: iconVisible ? sym.today_cost : "",
    cost: state.showBase ? formatCost(todayInfo.cost) : "",
    label: state.percentageOnly ? "" : "today",
    budget: state.percentText ? ` ${state.percentText}` : "",
  };
}

export function formatTodaySegment(
  todayInfo: TuiData["todayInfo"] & {},
  sym: SymbolSet,
  config: PowerlineConfig,
  iconVisible = true,
): string {
  const state = resolveBudgetDisplay(
    todayInfo.cost,
    todayInfo.tokens,
    config.budget?.today,
  );
  if (state.suppressAll) return "";

  const icon = iconVisible ? sym.today_cost : "";

  if (!state.showBase) {
    return icon ? `${icon} ${state.percentText}` : state.percentText;
  }

  const costStr = formatCost(todayInfo.cost);
  let text = icon ? `${icon} ${costStr} today` : `${costStr} today`;
  if (state.percentText) text += ` ${state.percentText}`;
  return text;
}

export function formatMetricsParts(
  data: TuiData,
  sym: SymbolSet,
): Record<string, string> {
  const empty = {
    response: "",
    responseIcon: "",
    responseVal: "",
    lastResponse: "",
    lastResponseIcon: "",
    lastResponseVal: "",
    added: "",
    addedIcon: "",
    addedVal: "",
    removed: "",
    removedIcon: "",
    removedVal: "",
  };
  if (!data.metricsInfo) return empty;

  const hasResponse =
    data.metricsInfo.responseTime !== null &&
    !isNaN(data.metricsInfo.responseTime) &&
    data.metricsInfo.responseTime > 0;
  const responseValStr = hasResponse
    ? formatResponseTime(data.metricsInfo.responseTime!)
    : "";

  const hasLast =
    data.metricsInfo.lastResponseTime !== null &&
    !isNaN(data.metricsInfo.lastResponseTime) &&
    data.metricsInfo.lastResponseTime > 0;
  const lastValStr = hasLast
    ? formatResponseTime(data.metricsInfo.lastResponseTime!)
    : "";

  const hasAdded =
    data.metricsInfo.linesAdded !== null && data.metricsInfo.linesAdded > 0;
  const addedValStr = hasAdded ? `${data.metricsInfo.linesAdded}` : "";

  const hasRemoved =
    data.metricsInfo.linesRemoved !== null && data.metricsInfo.linesRemoved > 0;
  const removedValStr = hasRemoved ? `${data.metricsInfo.linesRemoved}` : "";

  return {
    response: hasResponse ? `${sym.metrics_response} ${responseValStr}` : "",
    responseIcon: hasResponse ? sym.metrics_response : "",
    responseVal: responseValStr,
    lastResponse: hasLast
      ? `${sym.metrics_last_response} ${lastValStr}`
      : `${sym.metrics_last_response} --`,
    lastResponseIcon: sym.metrics_last_response,
    lastResponseVal: hasLast ? lastValStr : "--",
    added: hasAdded ? `${sym.metrics_lines_added}${addedValStr}` : "",
    addedIcon: hasAdded ? sym.metrics_lines_added : "",
    addedVal: addedValStr,
    removed: hasRemoved ? `${sym.metrics_lines_removed}${removedValStr}` : "",
    removedIcon: hasRemoved ? sym.metrics_lines_removed : "",
    removedVal: removedValStr,
  };
}

export function formatMetricsSegment(data: TuiData, sym: SymbolSet): string {
  const parts = formatMetricsParts(data, sym);
  const filled = [
    parts.response,
    parts.lastResponse,
    parts.added,
    parts.removed,
  ].filter(Boolean);
  return filled.length > 0 ? filled.join(" · ") : "";
}

export function formatActivityParts(
  data: TuiData,
  sym: SymbolSet,
): Record<string, string> {
  const empty = {
    icon: "",
    duration: "",
    durationIcon: "",
    durationVal: "",
    messages: "",
    messagesIcon: "",
    messagesVal: "",
  };
  if (!data.metricsInfo) return empty;

  const hasDuration =
    data.metricsInfo.sessionDuration !== null &&
    data.metricsInfo.sessionDuration > 0;
  const durationValStr = hasDuration
    ? formatDuration(data.metricsInfo.sessionDuration!)
    : "";

  const hasMessages =
    data.metricsInfo.messageCount !== null && data.metricsInfo.messageCount > 0;
  const messagesValStr = hasMessages ? `${data.metricsInfo.messageCount}` : "";

  return {
    icon: sym.activity,
    duration: hasDuration ? `${sym.metrics_duration} ${durationValStr}` : "",
    durationIcon: hasDuration ? sym.metrics_duration : "",
    durationVal: durationValStr,
    messages: hasMessages ? `${sym.metrics_messages} ${messagesValStr}` : "",
    messagesIcon: hasMessages ? sym.metrics_messages : "",
    messagesVal: messagesValStr,
  };
}

export function formatActivitySegment(data: TuiData, sym: SymbolSet): string {
  const parts = formatActivityParts(data, sym);
  const filled = [parts.duration, parts.messages].filter(Boolean);
  return filled.length > 0 ? filled.join(" · ") : "";
}

export function formatGitParts(
  data: TuiData,
  sym: SymbolSet,
  iconVisible = true,
): Record<string, string> {
  if (!data.gitInfo)
    return {
      icon: "",
      headVal: "",
      branch: "",
      status: "",
      ahead: "",
      behind: "",
      working: "",
      head: "",
    };

  let statusIcon: string;
  if (data.gitInfo.status === "conflicts") {
    statusIcon = sym.git_conflicts;
  } else if (data.gitInfo.status === "dirty") {
    statusIcon = sym.git_dirty;
  } else if (data.gitInfo.status === "unknown") {
    statusIcon = "?";
  } else {
    statusIcon = sym.git_clean;
  }

  const ahead =
    data.gitInfo.ahead > 0 ? `${sym.git_ahead}${data.gitInfo.ahead}` : "";
  const behind =
    data.gitInfo.behind > 0 ? `${sym.git_behind}${data.gitInfo.behind}` : "";

  const counts: string[] = [];
  if (data.gitInfo.staged && data.gitInfo.staged > 0)
    counts.push(`+${data.gitInfo.staged}`);
  if (data.gitInfo.unstaged && data.gitInfo.unstaged > 0)
    counts.push(`~${data.gitInfo.unstaged}`);
  if (data.gitInfo.untracked && data.gitInfo.untracked > 0)
    counts.push(`?${data.gitInfo.untracked}`);
  const working = counts.length > 0 ? `(${counts.join(" ")})` : "";

  const headParts: string[] = [];
  if (iconVisible) headParts.push(sym.branch);
  headParts.push(data.gitInfo.branch, statusIcon);
  if (ahead) headParts.push(ahead);
  if (behind) headParts.push(behind);

  const infoParts = [data.gitInfo.branch, statusIcon];
  if (ahead) infoParts.push(ahead);
  if (behind) infoParts.push(behind);

  return {
    icon: iconVisible ? sym.branch : "",
    headVal: infoParts.join(" "),
    branch: data.gitInfo.branch,
    status: statusIcon,
    ahead,
    behind,
    working,
    head: headParts.join(" "),
  };
}

export function formatGitSegment(
  data: TuiData,
  sym: SymbolSet,
  iconVisible = true,
): string {
  const parts = formatGitParts(data, sym, iconVisible);
  if (!parts.branch) return "";
  let text = parts.icon
    ? `${parts.icon} ${parts.branch} ${parts.status}`
    : `${parts.branch} ${parts.status}`;
  if (parts.ahead) text += ` ${parts.ahead}`;
  if (parts.behind) text += `${parts.behind}`;
  if (parts.working) text += ` ${parts.working}`;
  return text;
}

export function formatDirParts(
  data: TuiData,
  config: PowerlineConfig,
  sym: SymbolSet,
  iconVisible = true,
): Record<string, string> {
  return {
    icon: iconVisible ? sym.dir : "",
    value: formatDirValue(data, config),
  };
}

export function formatDirValue(data: TuiData, config: PowerlineConfig): string {
  const raw = getDirectoryDisplay(data.hookData);
  const dirConfig = config.display.lines
    .map((line) => line.segments.directory)
    .find((d) => d?.enabled);
  const style =
    dirConfig?.style ?? (dirConfig?.showBasename ? "basename" : "fish");
  if (style === "basename") {
    const sep = raw.includes("/") ? "/" : "\\";
    return raw.split(sep).pop() || raw;
  }
  if (style === "full") return raw;
  return abbreviateFishStyle(raw);
}

export function formatVersionParts(
  data: TuiData,
  sym: SymbolSet,
  iconVisible = true,
): Record<string, string> {
  if (!data.hookData.version) return { icon: "", value: "" };
  return {
    icon: iconVisible ? sym.version : "",
    value: `v${data.hookData.version}`,
  };
}

export function formatVersionSegment(
  data: TuiData,
  sym: SymbolSet,
  iconVisible = true,
): string {
  const parts = formatVersionParts(data, sym, iconVisible);
  if (!parts.value) return "";
  return parts.icon ? `${parts.icon} ${parts.value}` : parts.value;
}

export function formatAgentParts(
  data: TuiData,
  sym: SymbolSet,
  iconVisible = true,
): Record<string, string> {
  const raw = data.hookData.agent?.name;
  if (typeof raw !== "string") return { icon: "", name: "" };
  const name = raw.trim();
  if (!name) return { icon: "", name: "" };
  return {
    icon: iconVisible ? sym.agent : "",
    name,
  };
}

export function formatAgentSegment(
  data: TuiData,
  sym: SymbolSet,
  config: PowerlineConfig,
  iconVisible = true,
): string {
  const parts = formatAgentParts(data, sym, iconVisible);
  if (!parts.name) return "";
  const agentConfig = config.display.lines
    .map((line) => line.segments.agent)
    .find((a) => a?.enabled);
  const body = agentConfig?.showLabel ? `agent: ${parts.name}` : parts.name;
  return parts.icon ? `${parts.icon} ${body}` : body;
}

function buildThinkingBody(
  data: TuiData,
  thinkingConfig: { showEnabled?: boolean; showEffort?: boolean } | undefined,
): string {
  const showEnabled = thinkingConfig?.showEnabled ?? true;
  const showEffort = thinkingConfig?.showEffort ?? true;
  if (!showEnabled && !showEffort) return "";

  const enabled = showEnabled ? getThinkingEnabled(data.hookData) : null;
  const level = showEffort ? getEffortLevel(data.hookData) : null;

  const segments: string[] = [];
  if (enabled !== null) segments.push(enabled ? "On" : "Off");
  if (level) segments.push(level);
  return segments.join(" · ");
}

export function formatThinkingParts(
  data: TuiData,
  sym: SymbolSet,
  thinkingConfig: { showEnabled?: boolean; showEffort?: boolean } | undefined,
  iconVisible = true,
): Record<string, string> {
  const showEnabled = thinkingConfig?.showEnabled ?? true;
  const showEffort = thinkingConfig?.showEffort ?? true;
  const enabled = showEnabled ? getThinkingEnabled(data.hookData) : null;
  const level = showEffort ? getEffortLevel(data.hookData) : null;

  const enabledText = enabled === null ? "" : enabled ? "On" : "Off";
  const effortText = level ?? "";
  const hasAny = enabledText !== "" || effortText !== "";
  return {
    icon: hasAny && iconVisible ? sym.thinking : "",
    enabled: enabledText,
    effort: effortText,
  };
}

export function formatThinkingSegment(
  data: TuiData,
  sym: SymbolSet,
  thinkingConfig: { showEnabled?: boolean; showEffort?: boolean } | undefined,
  iconVisible = true,
): string {
  const body = buildThinkingBody(data, thinkingConfig);
  if (!body) return "";
  return iconVisible ? `${sym.thinking} ${body}` : body;
}

export function formatCacheTimerParts(
  data: TuiData,
  sym: SymbolSet,
  iconVisible = true,
): Record<string, string> {
  if (!data.cacheTimerInfo) return { icon: "", value: "" };
  return {
    icon: iconVisible ? sym.cache_timer : "",
    value: formatCacheTimerElapsed(data.cacheTimerInfo.elapsedSeconds),
  };
}

export function formatCacheTimerSegment(
  data: TuiData,
  sym: SymbolSet,
  iconVisible = true,
): string {
  const parts = formatCacheTimerParts(data, sym, iconVisible);
  if (!parts.value) return "";
  return parts.icon ? `${parts.icon} ${parts.value}` : parts.value;
}

/** The TTL the timer colors against: configured, else detected, else the 300s default
 * of cacheTimerStyle — the same order the classic renderer uses. */
export function cacheTimerTtl(config: PowerlineConfig, data: TuiData): number | undefined {
  const configured = config.display.lines
    .map((line) => line.segments.cacheTimer)
    .find((t) => t?.enabled)?.ttlSeconds;
  return configured ?? data.cacheTimerInfo?.detectedTtlSeconds;
}

export function cacheTimerStyle(
  elapsed: number,
  colors: PowerlineColors,
  ttlSeconds = 300,
): { fg: string; bold: boolean } {
  if (elapsed >= ttlSeconds) {
    return { fg: colors.contextCriticalFg, bold: colors.contextCriticalBold };
  }
  if (elapsed >= ttlSeconds * 0.6) {
    return { fg: colors.contextWarningFg, bold: colors.contextWarningBold };
  }
  return { fg: colors.cacheTimerFg, bold: colors.cacheTimerBold };
}

export function formatTmuxParts(data: TuiData): Record<string, string> {
  if (!data.tmuxSessionId) return { label: "", value: "" };
  return { label: "tmux", value: data.tmuxSessionId };
}

export function formatTmuxSegment(data: TuiData): string {
  const parts = formatTmuxParts(data);
  if (!parts.label) return "";
  return `${parts.label}:${parts.value}`;
}

export function formatEnvParts(config: PowerlineConfig): Record<string, string> {
  const envConfig = config.display.lines
    .map((line) => line.segments.env)
    .find((env) => env?.enabled);

  if (!envConfig || !envConfig.variable) return { prefix: "", value: "" };
  const envVal = globalThis.process?.env?.[envConfig.variable];
  if (!envVal) return { prefix: "", value: "" };
  const prefix = envConfig.prefix ?? envConfig.variable;
  return { prefix: prefix || "", value: envVal };
}

export function formatEnvSegment(config: PowerlineConfig): string {
  const parts = formatEnvParts(config);
  if (!parts.value) return "";
  return parts.prefix ? `${parts.prefix}:${parts.value}` : parts.value;
}
