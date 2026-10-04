import type { ClaudeHookData } from "../utils/claude";
import { getEffortLevel, getThinkingEnabled } from "../utils/claude";
import type { PowerlineColors } from "../themes";
import type { PowerlineConfig } from "../config/loader";
import type { BlockInfo } from "./block";
import type { CacheTimerInfo } from "./cacheTimer";
import type {
  UsageInfo,
  GitInfo,
  ContextInfo,
  MetricsInfo,
} from ".";
import type { TodayInfo } from "./today";
import type { BastraInfo } from "./bastra";

import {
  formatModelName,
  abbreviateFishStyle,
  formatTimeSince,
  formatDuration,
  formatLongTimeRemaining,
  formatCacheTimerElapsed,
  formatCacheTimerRemaining,
  collapseHome,
  minutesUntilReset,
} from "../utils/formatters";

// #1039: the segment config types, the bar drawing and the shared text
// formatting live in their own modules; this class keeps one render method per
// segment and delegates to them. The types are re-exported so every import
// from "./renderer" keeps working.
import {
  plural,
  getDisplayDirectoryName,
  formatUsageWithBudget,
} from "./renderer-format";
import {
  buildBar,
  resolveBarStyleDef,
  formatPercentageWithBar,
} from "./renderer-bars";

import { shouldShowIcon } from "../utils/icon-visibility";

import type {
  SegmentConfig,
  DirectorySegmentConfig,
  GitSegmentConfig,
  UsageSegmentConfig,
  ContextSegmentConfig,
  MetricsSegmentConfig,
  BlockSegmentConfig,
  TodaySegmentConfig,
  VersionSegmentConfig,
  SessionIdSegmentConfig,
  EnvSegmentConfig,
  WeeklySegmentConfig,
  AgentSegmentConfig,
  ThinkingSegmentConfig,
  CacheTimerSegmentConfig,
  BastraSegmentConfig,
  PowerlineSymbols,
  SegmentData,
} from "./renderer-types";
export type {
  SegmentConfig,
  DirectorySegmentConfig,
  GitSegmentConfig,
  UsageSegmentConfig,
  TmuxSegmentConfig,
  BarDisplayStyle,
  ContextSegmentConfig,
  MetricsSegmentConfig,
  BlockSegmentConfig,
  TodaySegmentConfig,
  VersionSegmentConfig,
  SessionIdSegmentConfig,
  EnvSegmentConfig,
  WeeklySegmentConfig,
  AgentSegmentConfig,
  ThinkingSegmentConfig,
  CacheTimerSegmentConfig,
  BastraSegmentConfig,
  AnySegmentConfig,
  PowerlineSymbols,
  SegmentData,
} from "./renderer-types";

export class SegmentRenderer {
  constructor(
    private readonly config: PowerlineConfig,
    private readonly symbols: PowerlineSymbols,
  ) {}

  private leadingIcon(symbol: string, segConfig?: SegmentConfig): string {
    const show = shouldShowIcon(
      this.config.display?.showIcons,
      segConfig?.showIcon,
    );
    return show ? `${symbol} ` : "";
  }

  renderDirectory(
    hookData: ClaudeHookData,
    colors: PowerlineColors,
    config?: DirectorySegmentConfig,
  ): SegmentData {
    const worktreeOriginalCwd = hookData.worktree?.original_cwd || undefined;
    const currentDir =
      worktreeOriginalCwd ??
      (hookData.workspace?.current_dir || hookData.cwd || "/");
    const projectDir = worktreeOriginalCwd ?? hookData.workspace?.project_dir;

    const style = config?.style ?? (config?.showBasename ? "basename" : "full");

    if (style === "basename") {
      const basename = currentDir.split(/[\\/]/).pop() || "root";
      return {
        text: basename,
        bgColor: colors.modeBg,
        fgColor: colors.modeFg,
      };
    }

    const displayDir = collapseHome(currentDir);
    const displayProjectDir = projectDir
      ? collapseHome(projectDir)
      : projectDir;

    let dirName = getDisplayDirectoryName(displayDir, displayProjectDir);

    if (style === "fish") {
      dirName = abbreviateFishStyle(dirName);
    }

    return {
      text: dirName,
      bgColor: colors.modeBg,
      fgColor: colors.modeFg,
    };
  }

  renderGit(
    gitInfo: GitInfo,
    colors: PowerlineColors,
    config?: GitSegmentConfig,
  ): SegmentData | null {
    if (!gitInfo) return null;

    const parts: string[] = [];

    if (config?.showRepoName && gitInfo.repoName) {
      parts.push(gitInfo.repoName);
      if (gitInfo.isWorktree) {
        parts.push(this.symbols.git_worktree);
      }
    }

    if (config?.showOperation && gitInfo.operation) {
      parts.push(`[${gitInfo.operation}]`);
    }

    const showBranchIcon = shouldShowIcon(
      this.config.display?.showIcons,
      config?.showIcon,
    );
    parts.push(
      showBranchIcon
        ? `${this.symbols.branch} ${gitInfo.branch}`
        : gitInfo.branch,
    );

    if (config?.showTag && gitInfo.tag) {
      parts.push(`${this.symbols.git_tag} ${gitInfo.tag}`);
    }

    if (config?.showSha && gitInfo.sha) {
      parts.push(`${this.symbols.git_sha} ${gitInfo.sha}`);
    }

    if (config?.showAheadBehind !== false) {
      if (gitInfo.ahead > 0 && gitInfo.behind > 0) {
        parts.push(
          `${this.symbols.git_ahead}${gitInfo.ahead}${this.symbols.git_behind}${gitInfo.behind}`,
        );
      } else if (gitInfo.ahead > 0) {
        parts.push(`${this.symbols.git_ahead}${gitInfo.ahead}`);
      } else if (gitInfo.behind > 0) {
        parts.push(`${this.symbols.git_behind}${gitInfo.behind}`);
      }
    }

    if (config?.showWorkingTree) {
      const counts: string[] = [];
      if (gitInfo.staged && gitInfo.staged > 0)
        counts.push(`+${gitInfo.staged}`);
      if (gitInfo.unstaged && gitInfo.unstaged > 0)
        counts.push(`~${gitInfo.unstaged}`);
      if (gitInfo.untracked && gitInfo.untracked > 0)
        counts.push(`?${gitInfo.untracked}`);
      if (gitInfo.conflicts && gitInfo.conflicts > 0)
        counts.push(`!${gitInfo.conflicts}`);
      if (counts.length > 0) {
        parts.push(`(${counts.join(" ")})`);
      }
    }

    if (config?.showUpstream && gitInfo.upstream) {
      parts.push(`${this.symbols.git_upstream}${gitInfo.upstream}`);
    }

    if (
      config?.showStashCount &&
      gitInfo.stashCount &&
      gitInfo.stashCount > 0
    ) {
      parts.push(`${this.symbols.git_stash} ${gitInfo.stashCount}`);
    }

    if (config?.showTimeSinceCommit && gitInfo.timeSinceCommit !== undefined) {
      const time = formatTimeSince(gitInfo.timeSinceCommit);
      parts.push(`${this.symbols.git_time} ${time}`);
    }

    let gitStatusIcon = this.symbols.git_clean;
    if (gitInfo.status === "conflicts") {
      gitStatusIcon = this.symbols.git_conflicts;
    } else if (gitInfo.status === "dirty") {
      gitStatusIcon = this.symbols.git_dirty;
    } else if (gitInfo.status === "unknown") {
      gitStatusIcon = "?";
    }
    parts.push(gitStatusIcon);

    return {
      text: parts.join(" "),
      bgColor: colors.gitBg,
      fgColor: colors.gitFg,
    };
  }

  renderModel(
    hookData: ClaudeHookData,
    colors: PowerlineColors,
    config?: SegmentConfig,
  ): SegmentData {
    const rawName = hookData.model?.display_name || "Claude";
    const modelName = formatModelName(rawName);

    return {
      text: `${this.leadingIcon(this.symbols.model, config)}${modelName}`,
      bgColor: colors.modelBg,
      fgColor: colors.modelFg,
    };
  }

  renderSession(
    usageInfo: UsageInfo,
    colors: PowerlineColors,
    config?: UsageSegmentConfig,
  ): SegmentData | null {
    const type = config?.type || "cost";
    const costSource = config?.costSource;
    const sessionBudget = this.config.budget?.session;

    const getCost = () => {
      if (costSource === "calculated") return usageInfo.session.calculatedCost;
      if (costSource === "official")
        return usageInfo.session.officialCost ?? usageInfo.session.calculatedCost;
      return usageInfo.session.cost;
    };

    const formattedUsage = formatUsageWithBudget(
      getCost(),
      usageInfo.session.tokens,
      usageInfo.session.tokenBreakdown,
      type,
      sessionBudget,
      config?.showUnits ?? true,
    );

    if (formattedUsage === null) return null;

    const text = `${this.leadingIcon(this.symbols.session_cost, config)}${formattedUsage}`;

    return {
      text,
      bgColor: colors.sessionBg,
      fgColor: colors.sessionFg,
    };
  }

  renderSessionId(
    sessionId: string,
    colors: PowerlineColors,
    config?: SessionIdSegmentConfig,
  ): SegmentData {
    const showLabel = config?.showIdLabel !== false;
    const text = showLabel
      ? `${this.leadingIcon(this.symbols.session_id, config)}${sessionId}`
      : sessionId;

    return {
      text,
      bgColor: colors.sessionBg,
      fgColor: colors.sessionFg,
    };
  }

  renderTmux(
    sessionId: string | null,
    colors: PowerlineColors,
  ): SegmentData | null {
    if (!sessionId) {
      return {
        text: `tmux:none`,
        bgColor: colors.tmuxBg,
        fgColor: colors.tmuxFg,
      };
    }

    return {
      text: `tmux:${sessionId}`,
      bgColor: colors.tmuxBg,
      fgColor: colors.tmuxFg,
    };
  }

  renderContext(
    contextInfo: ContextInfo | null,
    colors: PowerlineColors,
    config?: ContextSegmentConfig,
  ): SegmentData | null {
    const barLength = 10;
    const style = config?.displayStyle ?? "text";
    const defaultMode = style === "text" ? "remaining" : "used";
    const mode = config?.percentageMode ?? defaultMode;

    const barStyleDef = resolveBarStyleDef(this.symbols, style);

    const emptyPct = mode === "remaining" ? "100%" : "0%";
    if (!contextInfo) {
      if (barStyleDef) {
        const emptyBar =
          mode === "remaining"
            ? buildBar(barStyleDef, barLength, 0, barLength)
            : barStyleDef.empty.repeat(barLength);
        return {
          text: `${emptyBar} ${emptyPct}`,
          bgColor: colors.contextBg,
          fgColor: colors.contextFg,
        };
      }
      return {
        text: `${this.leadingIcon(this.symbols.context_time, config)}0 (${emptyPct})`,
        bgColor: colors.contextBg,
        fgColor: colors.contextFg,
      };
    }

    let bgColor = colors.contextBg;
    let fgColor = colors.contextFg;
    let bold = colors.contextBold;

    if (contextInfo.contextLeftPercentage <= 20) {
      bgColor = colors.contextCriticalBg;
      fgColor = colors.contextCriticalFg;
      bold = colors.contextCriticalBold;
    } else if (contextInfo.contextLeftPercentage <= 40) {
      bgColor = colors.contextWarningBg;
      fgColor = colors.contextWarningFg;
      bold = colors.contextWarningBold;
    }

    const pct =
      mode === "remaining"
        ? contextInfo.contextLeftPercentage
        : contextInfo.usablePercentage;
    const filledCount = Math.round(
      (pct / 100) * barLength,
    );
    const emptyCount = barLength - filledCount;

    if (barStyleDef) {
      const bar = buildBar(
        barStyleDef,
        filledCount,
        emptyCount,
        barLength,
      );

      const text = config?.showPercentageOnly
        ? `${bar} ${pct}%`
        : `${bar} ${contextInfo.totalTokens.toLocaleString()} (${pct}%)`;

      return { text, bgColor, fgColor, bold };
    }

    const iconPrefix = this.leadingIcon(this.symbols.context_time, config);
    const text = config?.showPercentageOnly
      ? `${iconPrefix}${pct}%`
      : `${iconPrefix}${contextInfo.totalTokens.toLocaleString()} (${pct}%)`;

    return { text, bgColor, fgColor, bold };
  }

  renderMetrics(
    metricsInfo: MetricsInfo | null,
    colors: PowerlineColors,
    config?: MetricsSegmentConfig,
  ): SegmentData | null {
    if (!metricsInfo) {
      return {
        text: `${this.symbols.metrics_response} new`,
        bgColor: colors.metricsBg,
        fgColor: colors.metricsFg,
      };
    }

    const parts: string[] = [];

    if (config?.showLastResponseTime && metricsInfo.lastResponseTime !== null) {
      const lastResponseTime =
        metricsInfo.lastResponseTime < 60
          ? `${metricsInfo.lastResponseTime.toFixed(1)}s`
          : `${(metricsInfo.lastResponseTime / 60).toFixed(1)}m`;
      parts.push(`${this.symbols.metrics_last_response} ${lastResponseTime}`);
    }

    if (
      config?.showResponseTime !== false &&
      metricsInfo.responseTime !== null
    ) {
      const responseTime =
        metricsInfo.responseTime < 60
          ? `${metricsInfo.responseTime.toFixed(1)}s`
          : `${(metricsInfo.responseTime / 60).toFixed(1)}m`;
      parts.push(`${this.symbols.metrics_response} ${responseTime}`);
    }

    if (
      config?.showDuration !== false &&
      metricsInfo.sessionDuration !== null
    ) {
      const duration = formatDuration(metricsInfo.sessionDuration);
      parts.push(`${this.symbols.metrics_duration} ${duration}`);
    }

    if (
      config?.showMessageCount !== false &&
      metricsInfo.messageCount !== null
    ) {
      parts.push(
        `${this.symbols.metrics_messages} ${metricsInfo.messageCount}`,
      );
    }

    if (
      config?.showLinesAdded !== false &&
      metricsInfo.linesAdded !== null &&
      metricsInfo.linesAdded > 0
    ) {
      parts.push(
        `${this.symbols.metrics_lines_added} ${metricsInfo.linesAdded}`,
      );
    }

    if (
      config?.showLinesRemoved !== false &&
      metricsInfo.linesRemoved !== null &&
      metricsInfo.linesRemoved > 0
    ) {
      parts.push(
        `${this.symbols.metrics_lines_removed} ${metricsInfo.linesRemoved}`,
      );
    }

    if (parts.length === 0) {
      return {
        text: `${this.symbols.metrics_response} active`,
        bgColor: colors.metricsBg,
        fgColor: colors.metricsFg,
      };
    }

    return {
      text: parts.join(" "),
      bgColor: colors.metricsBg,
      fgColor: colors.metricsFg,
    };
  }

  renderBlock(
    blockInfo: BlockInfo,
    colors: PowerlineColors,
    config?: BlockSegmentConfig,
  ): SegmentData {
    const pct = Math.round(blockInfo.nativeUtilization);
    const timeStr = formatLongTimeRemaining(blockInfo.timeRemaining);
    const blockBudget = this.config.budget?.block;
    const warningThreshold = blockBudget?.warningThreshold ?? 80;

    let bgColor = colors.blockBg;
    let fgColor = colors.blockFg;
    let bold = colors.blockBold;
    if (pct >= warningThreshold) {
      bgColor = colors.contextCriticalBg;
      fgColor = colors.contextCriticalFg;
      bold = colors.contextCriticalBold;
    } else if (pct >= 50) {
      bgColor = colors.contextWarningBg;
      fgColor = colors.contextWarningFg;
      bold = colors.contextWarningBold;
    }

    return {
      text: `${this.leadingIcon(this.symbols.block_cost, config)}${formatPercentageWithBar(this.symbols, pct, config?.displayStyle, timeStr)}`,
      bgColor,
      fgColor,
      bold,
    };
  }

  renderWeekly(
    hookData: ClaudeHookData,
    colors: PowerlineColors,
    config?: WeeklySegmentConfig,
  ): SegmentData | null {
    const sevenDay = hookData.rate_limits?.seven_day;
    if (!sevenDay) return null;

    const pct = Math.round(sevenDay.used_percentage);
    const timeStr = formatLongTimeRemaining(
      minutesUntilReset(sevenDay.resets_at),
    );

    let bgColor = colors.weeklyBg;
    let fgColor = colors.weeklyFg;
    let bold = colors.weeklyBold;
    if (pct >= 80) {
      bgColor = colors.contextCriticalBg;
      fgColor = colors.contextCriticalFg;
      bold = colors.contextCriticalBold;
    } else if (pct >= 50) {
      bgColor = colors.contextWarningBg;
      fgColor = colors.contextWarningFg;
      bold = colors.contextWarningBold;
    }

    return {
      text: `${this.leadingIcon(this.symbols.weekly_cost, config)}${formatPercentageWithBar(this.symbols, pct, config?.displayStyle, timeStr)}`,
      bgColor,
      fgColor,
      bold,
    };
  }

  renderToday(
    todayInfo: TodayInfo,
    colors: PowerlineColors,
    configOrType?: TodaySegmentConfig | string,
  ): SegmentData | null {
    const config: TodaySegmentConfig | undefined =
      typeof configOrType === "string"
        ? ({ enabled: true, type: configOrType } as TodaySegmentConfig)
        : configOrType;
    const type = config?.type ?? "cost";
    const todayBudget = this.config.budget?.today;
    const formattedUsage = formatUsageWithBudget(
      todayInfo.cost,
      todayInfo.tokens,
      todayInfo.tokenBreakdown,
      type,
      todayBudget,
      config?.showUnits ?? true,
    );

    if (formattedUsage === null) return null;

    const text = `${this.leadingIcon(this.symbols.today_cost, config)}${formattedUsage}`;

    return {
      text,
      bgColor: colors.todayBg,
      fgColor: colors.todayFg,
    };
  }

  renderVersion(
    hookData: ClaudeHookData,
    colors: PowerlineColors,
    config?: VersionSegmentConfig,
  ): SegmentData | null {
    if (!hookData.version) {
      return null;
    }

    return {
      text: `${this.leadingIcon(this.symbols.version, config)}v${hookData.version}`,
      bgColor: colors.versionBg,
      fgColor: colors.versionFg,
    };
  }

  renderEnv(
    colors: PowerlineColors,
    config: EnvSegmentConfig,
  ): SegmentData | null {
    const value = globalThis.process?.env?.[config.variable];
    if (!value) return null;
    const prefix = config.prefix ?? config.variable;
    const iconPrefix = this.leadingIcon(this.symbols.env, config);
    const text = prefix
      ? `${iconPrefix}${prefix}: ${value}`
      : `${iconPrefix}${value}`;
    return { text, bgColor: colors.envBg, fgColor: colors.envFg };
  }

  renderAgent(
    hookData: ClaudeHookData,
    colors: PowerlineColors,
    config?: AgentSegmentConfig,
  ): SegmentData | null {
    const rawName = hookData.agent?.name;
    if (typeof rawName !== "string") return null;
    const name = rawName.trim();
    if (!name) return null;

    const iconPrefix = this.leadingIcon(this.symbols.agent, config);
    const body = config?.showLabel ? `agent: ${name}` : name;

    return {
      text: `${iconPrefix}${body}`,
      bgColor: colors.agentBg,
      fgColor: colors.agentFg,
    };
  }

  renderThinking(
    hookData: ClaudeHookData,
    colors: PowerlineColors,
    config?: ThinkingSegmentConfig,
  ): SegmentData | null {
    const showEnabled = config?.showEnabled ?? true;
    const showEffort = config?.showEffort ?? true;
    if (!showEnabled && !showEffort) return null;

    const enabled = showEnabled ? getThinkingEnabled(hookData) : null;
    const level = showEffort ? getEffortLevel(hookData) : null;

    const parts: string[] = [];
    if (enabled !== null) parts.push(enabled ? "On" : "Off");
    if (level) parts.push(level);
    if (parts.length === 0) return null;

    const iconPrefix = this.leadingIcon(this.symbols.thinking, config);
    return {
      text: `${iconPrefix}${parts.join(" · ")}`,
      bgColor: colors.thinkingBg,
      fgColor: colors.thinkingFg,
    };
  }

  renderCacheTimer(
    info: CacheTimerInfo,
    colors: PowerlineColors,
    config?: CacheTimerSegmentConfig,
  ): SegmentData {
    const e = info.elapsedSeconds;
    const iconPrefix = this.leadingIcon(this.symbols.cache_timer, config);

    let bgColor = colors.cacheTimerBg;
    let fgColor = colors.cacheTimerFg;
    let bold = colors.cacheTimerBold;

    if (config?.displayMode === "remaining") {
      const ttl = config.ttlSeconds ?? info.detectedTtlSeconds ?? 3600;
      const remaining = Math.max(0, ttl - e);
      const text = `${iconPrefix}${formatCacheTimerRemaining(remaining)}`;
      if (remaining < 60) {
        bgColor = colors.contextCriticalBg;
        fgColor = colors.contextCriticalFg;
        bold = colors.contextCriticalBold;
      } else if (remaining < 300) {
        bgColor = colors.contextWarningBg;
        fgColor = colors.contextWarningFg;
        bold = colors.contextWarningBold;
      }
      return { text, bgColor, fgColor, bold };
    }

    const text = `${iconPrefix}${formatCacheTimerElapsed(e)}`;
    const ttl = config?.ttlSeconds ?? info.detectedTtlSeconds ?? 300;
    if (e >= ttl) {
      bgColor = colors.contextCriticalBg;
      fgColor = colors.contextCriticalFg;
      bold = colors.contextCriticalBold;
    } else if (e >= ttl * 0.6) {
      bgColor = colors.contextWarningBg;
      fgColor = colors.contextWarningFg;
      bold = colors.contextWarningBold;
    }

    return { text, bgColor, fgColor, bold };
  }

  renderBastra(
    info: BastraInfo | null,
    colors: PowerlineColors,
    config?: BastraSegmentConfig,
  ): SegmentData | null {
    if (!info) return null;

    const icon = this.leadingIcon(this.symbols.bastra, config);
    let text: string;

    if (info.state === "idle" || info.recallCount === 0) {
      text = `${icon}bastra · ${info.vaultSize} memories`;
    } else if (info.currentStage && info.currentStageStartedAt) {
      // Active recall: live total = accumulated + the running recall's elapsed.
      const live =
        info.currentRecallStartedAt !== null
          ? info.totalMs + Math.max(0, Date.now() - info.currentRecallStartedAt)
          : info.totalMs;
      // Prefer the human-readable banter phrase; fall back to the raw stage
      // name (banter off, or older feed without current_message).
      const label = info.currentMessage ?? info.currentStage;
      text = `${icon}bastra · ${plural(info.recallCount, "call", "calls")} · ${plural(info.totalHits, "hit", "hits")} · ${live}ms · ${label}`;
    } else {
      // Between/after recalls in this turn — done snapshot. The running-state
      // phrase is too brief (~120ms) for the ≥1s statusline refresh to catch,
      // so the forwarder persists a done phrase here; show it for a short TTL,
      // then fall back to the bare banner.
      const PHRASE_TTL_MS = 10_000;
      const showPhrase =
        info.lastPhrase !== null &&
        info.lastPhraseAt !== null &&
        Date.now() - info.lastPhraseAt < PHRASE_TTL_MS;
      const tail = showPhrase ? ` · ${info.lastPhrase}` : "";
      // hits come from recalls only; ms from any tool call. Show each only
      // when present, so load_memory-only turns read "N calls · Xms" (no hits).
      const hits = info.totalHits > 0 ? ` · ${plural(info.totalHits, "hit", "hits")}` : "";
      const ms = info.totalMs > 0 ? ` · ${info.totalMs}ms` : "";
      text = `${icon}✓ bastra · ${plural(info.recallCount, "call", "calls")}${hits}${ms}${tail}`;
    }

    return {
      text,
      bgColor: colors.bastraBg,
      fgColor: colors.bastraFg,
      bold: colors.bastraBold,
    };
  }
}
