import type { PanelGit } from './git-status';

export interface NeuralData {
  mode: 'demo' | 'snapshot' | 'live';
  client?: 'claude' | 'codex';
  git?: PanelGit | null;
  effort?: string | null;
  durationMs?: number | null;
  costUsd?: number | null;
  cacheHitRatio?: number | null;
  /** Codex cached-input token share, distinct from Claude's request cache hit ratio. */
  cachedInputRatio?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  tokens?: number | null;
  clientLatency?: number | null;
  timingSource?: 'forwarder' | 'client';
  active?: boolean;
  recent?: boolean;
  agentActive?: boolean;
  errors?: number;
  fresh?: boolean;
  project: string;
  model: string;
  context: number | null;
  contextTotal?: number | null;
  contextFree?: number | null;
  usage: number | null;
  usageResetsAt?: number | null;
  usage5h?: number | null;
  usage5hResetsAt?: number | null;
  apiDurationMs?: number | null;
  /** Titles of the memories loaded in this turn, oldest first. */
  loadedTitles?: string[];
  now?: number;
  vault: number | null;
  searches: number | null;
  hits: number | null;
  loads: number | null;
  saves: number | null;
  latency: number | null;
  stage: string;
}

export const NEURAL_DEMO: NeuralData = {
  mode: 'demo', project: 'bastra-recall', model: 'OPUS 5.5', context: 24,
  usage: 70, vault: 1368, searches: 2, hits: 6, loads: 3, saves: 1,
  latency: 120, stage: 'Semantik abgleichen',
};
