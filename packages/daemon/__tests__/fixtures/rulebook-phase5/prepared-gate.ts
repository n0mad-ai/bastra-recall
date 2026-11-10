import { runGateLane, type GatePayload, type GateDeps } from '../../../src/gate-lane.js';
import { loadSessionState } from '../../../src/session-state.js';
import { projectForLane } from '../../../src/scope-filter.js';
import { withFixtureClock } from '../fixture-clock.js';

/** Mechanical gate replay measures decisions, not repeated fixture catalog I/O.
 * Prepare each production projection separately; the real deadline has its own control. */
export type PreparedGateTiming={preparation_ms:number;gate_ms:number};
export async function preparedGate(payload: GatePayload, deps: GateDeps,observe?:(timing:PreparedGateTiming)=>void): Promise<string> {
  if (!deps.kernel) return runGateLane(payload, deps);
  const started=performance.now();
  const state = payload.session_id ? await loadSessionState(payload.session_id) : undefined;
  const active = state?.activeConventions ?? [];
  const project = projectForLane(payload.cwd || process.cwd());
  const ids = await deps.kernel(active, project, 'ids');
  const content = await deps.kernel(active, project, 'content');
  const prepared=performance.now();
  try{return await withFixtureClock(() => runGateLane(payload, {...deps, kernel: async (_active, _project, mode) => mode === 'ids' ? ids : content}));}
  finally{observe?.({preparation_ms:prepared-started,gate_ms:performance.now()-prepared});}
}
