import { dropUnreadableRateLimits, type ClaudeHookData } from "./utils/claude";
import type { PowerlineConfig, LineConfig } from "./config/loader";
import type {
  UsageInfo,
  ContextInfo,
  MetricsInfo,
  PowerlineSymbols,
  AnySegmentConfig,
  ContextSegmentConfig,
} from "./segments";
import type { BlockInfo } from "./segments/block";
import type { TodayInfo } from "./segments/today";
import type { CacheTimerInfo } from "./segments/cacheTimer";
import type { TuiData } from "./tui";
import type { RenderedSegment } from "./powerline-layout";

import { BOX_CHARS, BOX_CHARS_TEXT } from "./utils/constants";
import { getTerminalWidth, getRawTerminalWidth } from "./utils/terminal-width";
import { renderTuiPanel } from "./tui";
import { PowerlineTheme } from "./powerline-theme";
import { PowerlineSegments } from "./powerline-segments";
import { PowerlineLayout } from "./powerline-layout";

/**
 * Renders the statusline for one hook tick. Since #1039 the work is split
 * over three collaborators: PowerlineTheme (glyphs, colours), PowerlineSegments
 * (data providers, per-segment dispatch) and PowerlineLayout (measuring,
 * wrapping, ANSI line assembly). This class keeps the flow: which data to
 * fetch, which lines to render, and the TUI hand-over.
 */
export class PowerlineRenderer {
  private readonly symbols: PowerlineSymbols;
  private readonly theme: PowerlineTheme;
  private readonly segments: PowerlineSegments;
  private readonly layout: PowerlineLayout;

  constructor(private readonly config: PowerlineConfig) {
    this.theme = new PowerlineTheme(config);
    this.symbols = this.theme.initializeSymbols();
    this.segments = new PowerlineSegments(config, this.symbols);
    this.layout = new PowerlineLayout(config, this.symbols, this.theme);
  }

  async generateStatusline(rawHookData: ClaudeHookData): Promise<string> {
    const hookData = dropUnreadableRateLimits(rawHookData);
    if (this.config.display.style === "tui") {
      return this.generateTuiStatusline(hookData);
    }

    const usageInfo = this.segments.needsSegmentInfo("session")
      ? await this.segments.usageProvider.getUsageInfo(hookData.session_id, hookData)
      : null;

    const blockInfo = this.segments.needsSegmentInfo("block")
      ? await this.segments.blockProvider.getActiveBlockInfo(hookData)
      : null;

    const todayInfo = this.segments.needsSegmentInfo("today")
      ? await this.segments.todayProvider.getTodayInfo()
      : null;

    const contextSegmentConfig = this.config.display.lines
      .map((line) => line.segments.context)
      .find((c) => c?.enabled) as ContextSegmentConfig | undefined;
    const autocompactBuffer = contextSegmentConfig?.autocompactBuffer ?? 33000;
    const contextInfo = this.segments.needsSegmentInfo("context")
      ? await this.segments.contextProvider.getContextInfo(hookData, autocompactBuffer)
      : null;

    const metricsInfo = this.segments.needsSegmentInfo("metrics")
      ? await this.segments.metricsProvider.getMetricsInfo(hookData.session_id, hookData)
      : null;

    const cacheTimerInfo = this.segments.needsSegmentInfo("cacheTimer")
      ? await this.segments.cacheTimerProvider.getCacheTimerInfo(hookData)
      : null;

    if (this.config.display.autoWrap) {
      return this.generateAutoWrapStatusline(
        hookData,
        usageInfo,
        blockInfo,
        todayInfo,
        contextInfo,
        metricsInfo,
        cacheTimerInfo,
      );
    }

    const lines = await Promise.all(
      this.config.display.lines.map((lineConfig) =>
        this.renderLine(
          lineConfig,
          hookData,
          usageInfo,
          blockInfo,
          todayInfo,
          contextInfo,
          metricsInfo,
          cacheTimerInfo,
        ),
      ),
    );

    return lines.filter((line) => line.length > 0).join("\n");
  }

  private async generateAutoWrapStatusline(
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    blockInfo: BlockInfo | null,
    todayInfo: TodayInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    cacheTimerInfo: CacheTimerInfo | null,
  ): Promise<string> {
    const colors = this.theme.getThemeColors();
    const currentDir = hookData.workspace?.current_dir || hookData.cwd || "/";
    const terminalWidth = getTerminalWidth();

    const outputLines: string[] = [];

    for (const lineConfig of this.config.display.lines) {
      const segments = Object.entries(lineConfig.segments)
        .filter(
          ([_, config]: [string, AnySegmentConfig | undefined]) =>
            config?.enabled,
        )
        .map(([type, config]: [string, AnySegmentConfig]) => ({
          type,
          config,
        }));

      const renderedSegments: RenderedSegment[] = [];
      for (const segment of segments) {
        const segmentData = await this.segments.renderSegment(
          segment,
          hookData,
          usageInfo,
          blockInfo,
          todayInfo,
          contextInfo,
          metricsInfo,
          cacheTimerInfo,
          colors,
          currentDir,
        );

        if (segmentData) {
          renderedSegments.push({
            type: segment.type,
            text: segmentData.text,
            bgColor: segmentData.bgColor,
            fgColor: segmentData.fgColor,
            bold: segmentData.bold,
          });
        }
      }

      if (renderedSegments.length === 0) continue;

      outputLines.push(
        ...this.layout.wrapSegments(renderedSegments, terminalWidth, colors),
      );
    }

    return outputLines.join("\n");
  }

  private async generateTuiStatusline(
    hookData: ClaudeHookData,
  ): Promise<string> {
    const colors = this.theme.getThemeColors();
    const terminalWidth = getTerminalWidth();
    const currentDir = hookData.workspace?.current_dir || hookData.cwd || "/";
    const charset = this.config.display.charset || "unicode";
    const boxChars = charset === "text" ? BOX_CHARS_TEXT : BOX_CHARS;
    const contextSegmentConfig = this.config.display.lines
      .map((line) => line.segments.context)
      .find((c) => c?.enabled) as ContextSegmentConfig | undefined;
    const autocompactBuffer = contextSegmentConfig?.autocompactBuffer ?? 33000;

    const results = await Promise.allSettled([
      this.segments.usageProvider.getUsageInfo(hookData.session_id, hookData),
      this.segments.blockProvider.getActiveBlockInfo(hookData),
      this.segments.todayProvider.getTodayInfo(),
      this.segments.contextProvider.getContextInfo(hookData, autocompactBuffer),
      this.segments.metricsProvider.getMetricsInfo(hookData.session_id, hookData),
      this.segments.gitService.getGitInfo(
        currentDir,
        {
          showSha: false,
          showWorkingTree: true,
          showOperation: false,
          showTag: false,
          showTimeSinceCommit: false,
          showStashCount: false,
          showUpstream: false,
          showRepoName: false,
        },
        hookData.workspace?.project_dir,
      ),
      this.segments.tmuxService.getSessionId(),
      this.segments.cacheTimerProvider.getCacheTimerInfo(hookData),
    ]);
    const val = <T>(r: PromiseSettledResult<T>) =>
      r.status === "fulfilled" ? r.value : null;
    const [
      usageInfo,
      blockInfo,
      todayInfo,
      contextInfo,
      metricsInfo,
      gitInfo,
      tmuxSessionId,
      cacheTimerInfo,
    ] = [
      val(results[0]!),
      val(results[1]!),
      val(results[2]!),
      val(results[3]!),
      val(results[4]!),
      val(results[5]!),
      val(results[6]!),
      val(results[7]!),
    ] as const;

    const tuiData: TuiData = {
      hookData,
      usageInfo,
      blockInfo,
      todayInfo,
      contextInfo,
      metricsInfo,
      gitInfo,
      cacheTimerInfo,
      bastraInfo: this.segments.bastraProvider.getBastraInfo(), // #53: TUI parity
      tmuxSessionId,
      colors,
    };

    return renderTuiPanel(
      tuiData,
      boxChars,
      colors.reset,
      terminalWidth,
      this.config,
      { rawTerminalWidth: getRawTerminalWidth() },
    );
  }


  private async renderLine(
    lineConfig: LineConfig,
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    blockInfo: BlockInfo | null,
    todayInfo: TodayInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    cacheTimerInfo: CacheTimerInfo | null,
  ): Promise<string> {
    const colors = this.theme.getThemeColors();
    const currentDir = hookData.workspace?.current_dir || hookData.cwd || "/";

    const segments = Object.entries(lineConfig.segments)
      .filter(
        ([_, config]: [string, AnySegmentConfig | undefined]) =>
          config?.enabled,
      )
      .map(([type, config]: [string, AnySegmentConfig]) => ({ type, config }));

    const renderedSegments: RenderedSegment[] = [];
    for (const segment of segments) {
      const segmentData = await this.segments.renderSegment(
        segment,
        hookData,
        usageInfo,
        blockInfo,
        todayInfo,
        contextInfo,
        metricsInfo,
        cacheTimerInfo,
        colors,
        currentDir,
      );

      if (segmentData) {
        renderedSegments.push({
          type: segment.type,
          text: segmentData.text,
          bgColor: segmentData.bgColor,
          fgColor: segmentData.fgColor,
          bold: segmentData.bold,
        });
      }
    }

    return this.layout.buildLineFromSegments(renderedSegments, colors);
  }
}
