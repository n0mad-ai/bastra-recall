import { taskCliCall } from "./tasks-cmd.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
/** Historical declaration is no longer an authority gate. */
export async function declareTaskBoundary() {
  process.stdout.write("Die Vertrauensgrenze ist das lokale Rechnerkonto. Keine zusätzliche Grenzerklärung oder Schlüssel-Freigabe erforderlich.\n");
}
/** Called under the user's instruction; never asks for a second confirmation. */
export async function enableTaskExecution(authorization: string) {
  await taskCliCall("controls", { execution_stopped: false, adapter: { id: "local-artifact-v1", enabled: true } }, authorization, resolveDaemonEndpoint().baseUrl);
  process.stdout.write("Lokaler Adapter aktiviert, Ausführungsstopp aufgehoben. Die Nutzeranweisung im Chat ist die Freigabe; Vorschau, Schreibabgleich und Quittung bleiben erforderlich.\n");
}
