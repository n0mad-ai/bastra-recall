/**
 * The words `bastra bridges` prints, by language.primary (#1602): English is
 * the default and the fallback (byte-identical to before), German complete.
 * Text the product writes — never matched against user text. The held-out
 * report lines (formatVerifyReport) and the gate's reasons stay English.
 */
const en = {
  migrateFailed: (from: string, to: string, message: string) =>
    `! could not copy the bridges pool from ${from} to ${to} (${message})\n`,
  enabled: "✓ shared learned-recall enabled — restart the daemon to load it\n",
  noClone: "  note: bridges live in the Commons repo — run 'bastra commons enable' to clone it first\n",
  noPool:
    "  note: the Commons repo has no bridges/ yet; the pool is empty (recall unchanged) until bridges are added\n",
  disabled: "✓ shared learned-recall disabled — restart the daemon to apply\n",
  update: "bridges sync with the Commons repo — run 'bastra commons update' to pull the latest\n",
  languageOverride: (current: string | null | undefined) =>
    `query-language override: ${current ?? "(auto — every language folder)"}\n`,
  languageCleared: "✓ query-language override cleared — queries consult every language folder\n",
  languageUnsupported: (lang: string, supported: string) =>
    `✗ unsupported language '${lang}' — the override accepts: ${supported} (or 'auto' to clear; without an override every language folder is consulted, #707)\n`,
  languageSet: (lang: string) => `✓ query-language override set to '${lang}'\n`,
  liveState: (live: boolean) =>
    `query expansion: ${live ? "live — bridges widen recall queries" : "shadow — fires are logged (bridge_expansion, applied: false), ranking unchanged"}\n`,
  liveSwitched: (on: boolean): string =>
    on
      ? "✓ query expansion live — bridges widen recall queries; restart the daemon to apply\n"
      : "✓ query expansion back to shadow — restart the daemon to apply\n",
  noVaultMint: "✗ BASTRA_VAULT_PATH not set — cannot read memory vocabulary to mint bridges\n",
  nothingToMint: "no acted-on reaches found in telemetry — nothing to mint yet\n",
  minted: (
    o: { minted: number; reaches: number; written: number; pruned: number; demoted: number; archived: number },
    dir: string
  ) =>
    `✓ minted ${o.minted} bridge(s) from ${o.reaches} acted-on reach(es) — ${o.written} written to ${dir}, ${o.pruned} unconfirmed expired, ${o.demoted} demoted, ${o.archived} archived\n` +
    "  a running daemon picks them up with its next scheduled mint, or restart it to load them now\n",
  noPools: "no candidate pools in telemetry yet (needs #121 logging + some recalls) — nothing to harvest\n",
  noVaultHarvest: "✗ BASTRA_VAULT_PATH not set — cannot read memory vocabulary\n",
  ollamaDown: (url: string, message: string, remote: boolean) =>
    `✗ local reranker unavailable — Ollama not reachable at ${url} (${message}).\n` +
    "  start Ollama, or run 'bastra models on' to set it up.\n" +
    (remote
      ? "  note: BASTRA_OLLAMA_URL points at a configured remote — if the reranker runs on THIS box, unset it to dial loopback.\n"
      : ""),
  modelMissing: (preferred: string) =>
    `✗ reranker model '${preferred}' is not pulled and no other chat model is installed.\n` +
    `  run 'ollama pull ${preferred}' (or 'bastra models set <tag>' to pick a model you already have).\n`,
  fellBack: (preferred: string, model: string) =>
    `  note: '${preferred}' is not pulled — falling back to '${model}'. ` +
    `run 'ollama pull ${preferred}' or 'bastra models set <tag>' to pin one.\n`,
  harvesting: (model: string, pools: number) =>
    `harvesting far slice with local reranker (${model}) over ${pools} pools…\n`,
  judging: (done: number, total: number) => `  judged ${done}/${total}\r`,
  harvested: (judged: number, minted: number, written: number, dir: string) =>
    `\n✓ judged ${judged} far case(s) → minted ${minted} bridge(s) — ${written} written to ${dir}\n` +
    "  restart the daemon to load them\n",
  noVaultVerify: "✗ BASTRA_VAULT_PATH not set — the held-out check ranks against the vault\n",
  passGate: (eligible: number, local: number) => `${eligible} of ${local} local bridge(s) pass the #129 gate\n`,
  staged: (n: number, dir: string, repo: string) =>
    `✓ staged ${n} scrubbed bridge(s) in ${dir}\n` +
    `  review them, then open a PR adding them under bridges/<lang>/ to ${repo}\n`,
  poolNone: "none",
  poolCount: (n: number, languages: string) => `${n} bridges (${languages})`,
  poolOff: "(not loaded — disabled)",
  lastMint: (m: { ts: string; minted: number; reaches: number; trigger: string; host: string }) =>
    `last mint: ${m.ts} — ${m.minted} bridge(s) from ${m.reaches} reach(es) (${m.trigger}, ${m.host})`,
  neverMinted: "last mint: never ran on this box",
  status: (
    enabled: boolean,
    lang: string | null | undefined,
    live: boolean,
    pool: string,
    repo: string,
    mint: string
  ) =>
    `shared learned-recall: ${enabled ? "enabled" : "disabled"} · language: ${lang ?? "auto"} · ` +
    `query expansion: ${live ? "live" : "shadow"} · ` +
    `pool: ${pool} · repo: ${repo}\n` +
    `${mint}\n`,
  unknownSub: (sub: string) =>
    `unknown bridges subcommand '${sub}' — use enable|disable|status|language|live|mint|harvest|update|verify|contribute\n`,
};
export type BridgesWords = typeof en;

const de: BridgesWords = {
  migrateFailed: (from: string, to: string, message: string) =>
    `! der Brücken-Pool ließ sich nicht von ${from} nach ${to} kopieren (${message})\n`,
  enabled: "✓ gemeinsame gelernte Suche eingeschaltet — den Daemon neu starten, um sie zu laden\n",
  noClone: "  Hinweis: Brücken liegen im Commons-Repo — zuerst 'bastra commons enable' ausführen, um es zu klonen\n",
  noPool:
    "  Hinweis: das Commons-Repo hat noch kein bridges/; der Pool bleibt leer (Suche unverändert), bis Brücken dazukommen\n",
  disabled: "✓ gemeinsame gelernte Suche ausgeschaltet — den Daemon neu starten, damit es gilt\n",
  update: "Brücken kommen mit dem Commons-Repo — 'bastra commons update' holt den neuesten Stand\n",
  languageOverride: (current: string | null | undefined) =>
    `festgelegte Suchsprache: ${current ?? "(automatisch — jeder Sprachordner)"}\n`,
  languageCleared: "✓ festgelegte Suchsprache entfernt — Suchen ziehen jeden Sprachordner heran\n",
  languageUnsupported: (lang: string, supported: string) =>
    `✗ Sprache '${lang}' wird nicht unterstützt — möglich sind: ${supported} (oder 'auto' zum Entfernen; ohne Festlegung wird jeder Sprachordner herangezogen, #707)\n`,
  languageSet: (lang: string) => `✓ Suchsprache festgelegt auf '${lang}'\n`,
  liveState: (live: boolean) =>
    `Anfrageerweiterung: ${live ? "live — Brücken erweitern Suchanfragen" : "Schatten — Auslösungen werden protokolliert (bridge_expansion, applied: false), Rangfolge unverändert"}\n`,
  liveSwitched: (on: boolean): string =>
    on
      ? "✓ Anfrageerweiterung live — Brücken erweitern Suchanfragen; den Daemon neu starten, damit es gilt\n"
      : "✓ Anfrageerweiterung zurück im Schatten — den Daemon neu starten, damit es gilt\n",
  noVaultMint:
    "✗ BASTRA_VAULT_PATH ist nicht gesetzt — das Vokabular der Memories lässt sich nicht lesen, um Brücken zu bilden\n",
  nothingToMint: "keine genutzten Treffer in der Telemetrie gefunden — noch nichts zu bilden\n",
  minted: (
    o: { minted: number; reaches: number; written: number; pruned: number; demoted: number; archived: number },
    dir: string
  ) =>
    `✓ ${o.minted} Brücke(n) aus ${o.reaches} genutzten Treffer(n) gebildet — ${o.written} nach ${dir} geschrieben, ${o.pruned} unbestätigte abgelaufen, ${o.demoted} herabgestuft, ${o.archived} archiviert\n` +
    "  ein laufender Daemon übernimmt sie mit seiner nächsten geplanten Bildung; für sofort neu starten\n",
  noPools:
    "noch keine Kandidaten-Pools in der Telemetrie (braucht #121-Protokoll und einige Suchen) — nichts zu ernten\n",
  noVaultHarvest: "✗ BASTRA_VAULT_PATH ist nicht gesetzt — das Vokabular der Memories lässt sich nicht lesen\n",
  ollamaDown: (url: string, message: string, remote: boolean) =>
    `✗ lokales Reranking nicht verfügbar — Ollama unter ${url} nicht erreichbar (${message}).\n` +
    "  Ollama starten oder 'bastra models on' ausführen, um es einzurichten.\n" +
    (remote
      ? "  Hinweis: BASTRA_OLLAMA_URL zeigt auf ein eingerichtetes entferntes Gerät — läuft das Reranking auf DIESEM Gerät, die Variable entfernen.\n"
      : ""),
  modelMissing: (preferred: string) =>
    `✗ das Reranking-Modell '${preferred}' ist nicht geladen und kein anderes Chat-Modell installiert.\n` +
    `  'ollama pull ${preferred}' ausführen (oder 'bastra models set <tag>', um ein vorhandenes Modell zu wählen).\n`,
  fellBack: (preferred: string, model: string) =>
    `  Hinweis: '${preferred}' ist nicht geladen — es wird '${model}' genutzt. ` +
    `'ollama pull ${preferred}' oder 'bastra models set <tag>' legt eines fest.\n`,
  harvesting: (model: string, pools: number) =>
    `ferne Fälle werden mit lokalem Reranking (${model}) über ${pools} Pools geerntet …\n`,
  judging: (done: number, total: number) => `  bewertet ${done}/${total}\r`,
  harvested: (judged: number, minted: number, written: number, dir: string) =>
    `\n✓ ${judged} ferne(n) Fall/Fälle bewertet → ${minted} Brücke(n) gebildet — ${written} nach ${dir} geschrieben\n` +
    "  den Daemon neu starten, um sie zu laden\n",
  noVaultVerify: "✗ BASTRA_VAULT_PATH ist nicht gesetzt — die Gegenprobe misst die Rangfolge am Vault\n",
  passGate: (eligible: number, local: number) =>
    `${eligible} von ${local} lokalen Brücke(n) bestehen die #129-Prüfung\n`,
  staged: (n: number, dir: string, repo: string) =>
    `✓ ${n} bereinigte Brücke(n) in ${dir} bereitgelegt\n` +
    `  prüfen, dann einen PR öffnen, der sie unter bridges/<lang>/ zu ${repo} hinzufügt\n`,
  poolNone: "keine",
  poolCount: (n: number, languages: string) => `${n} Brücken (${languages})`,
  poolOff: "(nicht geladen — ausgeschaltet)",
  lastMint: (m: { ts: string; minted: number; reaches: number; trigger: string; host: string }) =>
    `letzte Bildung: ${m.ts} — ${m.minted} Brücke(n) aus ${m.reaches} Treffer(n) (${m.trigger}, ${m.host})`,
  neverMinted: "letzte Bildung: lief auf diesem Gerät noch nie",
  status: (
    enabled: boolean,
    lang: string | null | undefined,
    live: boolean,
    pool: string,
    repo: string,
    mint: string
  ) =>
    `gemeinsame gelernte Suche: ${enabled ? "eingeschaltet" : "ausgeschaltet"} · Sprache: ${lang ?? "automatisch"} · ` +
    `Anfrageerweiterung: ${live ? "live" : "Schatten"} · ` +
    `Pool: ${pool} · Repo: ${repo}\n` +
    `${mint}\n`,
  unknownSub: (sub: string) =>
    `unbekannter Brücken-Unterbefehl '${sub}' — möglich sind enable|disable|status|language|live|mint|harvest|update|verify|contribute\n`,
};

export const BRIDGES_WORDS: Readonly<Record<string, BridgesWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function bridgesWordsIn(language: string | undefined): BridgesWords {
  return BRIDGES_WORDS[language ?? "en"] ?? en;
}
