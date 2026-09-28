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
 * the daemon's own #353 schedule — write new local bridge files into
 * `bridgesPath()`, ~/.bastra/bridges since #648, outside the clone; they only
 * ever leave via the PR flow.)
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SearchIndex, Vault } from "@bastra-recall/core";
import {
  getSharedRecallEnabled,
  setSharedRecallEnabled,
  getSharedRecallLanguage,
  setSharedRecallLanguage,
  clearSharedRecallLanguage,
  resolveGenerationModel,
} from "../settings.js";
import { envFirst } from "../env.js";
import { commonsPath, COMMONS_REPO_URL, verifierId } from "./commons.js";
import { BridgePool, distinctiveTerms, isConfirmedBridge, MIN_BRIDGE_EVIDENCE, scrubBridge, type Bridge } from "../learned-recall/bridges.js";
import {
  readEventLog,
  writeBridges,
  extractCandidatePools,
  harvestFarBridges,
  bridgeTeachingEvents,
  listLocalBridgeFiles,
} from "../learned-recall/harvest.js";
import { runInBandMint, readLastMint, recordHarvestRun, LAST_MINT_FILE, memoryTermsGetter } from "../learned-recall/mint-job.js";
import { contributionVerdict, verifyBridges, STRATA, SERVING_K, type VerifyReport } from "../learned-recall/verify.js";
import { ollamaChat, listOllamaModels, resolveRerankModel } from "../learned-recall/reranker.js";
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from "../learned-recall/language.js";

/** #648: the local pool (`bridges/`, `last-mint.json`) is per-box state and
 *  lives in its own directory, not inside the git checkout of the shared
 *  Commons repo. Env override kept for tests/relocation. */
export function bridgesPath(): string {
  return process.env.BASTRA_BRIDGES_PATH ?? join(homedir(), ".bastra", "bridges");
}

/**
 * #648: one-time move of a pool minted before the split, from its old home
 * inside the Commons root to `bridgesPath()`. Copies, never deletes: the old
 * files stay where they were, so a downgrade still finds them. Idempotent — it
 * only runs while the new root has no `bridges/` yet, so a pool minted at the
 * new path is never overwritten. Returns what it copied (empty when nothing).
 */
export function migrateBridgesPool(): string[] {
  const from = commonsPath();
  const to = bridgesPath();
  if (from === to || existsSync(join(to, "bridges"))) return [];
  const copied: string[] = [];
  for (const name of ["bridges", LAST_MINT_FILE]) {
    const src = join(from, name);
    const dest = join(to, name);
    if (!existsSync(src) || existsSync(dest)) continue;
    // Staged, then renamed: a copy that stops midway must not leave a partial
    // `bridges/` that the idempotence check above would take for a finished one.
    const staging = `${dest}.migrating`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    cpSync(src, staging, { recursive: true });
    renameSync(staging, dest);
    copied.push(name);
  }
  return copied;
}

/** #129: how deep the held-out check reads the ranking. Beyond it a gold
 *  counts as not found (reciprocal rank 0). */
const VERIFY_RANK_DEPTH = 50;

/** #129: the pool-level slices of the held-out check, one line each. */
export function formatVerifyReport(r: VerifyReport): string {
  const lines = [`held-out check (#129): ${r.cases} labelled case(s) from the candidate-pool log, ${r.folds} folds, near = top ${SERVING_K}`];
  for (const s of STRATA) {
    const slice = r.pool[s];
    const lift = slice.fired > 0 ? (slice.liftSum / slice.fired).toFixed(3) : "—";
    lines.push(`  ${s}: ${slice.cases} case(s), bridges fired on ${slice.fired}, mean Δ reciprocal rank ${lift}, near regressions ${slice.regressions}`);
  }
  return lines.join("\n") + "\n";
}

/** #129: write each eligible bridge, scrubbed and signed with the pseudonymous
 *  verifier id, to <bridgesPath>/contribute/<lang>/<id>.json — the files a PR
 *  would add to the Commons repo. Returns what was staged. */
function stageContribution(bridges: Bridge[]): Bridge[] {
  const verifier = verifierId();
  const date = new Date().toISOString().slice(0, 10);
  const staged: Bridge[] = [];
  for (const b of bridges) {
    const scrubbed = scrubBridge(b);
    if (!scrubbed) continue;
    const { first_seen: _local, demoted_at: _never, ...shared } = scrubbed;
    const out: Bridge = { ...shared, verifier, date };
    const dir = join(bridgesPath(), "contribute", out.lang);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${out.id}.json`), JSON.stringify(out, null, 2) + "\n", "utf8");
    staged.push(out);
  }
  return staged;
}

export async function cmdBridges(opts: { sub: string | null; positional?: string[] }): Promise<number> {
  const sub = opts.sub ?? "status";
  // #648: a CLI mint before the first daemon start after the upgrade must not
  // start a fresh pool next to the old one.
  try {
    migrateBridgesPool();
  } catch (err) {
    process.stderr.write(`! could not copy the bridges pool from ${commonsPath()} to ${bridgesPath()} (${(err as Error).message})\n`);
  }
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
        process.stdout.write(`query-language override: ${cur ?? "(auto — every language folder)"}\n`);
        return 0;
      }
      if (lang === "auto") {
        await clearSharedRecallLanguage();
        process.stdout.write("✓ query-language override cleared — queries consult every language folder\n");
        return 0;
      }
      // Validate against the SAME set the daemon enforces at boot (SUPPORTED_LANGUAGES),
      // so the CLI never confirms an override the daemon would silently discard.
      if (!isSupportedLanguage(lang.toLowerCase())) {
        process.stderr.write(`✗ unsupported language '${lang}' — the override accepts: ${SUPPORTED_LANGUAGES.join(", ")} (or 'auto' to clear; without an override every language folder is consulted, #707)\n`);
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
      // and a bridges_mint telemetry event (`harvest` below records the event too, #705).
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
        `✓ minted ${outcome.minted} bridge(s) from ${outcome.reaches} acted-on reach(es) — ${outcome.written} written to ${join(bridgesPath(), "bridges")}, ${outcome.pruned} unconfirmed expired, ${outcome.demoted ?? 0} demoted, ${outcome.archived ?? 0} archived\n` +
          "  a running daemon picks them up with its next scheduled mint, or restart it to load them now\n",
      );
      return 0;
    }
    case "harvest": {
      // Teacher 2: deep harvest over the #121 far slice using the local reranker.
      const daysArg = opts.positional?.[2];
      const days = daysArg ? parseInt(daysArg, 10) : null;
      const events = await readEventLog(undefined, days != null && Number.isFinite(days) ? days : null);
      // #704: the far harvest learns from the same origins as the in-band mint.
      const pools = extractCandidatePools(bridgeTeachingEvents(events));
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
      // Same evidence gate as the in-band mint (#672: a first judged reach is
      // written unconfirmed; the next mint pass expires it unless confirmed).
      const written = await writeBridges(
        bridgesPath(),
        result.bridges.filter((b) => b.evidence >= MIN_BRIDGE_EVIDENCE),
      );
      // #705: the doctor's bridge note reads bridges_mint events; without one a
      // pool the harvest filled reported "written 0".
      await recordHarvestRun({ minted: result.minted, reaches: result.judged, written });
      process.stdout.write(
        `\n✓ judged ${result.judged} far case(s) → minted ${result.minted} bridge(s) — ${written} written to ${join(bridgesPath(), "bridges")}\n` +
          "  restart the daemon to load them\n",
      );
      return 0;
    }
    case "verify":
    case "contribute": {
      // #129: a bridge may leave this machine only after the held-out check in
      // learned-recall/verify.ts: k-fold over the #121 candidate-pool log, lift
      // ≥ 0 in every slice it fires on, no near regression, not below the
      // foreign-expansion null, confirmed on independent occasions, not demoted.
      // `verify` prints the verdicts; `contribute` also stages the eligible
      // bridges (scrubbed) for a reviewed PR. Nothing is pushed from here — the
      // PR is opened by a person who has read what it carries.
      const daysArg = opts.positional?.[2];
      const days = daysArg ? parseInt(daysArg, 10) : null;
      const vaultPath = envFirst("BASTRA_VAULT_PATH", "NEXUS_VAULT_PATH");
      if (!vaultPath) {
        process.stderr.write("✗ BASTRA_VAULT_PATH not set — the held-out check ranks against the vault\n");
        return 1;
      }
      const local = (await listLocalBridgeFiles(bridgesPath()))
        .map((f) => f.bridge)
        .filter((b): b is Bridge => typeof b.id === "string" && typeof b.lang === "string" && Array.isArray(b.trigger_terms) && Array.isArray(b.expansion_terms) && typeof b.evidence === "number");
      // Only a confirmed, undemoted bridge can pass; the rest is not measured.
      const only = new Set(local.filter((b) => isConfirmedBridge(b) && typeof b.demoted_at !== "string").map((b) => b.id));
      const events = bridgeTeachingEvents(await readEventLog(undefined, days != null && Number.isFinite(days) ? days : null));
      const vault = new Vault(vaultPath);
      await vault.init();
      const search = new SearchIndex(vault);
      search.start();
      let report: VerifyReport;
      try {
        report = verifyBridges({
          events,
          getMemoryTerms: memoryTermsGetter(vault),
          rank: (q) => search.recall(q, { k: VERIFY_RANK_DEPTH, allow_private: true }).map((h) => h.id),
          only,
        });
      } finally {
        search.stop();
        await vault.stop();
      }
      process.stdout.write(formatVerifyReport(report));
      const eligible: Bridge[] = [];
      for (const b of local) {
        const verdict = contributionVerdict(b, report.perBridge.get(b.id));
        process.stdout.write(`  ${verdict.eligible ? "✓" : "·"} ${b.id} [${b.lang}] ${b.trigger_terms.join(" ")}${verdict.eligible ? "" : ` — ${verdict.reasons.join("; ")}`}\n`);
        if (verdict.eligible) eligible.push(b);
      }
      process.stdout.write(`${eligible.length} of ${local.length} local bridge(s) pass the #129 gate\n`);
      if (sub === "verify" || eligible.length === 0) return 0;
      const staged = stageContribution(eligible);
      process.stdout.write(
        `✓ staged ${staged.length} scrubbed bridge(s) in ${join(bridgesPath(), "contribute")}\n` +
          `  review them, then open a PR adding them under bridges/<lang>/ to ${COMMONS_REPO_URL.replace(/\.git$/, "")}\n`,
      );
      return 0;
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
      process.stderr.write(`unknown bridges subcommand '${sub}' — use enable|disable|status|language|mint|harvest|update|verify|contribute\n`);
      return 2;
  }
}
