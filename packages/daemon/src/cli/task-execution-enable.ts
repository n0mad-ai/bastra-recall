import { taskCliCall } from "./tasks-cmd.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { taskCliLanguage, taskCliWords } from "./task-cli-words.js";
/** Historical declaration is no longer an authority gate. */
export async function declareTaskBoundary() {
  process.stdout.write(taskCliWords(await taskCliLanguage()).boundary + "\n");
}
/** Called under the user's instruction; never asks for a second confirmation. */
export async function enableTaskExecution(authorization: string) {
  await taskCliCall(
    "controls",
    { execution_stopped: false, adapter: { id: "local-artifact-v1", enabled: true } },
    authorization,
    resolveDaemonEndpoint().baseUrl
  );
  process.stdout.write(taskCliWords(await taskCliLanguage()).executionEnabled + "\n");
}
