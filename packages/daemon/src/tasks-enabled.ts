/** Proactive tasks are an opt-in preview until v1.2.0 (#1238).
 * Set BASTRA_TASKS=1 in the daemon AND its clients/hooks; restart those processes.
 * No settings/task file reads: safe to call on every passive request path.
 */
export const TASKS_DEFAULT = false;
export const TASKS_PREVIEW_HINT = "Aufgaben sind eine standardmäßig ausgeschaltete Vorschau (preview). Aktivieren: BASTRA_TASKS=1 im Daemon und in Clients/Hooks setzen, diese Prozesse danach neu starten.";
export function tasksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BASTRA_TASKS === undefined ? TASKS_DEFAULT : env.BASTRA_TASKS === "1";
}
