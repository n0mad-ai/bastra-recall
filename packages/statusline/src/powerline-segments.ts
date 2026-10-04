import type { ClaudeHookData } from "./utils/claude";
import type { PowerlineColors } from "./themes";
import type { PowerlineConfig, LineConfig } from "./config/loader";
import type {
  UsageInfo,
  ContextInfo,
  MetricsInfo,
  PowerlineSymbols,
  AnySegmentConfig,
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
} from "./segments";
import type { BlockInfo } from "./segments/block";
import type { TodayInfo } from "./segments/today";
import type { CacheTimerInfo } from "./segments/cacheTimer";

import {
  UsageProvider,
  ContextProvider,
  GitService,
  TmuxService,
  MetricsProvider,
  SegmentRenderer,
} from "./segments";
import { BlockProvider } from "./segments/block";
import { TodayProvider } from "./segments/today";
import { CacheTimerProvider } from "./segments/cacheTimer";
import { BastraProvider } from "./segments/bastra";
import type { BastraSegmentConfig } from "./segments/renderer";

/**
 * Segment data for PowerlineRenderer (#1039): the lazily created data
 * providers, and the dispatch from a configured segment to its renderer in
 * SegmentRenderer, including which data each segment needs.
 */
export class PowerlineSegments {
  private _usageProvider?: UsageProvider;
  private _blockProvider?: BlockProvider;
  private _todayProvider?: TodayProvider;
  private _contextProvider?: ContextProvider;
  private _gitService?: GitService;
  private _tmuxService?: TmuxService;
  private _metricsProvider?: MetricsProvider;
  private _cacheTimerProvider?: CacheTimerProvider;
  private _bastraProvider?: BastraProvider;
  private _segmentRenderer?: SegmentRenderer;

  constructor(
    private readonly config: PowerlineConfig,
    private readonly symbols: PowerlineSymbols,
  ) {}

  get usageProvider(): UsageProvider {
    if (!this._usageProvider) {
      this._usageProvider = new UsageProvider();
    }
    return this._usageProvider;
  }

  get blockProvider(): BlockProvider {
    if (!this._blockProvider) {
      this._blockProvider = new BlockProvider();
    }
    return this._blockProvider;
  }

  get todayProvider(): TodayProvider {
    if (!this._todayProvider) {
      this._todayProvider = new TodayProvider();
    }
    return this._todayProvider;
  }

  get contextProvider(): ContextProvider {
    if (!this._contextProvider) {
      this._contextProvider = new ContextProvider(this.config);
    }
    return this._contextProvider;
  }

  get gitService(): GitService {
    if (!this._gitService) {
      this._gitService = new GitService();
    }
    return this._gitService;
  }

  get tmuxService(): TmuxService {
    if (!this._tmuxService) {
      this._tmuxService = new TmuxService();
    }
    return this._tmuxService;
  }

  get metricsProvider(): MetricsProvider {
    if (!this._metricsProvider) {
      this._metricsProvider = new MetricsProvider();
    }
    return this._metricsProvider;
  }

  get cacheTimerProvider(): CacheTimerProvider {
    if (!this._cacheTimerProvider) {
      this._cacheTimerProvider = new CacheTimerProvider();
    }
    return this._cacheTimerProvider;
  }

  get bastraProvider(): BastraProvider {
    if (!this._bastraProvider) {
      this._bastraProvider = new BastraProvider();
    }
    return this._bastraProvider;
  }

  private get segmentRenderer(): SegmentRenderer {
    if (!this._segmentRenderer) {
      this._segmentRenderer = new SegmentRenderer(this.config, this.symbols);
    }
    return this._segmentRenderer;
  }

  needsSegmentInfo(segmentType: keyof LineConfig["segments"]): boolean {
    return this.config.display.lines.some(
      (line) => line.segments[segmentType]?.enabled,
    );
  }

  async renderSegment(
    segment: { type: string; config: AnySegmentConfig },
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    blockInfo: BlockInfo | null,
    todayInfo: TodayInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    cacheTimerInfo: CacheTimerInfo | null,
    colors: PowerlineColors,
    currentDir: string,
  ) {
    if (segment.type === "directory") {
      return this.segmentRenderer.renderDirectory(
        hookData,
        colors,
        segment.config as DirectorySegmentConfig,
      );
    }
    if (segment.type === "model") {
      return this.segmentRenderer.renderModel(hookData, colors, segment.config);
    }

    if (segment.type === "git") {
      return await this.renderGitSegment(
        segment.config as GitSegmentConfig,
        hookData,
        colors,
        currentDir,
      );
    }

    if (segment.type === "session") {
      return this.renderSessionSegment(
        segment.config as UsageSegmentConfig,
        usageInfo,
        colors,
      );
    }

    if (segment.type === "sessionId") {
      return hookData.session_id
        ? this.segmentRenderer.renderSessionId(
            hookData.session_id,
            colors,
            segment.config as SessionIdSegmentConfig,
          )
        : null;
    }

    if (segment.type === "tmux") {
      return await this.renderTmuxSegment(colors);
    }

    if (segment.type === "context") {
      return this.renderContextSegment(
        segment.config as ContextSegmentConfig,
        contextInfo,
        colors,
      );
    }

    if (segment.type === "metrics") {
      return this.renderMetricsSegment(
        segment.config as MetricsSegmentConfig,
        metricsInfo,
        blockInfo,
        colors,
      );
    }

    if (segment.type === "block") {
      return this.renderBlockSegment(
        segment.config as BlockSegmentConfig,
        blockInfo,
        colors,
      );
    }

    if (segment.type === "today") {
      return this.renderTodaySegment(
        segment.config as TodaySegmentConfig,
        todayInfo,
        colors,
      );
    }

    if (segment.type === "version") {
      return this.renderVersionSegment(
        segment.config as VersionSegmentConfig,
        hookData,
        colors,
      );
    }

    if (segment.type === "env") {
      return this.segmentRenderer.renderEnv(
        colors,
        segment.config as EnvSegmentConfig,
      );
    }

    if (segment.type === "weekly") {
      return this.segmentRenderer.renderWeekly(
        hookData,
        colors,
        segment.config as WeeklySegmentConfig,
      );
    }

    if (segment.type === "agent") {
      return this.segmentRenderer.renderAgent(
        hookData,
        colors,
        segment.config as AgentSegmentConfig,
      );
    }

    if (segment.type === "thinking") {
      return this.segmentRenderer.renderThinking(
        hookData,
        colors,
        segment.config as ThinkingSegmentConfig,
      );
    }

    if (segment.type === "cacheTimer") {
      if (!cacheTimerInfo) return null;
      return this.segmentRenderer.renderCacheTimer(
        cacheTimerInfo,
        colors,
        segment.config as CacheTimerSegmentConfig,
      );
    }

    if (segment.type === "bastra") {
      const info = this.bastraProvider.getBastraInfo();
      return this.segmentRenderer.renderBastra(
        info,
        colors,
        segment.config as BastraSegmentConfig,
      );
    }

    return null;
  }

  private async renderGitSegment(
    config: GitSegmentConfig,
    hookData: ClaudeHookData,
    colors: PowerlineColors,
    currentDir: string,
  ) {
    if (!this.needsSegmentInfo("git")) return null;

    const gitInfo = await this.gitService.getGitInfo(
      currentDir,
      {
        showSha: config?.showSha,
        showWorkingTree: config?.showWorkingTree,
        showOperation: config?.showOperation,
        showTag: config?.showTag,
        showTimeSinceCommit: config?.showTimeSinceCommit,
        showStashCount: config?.showStashCount,
        showUpstream: config?.showUpstream,
        showRepoName: config?.showRepoName,
      },
      hookData.workspace?.project_dir,
    );

    return gitInfo
      ? this.segmentRenderer.renderGit(gitInfo, colors, config)
      : null;
  }

  private renderSessionSegment(
    config: UsageSegmentConfig,
    usageInfo: UsageInfo | null,
    colors: PowerlineColors,
  ) {
    if (!usageInfo) return null;
    return this.segmentRenderer.renderSession(usageInfo, colors, config);
  }

  private async renderTmuxSegment(colors: PowerlineColors) {
    if (!this.needsSegmentInfo("tmux")) return null;
    const tmuxSessionId = await this.tmuxService.getSessionId();
    return this.segmentRenderer.renderTmux(tmuxSessionId, colors);
  }

  private renderContextSegment(
    config: ContextSegmentConfig,
    contextInfo: ContextInfo | null,
    colors: PowerlineColors,
  ) {
    if (!this.needsSegmentInfo("context")) return null;
    return this.segmentRenderer.renderContext(contextInfo, colors, config);
  }

  private renderMetricsSegment(
    config: MetricsSegmentConfig,
    metricsInfo: MetricsInfo | null,
    _blockInfo: BlockInfo | null,
    colors: PowerlineColors,
  ) {
    return this.segmentRenderer.renderMetrics(metricsInfo, colors, config);
  }

  private renderBlockSegment(
    config: BlockSegmentConfig,
    blockInfo: BlockInfo | null,
    colors: PowerlineColors,
  ) {
    if (!blockInfo) return null;
    return this.segmentRenderer.renderBlock(blockInfo, colors, config);
  }

  private renderTodaySegment(
    config: TodaySegmentConfig,
    todayInfo: TodayInfo | null,
    colors: PowerlineColors,
  ) {
    if (!todayInfo) return null;
    return this.segmentRenderer.renderToday(todayInfo, colors, config);
  }

  private renderVersionSegment(
    config: VersionSegmentConfig,
    hookData: ClaudeHookData,
    colors: PowerlineColors,
  ) {
    return this.segmentRenderer.renderVersion(hookData, colors, config);
  }
}
