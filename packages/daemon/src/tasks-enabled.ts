import { TASKS_DEFAULT } from "./settings-defaults.js";
export { TASKS_DEFAULT } from "./settings-defaults.js";
import { runtimeFeatureSetting } from "./runtime-feature-settings.js";
/** Proactive tasks are enabled by default from v1.2.0 (#1289).
 * Disable with tasks.enabled=false or BASTRA_TASKS=0; restart daemon and clients/hooks.
 * One read-only settings snapshot per process; passive requests use memory.
 */
export const TASKS_PREVIEW_HINT = "Aufgaben sind ausgeschaltet. Aktivieren: tasks.enabled=true in den Einstellungen oder BASTRA_TASKS=1 im Daemon und in Clients/Hooks setzen, diese Prozesse danach neu starten.";
export function tasksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BASTRA_TASKS === undefined ? (env === process.env ? runtimeFeatureSetting("tasks", TASKS_DEFAULT) : TASKS_DEFAULT) : env.BASTRA_TASKS === "1";
}
