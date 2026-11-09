import { TASKS_DEFAULT } from "./settings-defaults.js";
export { TASKS_DEFAULT } from "./settings-defaults.js";
import { runtimeFeatureSetting } from "./runtime-feature-settings.js";
/** Proactive tasks are an opt-in preview until v1.2.0 (#1238).
 * Set BASTRA_TASKS=1 in the daemon AND its clients/hooks; restart those processes.
 * One read-only settings snapshot per process; passive requests use memory.
 */
export const TASKS_PREVIEW_HINT = "Aufgaben sind eine standardmäßig ausgeschaltete Vorschau (preview). Aktivieren: BASTRA_TASKS=1 im Daemon und in Clients/Hooks setzen, diese Prozesse danach neu starten.";
export function tasksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BASTRA_TASKS === undefined ? (env === process.env ? runtimeFeatureSetting("tasks", TASKS_DEFAULT) : TASKS_DEFAULT) : env.BASTRA_TASKS === "1";
}
