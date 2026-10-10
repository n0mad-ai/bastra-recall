/** Synthetic recall comparison. No real vault, daemon, pull or cloud fallback. */
import { args, required, positive, corpus, core, FIELD_BOOST, generation, fixture, digest, timing, forecast, metrics, outputGuard, pretty, modelInfo, loopbackUrl, logLine, rank, QUERY_TYPES, BASE_URL, errorText, applyExpansions, type ExpansionEntry } from "./common.mts";

const a = args(["corpus", "expand-model", "embedding-model", "out", "limit", "embedding-dim", "expansions-in", "expansions-out", "timeout-ms", "chat-url", "embedding-url"], ["help"]);
if (a.help) {
  console.log("node --import tsx tools/model-compare/recall.mts --corpus FILE --expand-model MODEL|none --embedding-model MODEL|none --out FILE [--limit N] [--expansions-in FILE] [--expansions-out FILE] [--embedding-dim N] [--timeout-ms N] [--chat-url LOOPBACK] [--embedding-url LOOPBACK]");
} else {
  const file = required(a, "corpus"), out = required(a, "out"), expandModel = required(a, "expand-model"), embeddingModel = required(a, "embedding-model");
  const chatURL = loopbackUrl(a["chat-url"]), embeddingURL = loopbackUrl(a["embedding-url"]);
  const write = outputGuard([out, a["expansions-out"] as string | undefined], [file, a["expansions-in"] as string | undefined]);
  if (expandModel !== "none" && embeddingModel === "none" && !a["expansions-in"]) throw Error("Production expansion self-test requires an embedding model");
  if (a["expansions-in"] && expandModel !== "none") throw Error("Cache replay uses --expand-model none; it never regenerates");
  const c = await corpus(file, a.limit), started = performance.now();
  const result: any = { schema: 1, tool: "model-compare-recall", status: "running", created_at: new Date().toISOString(), corpus_sha256: c.sha256,
    corpus_total: c.total, notes_measured: c.notes.length, ids: c.notes.map(n => n.id), expand_model: expandModel, embedding_model: embeddingModel,
    parameters: { default_base_url: BASE_URL, chat_base_url: chatURL, embedding_base_url: embeddingURL, think: false, temperature: 0, expand_num_ctx: generation.DEFAULT_NUM_CTX,
      expansion_timeout_ms: positive(a["timeout-ms"], 120_000), self_test: "SearchIndex.recallHybrid(k=10, allow_private=true)",
      rank_k: c.notes.length, field_boost: FIELD_BOOST, vector_prefix: "raw production input", hybrid_arm_cap: 50,
      mrr_definition: "reciprocal of rank in the complete returned recall pool; missing=0 (hybrid retains production arm caps)" }, rows: [], summary: [], issues: [] };
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(c.notes, embeddingModel, a["embedding-dim"], embeddingURL);
    result.embedding_metadata = f.embeddingInfo; result.dimension_probe = f.dimensionProbe;
    const entries: ExpansionEntry[] = [];
    let expansionInfo: any = null;
    if (a["expansions-in"]) {
      const cache = await applyExpansions(f, a["expansions-in"] as string);
      entries.push(...cache.entries.filter((e: ExpansionEntry) => result.ids.includes(e.id)));
      result.expansion_mode = "replay";
      result.expansion_selection_provider = cache.selection_embedding_model;
      result.expansion_source_corpus_sha256 = cache.corpus_sha256;
      expansionInfo = cache.model_metadata;
      result.expansion_source_model = cache.model;
    } else if (expandModel !== "none") {
      expansionInfo = await modelInfo(expandModel, chatURL);
      const client = generation.ollamaChat({ baseURL: chatURL, model: expandModel, timeoutMs: result.parameters.expansion_timeout_ms,
        numCtx: generation.DEFAULT_NUM_CTX, redirect: "error" });
      let raw = "", generationMs = 0, failures = 0;
      const current = f;
      const expander = new core.TriggerExpander(current.vault, current.embeddings!, { backfillOnStart: false,
        chat: p => current.serial.run(async () => { const t = performance.now(); try { raw = await client(p); return raw; } finally { generationMs = performance.now() - t; } }),
        selfTest: async (phrase, id) => (await current.search.recallHybrid(phrase, { k: 10, allow_private: true })).some(h => h.id === id) });
      result.expansion_order = current.vault.list().map(m => m.fm.id);
      for (const m of current.vault.list()) {
        const entry: any = { id: m.fm.id, source_hash: core.sourceHash(m), prompt_sha256: digest(core.buildExpandPrompt(m)), status: "not-attempted", phrases: [] };
        entries.push(entry);
        // Same five-consecutive-generation-failures brake as production backfill.
        if (failures >= 5) { entry.status = "production-breaker"; continue; }
        raw = ""; generationMs = 0; const t = performance.now();
        try {
          const kept = await expander.expand(m.fm.id);
          entry.raw = raw; entry.parsed_candidates = core.parseExpansions(raw, m.fm.recall_when, 5);
          entry.phrases = kept ?? [];
          entry.status = kept === null ? "generation-empty-or-not-written" : "written";
          failures = raw.trim() ? 0 : failures + 1;
          if (!raw.trim()) result.issues.push({ id: m.fm.id, issue: "empty content with think:false; no workaround/no stamp" });
        } catch (e) { entry.status = "error"; entry.error = errorText(e); failures++; result.issues.push({ id: m.fm.id, issue: entry.error }); }
        entry.duration_ms = performance.now() - t; entry.generation_ms = generationMs;
        await current.drain();
        console.error(`[model-compare] expanded ${entries.length}/${c.notes.length}: ${logLine(m.fm.id)} (${entry.phrases.length} phrases)`);
      }
      result.expansion_mode = "generated";
      result.expansion_selection_provider = embeddingModel;
    } else {
      result.expansion_mode = "none";
      for (const m of f.vault.list()) entries.push({ id: m.fm.id, source_hash: core.sourceHash(m), prompt_sha256: digest(core.buildExpandPrompt(m)), status: "disabled", phrases: [] });
    }
    result.expansion_metadata = expansionInfo;
    result.expansions = entries;
    result.expansion_stats = { notes_without_usable_phrases: entries.filter(e => !e.phrases.length).length,
      no_usable_ratio: entries.filter(e => !e.phrases.length).length / c.notes.length, phrase_count: entries.reduce((n, e) => n + e.phrases.length, 0),
      generation_calls_this_run: result.expansion_mode === "generated" ? entries.filter(e => e.duration_ms !== undefined).length : 0,
      per_note_timing: timing(result.expansion_mode === "generated" ? entries.flatMap(e => e.duration_ms === undefined ? [] : [e.duration_ms]) : []),
      cached_source_timing: result.expansion_mode === "replay" ? timing(entries.flatMap(e => e.duration_ms === undefined ? [] : [e.duration_ms])) : null };
    result.estimate_180_expansions = forecast(result.expansion_mode === "generated" ? entries.filter(e => e.status === "written").flatMap(e => e.duration_ms === undefined ? [] : [e.duration_ms]) : [], 180);
    if (a["expansions-out"]) await write(a["expansions-out"] as string, pretty({ schema: 1, corpus_sha256: c.sha256,
      model: result.expansion_source_model ?? expandModel, model_metadata: expansionInfo, selection_embedding_model: result.expansion_selection_provider ?? null,
      parameters: result.parameters, entries }));
    const lanes = embeddingModel === "none" ? ["bm25"] as const : ["bm25", "hybrid", "vector"] as const;
    for (const n of c.notes) for (const kind of QUERY_TYPES) for (const lane of lanes) {
      const query = n.queries[kind], t = performance.now(), hits = await rank(f, query, lane, c.notes.length);
      const index = hits.findIndex(h => h.id === n.id);
      result.rows.push({ query_id: `${n.id}/${kind}`, kind, note_lang: n.lang, query_lang: kind === "far_xlang" ? (n.lang === "de" ? "en" : "de") : n.lang, query, target_id: n.id, lane, rank: index < 0 ? null : index + 1,
        duration_ms: performance.now() - t, hits });
    }
    for (const lane of lanes) for (const kind of QUERY_TYPES) {
      const rows = result.rows.filter((r: any) => r.lane === lane && r.kind === kind);
      result.summary.push({ lane, kind, ...metrics(rows.map((r: any) => r.rank)), latency: timing(rows.map((r: any) => r.duration_ms)) });
    }
    result.embedding_stats = f.embeddingStats();
    result.status = result.issues.length ? "completed-with-issues" : "completed";
    console.table(result.summary.map(({ lane, kind, n, r_at_1, r_at_3, r_at_5, mrr }: any) => ({ lane, kind, n, "R@1": r_at_1.toFixed(3), "R@3": r_at_3.toFixed(3), "R@5": r_at_5.toFixed(3), MRR: mrr.toFixed(3) })));
  } catch (e) { result.status = "failed"; result.error = errorText(e); process.exitCode = 1; console.error(logLine(result.error)); }
  finally { result.total_ms = performance.now() - started; await write(out, pretty(result)); if (f) await f.close(); }
}
