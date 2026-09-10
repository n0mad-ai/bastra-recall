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

/** Modell sofort entladen (Idle). true = unload akzeptiert. */
export async function unloadOllamaModel(baseURL: string, model: string): Promise<boolean> {
  const base = baseURL.replace(/\/+$/, "");
  try {
    // Primär: /api/embed mit leerem Input + keep_alive:0. Fallback auf
    // /api/generate (der historisch dokumentierte Unload-Weg), falls eine
    // Ollama-Version den leeren Embed-Input ablehnt.
    let resp = await fetchWithTimeout(`${base}/api/embed`, { model, input: "", keep_alive: 0 }, 10_000);
    if (!resp.ok) {
      resp = await fetchWithTimeout(`${base}/api/generate`, { model, keep_alive: 0 }, 10_000);
    }
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

async function fetchWithTimeout(
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tid);
  }
}
