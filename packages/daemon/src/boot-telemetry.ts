/**
 * Start-up phase 3 (#1039): telemetry with its experiment arm, the core
 * observers (boot-observers.ts) and the curator demotions that survive a
 * restart.
 *
 * Moved verbatim out of `main()` in `index.ts`.
 */
import type { Vault, SearchIndex } from "@bastra-recall/core";
import type { Telemetry } from "./telemetry.js";
import { createDaemonTelemetry } from "./telemetry-setup.js";
import { loadCuratorState } from "./curator.js";
import { wireBootObservers } from "./boot-observers.js";
import { getExperimentConfig } from "./settings.js";

export async function startTelemetry(opts: {
  vaultPath: string;
  vault: Vault;
  search: SearchIndex;
}): Promise<{ telemetry: Telemetry }> {
  const { vaultPath, vault, search } = opts;

  // Hybrid-Recall: provider precedence env → cli-settings.json → none.
  // embeddingStatusLine logs the resolved mode on EVERY path including success —
  // the silent-success path was the root of #79.
  // Vor dem Embedding-Block konstruiert, weil Prewarm/Unload (#109) ihre
  // Lifecycle-Events darüber loggen. Der onUsage-Sink speist den Per-Memory-
  // Usage-Sidecar (#154) — fire-and-forget, ein kaputter Sidecar darf keinen
  // Tool-Call brechen (Contract in usage-sidecar.ts).
  const telemetry = createDaemonTelemetry(vaultPath, (id) => vault.get(id));

  // #267: Die Armzuweisung der §17.4-Experimente. Ohne registrierte
  // Konfiguration bleibt jedes Ereignis `unassigned` — die Spalte existiert
  // seit #263, behauptet aber kein laufendes Experiment. Erst diese Zeile macht
  // die Naht echt statt tot.
  const experimentConfig = await getExperimentConfig();
  telemetry.setExperiment(experimentConfig);
  if (experimentConfig) {
    console.error(
      `[bastra-recall] experiment ACTIVE: ${experimentConfig.experiment} — arms ${experimentConfig.arms.join(", ")}` +
        ` — registration ${experimentConfig.registration} v${experimentConfig.registration_version} (#267/#439)`,
    );
  }

  // Die Meldekanäle aus core (ID-Scan-Kosten, Mutations-Incidents) und die
  // Start-Detection des Recovery-Journals — wer zuhört, steht in
  // boot-observers.ts.
  await wireBootObservers({ telemetry, vaultPath: vaultPath });

  // Curator-Demotions (#155) überleben Daemon-Restarts: Score-Set aus dem
  // State-File beim Boot in den Index laden. Best-effort.
  try {
    const curatorState = await loadCuratorState(vaultPath);
    const staleIds = Object.keys(curatorState.stale);
    if (staleIds.length > 0) search.setDemotions(staleIds);
  } catch {
    /* kein State = keine Demotions */
  }

  return { telemetry };
}
