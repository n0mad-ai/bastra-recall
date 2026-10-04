import type { PowerlineColors, ColorTheme } from "./themes";
import type { PowerlineConfig } from "./config/loader";
import type { PowerlineSymbols } from "./segments";

import {
  hexToAnsi,
  hexToBasicAnsi,
  hexTo256Ansi,
  hexColorDistance,
} from "./utils/colors";
import { getColorSupport } from "./utils/color-support";
import { getTheme } from "./themes";
import { SYMBOLS, TEXT_SYMBOLS, RESET_CODE } from "./utils/constants";

/**
 * Glyph and colour theming for PowerlineRenderer (#1039): the separator and
 * icon set for the configured style/charset, the theme resolved to ANSI
 * escape codes for the detected colour depth, and the per-segment-type
 * colour lookups.
 */
export class PowerlineTheme {
  constructor(private readonly config: PowerlineConfig) {}

  initializeSymbols(): PowerlineSymbols {
    const style = this.config.display.style;
    const charset = this.config.display.charset || "unicode";
    const isMinimalStyle = style === "minimal";
    const isCapsuleStyle = style === "capsule";
    const symbolSet = charset === "text" ? TEXT_SYMBOLS : SYMBOLS;

    return {
      right: isMinimalStyle
        ? ""
        : isCapsuleStyle
          ? symbolSet.right_rounded
          : symbolSet.right,
      left: isCapsuleStyle ? symbolSet.left_rounded : "",
      branch: symbolSet.branch,
      model: symbolSet.model,
      git_clean: symbolSet.git_clean,
      git_dirty: symbolSet.git_dirty,
      git_conflicts: symbolSet.git_conflicts,
      git_ahead: symbolSet.git_ahead,
      git_behind: symbolSet.git_behind,
      git_worktree: symbolSet.git_worktree,
      git_tag: symbolSet.git_tag,
      git_sha: symbolSet.git_sha,
      git_upstream: symbolSet.git_upstream,
      git_stash: symbolSet.git_stash,
      git_time: symbolSet.git_time,
      session_cost: symbolSet.session_cost,
      block_cost: symbolSet.block_cost,
      today_cost: symbolSet.today_cost,
      context_time: symbolSet.context_time,
      metrics_response: symbolSet.metrics_response,
      metrics_last_response: symbolSet.metrics_last_response,
      metrics_duration: symbolSet.metrics_duration,
      metrics_messages: symbolSet.metrics_messages,
      metrics_lines_added: symbolSet.metrics_lines_added,
      metrics_lines_removed: symbolSet.metrics_lines_removed,
      metrics_burn: symbolSet.metrics_burn,
      version: symbolSet.version,
      bar_filled: symbolSet.bar_filled,
      bar_empty: symbolSet.bar_empty,
      env: symbolSet.env,
      session_id: symbolSet.session_id,
      weekly_cost: symbolSet.weekly_cost,
      agent: symbolSet.agent,
      thinking: symbolSet.thinking,
      cache_timer: symbolSet.cache_timer,
      bastra: symbolSet.bastra,
    };
  }

  getThemeColors(): PowerlineColors {
    const theme = this.config.theme;
    let colorTheme;

    const colorMode = this.config.display.colorCompatibility || "auto";
    const colorSupport = colorMode === "auto" ? getColorSupport() : colorMode;

    if (theme === "custom") {
      colorTheme = this.config.colors?.custom;
      if (!colorTheme) {
        throw new Error(
          "Custom theme selected but no colors provided in configuration",
        );
      }
    } else {
      colorTheme = getTheme(theme, colorSupport);
      if (!colorTheme) {
        console.warn(
          `Built-in theme '${theme}' not found, falling back to 'dark' theme`,
        );
        colorTheme = getTheme("dark", colorSupport)!;
      }
    }

    const convertHex = (hex: string, isBg: boolean): string => {
      if (colorSupport === "none") return "";
      if (colorSupport === "ansi") return hexToBasicAnsi(hex, isBg);
      if (colorSupport === "ansi256") return hexTo256Ansi(hex, isBg);
      return hexToAnsi(hex, isBg);
    };

    const fallbackTheme = getTheme("dark", colorSupport)!;

    const isTui = this.config.display.style === "tui";
    const isLightTheme = theme === "light";
    const terminalRef = isLightTheme ? "#f0f0f0" : "#1e1e1e";

    const getSegmentColors = (segment: Exclude<keyof ColorTheme, "tui">) => {
      const fallback = fallbackTheme[segment];
      const custom = colorTheme[segment];
      const colors = {
        fg: custom?.fg || fallback.fg,
        bg: custom?.bg || fallback.bg,
      };

      let fgHex = colors.fg;
      if (isTui && hexColorDistance(fgHex, terminalRef) < 60) {
        fgHex = colors.bg;
      }

      const bold =
        colorSupport !== "none" && Boolean(custom?.bold ?? fallback.bold);

      return {
        bg: convertHex(colors.bg, true),
        fg: convertHex(fgHex, false),
        bold,
      };
    };

    const directory = getSegmentColors("directory");
    const git = getSegmentColors("git");
    const model = getSegmentColors("model");
    const session = getSegmentColors("session");
    const block = getSegmentColors("block");
    const today = getSegmentColors("today");
    const tmux = getSegmentColors("tmux");
    const context = getSegmentColors("context");
    const contextWarning = getSegmentColors("contextWarning");
    const contextCritical = getSegmentColors("contextCritical");
    const metrics = getSegmentColors("metrics");
    const version = getSegmentColors("version");
    const env = getSegmentColors("env");
    const weekly = getSegmentColors("weekly");
    const agent = getSegmentColors("agent");
    const thinking = getSegmentColors("thinking");
    const cacheTimer = getSegmentColors("cacheTimer");

    // bastra brand color — fixed across all themes (not theme-derived), so
    // the bastra segment is always recognizable. White fg on bastra purple.
    const bastra = {
      bg: convertHex("#7c3aed", true),
      fg: convertHex("#ffffff", false),
      bold: colorSupport !== "none",
    };

    return {
      reset: colorSupport === "none" ? "" : RESET_CODE,
      modeBg: directory.bg,
      modeFg: directory.fg,
      modeBold: directory.bold,
      gitBg: git.bg,
      gitFg: git.fg,
      gitBold: git.bold,
      modelBg: model.bg,
      modelFg: model.fg,
      modelBold: model.bold,
      sessionBg: session.bg,
      sessionFg: session.fg,
      sessionBold: session.bold,
      blockBg: block.bg,
      blockFg: block.fg,
      blockBold: block.bold,
      todayBg: today.bg,
      todayFg: today.fg,
      todayBold: today.bold,
      tmuxBg: tmux.bg,
      tmuxFg: tmux.fg,
      tmuxBold: tmux.bold,
      contextBg: context.bg,
      contextFg: context.fg,
      contextBold: context.bold,
      contextWarningBg: contextWarning.bg,
      contextWarningFg: contextWarning.fg,
      contextWarningBold: contextWarning.bold,
      contextCriticalBg: contextCritical.bg,
      contextCriticalFg: contextCritical.fg,
      contextCriticalBold: contextCritical.bold,
      metricsBg: metrics.bg,
      metricsFg: metrics.fg,
      metricsBold: metrics.bold,
      versionBg: version.bg,
      versionFg: version.fg,
      versionBold: version.bold,
      envBg: env.bg,
      envFg: env.fg,
      envBold: env.bold,
      weeklyBg: weekly.bg,
      weeklyFg: weekly.fg,
      weeklyBold: weekly.bold,
      agentBg: agent.bg,
      agentFg: agent.fg,
      agentBold: agent.bold,
      thinkingBg: thinking.bg,
      thinkingFg: thinking.fg,
      thinkingBold: thinking.bold,
      cacheTimerBg: cacheTimer.bg,
      cacheTimerFg: cacheTimer.fg,
      cacheTimerBold: cacheTimer.bold,
      bastraBg: bastra.bg,
      bastraFg: bastra.fg,
      bastraBold: bastra.bold,
      partFg: theme === "custom" ? this.resolvePartColors(convertHex) : {},
    };
  }

  private resolvePartColors(
    convertHex: (hex: string, isBg: boolean) => string,
  ): Record<string, string> {
    const custom = this.config.colors?.custom as
      | Record<string, { fg?: string }>
      | undefined;
    if (!custom) return {};

    const result: Record<string, string> = {};
    for (const key of Object.keys(custom)) {
      const entry = custom[key];
      if (!entry?.fg) continue;
      result[key] = convertHex(entry.fg, false);
    }
    return result;
  }

  private getSegmentBgColor(
    segmentType: string,
    colors: PowerlineColors,
  ): string {
    switch (segmentType) {
      case "directory":
        return colors.modeBg;
      case "git":
        return colors.gitBg;
      case "model":
        return colors.modelBg;
      case "session":
      case "sessionId":
        return colors.sessionBg;
      case "block":
        return colors.blockBg;
      case "today":
        return colors.todayBg;
      case "tmux":
        return colors.tmuxBg;
      case "context":
        return colors.contextBg;
      case "metrics":
        return colors.metricsBg;
      case "version":
        return colors.versionBg;
      case "env":
        return colors.envBg;
      case "weekly":
        return colors.weeklyBg;
      case "agent":
        return colors.agentBg;
      case "thinking":
        return colors.thinkingBg;
      case "cacheTimer":
        return colors.cacheTimerBg;
      case "bastra":
        return colors.bastraBg;
      default:
        return colors.modeBg;
    }
  }

  getSegmentBoldFlag(
    segmentType: string,
    colors: PowerlineColors,
  ): boolean {
    switch (segmentType) {
      case "directory":
        return colors.modeBold;
      case "git":
        return colors.gitBold;
      case "model":
        return colors.modelBold;
      case "session":
      case "sessionId":
        return colors.sessionBold;
      case "block":
        return colors.blockBold;
      case "today":
        return colors.todayBold;
      case "tmux":
        return colors.tmuxBold;
      case "context":
        return colors.contextBold;
      case "metrics":
        return colors.metricsBold;
      case "version":
        return colors.versionBold;
      case "env":
        return colors.envBold;
      case "weekly":
        return colors.weeklyBold;
      case "agent":
        return colors.agentBold;
      case "thinking":
        return colors.thinkingBold;
      case "cacheTimer":
        return colors.cacheTimerBold;
      case "bastra":
        return colors.bastraBold;
      default:
        return colors.modeBold;
    }
  }
}
