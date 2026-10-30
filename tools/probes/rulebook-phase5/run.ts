import {writeFile} from 'node:fs/promises';
import {runProbe,measureLatency} from '../../../packages/daemon/__tests__/fixtures/rulebook-phase5/probe.js';

const args=process.argv.slice(2);
const option=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
const report=option('--report')??'/private/tmp/phase5-report.md';
const result=await runProbe();
const vault=option('--real-vault');
const latency=vault?await measureLatency(vault):null;
const escape=(s:string)=>s.replace(/\|/g,'\\|').replace(/\n/g,' ');
const lines=[
  '# Regelbuch Phase 5 — Prüfbericht',
  '',`Zeit: ${new Date().toISOString()}. 125 ausschließlich erfundene Regeln; DE/EN/JA/RU/ES im selben Katalog.`,
  '', '## Ergebnis und Grenzen', '',
  'PASS belegt technische Verträge im geskripteten Replay. GAP bedeutet reproduzierte Lücke, nicht bestandene Produktzusage. FAIL bedeutet unerwarteten Fehler im Prüfpaket.',
  'Produktionscode für Katalog, Suche, HTTP, Session/Prompt/Gate/Stop und Full-Load wird ausgeführt. Regeltexte liegen in einem temporären Vault; Floor-Registry, Einstellungen, Logs und Sitzungszustand sind isoliert. Es werden keine GitHub-Aktionen tatsächlich ausgeführt.',
  'Kein natives codex/claude gestartet, keine installierten Hooks verändert und keine echten Modellentscheidungen gemessen. Die beiden Host-Spalten sind Produktions-Lanes mit jeweiliger Hostkennung; Codex ist gezielt auf die belegte Version 0.162.1 gesetzt. Host-Installation, Toolspezifika außerhalb dieser Lanes und semantisches Verständnis beliebiger Wortlaute bleiben unbelegt. Die fünf Übersetzungen sind erfundene Testdaten, keine Wortliste im Produkt.',
  '', '## Matrix Sprache × Fall × Host', '', '| Sprache | Host | Fall | Ergebnis | Beleg |', '|---|---|---|---|---|',
  ...result.rows.map(r=>`| ${r.language} | ${r.client} | ${r.case} | ${r.status} | ${escape(r.detail)} |`),
  '', '## Gefundene Lücken und Vorschläge', '',
  '1. Fremde Nachricht: applicable:[] vor dem ersten Stop umgeht den Konventionsabruf in allen fünf Sprachen und beiden Host-Lanes. Ein Index und eine ehrliche Selbstauskunft erzwingen keine semantische Erkennung. Vorschlag ohne Wortliste: Bei vorhandener Kategorie correspondence am Antwortende eine konkrete Ladepflicht für diese Kategorie setzen; keine leere Selbstauskunft als Ersatz. Das ist absichtlich breiter und träfe auch harmlose Runden. Alternativ kann ein unabhängiger Modellprüfer die Kategorien auswählen; das wäre keine harte Garantie und muss gesondert evaluiert werden. Nicht implementiert.',
  '2. Task-Weglassen: je Sprache/Host drei Formen (Prosa, Codezaun, Zitat), insgesamt 30/30 überlange Ausgaben ohne Task umgehen die Längenreparatur, obwohl der Validator geladen ist. Auf Claude Code fordern alle 15 Kontrollen mit explizitem Review-Task Reparatur an. Vorschlag: Für geladene Korrespondenz-Kategorien einen expliziten, ausgabelokalen Vertrag für Entwürfe verwenden, der nicht an einer optionalen Task-Meldung hängt; gemeinsam mit harmlosen Code-/Erklärantworten evaluieren. Nicht implementiert.',
  '3. Codex-Längenreparatur ist im Produktionscode deaktiviert: auch mit explizitem Task kein Reparaturauftrag (15 Kontrollen). Das Regelbuch-Stop-Gate ist davon getrennt und funktioniert im Replay. Eine native, isolierte Prüfung des Reparaturwegs ist vor Aktivierung nötig.',
  '', 'Befund-Issues: [#1340 — Korrespondenzabruf](https://github.com/n0mad-ai/bastra-recall/issues/1340), [#1341 — Task-Weglassen](https://github.com/n0mad-ai/bastra-recall/issues/1341), jeweils v1.1.8 mit Labels, EN/DE. Codex-Reparaturgrenze: #1311. Übergeordnete Prüfung: #1336, Epic #1276. Die größeren Lücken wurden entsprechend dem Auftrag nicht ungefragt gebaut.',
  '', '## Security-Nachtrag und Fixrunde 1', '',
  'Die Snapshot-Variante aus ca833580 wurde nach Gegenprüfung ersetzt. Es gelten dynamisch alle gültigen geladenen/aktiven Validatoren der Session/Kontextgeneration. Laufende Minima je Kanal/Einheit verhindern Lockerung durch spätere Loads, Reloads oder Modellmeldungen. Keine eingefrorene Taskmenge, kein since-Filter, keine Auswahl durch die Reihenfolge von applicable. Nur ein unzweideutiger Kanal aus dem eigenen Nutzer-Turn über den bestehenden Kandidatenpfad darf verengen; diese Auswahl überlebt eingefügte Mail, Entwurfserkennung und Freigabe. Der Beleg kommt aus dem echten Ablauf in rulebook-phase5-fix1.test.ts, nicht aus handgesetzter validatorRuleId.',
  'Bewusste Grenze: Ohne Nutzer-Kanalbindung gelten auch mehrere geladene Kanäle gemeinsam. Ein konservativer Fehlalarm endet nach zwei Reparaturanfragen und einmal Erschöpfung. Unterschiedliche Zähleinheiten sind gemeinsam zu erfüllen. Task vor dem Load: Die echte Stop-Lane fordert nach späterem Discord-Load Reparatur an (Claude Code); diese Zusatzvariante zu #1341 ist geschlossen. Ohne Task bleibt #1341 offen; Codex-Reparatur bleibt gemäß #1311 deaktiviert.',
  'Die Korrespondenz-Positivkontrolle verwendet nach dem ersten Block eine frische Runde und stop_hook_active=false. Ohne den echten Load muss sie scheitern. Die Längen-Positivkontrollen laufen ebenfalls durch die echte Stop-Lane. Reproduzierbare Regressionen: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/rulebook-phase5-fix1.test.ts packages/daemon/__tests__/rulebook-phase5-security.test.ts. Rotbeleg gegen isoliertes ca833580: /private/tmp/phase5-fix1-red.log. Die größeren Lücken #1340/#1341 bleiben ausdrücklich offen.',
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
