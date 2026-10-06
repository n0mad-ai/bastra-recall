/** Read-only projection of Codex's rollout. Unknown records are ignored. */
export interface CodexStatus {
  sessionId: string | null;
  cwd: string;
  branch: string | null;
  model: string | null;
  effort: string | null;
  turnId: string | null;
  active: boolean;
  startedAt: number | null;
  turnStartedAt: number | null;
  contextUsed: number | null;
  contextWindow: number | null;
  tokens: number | null;
  limits: { minutes: number; used: number; resetsAt: number | null }[];
  calls: number;
  searches: number;
  loads: number;
  saves: number;
  hits: number;
  ms: number;
  errors: number;
  lastTool: string | null;
  lastAt: number | null;
  vaultSize: number | null;
  loadedTitles: string[];
  cachedInputTokens: number | null;
  inputTokens: number | null;
}

export function emptyStatus(): CodexStatus {
  return { sessionId: null, cwd: '', branch: null, model: null, effort: null,
    turnId: null, active: false, startedAt: null, turnStartedAt: null, contextUsed: null, contextWindow: null,
    tokens: null, limits: [], calls: 0, searches: 0, loads: 0, saves: 0,
    hits: 0, ms: 0, errors: 0, lastTool: null, lastAt: null, vaultSize: null, loadedTitles: [], cachedInputTokens: null, inputTokens: null };
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }

function toolResult(value: unknown): Record<string, any> {
  const result = object(value);
  if (result.structuredContent) return object(result.structuredContent);
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      try { return object(JSON.parse(block.text)); } catch { /* non-JSON tool output */ }
    }
  }
  return {};
}

/** Holds only bounded metadata: never stores prompts, tool arguments or memory bodies. */
export class CodexProjection {
  state = emptyStatus();
  private completed = new Set<string>();

  accept(record: unknown): void {
    const row = object(record);
    const p = object(row.payload);
    const s = this.state;
    if (row.type === 'session_meta') {
      s.sessionId = text(p.id) ?? text(p.session_id);
      s.cwd = text(p.cwd) ?? s.cwd;
      s.branch = text(object(p.git).branch);
      s.contextWindow = finite(p.context_window) ?? s.contextWindow;
      const started = Date.parse(p.timestamp ?? row.timestamp);
      s.startedAt = Number.isFinite(started) ? started : null;
    }
    if (row.type === 'turn_context') {
      s.model = text(p.model) ?? s.model;
      s.effort = text(p.effort) ?? s.effort;
      s.cwd = text(p.cwd) ?? s.cwd;
    }
    if (row.type !== 'event_msg') return;
    if (p.type === 'task_started' || p.type === 'turn_started') {
      const id = text(p.turn_id);
      if (id !== s.turnId || id === null) {
        Object.assign(s, { turnId: id, calls: 0, searches: 0, loads: 0, saves: 0,
          hits: 0, ms: 0, errors: 0, lastTool: null, lastAt: null, loadedTitles: [] });
        this.completed.clear();
      }
      s.active = true;
      const started = Date.parse(row.timestamp);
      s.turnStartedAt = Number.isFinite(started) ? started : null;
      s.contextWindow = finite(p.model_context_window) ?? s.contextWindow;
    }
    if ((p.type === 'task_complete' || p.type === 'task_interrupted' || p.type === 'turn_completed') &&
        (!s.turnId || typeof p.turn_id !== 'string' || p.turn_id === s.turnId)) s.active = false;
    if (p.type === 'token_count') {
      const info = object(p.info);
      s.tokens = finite(object(info.total_token_usage).total_tokens) ?? s.tokens;
      s.cachedInputTokens = finite(object(info.total_token_usage).cached_input_tokens) ?? s.cachedInputTokens;
      s.inputTokens = finite(object(info.total_token_usage).input_tokens) ?? s.inputTokens;
      s.contextUsed = finite(object(info.last_token_usage).total_tokens) ?? s.contextUsed;
      s.contextWindow = finite(info.model_context_window) ?? s.contextWindow;
      // Null/missing limits mean "no update", never 0%.
      if (p.rate_limits && typeof p.rate_limits === 'object') {
        const rate = object(p.rate_limits);
        const limits: CodexStatus['limits'] = [];
        for (const key of ['primary', 'secondary']) {
          const r = object(rate[key]);
          const minutes = finite(r.window_minutes), used = finite(r.used_percent);
          if (minutes !== null && minutes > 0 && used !== null) limits.push({ minutes, used, resetsAt: finite(r.resets_at) });
        }
        s.limits = limits;
      }
    }
    if (p.type !== 'item_completed') return;
    if (s.turnId && typeof p.turn_id === 'string' && p.turn_id !== s.turnId) return;
    const item = object(p.item);
    // The final answer is already visible when the terminal lifecycle event is
    // delayed or absent. Commentary must keep the current turn active.
    if (['AgentMessage', 'agentMessage'].includes(item.type) && item.phase === 'final_answer') {
      s.active = false;
      return;
    }
    if (!['McpToolCall', 'mcpToolCall'].includes(item.type)) return;
    if (typeof item.server !== 'string' || !/^bastra[-_]recall$/.test(item.server)) return;
    const id = text(item.id);
    if (!id || this.completed.has(id)) return;
    // Bound the dedup table even if a malformed transcript never changes turn.
    if (this.completed.size >= 4096) this.completed.delete(this.completed.values().next().value!);
    this.completed.add(id);
    const tool = text(item.tool) ?? 'tool';
    const result = toolResult(item.result);
    const error = item.status === 'failed' || item.status === 'error' || Boolean(item.error) || object(item.result).isError === true || Boolean(result.error) || result.isError === true;
    s.calls++;
    if (error) s.errors++;
    else {
      if (tool === 'recall' || tool === 'find_document') { s.searches++; s.hits += Array.isArray(result.hits) ? result.hits.length : 0; }
      if (tool === 'load_memory' || tool === 'read_document') {
        s.loads++;
        const title = text(object(result.frontmatter).title) ?? text(result.title) ?? text(result.id);
        if (title && !s.loadedTitles.includes(title)) s.loadedTitles.push(title);
        if (s.loadedTitles.length > 32) s.loadedTitles.shift();
      }
      if (tool === 'save_memory' || tool === 'save_document' || tool === 'save_product_doc' || tool === 'edit_memory') s.saves++;
    }
    const duration = object(item.duration);
    const ms = finite(item.durationMs) ?? ((finite(duration.secs) ?? 0) * 1000 + (finite(duration.nanos) ?? 0) / 1e6);
    s.ms += ms;
    s.lastTool = tool;
    const timestamp = Date.parse(row.timestamp);
    s.lastAt = Number.isFinite(timestamp) ? timestamp : null;
    s.vaultSize = finite(result.vault_size) ?? s.vaultSize;
  }
}

/** Existing forwarder feed, matched by identity rather than nearest/newest file. */
export interface RecallFeed {
  ts: number;
  turn_id?: number;
  cc_session_id?: string;
  current_stage?: string | null;
  current_message?: string | null;
  current_recall_started_at?: number | null;
  last_phrase?: string | null;
  last_phrase_at?: number | null;
  recall_count?: number;
  total_hits?: number;
  total_ms?: number;
}
