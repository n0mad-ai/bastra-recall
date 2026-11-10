import { runGateLane, type GatePayload, type GateDeps } from '../../../src/gate-lane.js';
import { loadSessionState } from '../../../src/session-state.js';
import { projectForLane } from '../../../src/scope-filter.js';

/** Mechanical gate replay measures decisions, not repeated fixture catalog I/O.
 * Resolve exactly the production projection first; keep the gate's real budget. */
export async function preparedGate(payload: GatePayload, deps: GateDeps): Promise<string> {
  const state = payload.session_id ? await loadSessionState(payload.session_id) : undefined;
  const catalog = deps.kernel ? await deps.kernel(state?.activeConventions ?? [], projectForLane(payload.cwd || process.cwd()), 'ids') : undefined;
  return runGateLane(payload, {...deps, ...(catalog ? {kernel: async () => catalog} : {})});
}
