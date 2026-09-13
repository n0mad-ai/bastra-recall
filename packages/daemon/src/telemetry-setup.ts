/** Daemon-owned telemetry wiring: event ledger plus the durable usage sidecar. */
import { Telemetry } from "./telemetry.js";
import { recordUsage } from "./usage-sidecar.js";
import { hintRevision, type HintMemory } from "./hint-suppression.js";

export function createDaemonTelemetry(
  vaultPath: string,
  memoryOf: (id: string) => HintMemory | undefined,
): Telemetry {
  return new Telemetry({
    onUsage: (events) => {
      void recordUsage(
        vaultPath,
        events.map((event) => {
          const revision = hintRevision(memoryOf(event.id));
          return revision ? { ...event, revision } : event;
        }),
      );
    },
  });
}
