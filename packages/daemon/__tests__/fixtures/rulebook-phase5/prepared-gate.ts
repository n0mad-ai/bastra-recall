import { runGateLane, type GatePayload, type GateDeps } from '../../../src/gate-lane.js';
import { loadSessionState } from '../../../src/session-state.js';
import { projectForLane } from '../../../src/scope-filter.js';

/** Mechanical gate replay measures decisions, not repeated fixture catalog I/O.
 * Prepare each production projection separately; keep the gate's real budget. */
export async function preparedGate(payload: GatePayload, deps: GateDeps): Promise<string> {
  if (!deps.kernel) return runGateLane(payload, deps);
  const state = payload.session_id ? await loadSessionState(payload.session_id) : undefined;
  const active = state?.activeConventions ?? [];
  const project = projectForLane(payload.cwd || process.cwd());
  const ids = await deps.kernel(active, project, 'ids');
  const content = await deps.kernel(active, project, 'content');
  return runGateLane(payload, {...deps, kernel: async (_active, _project, mode) => mode === 'ids' ? ids : content});
}
