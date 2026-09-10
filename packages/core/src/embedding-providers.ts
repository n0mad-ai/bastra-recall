/**
 * Die Embedding-PROVIDER — OpenAI und Ollama.
 *
 * Herausgelöst aus `embeddings.ts` (#493), als diese Datei mit dem
 * strukturierten Provider-Ergebnis über die 800-Zeilen-Grenze wuchs. Der
 * Schnitt liegt an der fachlichen Naht, die es ohnehin schon gab: Hier steht,
 * WIE man einen Vektor bekommt (HTTP, Modelle, Keep-Alive-Socket), dort, was
 * der Index damit tut (Persistenz, Backfill, Cosine, Health). Reiner Umzug —
 * `embeddings.ts` re-exportiert alles, was hier steht, also ändert sich für
 * keinen Importeur etwas.
 */
import * as http from "node:http";
import * as https from "node:https";
import { assertLocalOrOptIn } from "./ollama-egress.js";

// ─── Provider Interface ──────────────────────────────────────────

export interface EmbeddingProvider {
  /** Stable ID für Persistenz-Header — bei Provider-Wechsel wird der
   *  Index invalidiert, weil Cosine zwischen Modellen sinnlos ist. */
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  /**
   * #493: derselbe Call, aber mit dem, was der Provider über sich SELBST
   * sagt — insbesondere, wie lange er das Modell laden musste.
   *
   * Optional, weil nur manche Provider so etwas melden: Ollama liefert
   * `load_duration` in seiner `/api/embed`-Antwort, eine gehostete API hat
   * kein Modell von uns im Speicher und damit nichts zu melden. Wo es die
   * Angabe gibt, ist sie GRUNDWAHRHEIT über die Residenz — und Tor 3 aus
   * #492 („20 echte Kaltstarts") stand bis hierher auf einer Schätzung aus
   * Zeitstempeln (`embedding-warmup.ts`).
   */
  embedWithMeta?(texts: string[]): Promise<EmbedWithMeta>;
}

/** #493: Was ein Provider über den eigenen Call sagen kann. */
export interface EmbedWithMeta {
  vectors: Float32Array[];
  /**
   * Modell-Ladezeit dieses Calls in ms, sofern der Provider sie meldet.
   * `null` = keine Angabe (nicht: „0 ms").
   */
  loadMs: number | null;
}

/**
 * #493: Ab wann eine gemeldete Ladezeit ein KALTSTART ist.
 *
 * Ollama meldet `load_duration` auch auf einem längst residenten Modell —
 * dort ist es die Buchführung des Servers und liegt im einstelligen bis
 * niedrig zweistelligen Millisekundenbereich. Ein echter Ladevorgang ist eine
 * andere Größenordnung: gemessen 08.09.2026 (M4 Pro, `embeddinggemma`,
 * 673 MB) antwortet ein warmer Embed komplett in 33–54 ms, während der erste
 * nach vollständigem Unload 585 ms braucht.
 *
 * Die Grenze trägt hier bewusst wenig Gewicht: `provider_load_ms` wird ROH
 * aufgezeichnet, also lässt sich die Schwelle aus den Messdaten selbst neu
 * ziehen, ohne dass eine einzige Stichprobe verloren geht.
 */
export const PROVIDER_COLD_LOAD_MS = 200;

// ─── OpenAI Provider ─────────────────────────────────────────────

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  private apiKey: string;
  private model: string;

  constructor(opts: {
    apiKey: string;
    model?: string;
    dim?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "text-embedding-3-small";
    this.dim = opts.dim ?? 1536;
    this.id = `openai-${this.model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        encoding_format: "float",
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "<binary>");
      throw new Error(`OpenAI embed HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = (await resp.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }
}

// ─── Ollama Provider ─────────────────────────────────────────────

/**
 * Lokales Embedding-Provider via Ollama (https://ollama.com).
 *
 * Vorteile ggü. OpenAI:
 * - Keine Token-Kosten / kein Quota
 * - Daten bleiben on-device (privatsphäre, GDPR)
 * - Kein Network-Roundtrip → schneller bei vielen kleinen Batches
 *
 * Setup:
 *   brew install ollama
 *   ollama pull embeddinggemma   # ~200 MB, multilingual, 768 dim
 *
 * Spricht das NATIVE `/api/embed`-Endpoint (nicht den OpenAI-compat-Layer
 * `/v1/embeddings`): nur das native API versteht `keep_alive`, womit der
 * Daemon das Lade-Fenster des Modells pro Request steuert — Kern des
 * Energie-Designs (#78): Modell bleibt während aktiver Arbeit warm, wird
 * bei Idle entladen statt dauerhaft RAM zu belegen (Laptop-Akku).
 * Cosine ist skalierungsinvariant, daher bleiben persistierte Vektoren
 * aus dem alten /v1-Pfad kompatibel (gleiches Modell, gleiche dim).
 *
 * Default-Modell: `embeddinggemma` (Google, 308M Params, multilingual,
 * MTEB-Best <500M). Daniels deutscher Vault profitiert vom multilingual-
 * Training. Alternativen: `nomic-embed-text` (288M, EN-fokussiert),
 * `bge-m3` (~2.3GB, 100+ Sprachen, schwerer aber robuster).
 */
/**
 * #466: Ollama über eine GEHALTENE Verbindung, nicht über `fetch`.
 *
 * Der Hybrid-Recall feuert den Dense-Arm ab, gibt dem Event Loop genau einen
 * Timer-Durchlauf (`search.ts`, #305) und belegt ihn dann synchron mit BM25.
 * Dieser eine Durchlauf reicht nur, wenn der Request in ihm auch auf die
 * Leitung geht — und das tut er nur über einen Socket, der SCHON offen ist.
 * Ein frischer TCP-Connect wird erst in der Poll-Phase fertig, die nach der
 * Blockade kommt; der Request ging dann erst NACH BM25 raus, und der Arm
 * lief bei jeder langen Query in seine Deadline (02.09.: 27 von 49 Prompt-
 * Lane-Recalls unfused, `vector_search_ms` durchgehend ≈ `bm25_search_ms`).
 *
 * `fetch` schließt seine Verbindung nach 4 s Idle (undici-Default), und die
 * Prompt-Lane-Aufrufe liegen Minuten auseinander — der Socket war praktisch
 * immer kalt. Gemessen (1500 Zeichen, 140 ms Blockade): warm 0 ms nach
 * Blockende, kalt 88–111 ms. Ein Node-Agent mit `keepAlive` hält den Socket,
 * bis der Server ihn schließt; ein serverseitig geschlossener wird vom Agent
 * still ersetzt (dann einmal kalt, wie vorher immer).
 *
 * Ein Agent pro Protokoll, modulweit: Prewarm (#361) und Recall teilen sich
 * damit dieselbe Verbindung, der Prewarm wärmt also auch den Socket.
 */
const keepAliveHttp = new http.Agent({ keepAlive: true });
const keepAliveHttps = new https.Agent({ keepAlive: true });

function postJsonKeepAlive(url: string, body: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const secure = target.protocol === "https:";
  const request = secure ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: "POST",
        agent: secure ? keepAliveHttps : keepAliveHttp,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  private baseURL: string;
  private model: string;
  private keepAlive?: string | number;

  constructor(opts: {
    baseURL?: string;
    model?: string;
    dim?: number;
    /** Ollama keep_alive pro Embed-Request, z.B. "10m" oder Sekunden.
     *  undefined = Feld weglassen → Server-Default (OLLAMA_KEEP_ALIVE, 5m). */
    keepAlive?: string | number;
  }) {
    this.baseURL = opts.baseURL ?? "http://localhost:11434";
    // Embedding text (query + memory) is POSTed to this endpoint. Enforce the
    // same "no egress" contract the reranker does (#124/#125): loopback by
    // default, remote only with BASTRA_ALLOW_REMOTE_OLLAMA=1. Fail fast at
    // construction rather than silently shipping text off-box on first embed.
    assertLocalOrOptIn(this.baseURL);
    this.model = opts.model ?? "embeddinggemma";
    // EmbeddingGemma default 768, andere Modelle abweichend — via opts
    // override-bar. Bei Mismatch wird der Index automatisch invalidiert
    // (siehe load(): dim/provider-Check).
    this.dim = opts.dim ?? 768;
    this.id = `ollama-${this.model}`;
    this.keepAlive = opts.keepAlive;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return (await this.embedWithMeta(texts)).vectors;
  }

  /**
   * #493: derselbe Request, plus `load_duration` aus der Antwort.
   *
   * Ollama meldet die Ladezeit des Modells in NANOSEKUNDEN neben den
   * Embeddings. Das ist die einzige Stelle im ganzen Pfad, an der die Residenz
   * nicht geschätzt, sondern vom Provider berichtet wird — und sie kostet
   * nichts: Die Antwort wird ohnehin schon geparst.
   */
  async embedWithMeta(texts: string[]): Promise<EmbedWithMeta> {
    if (texts.length === 0) return { vectors: [], loadMs: null };
    const url = this.baseURL.replace(/\/+$/, "") + "/api/embed";
    const body: Record<string, unknown> = { model: this.model, input: texts };
    if (this.keepAlive !== undefined) body.keep_alive = this.keepAlive;
    const resp = await postJsonKeepAlive(url, JSON.stringify(body));
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `Ollama embed HTTP ${resp.status} (${url}): ${resp.body.slice(0, 200)}`,
      );
    }
    const json = JSON.parse(resp.body) as { embeddings: number[][]; load_duration?: number };
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== texts.length) {
      throw new Error(
        `Ollama embed: expected ${texts.length} embeddings, got ${Array.isArray(json.embeddings) ? json.embeddings.length : "none"}`,
      );
    }
    return {
      vectors: json.embeddings.map((e) => new Float32Array(e)),
      // Nanosekunden → Millisekunden. Ein fehlendes Feld ist `null` und nicht
      // 0: „der Server sagt nichts" und „es musste nichts geladen werden" sind
      // verschiedene Aussagen, und nur die zweite wäre eine Messung.
      loadMs:
        typeof json.load_duration === "number" && Number.isFinite(json.load_duration)
          ? json.load_duration / 1e6
          : null,
    };
  }
}
