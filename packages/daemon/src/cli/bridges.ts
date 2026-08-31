/**
 * `bastra bridges` — the shared learned-recall layer (#120).
 *
 * Bridges live IN the Bastra Commons repo (alongside recipes/ and verifications/),
 * under bridges/<lang>/*.json. So they share the Commons clone, sync, and PR-gated
 * contribution model — `bastra commons enable` clones the repo; `bastra bridges enable`
 * just flips the separate sharedRecall toggle so the daemon loads the bridge pool
 * from that clone and uses it to widen recall queries. The daemon NEVER writes the
 * synced repo; sharing goes through PRs.
 *
 * A bridge is a language-tagged vocabulary-expansion rule {lang, trigger_terms,
 * expansion_terms} — no memory id or vault content (see learned-recall/bridges.ts).
 *
 * Local-first: toggle off ⇒ the daemon never builds the pool; nothing leaves the
 * machine. Contribution is opt-in and PR-only — there is no auto-egress.
 * ("Never writes" means the SYNCED content / no egress: local mints — CLI or
 * the daemon's own #353 schedule — write new local bridge files into the same
 * clone; they only ever leave via the PR flow.)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "@bastra-recall/core";
import {
  getSharedRecallEnabled,
  setSharedRecallEnabled,
  getSharedRecallLanguage,
  setSharedRecallLanguage,
  clearSharedRecallLanguage,
  resolveGenerationModel,
} from "../settings.js";
import { envFirst } from "../env.js";
import { commonsPath, COMMONS_REPO_URL } from "./commons.js";
import { BridgePool, distinctiveTerms, MIN_BRIDGE_EVIDENCE } from "../learned-recall/bridges.js";
import { readEventLog, writeBridges, extractCandidatePools, harvestFarBridges } from "../learned-recall/harvest.js";
import { runInBandMint, readLastMint } from "../learned-recall/mint-job.js";
import { ollamaChat, listOllamaModels, resolveRerankModel } from "../learned-recall/reranker.js";
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from "../learned-recall/language.js";

/** Bridges share the Commons clone. Env override kept for tests/relocation. */
export function bridgesPath(): string {
  return process.env.BASTRA_BRIDGES_PATH ?? commonsPath();
}

export async function cmdBridges(opts: { sub: string | null; positional?: string[] }): Promise<number> {
  const sub = opts.sub ?? "status";
  switch (sub) {
    case "enable": {
      await setSharedRecallEnabled(true);
      const cloned = existsSync(join(commonsPath(), ".git"));
      const hasPool = existsSync(join(bridgesPath(), "bridges"));
      process.stdout.write("✓ shared learned-recall enabled — restart the daemon to load it\n");
      if (!cloned) {
        process.stdout.write("  note: bridges live in the Commons repo — run 'bastra commons enable' to clone it first\n");
      } else if (!hasPool) {
        process.stdout.write("  note: the Commons repo has no bridges/ yet; the pool is empty (recall unchanged) until bridges are added\n");
      }
      return 0;
    }
    case "disable": {
      await setSharedRecallEnabled(false);
      process.stdout.write("✓ shared learned-recall disabled — restart the daemon to apply\n");
      return 0;
    }
    case "update": {
      // Bridges sync with the Commons repo; there is no separate remote to pull.
      process.stdout.write("bridges sync with the Commons repo — run 'bastra commons update' to pull the latest\n");
      return 0;
    }
    case "language": {
      const lang = opts.positional?.[2] ?? null;
      if (!lang) {
        const cur = await getSharedRecallLanguage();
        process.stdout.write(`query-language override: ${cur ?? "(auto-detect)"}\n`);
        return 0;
      }
      if (lang === "auto") {
        await clearSharedRecallLanguage();
        process.stdout.write("✓ query-language override cleared — auto-detect per query\n");
        return 0;
      }
      // Validate against the SAME set the daemon enforces at boot (SUPPORTED_LANGUAGES),
      // so the CLI never confirms an override the daemon would silently discard.
      if (!isSupportedLanguage(lang.toLowerCase())) {
        process.stderr.write(`✗ unsupported language '${lang}' — bridge pools exist only for: ${SUPPORTED_LANGUAGES.join(", ")} (or 'auto' to clear)\n`);
        return 2;
      }
      await setSharedRecallLanguage(lang);
      process.stdout.write(`✓ query-language override set to '${lang.toLowerCase()}'\n`);
      return 0;
    }
    case "mint": {
      // Offline harvest: reconstruct (far query → acted-on memory) reaches from the
      // telemetry log and mint bridges from them. Optional [days] limits the window.
      // Shared core with the daemon's own schedule (#353) — both record last-mint.json
      // and a bridges_mint telemetry event.
      const daysArg = opts.positional?.[2];
      const days = daysArg ? parseInt(daysArg, 10) : null;
      const vaultPath = envFirst("BASTRA_VAULT_PATH", "NEXUS_VAULT_PATH");
      if (!vaultPath) {
        process.stderr.write("✗ BASTRA_VAULT_PATH not set — cannot read memory vocabulary to mint bridges\n");
        return 1;
      }
      const vault = new Vault(vaultPath);
      await vault.init();
      const outcome = await runInBandMint({
        vault,
        bridgesRoot: bridgesPath(),
        trigger: "cli",
        days: days != null && Number.isFinite(days) ? days : null,
      });
      if (outcome.reaches === 0) {
        process.stdout.write("no acted-on reaches found in telemetry — nothing to mint yet\n");
        return 0;
      }
      process.stdout.write(
        `✓ minted ${outcome.minted} bridge(s) from ${outcome.reaches} acted-on reach(es) — ${outcome.written} written to ${join(bridgesPath(), "bridges")}\n` +
          "  a running daemon picks them up with its next scheduled mint, or restart it to load them now\n",
      );
      return 0;
    }
    case "harvest": {
      // Teacher 2: deep harvest over the #121 far slice using the local reranker.
      const daysArg = opts.positional?.[2];
      const days = daysArg ? parseInt(daysArg, 10) : null;
      const events = await readEventLog(undefined, days != null && Number.isFinite(days) ? days : null);
      const pools = extractCandidatePools(events);
      if (pools.length === 0) {
        process.stdout.write("no candidate pools in telemetry yet (needs #121 logging + some recalls) — nothing to harvest\n");
        return 0;
      }
      const vaultPath = envFirst("BASTRA_VAULT_PATH", "NEXUS_VAULT_PATH");
      if (!vaultPath) {
        process.stderr.write("✗ BASTRA_VAULT_PATH not set — cannot read memory vocabulary\n");
        return 1;
      }
      const vault = new Vault(vaultPath);
      await vault.init();
      const getMemoryInfo = (id: string): { text: string; terms: string[] } | null => {
        const m = vault.get(id);
        if (!m) return null;
        return {
          text: `${m.fm.title} — ${m.fm.summary}`,
          terms: distinctiveTerms([m.fm.title, m.fm.summary, ...m.fm.recall_when, ...m.fm.tags, m.body].join(" ")),
        };
      };
      // Probe what Ollama actually has before firing 50 chat calls: on a machine that
      // never pulled the default model, /api/chat 404s and the run dies at case 1/50
      // with a cryptic error. Resolve to an installed model (or a clear "pull it" hint).
      // #365/6: Der GEWÜNSCHTE Judge kommt aus derselben Auflösung wie im Daemon
      // (settings.ts: BASTRA_EXPAND_MODEL > BASTRA_RERANK_MODEL > generation.model
      // > GENERATION_MODEL_DEFAULT). Vorher las die CLI nur BASTRA_RERANK_MODEL und
      // fiel sonst auf DEFAULT_RERANK_MODEL zurück — ein per `bastra models set`
      // persistiertes Model wurde ignoriert. Der Settings-Key deckt per Definition
      // beide Lanes ab (doc2query UND reranking), und harvest ruft über
      // harvestFarBridges → rerank() exakt diese Lane. Auf einer 24-GB-Box, die
      // gemma4:12b persistiert hat, judgte harvest still auf gemma3:4b — und
      // verlangte im Fehlerfall sogar den Pull eines bewusst abgewählten Models.
      //
      // Bewusster Präzedenz-Wechsel, KEIN reines Superset: sind BEIDE Env-Vars
      // gesetzt, gewinnt hier ab jetzt BASTRA_EXPAND_MODEL über
      // BASTRA_RERANK_MODEL (settings.ts:381) — genau wie im Daemon. Allein
      // gesetzt pinnt BASTRA_RERANK_MODEL den Judge unverändert; nur die
      // Kollision der beiden kippt, und sie kippt zugunsten der Daemon-Parität.
      const preferred = await resolveGenerationModel();
      const ollamaURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
      let installed: string[];
      try {
        installed = await listOllamaModels();
      } catch (err) {
        process.stderr.write(
          `✗ local reranker unavailable — Ollama not reachable at ${ollamaURL} (${(err as Error).message}).\n` +
            "  start Ollama, or run 'bastra models on' to set it up.\n" +
            // #353: "Ollama is up" and "the harvest can reach it" are two different
            // facts when the address is a configured remote — name the gap.
            (process.env.BASTRA_OLLAMA_URL
              ? "  note: BASTRA_OLLAMA_URL points at a configured remote — if the reranker runs on THIS box, unset it to dial loopback.\n"
              : ""),
        );
        return 1;
      }
      const choice = resolveRerankModel(installed, preferred);
      if (!choice.model) {
        process.stderr.write(
          `✗ reranker model '${preferred}' is not pulled and no other chat model is installed.\n` +
            `  run 'ollama pull ${preferred}' (or 'bastra models set <tag>' to pick a model you already have).\n`,
        );
        return 1;
      }
      if (choice.fellBack) {
        process.stderr.write(
          `  note: '${preferred}' is not pulled — falling back to '${choice.model}'. ` +
            `run 'ollama pull ${preferred}' or 'bastra models set <tag>' to pin one.\n`,
        );
      }
      const model = choice.model;
      process.stdout.write(`harvesting far slice with local reranker (${model}) over ${pools.length} pools…\n`);
      // 8192 statt des 4096-Defaults (#366): der Rerank-Prompt ist der größte
      // im Repo. Der geloggte candidate_pool ist `Math.max(k*4, 20)` groß
      // (core/src/search.ts:310), k geht bis 20 (recall-handler.ts:33) → bis zu
      // 80 Kandidaten, und harvest.ts cappt nicht. buildRerankPrompt schneidet
      // jeden auf 200 Zeichen (reranker.ts:144) ⇒ bis ~16k Zeichen ≈ 4–5,4k
      // Tokens. In 4096 schneidet Ollama vorn ab — also Query und Top-
      // Kandidaten — und `parseRerankAnswer(answer, 80)` mintet die Bridge
      // stillschweigend aus der beschnittenen Liste.
      const result = await harvestFarBridges(pools, getMemoryInfo, ollamaChat({ model, numCtx: 8192 }), {
        onProgress: (done, total) => process.stderr.write(`  judged ${done}/${total}\r`),
      });
      // 20.08.: same evidence gate as the in-band mint — one judged reach stays an anecdote.
      const written = await writeBridges(
        bridgesPath(),
        result.bridges.filter((b) => b.evidence >= MIN_BRIDGE_EVIDENCE),
      );
      process.stdout.write(
        `\n✓ judged ${result.judged} far case(s) → minted ${result.minted} bridge(s) — ${written} written to ${join(bridgesPath(), "bridges")}\n` +
          "  restart the daemon to load them\n",
      );
      return 0;
    }
    case "contribute": {
      // Bridges are minted locally from successful recalls and contributed to the
      // Commons repo via PR (same flow as `bastra commons verify`). Deliberately
      // not auto-run: nothing leaves the machine without an explicit, reviewed PR.
      //
      // Still not wired, but the blocker moved. #121 (far-slice logging) closed
      // 2026-06-16 and `mint`/`harvest` above produce real bridges, so "there is
      // no harvested material" stopped being true. The live gate is #129: a
      // harvested bridge has promotion (`evidence`) and no demotion, the judge
      // that mints it is the judge that scores it, and `expansionsFor` perturbs
      // every query sharing a trigger term — so contribution waits on measured
      // lift over a held-out set, not on more plumbing.
      process.stderr.write(
        `contribute: not yet available — gated on #129 (verification contract: held-out lift, regression guard, demotion path). ` +
          `Minting works; what is missing is evidence that a bridge helps without regressing anything else. ` +
          `Bridges will be contributed to ${COMMONS_REPO_URL.replace(/\.git$/, "")} via PR once that gate is met.\n`,
      );
      return 1;
    }
    case "status": {
      const enabled = await getSharedRecallEnabled();
      const langOverride = await getSharedRecallLanguage();
      // Honor the same gate as the daemon (index.ts): when disabled, the pool is
      // never built — so status must not imply a live pool either.
      const pool = enabled ? BridgePool.load(bridgesPath()) : null;
      const poolStr = pool
        ? `${pool.size()} bridges (${pool.languages().map((l) => `${l}:${pool.size(l)}`).join(" ") || "none"})`
        : "(not loaded — disabled)";
      // #353: a frozen pool must be visible without counting files on disk.
      const lastMint = await readLastMint(bridgesPath());
      const mintStr = lastMint
        ? `last mint: ${lastMint.ts} — ${lastMint.minted} bridge(s) from ${lastMint.reaches} reach(es) (${lastMint.trigger}, ${lastMint.host})`
        : "last mint: never ran on this box";
      process.stdout.write(
        `shared learned-recall: ${enabled ? "enabled" : "disabled"} · language: ${langOverride ?? "auto"} · ` +
          `pool: ${poolStr} · repo: ${join(bridgesPath(), "bridges")}\n` +
          `${mintStr}\n`,
      );
      return 0;
    }
    default:
      process.stderr.write(`unknown bridges subcommand '${sub}' — use enable|disable|status|language|mint|harvest|update|contribute\n`);
      return 2;
  }
}
