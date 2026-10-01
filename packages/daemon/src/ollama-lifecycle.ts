/**
 * Energiebewusster Ollama-Modell-Lifecycle (#78).
 *
 * bastra-recall startet/stoppt NIE den Ollama-Prozess (das macht die Mac-App
 * bzw. der User) — gesteuert wird nur, ob das Embedding-Modell im RAM liegt:
 *
 *   - prewarm  = "Wakeup": Mini-Embed lädt das Modell, fire-and-forget beim
 *     Daemon-Boot, damit der erste echte Recall ein warmes Modell trifft.
 *     Seit #494 steht er NICHT mehr hier: Er lief als eigener HTTP-Call an
 *     der Singleflight-Grenze, am Breaker und am Nebenläufigkeitszähler
 *     vorbei, und war damit einer von bis zu fünf gleichzeitigen Embeds beim
 *     kalten Start. Es gibt jetzt genau einen Weg, dieses Modell zu wärmen —
 *     `WarmupCoordinator.ensureWarm` in `embedding-warmup.ts`.
 *   - unload   = "Idle-Befehl": keep_alive:0 entlädt das Modell sofort —
 *     ~600 MB RAM frei statt Dauerbelegung (mobiler Akku). Der nächste
 *     Embed lädt es in 1–2 s zurück.
 *
 * Bewusst KEIN OLLAMA_KEEP_ALIVE=-1 (Hebel B aus #78): das hielte das Modell
 * für immer im RAM — genau das Gegenteil des Energie-Ziels.
 * Alle Calls best-effort: werfen nie, loggen nur.
 */

/** `/api/ps` lists every model as `model:tag`; a name without a tag is `:latest`. */
const tagged = (name: string): string => (/:[^/]*$/.test(name) ? name : `${name}:latest`).toLowerCase();

/**
 * Unload the model now (idle). true = it is out of memory afterwards.
 *
 * Only a model that is in memory is unloaded (#701). The old request,
 * `/api/embed` with an empty input and `keep_alive: 0`, loaded a model Ollama
 * had already evicted: the embed handler schedules the runner before it looks
 * at the input, so the "unload" cost a 14–18 s load that the 10 s abort left
 * running. `GET /api/ps` says what is loaded; a model that is not there is
 * done, without a request. A loaded one gets the documented unload,
 * `/api/generate` with `keep_alive: 0` and no prompt, which expires the runner
 * and loads nothing. When `/api/ps` gives no answer, nothing is sent.
 */
export async function unloadOllamaModel(baseURL: string, model: string): Promise<boolean> {
  const base = baseURL.replace(/\/+$/, "");
  try {
    const ps = await fetchWithTimeout(`${base}/api/ps`, null, 10_000);
    if (!ps.ok) {
      console.error(`[bastra-recall] ollama idle-unload failed: /api/ps HTTP ${ps.status}`);
      return false;
    }
    const running = ((await ps.json()) as { models?: { name?: unknown; model?: unknown }[] }).models ?? [];
    if (!running.some((m) => [m.name, m.model].some((n) => typeof n === "string" && tagged(n) === tagged(model)))) {
      console.error(`[bastra-recall] ollama idle-unload: ${model} is not in memory, nothing to unload`);
      return true;
    }
    const resp = await fetchWithTimeout(`${base}/api/generate`, { model, keep_alive: 0 }, 10_000);
    if (resp.ok) {
      console.error(`[bastra-recall] ollama idle-unload: ${model} released (~RAM freed; next embed reloads it)`);
      return true;
    }
    console.error(`[bastra-recall] ollama idle-unload failed: HTTP ${resp.status}`);
    return false;
  } catch (err) {
    console.error(`[bastra-recall] ollama idle-unload failed: ${(err as Error).message}`);
    return false;
  }
}

/** POST `body` as JSON, or GET when there is none. */
async function fetchWithTimeout(
  url: string,
  body: Record<string, unknown> | null,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tid);
  }
}
