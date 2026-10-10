/** Bridge reranker comparison: production prompt/parser, numCtx=8192. */
import { args, required, positive, corpus, generation, fixture, rank, timing, forecast, outputGuard, pretty, modelInfo, loopbackUrl, logLine, digest, QUERY_TYPES, BASE_URL, applyExpansions, errorText } from "./common.mts";

const a = args(["corpus", "model", "embedding-model", "embedding-dim", "pool", "expansions-in", "out", "limit", "timeout-ms", "chat-url", "embedding-url"], ["help"]);
if (a.help) {
  console.log("node --import tsx tools/model-compare/rerank.mts --corpus FILE --model MODEL --out FILE [--embedding-model embeddinggemma] [--pool hybrid|bm25] [--limit N] [--expansions-in FILE] [--embedding-dim N] [--timeout-ms N] [--chat-url LOOPBACK] [--embedding-url LOOPBACK]");
} else {
  const file = required(a, "corpus"), out = required(a, "out"), model = required(a, "model");
  const chatURL = loopbackUrl(a["chat-url"]), embeddingURL = loopbackUrl(a["embedding-url"]);
  const write = outputGuard([out], [file, a["expansions-in"] as string | undefined]);
  const pool = (a.pool ?? "hybrid") as "hybrid" | "bm25";
  if (!["hybrid", "bm25"].includes(pool)) throw Error("--pool must be hybrid or bm25");
  const embeddingModel = (a["embedding-model"] ?? (pool === "hybrid" ? "embeddinggemma" : "none")) as string;
  if (pool === "hybrid" && embeddingModel === "none") throw Error("Hybrid pool needs an embedding model");
  const c = await corpus(file, a.limit);
  if (c.notes.length < 2) throw Error("Reranking requires at least two notes");
  const started = performance.now(), result: any = { schema: 1, tool: "model-compare-rerank", status: "running", model, embedding_model: embeddingModel,
    corpus_sha256: c.sha256, corpus_total: c.total, notes_measured: c.notes.length, pool, created_at: new Date().toISOString(),
    parameters: { default_base_url: BASE_URL, chat_base_url: chatURL, embedding_base_url: embeddingURL, think: false, temperature: 0, num_ctx: 8192, timeout_ms: positive(a["timeout-ms"], 30_000),
      desired_pool_size: 10, candidate_order: "deterministic SHA256 shuffle, independently per query/condition", candidate_text: "production title + summary, buildRerankPrompt clips to 200",
      absence_success: "production parser returns null AND first parsed number is 0 (empty/garbage is not rewarded)" }, rows: [], summary: [] };
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(c.notes, embeddingModel, a["embedding-dim"], embeddingURL);
    result.embedding_metadata = f.embeddingInfo; result.dimension_probe = f.dimensionProbe; result.model_metadata = await modelInfo(model, chatURL);
    if (a["expansions-in"]) { const cache = await applyExpansions(f, a["expansions-in"] as string); result.expansion_source_model = cache.model; result.expansion_selection_provider = cache.selection_embedding_model; result.expansion_source_corpus_sha256 = cache.corpus_sha256; }
    const current = f, client = generation.ollamaChat({ baseURL: chatURL, model, timeoutMs: result.parameters.timeout_ms, numCtx: 8192, redirect: "error" });
    let unusableStreak = 0, stopped = false;
    measure: for (const n of c.notes) for (const kind of QUERY_TYPES) {
      const query = n.queries[kind], nearest = await rank(current, query, pool, c.notes.length);
      // Zero-score lexical non-hits follow all retrieved negatives, deterministically.
      const negatives = [...nearest.map(h => h.id), ...c.notes.map(m => m.id)].filter((id, i, all) => id !== n.id && all.indexOf(id) === i);
      for (const condition of ["present", "absent"] as const) {
        const ids = condition === "present" ? [n.id, ...negatives.slice(0, 9)] : negatives.slice(0, 10);
        const seed = `${n.id}/${kind}/${condition}`;
        ids.sort((x, y) => digest(`${seed}/${x}`).localeCompare(digest(`${seed}/${y}`)));
        const candidates = ids.map(id => { const m = current.vault.get(id)!; return { id, text: `${m.fm.title} ${m.fm.summary}` }; });
        const prompt = generation.buildRerankPrompt(query, candidates), t = performance.now();
        let raw = "", error: string | null = null;
        try { raw = await current.serial.run(() => client(prompt)); } catch (e) { error = errorText(e); }
        const chosen = generation.parseRerankAnswer(raw, candidates.length), firstNumber = raw.match(/\d+/)?.[0];
        const explicitNone = firstNumber !== undefined && Number(firstNumber) === 0;
        const usable = !error && raw.trim().length > 0 && firstNumber !== undefined && Number(firstNumber) <= candidates.length;
        const chosenId = chosen === null ? null : candidates[chosen - 1].id;
        result.rows.push({ query_id: `${n.id}/${kind}`, kind, note_lang: n.lang, query_lang: kind === "far_xlang" ? (n.lang === "de" ? "en" : "de") : n.lang, query, target_id: n.id, condition, candidate_ids: ids, target_position: ids.indexOf(n.id) < 0 ? null : ids.indexOf(n.id) + 1,
          candidate_count: ids.length, retrieval_target_rank: nearest.findIndex(h => h.id === n.id) < 0 ? null : nearest.findIndex(h => h.id === n.id) + 1,
          raw, error, usable, strict_numeric_reply: /^(?:0|[1-9]\d*)$/.test(raw.trim()), parsed_position: chosen, chosen_id: chosenId,
          correct: usable && (condition === "present" ? chosenId === n.id : chosen === null && explicitNone), duration_ms: performance.now() - t, prompt_sha256: digest(prompt) });
        if (result.rows.length % 10 === 0) console.error(`[model-compare] reranked ${result.rows.length}/${c.notes.length * 6}`);
        unusableStreak = usable ? 0 : unusableStreak + 1;
        if (unusableStreak >= 5) { stopped = true; console.error("[model-compare] stopped after five unusable replies; no thinking workaround"); break measure; }
      }
    }
    for (const condition of ["present", "absent"]) for (const kind of QUERY_TYPES) {
      const rows = result.rows.filter((r: any) => r.condition === condition && r.kind === kind);
      result.summary.push({ condition, kind, n: rows.length, correct: rows.filter((r: any) => r.correct).length, accuracy: rows.length ? rows.filter((r: any) => r.correct).length / rows.length : null,
        unusable: rows.filter((r: any) => !r.usable).length, latency: timing(rows.map((r: any) => r.duration_ms)) });
    }
    result.status = stopped ? "stopped-unusable-model" : result.rows.some((r: any) => !r.usable) ? "completed-with-issues" : "completed";
    result.unmeasured_calls = c.notes.length * 6 - result.rows.length;
    result.estimate_180_notes = forecast(stopped ? [] : result.rows.map((r: any) => r.duration_ms), 180 * 6);
    result.embedding_stats = current.embeddingStats();
    console.table(result.summary.map((r: any) => ({ condition: r.condition, kind: r.kind, correct: `${r.correct}/${r.n}`, unusable: r.unusable,
      median_ms: r.latency.median_ms === null ? null : Math.round(r.latency.median_ms), p95_ms: r.latency.p95_ms === null ? null : Math.round(r.latency.p95_ms) })));
  } catch (e) { result.status = "failed"; result.error = errorText(e); process.exitCode = 1; console.error(logLine(result.error)); }
  finally { result.total_ms = performance.now() - started; await write(out, pretty(result)); if (f) await f.close(); }
}
