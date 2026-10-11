import { authenticateTask, requireTaskOwner, requireTaskDomains } from "../task-auth.js";
import { readApprovalRegistry, approvalRegistryPath, approvalRegistrySchema } from "../task-approval-keys.js";
import { withPathLock } from "../path-lock.js";
import { atomicWrite, tasksPath, transactTaskStore } from "../task-store.js";
import { taskPrivatePrompt } from "./task-private-prompt.js";
import { confirm } from "./prompt.js";
import { taskCliCall } from "./tasks-cmd.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
export async function declareTaskBoundary() {
  const owner = await authenticateTask(`Bearer ${await taskPrivatePrompt("Owner task token (hidden): ")}`); requireTaskOwner(owner);
  const path = approvalRegistryPath();
  if (!await confirm("Ich bestätige: Agenten können weder Aufgaben-Datenverzeichnis noch private Schlüssel noch die Daemon-Laufzeit ändern. Diese Grenze wird technisch NICHT geprüft. Grenze erklären?")) throw Object.assign(new Error("Owner declined boundary declaration"), { code: "forbidden", reason:"owner_declined" });
  await transactTaskStore(tasksPath(), undefined, s => { s.controls.execution_stopped = true; }, "control");
  await withPathLock(path, async ownership => { const registry = await readApprovalRegistry(path); if (!registry || !registry.keys.length || !registry.targets.length) throw Object.assign(new Error("Owner keys and registered targets required"), { code: "validation" });
    requireTaskDomains(owner, [...new Set([...registry.keys.map(k => k.domain), ...registry.targets.flatMap(t => t.owner_domains)])]);
    registry.protected_boundary = true; registry.revision++; await atomicWrite(path, JSON.stringify(approvalRegistrySchema.parse(registry)), ownership);
  }, { strictLocal: true });
  process.stdout.write("Owner-Grenze erklärt. Ausführung bleibt gestoppt. Alle Task-Prozesse neu starten, dann: bastra tasks execution-enable. Jede Wirkung braucht weiterhin alle Owner-Signaturen.\n");
}
export async function enableTaskExecution(authorization: string) {
  if (!await confirm("Lokalen Referenzadapter aktivieren und Ausführungsstopp aufheben? Jede Dateiänderung braucht weiterhin eine exakte Owner-Freigabe.")) throw Object.assign(new Error("Owner declined execution enable"), { code: "forbidden", reason:"owner_declined" });
  await taskCliCall("controls", { execution_stopped: false, adapter: { id: "local-artifact-v1", enabled: true } }, authorization, resolveDaemonEndpoint().baseUrl);
  process.stdout.write("Lokaler Adapter aktiviert, Ausführungsstopp aufgehoben. Nur fällige, scharfe Aufgaben mit allen gültigen Owner-Signaturen dürfen schreiben.\n");
}
