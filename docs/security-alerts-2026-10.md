# Dependency security assessment / Sicherheitsbewertung der Abhängigkeiten

## English

Assessment date: 2026-10-09. These changes upgrade dependencies; no dependency
is downgraded and the frontmatter parser is not replaced.

- **[GHSA-jqcg-44mw-7w3h](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h):**
  `daemon → @modelcontextprotocol/sdk → express → proxy-addr` is upgraded
  from 2.0.7 to the patched 2.0.8, including the change proposed by Dependabot
  PR #1112. Bastra's HTTP server uses Hono and does not configure Express
  proxy trust; nevertheless the vulnerable dependency is removed.
- **[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c):**
  `core → gray-matter → js-yaml → argparse → sprintf-js`. No patched
  `sprintf-js` release exists. `gray-matter/lib/engines.js` uses
  `js-yaml.safeLoad` and `safeDump`; only `js-yaml/bin/js-yaml.js` imports
  `argparse`. Parsing and writing frontmatter do not reach `sprintf-js`.
  The repository overrides `argparse` 1.0.10 with 2.0.1, which has no
  `sprintf-js` dependency and retains the legacy CLI API used by js-yaml 3.
  Version 3 removes that API, so it is not used. `gray-matter` 4.0.3 and
  `js-yaml` 3.15.2 remain unchanged. A before/after comparison of 23 existing
  synthetic vault fixtures found zero serialization differences, and a
  regression test checks that byte baseline while forbidding CLI imports.
  Root overrides affect repository installs only: npm does not propagate a
  package author's overrides to consumers. Independently installed published
  packages can still contain the unreachable CLI dependency; no claim is
  made that their audit is clean. Removing that downstream path would need a
  separate packaging or parser decision.
  Local `npm ls argparse --all` reports `invalid: ^1.0.7` at js-yaml's
  original dependency edge despite the root override. Fresh `npm ci` succeeds,
  installs 2.0.1, and parsing, byte roundtrips and the js-yaml CLI help pass;
  the diagnostic is recorded rather than hidden.
- **[GHSA-86w9-cpqp-85rv](https://osv.dev/vulnerability/GHSA-86w9-cpqp-85rv):**
  `daemon (devDependency) → @anthropic-ai/mcpb 2.1.2 → node-forge 1.4.0`.
  The newest published forge version remains affected; no patched release
  is available. It is absent from the production dependency tree. The
  repository invokes `mcpb pack` in `packages/daemon/scripts/build-mcpb.mjs`
  and its release workflow, never `mcpb verify`, `sign` or `info`. The pack
  handler calls `packExtension`, not signature verification. The MCPB CLI
  imports the forge-backed signing module, but the repository's pack path
  does not execute the vulnerable RSA verification operation. MCPB's other
  CLI commands expose verification, so this assessment must be revisited if
  those commands are adopted or untrusted bundles are verified.

The full development audit remains nonzero for `node-forge` and its parent
`@anthropic-ai/mcpb`. Production audit is clean for the repository lockfile.
Scorecard still has one OSV advisory to count until a patched release or an
explicitly approved exception is available. No advisory is automatically
suppressed or dismissed by these changes.

## Deutsch

Bewertet am 09.10.2026. Die Änderungen aktualisieren Abhängigkeiten; kein Paket
wird herabgestuft und der Frontmatter-Parser wird nicht ersetzt.

- **[GHSA-jqcg-44mw-7w3h](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h):**
  `daemon → @modelcontextprotocol/sdk → express → proxy-addr` wird von
  2.0.7 auf die gepatchte 2.0.8 aktualisiert, einschließlich der Änderung
  aus Dependabot-PR #1112. Bastras HTTP-Server verwendet Hono und richtet
  kein Express-Proxy-Vertrauen ein; die verwundbare Abhängigkeit wird
  trotzdem entfernt.
- **[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c):**
  `core → gray-matter → js-yaml → argparse → sprintf-js`. Es gibt kein
  gepatchtes `sprintf-js`-Release. `gray-matter/lib/engines.js` verwendet
  `js-yaml.safeLoad` und `safeDump`; nur `js-yaml/bin/js-yaml.js` importiert
  `argparse`. Frontmatter-Lesen und -Schreiben erreicht `sprintf-js` nicht.
  Das Repo überschreibt `argparse` 1.0.10 mit 2.0.1: Diese Version braucht
  kein `sprintf-js` und behält die alte CLI-API, die js-yaml 3 verwendet.
  Version 3 entfernt diese API und wird deshalb nicht verwendet.
  `gray-matter` 4.0.3 und `js-yaml` 3.15.2 bleiben unverändert. Der Vergleich
  vor und nach der Änderung über 23 vorhandene synthetische Vault-Fixtures
  ergab keine abweichende Serialisierung; ein Regressionstest prüft diesen
  Byte-Stand und verbietet dabei CLI-Imports. Root-Overrides gelten nur für
  Repo-Installationen: npm überträgt die Overrides eines Paketautors nicht
  auf Verbraucher. Separat installierte veröffentlichte Pakete können die
  nicht erreichbare CLI-Abhängigkeit weiter enthalten; für deren Audit wird
  keine Fehlerfreiheit behauptet. Diesen nachgelagerten Pfad zu entfernen
  braucht eine eigene Entscheidung zu Packaging oder Parser.
  Lokal meldet `npm ls argparse --all` an der ursprünglichen js-yaml-Kante
  trotz Root-Override `invalid: ^1.0.7`. Ein frisches `npm ci` gelingt und
  installiert 2.0.1; Parsing, Byte-Rundläufe und die js-yaml-CLI-Hilfe bestehen.
  Diese Diagnose wird festgehalten und nicht verschwiegen.
- **[GHSA-86w9-cpqp-85rv](https://osv.dev/vulnerability/GHSA-86w9-cpqp-85rv):**
  `daemon (devDependency) → @anthropic-ai/mcpb 2.1.2 → node-forge 1.4.0`.
  Auch die neueste veröffentlichte Forge-Version ist betroffen; es gibt
  kein gepatchtes Release. Im Produktions-Abhängigkeitsbaum fehlt das Paket.
  Das Repo ruft in `packages/daemon/scripts/build-mcpb.mjs` und im
  Release-Workflow `mcpb pack` auf, niemals `mcpb verify`, `sign` oder `info`.
  Der Pack-Handler ruft `packExtension` auf, keine Signaturprüfung. Die
  MCPB-CLI importiert zwar das Forge-basierte Signiermodul, der verwendete
  Pack-Pfad führt die verwundbare RSA-Prüfung aber nicht aus. Andere
  MCPB-CLI-Befehle bieten eine Prüfung an; bei ihrer Einführung oder bei
  Prüfung fremder Bundles muss diese Bewertung erneut erfolgen.

Das vollständige Entwicklungs-Audit bleibt wegen `node-forge` und dessen
Elternpaket `@anthropic-ai/mcpb` rot. Das Produktions-Audit des Repo-Lockfiles
ist sauber. Scorecard kann weiter eine OSV-Warnung zählen, bis ein Patch oder
eine ausdrücklich freigegebene Ausnahme vorliegt. Diese Änderungen
unterdrücken oder schließen keine Warnung automatisch.
