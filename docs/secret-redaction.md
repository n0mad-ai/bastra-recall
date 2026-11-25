# Secret redaction in local drafts, the suggestion relay and the vault write path

The local draft store removes recognizable credential values and keeps useful
locations. It uses technical binding names, provider prefixes, private-key
blocks, URL userinfo and opaque strings. It does not use natural-language
password word lists. Existing `[REDACTED]` placeholders are idempotent.

Paths and `$NAME` / `${NAME}` references remain visible. Draft fields are clipped
before redaction (quote: 600 characters; context: 160; other fields: 160 or 200).
Where a whitespace boundary exists, a token crossing the bound is discarded.
Without whitespace, clipping returns a shortened prefix and never splits a
surrogate pair. The same character-boundary check applies after redaction. Nested bindings are scanned without repeatedly parsing the same
neutral wrapper. Query and flag scans skip already processed value spans.

URL userinfo is separated from its host before considering later `@` characters
in paths or queries. Quoted authorization headers stop at their enclosing quote;
Digest parameters inside that quote are removed together. Code-symbol shape
exemptions include PascalCase and acronyms. Named command/field contexts can
retain technical identifiers; those exemptions never suppress an explicit
credential binding.

## Network credentials

Explicit password positions also redact word-only values: `nmcli dev|device wifi
connect … password`, `networksetup -setairportnetwork`, netsh's `Key Content:`
field, quoted `WiFi.begin` password literals and `#define WIFI_PSK` literals,
Fortinet `set psksecret`, VyOS `set vpn ipsec … authentication pre-shared-secret`,
`uci set wireless.…key=`, `<pre-shared-key>`, `psk_old=` / `PSK_GUEST=` (PSK
bindings with underscore suffixes), flat JSON `"psks"` string arrays, Cisco
`crypto isakmp key … address`, OpenWrt `option key`, and a complete Wi-Fi QR
with SSID and `P:`. SSIDs, devices, addresses and surrounding quotes remain.
Curl user arguments include attached bundles such as `-sufixture:pw`; HTTPie
`http -a user:pw` is also recognized. Existing path/variable-reference exemptions
and idempotent placeholders apply. This recognizes these scalar grammars, not
arbitrary shell/C evaluation; word-only PSK values in ordinary prose keep their
existing readable boundary. Unquoted `WiFi.begin` password values and other
vendor grammars can remain visible.

Explicit PSK assignments also redact placeholder phrases such as
`PSK: see the password manager` (#1625). A path or environment reference can
still be used to point to a secret without storing it in the note.

## Suggestion relay

The pending suggestion relay uses this same filter on its text blocks before
storage, including retained legacy rows on every write. It also cleans old rows
before delivery. Its file remains the same JSON array, now written with mode
0600 like `drafts.json`; no migration runs. Bounds apply before and after
redaction, using the draft character/placeholder boundary. Dedupe compares the
safe relay text; credential-only differences therefore do not stack identical
visible suggestions, as with draft fingerprints. The harvest's already-stored
vault comparison still sees the original quote before relay storage. Provisional
withdrawal compares safe text and returns the original caller strings.

## Vault write path

Since 1.3.0 (#1470) the same filter runs on the main write path before anything
is written: `save_memory` (title, summary, body, `recall_when`, `applies_when`,
`verify_cmd`), `edit_memory` (the new text of `str_replace` and `append`, and the
patched summary, `recall_when` and `applies_when`; never `old_str`, which must
match the stored body) and `save_document` (title, summary, body,
`recall_when`). This covers every transport, the web UI included. The write goes
through without a confirmation prompt. The receipt names each field and how many
values it lost in `secrets_redacted`, and `warning` says so in one sentence.
Paths stay verbatim here (no home-directory abbreviation), and text without a
recognized credential is written byte for byte. Memories written before 1.3.0
are not rewritten.

## Switching it off

Since 1.3.0 redaction of your own content can be switched off:
`bastra config set redaction.enabled false`, or in the web UI under Settings ›
Writing & docs › "Redact credentials". It is on by default. Off, drafts, the
suggestion relay, notes (`save_memory`, `edit_memory`), documents
(`save_document`), tasks and reports (`task_report_save`) keep their text byte for
byte as written; the home-directory abbreviation in drafts, tasks and reports is
dropped too. The setting needs no restart (from the web UI at once, from the
terminal within a second). `bastra doctor` names the off state. Redacted
regardless of the switch: the vault's append-only audit snapshots and reasons,
training data, telemetry content and the queries in the vault report. Recognized
credentials are also redacted in outgoing OpenAI embedding requests and requests
to remote Ollama. The task execution adapter still requires credentials to stay
out of its exact previews and backups. A connected assistant or a file sync
service can receive the vault content that you keep with the switch off.

## Fixed acceptance corpus

`packages/core/__tests__/redact-secrets-corpus.test.ts` retains every literal and
performance input from the seven reviewer scripts (`verify-a/adv`,
`verify-a2/adv` and `adv2`, `verify-a3/red`, `verify-1091/classes`, `reach` and
`port`). The 46-row `reach` secrets table and the one-character `red` result-key probe
are included. Duplicate inputs are retained with their source labels. Provider-shaped
fixtures are assembled from short chunks.

The seeded `port` samples reproduce seed `0x1091abcd`, all eight families and all
5,000 samples per family, with four wrappers. `adv2` did not retain its crypto-
random samples; the same eleven distributions and 2,000-sample counts are now
frozen with the continued seed, with three wrappers. This is a reproducible
replacement, not a claim to recover unrecorded random bytes.

Baseline outcome bits were measured against `main` commit `226dd628` and are
stored in the test, never recomputed from the implementation. Each static row
has a `knownLimit` marker; seeded rows use a separate frozen outcome bitmap.
Both new regressions and changes to a known limit fail the acceptance test.
The frozen #1113 extension lives in `__tests__/fixtures/network-redaction-corpus.ts`
and is included by this same test: 17 positive/negative pairs. On pre-filter main
`75a469de`, all 17 positive targets failed and all 17 negative cases passed; after
the change all 34 pass. The fixture SHA-256 is
`30161c0e8753cddcd2c14f716ccb0c2b009de0639b98de801f12eeea0e6da1d0`.
No further counterexample search or language-specific word list was added.
The remaining limits below are recorded, not expanded into more filter rules.

| Corpus section | Entries | Worse than main | Known limits |
| --- | ---: | ---: | ---: |
| Literal/property rows, including network extension | 829 | 0 | 78 |
| Seeded token rows | 226,000 | 0 | 17,965 |
| Runtime rows | 66 | 0 | 0 |
| Total | 226,895 | 0 | 18,043 |

The runtime rows must finish below two seconds each. Local measurements after
the correction: 50k `a=` characters about 4 ms, 100k about 8 ms (the previous PR
measured 6,879 / 27,595 ms); 400k `eyJa-` characters about 21 ms (main measured
about 14,924 ms). These are individual local measurements, not universal speed
guarantees.

`packages/core/__tests__/redact-loose-forms.test.ts` additionally runs twelve
repeated PSK and curl shapes at 50 KB and 200 KB. The larger input must finish
below two seconds and within eight times the smaller one plus 100 ms; a
quadratic scan needs about sixteen times as long.

## Known limits, with examples

The added `reach` table pins four unchanged leaks as limits: `password=$ecr3t`
(has variable-reference syntax); `redis://:12?34@cache.internal:6379`
(numeric password/query ambiguity); `jwt_eyJ…` (underscore-prefixed JWT);
and `echo S3cret | docker login --password-stdin` (value passed through stdin).
The filter is unchanged by the corpus/Unicode-clipping follow-up.


This is a heuristic, not a guarantee that a conversation contains no secrets.
Avoid placing actual credentials in conversations.

| Ambiguity or unsupported form | Example and current behavior |
| --- | --- |
| Slash-leading password / path | `--password=/Sommer2024!` stays visible: it is also a valid absolute filename. Filesystem checks would lose remote or planned paths. Slash-leading Base64 shares this ambiguity. |
| Numeric password with literal URL delimiter | `https://user:12?34@host.internal/x` stays visible because `user:12` can be a host/port preceding a query. |
| Ordinary prose, short PIN | `the password is tiny123`, `die PIN ist 482913` stay visible. No language-specific interpretation is attempted. |
| Word-only PSK passphrase in prose | `Der PSK lautet kartoffelsalat`, `the PSK is blauer elefant tanzt`, `: PSK kartoffelsalat` stay visible. Prose and non-positional forms without `=` only redact a quoted value or a single secret-shaped token; explicitly named password positions above also redact plain words; `psk=…` assignments still redact to the end of the value. Details in [hooks.md](./hooks.md). |
| Credential name outside the recognized syntax | `secret_key_base: abc999xyz`, `pw=hunter2`, `credentials: hunter2` can stay visible. |
| Other command grammars | `mysqldump -phunter2`, `/usr/bin/mysql -ppw1`, `redis-cli -a hunter2`, netrc prose, scp-like `me:password@host` can stay visible. |
| Other encoded/signature fields | A short JSON `auth` Base64 value, a non-JWT dotted token, URL `sig=` / `X-Amz-Signature=` may stay visible. |
| Short bare opaque values | Unqualified Base62 of 20 characters and lowercase/digit strings of 16 characters may stay visible. Hex values shaped like 40/64-character public hashes survive unqualified contexts. |
| Symbol or path shaped opaque values | A value conforming to a code-symbol or locator exemption can stay visible; explicit credential bindings still take priority except for paths/references. |
| Bare key/resource/prose labels | `key: value`, `secret: db-credentials`, `max token: 4000`, `Token: see the vault` are conservatively redacted. A short credential under the same syntax must not gain a new exemption. |
| More complex variable/code references | `${{ secrets.GITHUB_TOKEN }}`, `process.env.OPENAI_API_KEY`, `os.environ['GH_TOKEN']` and `password: !vault \|` can be damaged. Only `$NAME` / `${NAME}` are recognized as variable references. |
| User-only URL authority | `ssh://deploy@build-box.internal:2222/srv/app` loses the user, since a username and a token-only credential have the same form. The host remains. |
| Standalone technical identifiers | `aarch64-unknown-linux-gnu`, `srv_db01_prod_euc1_replica02`, some EC2/VPC/runner names, `base64EncodedStringWithOptions`, `kCFStreamPropertyHTTPProxyHost` can be redacted outside a recognized context. |
| Public hashes, versions and request IDs | `md5 d41d8cd98f00b204e9800998ecf8427e`, a `trace_id`, a `sha512-` value, `v1.0.1-rc.2+build.20261007` or a request ID can trigger opaque-value heuristics. |

One original keep-unchanged row contains a real credential-shaped header
(`curl -H "Authorization: Bearer abc123" …`). Its credential is deliberately
redacted; the original unchanged expectation is marked as a limit, while a
separate regression requires the URL suffix to survive. No true credentials or
private vault content are included in these examples.

---

## Deutsch: fester Maßstab und Grenzen

Der feste Korpus prüft 226.895 Einträge mit dem eingefrorenen Altmaßstab
`226dd628` und der Netzwerk-Erweiterung: keine Verschlechterung, 18.043
markierte Grenzen einschließlich synthetischer
Zufallstoken. Die Grenzen werden nicht durch weitere Sonderregeln verfolgt.
Ein slashbeginnendes Passwort ist auch ein gültiger Pfad; nackte Labels wie
`Token: <Prosa>` sind mehrdeutig. Zusätzliche Befehlsgrammatiken, kurze Werte,
Signaturfelder und manche öffentliche Bezeichner bleiben ebenfalls Grenzen.
Entwurfsfelder werden vor dem Schwärzen gekürzt; angeschnittene Tokens werden bei vorhandener Leerzeichengrenze weggelassen.
Ohne Leerzeichen bleibt ein gekürzter Präfix stehen, ohne Surrogatpaar zu teilen. Tatsächliche Zugangsdaten gehören nicht in ein Gespräch.

Explizite Passwortpositionen schwärzen auch reine Wörter: `nmcli dev|device wifi
connect … password`, `networksetup -setairportnetwork`, netshs Feld `Key Content:`,
Passwort-Stringliterale in `WiFi.begin` und `#define WIFI_PSK`, Fortinets
`set psksecret`, VyOS `set vpn ipsec … authentication pre-shared-secret`,
`uci set wireless.…key=`, `<pre-shared-key>`, `psk_old=` / `PSK_GUEST=`
(PSK-Bindungen mit Unterstrich-Suffixen), flache JSON-Stringarrays `"psks"`, Cisco
`crypto isakmp key … address`, OpenWrt `option key` und vollständige WLAN-QR-Texte
mit SSID und `P:`. SSIDs, Geräte, Adressen und umgebende Anführungszeichen bleiben.
Angehängte curl-Bündel wie `-sufixture:pw` sowie HTTPie `http -a user:pw` werden
erkannt. Die bisherigen Pfad-/Variablenreferenzen und Platzhalter bleiben erhalten.
Erkannt werden diese skalaren Grammatiken, keine beliebige Shell-/C-Ausführung;
reine Wort-Passphrasen in gewöhnlicher PSK-Prosa bleiben wie bisher lesbar.

Ausdrückliche PSK-Zuweisungen schwärzen auch Platzhalter wie
`PSK: siehe Passwortmanager` (#1625). Ein Pfad oder eine Umgebungsreferenz
kann weiterhin auf ein Geheimnis verweisen, ohne es in der Notiz zu speichern.
Unquotierte `WiFi.begin`-Passwortwerte und andere Hersteller-Grammatiken können
lesbar bleiben.

Die Erweiterung umfasst 17 feste Positiv-/Negativpaare in
`__tests__/fixtures/network-redaction-corpus.ts`, eingebunden in denselben Test.
Vor der Filteränderung auf main `75a469de`: 17 Positivziele verfehlt, alle 17
Negativfälle bestanden; danach 34/34 bestanden. Die Fixture-SHA-256 lautet:
`30161c0e8753cddcd2c14f716ccb0c2b009de0639b98de801f12eeea0e6da1d0`.
Keine weitere Gegenbeispielsuche und keine Wortliste natürlicher Sprache.

### Bekannte Grenzen mit Beispielen

Die zusätzliche `reach`-Tabelle hält vier unveränderte lesbare Fälle als Grenzen
fest: `password=$ecr3t` (Syntax einer Variablenreferenz),
`redis://:12?34@cache.internal:6379` (mehrdeutiges numerisches Passwort/Query),
`jwt_eyJ…` (JWT mit Unterstrich-Präfix) und
`echo S3cret | docker login --password-stdin` (Wert über stdin).
Der Korpus-/Unicode-Kürzungsnachtrag verändert den Filter nicht.
Das ist eine Heuristik, keine Garantie für ein Gespräch ohne Zugangsdaten.
Echte Zugangsdaten nicht in Gespräche schreiben.

| Mehrdeutigkeit oder nicht unterstützte Form | Beispiel und aktuelles Verhalten |
| --- | --- |
| Slashbeginnendes Passwort / Pfad | `--password=/Sommer2024!` bleibt sichtbar: Das ist auch ein gültiger absoluter Dateiname. Dateisystemprüfungen würden entfernte oder geplante Pfade verlieren. Slashbeginnendes Base64 ist ebenso mehrdeutig. |
| Numerisches Passwort mit wörtlichem URL-Trennzeichen | `https://user:12?34@host.internal/x` bleibt sichtbar, weil `user:12` ein Host/Port vor einer Query sein kann. |
| Gewöhnliche Prosa, kurze PIN | `the password is tiny123`, `die PIN ist 482913` bleiben sichtbar. Es gibt keine sprachspezifische Interpretation. |
| PSK-Passphrase nur aus Wörtern in Prosa | `Der PSK lautet kartoffelsalat`, `the PSK is blauer elefant tanzt`, `: PSK kartoffelsalat` bleiben sichtbar. Prosa und nicht positionale Formen ohne `=` schwärzen nur quotierte Werte oder ein einzelnes Token mit Geheimnisform; die oben ausdrücklich benannten Passwortpositionen schwärzen auch reine Wörter. `psk=…`-Zuweisungen schwärzen weiterhin bis zum Wertende. Details in [hooks.md](./hooks.md). |
| Credential-Name außerhalb erkannter Syntax | `secret_key_base: abc999xyz`, `pw=hunter2`, `credentials: hunter2` können sichtbar bleiben. |
| Andere Befehlsgrammatiken | `mysqldump -phunter2`, `/usr/bin/mysql -ppw1`, `redis-cli -a hunter2`, netrc-Prosa und scp-artiges `me:password@host` können sichtbar bleiben. |
| Andere kodierte Felder / Signaturfelder | Ein kurzer JSON-`auth`-Base64-Wert, ein gepunktetes Token ohne JWT-Form sowie URL-`sig=` / `X-Amz-Signature=` können sichtbar bleiben. |
| Kurze nackte opake Werte | Nicht näher bezeichnetes Base62 mit 20 Zeichen sowie Zeichenfolgen aus Kleinbuchstaben/Ziffern mit 16 Zeichen können sichtbar bleiben. Hexwerte in Form öffentlicher 40-/64-Zeichen-Hashes bleiben ohne Credential-Kontext erhalten. |
| Opake Werte in Symbol- oder Pfadform | Ein Wert, der eine Code-Symbol- oder Ortsausnahme erfüllt, kann sichtbar bleiben; explizite Credential-Bindungen haben weiterhin Vorrang, außer bei Pfaden/Referenzen. |
| Nackte Key-/Ressourcen-/Prosa-Labels | `key: value`, `secret: db-credentials`, `max token: 4000`, `Token: see the vault` werden vorsichtig geschwärzt. Ein kurzer Zugangswert in derselben Syntax darf keine neue Ausnahme erhalten. |
| Komplexere Variablen-/Code-Referenzen | `${{ secrets.GITHUB_TOKEN }}`, `process.env.OPENAI_API_KEY`, `os.environ['GH_TOKEN']` und `password: !vault \|` können beschädigt werden. Nur `$NAME` / `${NAME}` werden als Variablenreferenzen erkannt. |
| URL-Authority nur mit Nutzername | `ssh://deploy@build-box.internal:2222/srv/app` verliert den Nutzer, weil Nutzername und Token-Zugang dieselbe Form haben. Der Host bleibt. |
| Alleinstehende technische Bezeichner | `aarch64-unknown-linux-gnu`, `srv_db01_prod_euc1_replica02`, manche EC2-/VPC-/Runner-Namen, `base64EncodedStringWithOptions`, `kCFStreamPropertyHTTPProxyHost` können außerhalb eines erkannten Kontexts geschwärzt werden. |
| Öffentliche Hashes, Versionen und Request-IDs | `md5 d41d8cd98f00b204e9800998ecf8427e`, eine `trace_id`, ein `sha512-`-Wert, `v1.0.1-rc.2+build.20261007` oder eine Request-ID können die Heuristik für opake Werte auslösen. |

Eine ursprüngliche Unverändert-Zeile enthält einen Credential-förmigen Header
(`curl -H "Authorization: Bearer abc123" …`). Sein Zugangswert wird absichtlich
geschwärzt; die ursprüngliche Unverändert-Erwartung gilt als Grenze, während ein
separater Regressionstest den URL-Suffix erhält. Diese Beispiele enthalten keine
echten Zugangsdaten oder Inhalte eines privaten Vaults.

## Deutsch: Schreibpfad in den Vault

Seit 1.3.0 (#1470) läuft derselbe Filter auf dem Hauptschreibpfad, bevor etwas
geschrieben wird: `save_memory` (Titel, Summary, Body, `recall_when`,
`applies_when`, `verify_cmd`), `edit_memory` (der neue Text von `str_replace` und
`append` sowie gepatchte Summary, `recall_when` und `applies_when`; nie `old_str`,
das zum gespeicherten Body passen muss) und `save_document` (Titel, Summary, Body,
`recall_when`). Das gilt für jeden Zugangsweg, auch die Weboberfläche. Geschrieben
wird ohne Rückfrage. Die Quittung nennt in `secrets_redacted` jedes Feld und wie
viele Werte es verloren hat, `warning` sagt es in einem Satz. Pfade bleiben hier
unverändert (keine Abkürzung des Home-Verzeichnisses), und Text ohne erkannte
Zugangsdaten wird Byte für Byte geschrieben. Vor 1.3.0 geschriebene Memories werden
nicht umgeschrieben.

## Deutsch: Schwärzung ausschalten

Seit 1.3.0 lässt sich die Schwärzung für die eigenen Inhalte ausschalten:
`bastra config set redaction.enabled false` oder in der Weboberfläche unter
Einstellungen › Schreiben & Doku › „Zugangsdaten schwärzen“. Standard ist an. Aus
bleiben Entwürfe, Vorschlags-Relay, Notizen (`save_memory`, `edit_memory`),
Dokumente (`save_document`), Aufgaben und Berichte (`task_report_save`) Byte für
Byte so, wie sie geschrieben wurden; auch die Abkürzung des Home-Verzeichnisses in
Entwürfen, Aufgaben und Berichten entfällt dann. Die Einstellung gilt ohne Neustart
(aus der Weboberfläche sofort, aus dem Terminal nach spätestens einer Sekunde).
`bastra doctor` nennt den ausgeschalteten Zustand. Unabhängig vom Schalter bleiben
geschwärzt: die Vor- und Nachbilder und Begründungen im anhängenden Audit-Protokoll
des Vaults, Trainingsdaten, die Inhalte in der Telemetrie und die Suchanfragen im
Vault-Bericht. Erkannte Zugangsdaten werden auch in Anfragen an OpenAI-Embeddings
und entferntes Ollama geschwärzt. Die exakten Vorschauen und Sicherungen der
Aufgabenausführung dürfen weiterhin keine erkannten Zugangsdaten enthalten. Ein
verbundener Assistent oder ein Dateisynchronisierungsdienst kann die Vault-Inhalte
erhalten, die du bei ausgeschaltetem Schalter speicherst.

## Deutsch: Vorschlags-Relay

Der Pending-Relay nutzt denselben Filter für seine Textblöcke vor dem Speichern,
auch für verbliebene alte Zeilen bei jedem Schreiben. Alte Zeilen werden ebenso
vor der Auslieferung geschwärzt. Die Datei bleibt dasselbe JSON-Array und wird
wie `drafts.json` mit Rechten 0600 geschrieben; es läuft keine Migration.
Grenzen gelten vor und nach der Schwärzung, mit derselben Zeichen-/Platzhaltergrenze
wie bei Entwürfen. Die Dublettensuche vergleicht den sicheren Relay-Text;
Unterschiede nur in Zugangsdaten stapeln deshalb keine gleich sichtbaren
Vorschläge, wie bei Entwurfs-Fingerprints. Der Harvester-Abgleich „schon im Vault“
sieht weiterhin das ursprüngliche Zitat vor der Relay-Speicherung. Die vorläufige
Rücknahme vergleicht sicheren Text und gibt die ursprünglichen Aufrufer-Strings
zurück.
