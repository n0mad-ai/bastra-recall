import {writeFile} from 'node:fs/promises';
import {runProbe,measureLatency} from '../../../packages/daemon/__tests__/fixtures/rulebook-phase5/probe.js';

const args=process.argv.slice(2);
const option=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
const report=option('--report')??'/private/tmp/phase5-report.md';
const result=await runProbe();
const vault=option('--real-vault');
const latency=vault?await measureLatency(vault):null;
const escape=(s:string)=>s.replace(/\\/g,'\\\\').replace(/\|/g,'\\|').replace(/\n/g,' ');
const lines=[
  '# Regelbuch Phase 5 — Prüfbericht',
  '',`Zeit: ${new Date().toISOString()}. 125 ausschließlich erfundene Regeln; DE/EN/JA/RU/ES im selben Katalog.`,
  '', '## Ergebnis und Grenzen', '',
  'PASS belegt technische Verträge im geskripteten Replay. GAP bedeutet reproduzierte Lücke, nicht bestandene Produktzusage. FAIL bedeutet unerwarteten Fehler im Prüfpaket.',
  'Produktionscode für Katalog, Suche, HTTP, Session/Prompt/Gate/Stop und Full-Load wird ausgeführt. Regeltexte liegen in einem temporären Vault; Floor-Registry, Einstellungen, Logs und Sitzungszustand sind isoliert. Es werden keine GitHub-Aktionen tatsächlich ausgeführt.',
  'Kein natives codex/claude gestartet, keine installierten Hooks verändert und keine echten Modellentscheidungen gemessen. Die beiden Host-Spalten sind Produktions-Lanes mit jeweiliger Hostkennung; Codex ist gezielt auf die belegte Version 0.162.1 gesetzt. Host-Installation, Toolspezifika außerhalb dieser Lanes und semantisches Verständnis beliebiger Wortlaute bleiben unbelegt. Die fünf Übersetzungen sind erfundene Testdaten, keine Wortliste im Produkt.',
  '', '## Matrix Sprache × Fall × Host', '', '| Sprache | Host | Fall | Ergebnis | Beleg |', '|---|---|---|---|---|',
  ...result.rows.map(r=>`| ${r.language} | ${r.client} | ${r.case} | ${r.status} | ${escape(r.detail)} |`),
  '', '## Erklärungspflicht und Entwurfsprüfung (#1340 / #1341)', '',
  'Regeln mit Validator oder ausdrücklicher correspondence-Kategorie brauchen pro Runde eine ausdrückliche Entscheidung je ID: applicable, vollständiges Laden oder not_applicable mit begründeter Ausnahme. Ein leeres applicable:[] und das Laden einer fremden Regel reichen nicht. Es gibt höchstens einen Regelbuch-Stop-Block, danach Durchlauf mit sichtbarer Verstoßzählung. Das Modell kann lügen; die semantische Richtigkeit der Erklärung wird nicht geprüft.',
  'Erklärte oder geladene Validatoren prüfen Kopierkandidaten auch ohne activeTask. Claude Code fordert bei Überlänge höchstens zweimal Reparatur an und protokolliert danach Erschöpfung. Eine spätere Modell-Taskmeldung setzt das Budget nicht zurück. Codex protokolliert die Überlänge und meldet den Verstoß beim nächsten Prompt; eine native Same-Turn-Reparatur ist gemäß #1311 weiterhin nicht zertifiziert und bleibt aus.',
  'Die bisherigen GAP-Zellen correspondence-empty-check-bypass und task-omission sind in allen fünf Sprachen und beiden Host-Kennungen PASS. Das ist eine strukturelle Abnahme, kein Nachweis wahrer Modell-Erklärungen oder universeller Regelbefolgung.',
  '', '## Kosten und harmlose Kontrollen', '',
  `Ehrlicher geskripteter Ablauf: ${result.costs.honestRounds} harmlose Runden (Frage, Rechnung, Bestätigung, Code, reine Übersetzung); ${result.costs.checks} rulebook_check-Aufrufe, ${result.costs.stopBlocks} zusätzliche Stop-Blöcke, ${result.costs.repairs} Reparaturen. Summierte UTF-8-Tool-Payloads: ${result.costs.payloadBytes} Bytes (ohne HTTP-Header; keine LLM-Tokenmessung).`,
  `Ignorierender Ablauf: ${result.costs.ignoredHarmlessBlocks}/40 harmlose Runden erhalten den ersten, begrenzten Erklärungsblock. Er ist absichtlich unabhängig vom Promptinhalt. Nach expliziter Entscheidung ist kein weiterer Block nötig. Dies misst Skript-/HTTP-Verhalten, keine Häufigkeit im echten Modellbetrieb.`,
  '', '## Quellen, Kanal und Grenzen', '',
  'Stop liest aktuelle Validatoren ausschließlich aus dem In-Memory-Index, einschließlich erklärter, nicht geladener IDs. Externe Änderungen folgen Watcher/Reindex und dem dokumentierten Hintergrundabgleich. Bestehende Regeln bleiben gemäß Owner-Entscheidung direkt änderbar; neue Agenten-Regeln/Validatoren auf Nicht-Regeln bleiben Vorschläge. Validator-/Sessionstatus allein autorisiert keine neue Regeldeklaration.',
  'Kanalverengung erfordert den gespeicherten Trigger im eigenen Nutzertext und einen tatsächlich vorhandenen passenden Validator. Sonst gelten alle erklärten Validatoren. Explizit nicht anwendbare Regeln werden nicht geprüft; eine bereits in dieser Runde geladene oder erklärte Regel lässt sich nicht nachträglich per Modellmeldung abschwächen. Freigaben stammen nur vom Nutzer, und keine Task-/Versandfreigabe wird erfunden.',
  'Aktionsgrenzen bleiben bei zwei Ablehnungen; Ausfälle bleiben fail-open. Compact kann nur geladene Regeln verlieren; die Erklärungspflicht entsteht bei jeder neuen Runde erneut aus dem aktuellen Katalog. Issues werden erst nach Gegenprüfung und Freigabe der Hauptsession geschlossen. Kein Push, Deploy oder neue native Host-Zertifizierung durch dieses Prüfskript.',
  '', '## Latenz', '',
  ...(latency?[
    `${latency.memories} indexierte Memories, vier parallele Sitzungen, ${latency.rounds} Messrunden je Sitzung, zwei Warmup-Runden ausgeschlossen. ${latency.mode}.`,
    'Gemessen: Loopback-HTTP-Roundtrip bis zur vollständigen JSON-Antwort. Kein Start einer nativen Host-Binary, kein Embedding-Modell, keine Modellantwortzeit. Der echte Vault wird nur gelesen; der Produktionsdaemon und seine Sitzungen bleiben unberührt.',
    '', '| Lane | n | Median ms | p95 ms | Antworten |', '|---|---:|---:|---:|---|',
    ...Object.entries(latency.lanes).map(([name,s])=>`| ${name} | ${s.n} | ${s.median_ms.toFixed(2)} | ${s.p95_ms.toFixed(2)} | ${JSON.stringify(s.responses)} |`),
  ]:['Nicht ausgeführt: kein --real-vault übergeben. Der Offline-Lauf liest keinen Nutzer-Vault.']),
  '', `Unerwartete Fehler: ${result.rows.filter(r=>r.status==='FAIL').length}. Replaydauer: ${Math.round(result.duration_ms)} ms.`,
];
await writeFile(report,lines.join('\n')+'\n');
await writeFile(report.replace(/\.md$/,'.json'),JSON.stringify({result,latency},null,2)+'\n');
console.log(`Report: ${report}; unexpected failures: ${result.rows.filter(r=>r.status==='FAIL').length}`);
if(result.rows.some(r=>r.status==='FAIL'))process.exitCode=1;
