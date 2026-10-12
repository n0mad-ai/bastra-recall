# Release checklist / Release-Checkliste

[English](#english) · [Deutsch](#deutsch)

## English

For maintainers of a built source checkout. These commands describe the workflow; updating user documentation does not authorize a release.

1. Run `npm run release:version -- <version>` (use `--dry-run` first). It updates package versions and internal pins; stable versions also update both README release lines, while prereleases (`-beta`, `-rc`, etc.) retain the stable README announcement; then refresh the lockfile with `npm install`.
2. For a stable release, write the matching `CHANGELOG.md` section; `npm test` stays red until it exists. Prereleases do not require a matching section. Work each user-visible item through README, `docs/` and the separate Wiki. Keep README brief, link deeper guidance, and maintain equivalent EN/DE content. Check hook registrations, commands, defaults, switches, endpoints and tested support. Keep unreleased features labelled.
3. Update and publish Wiki Home (both tables/version lines), Sidebar and affected pages after review. **Required checklist: Wiki updated (EN + DE) for this version.** This is a releaser attestation; it does not automatically inspect the separate repository. Do not check the box for a local unpushed Wiki commit.
4. Run `npm test`, `npm run check:types`, `npm run build` and `node tools/link-check.mjs`. For stable versions, the existing test suite checks both README release lines against root `package.json` and requires an exact changelog section. The publishing gate repeats these checks.
5. Follow `scripts/bump.mjs`'s draft handoff only after release authorization. The real `publish-npm.yml` dispatch requires `wiki_updated=true`; default is false. `DRY_RUN=false` without `WIKI_UPDATED=true` fails the binding gate before any downstream publication. A dry run requires no Wiki attestation and publishes nothing.
6. The gate binds draft/tag/package versions to one commit. Assets are checked before npm publication, the wrapper is last, and GitHub promotion follows full-set verification. `node scripts/publish-release-set.mjs --verify` never publishes and checks registry visibility in one five-minute window (unfinished packages only; pauses up to 30 seconds).

The Wiki checkbox is the smallest enforceable reminder for a separately maintained repository. It cannot prove that prose is complete or correct; the release reviewer still compares it against the changelog. [User update guide](https://github.com/n0mad-ai/bastra-recall/wiki/Updating).

## Deutsch

Für Maintainer eines gebauten Quellcode-Checkouts. Die Befehle beschreiben den Ablauf; das Aktualisieren von Nutzerdoku autorisiert keinen Release.

1. Führe `npm run release:version -- <version>` aus (zuerst mit `--dry-run`). Es setzt Paketversionen und interne Pins; stabile Versionen setzen zusätzlich beide README-Release-Zeilen, Vorabversionen (`-beta`, `-rc` usw.) behalten die stabile README-Ankündigung; aktualisiere danach das Lockfile mit `npm install`.
2. Schreibe für einen stabilen Release den passenden Abschnitt in `CHANGELOG.md`; `npm test` bleibt bis dahin rot. Vorabversionen brauchen keinen passenden Abschnitt. Gleiche jeden nutzerrelevanten Punkt mit README, `docs/` und dem getrennten Wiki ab. Halte die README knapp, verlinke tiefere Anleitungen und pflege gleich vollständige EN-/DE-Inhalte. Prüfe Hook-Registrierungen, Befehle, Defaults, Schalter, Endpunkte und getesteten Support. Unveröffentlichte Funktionen bleiben gekennzeichnet.
3. Aktualisiere und veröffentliche nach Prüfung Wiki-Home (beide Tabellen/Versionszeilen), Sidebar und betroffene Seiten. **Pflichtpunkt: Wiki aktualisiert (EN + DE) für diese Version.** Das ist eine Bestätigung des Release-Verantwortlichen; das getrennte Repository wird nicht automatisch untersucht. Ein lokaler ungepushter Wiki-Commit reicht nicht für das Häkchen.
4. Führe `npm test`, `npm run check:types`, `npm run build` und `node tools/link-check.mjs` aus. Für stabile Versionen vergleicht der bestehende Testlauf beide README-Release-Zeilen mit Root-`package.json` und verlangt den exakten Changelog-Abschnitt. Das Publishing-Gate wiederholt diese Prüfungen.
5. Folge dem Draft-Handover aus `scripts/bump.mjs` erst nach Release-Autorisierung. Der echte Dispatch von `publish-npm.yml` verlangt `wiki_updated=true`; Standard ist false. `DRY_RUN=false` ohne `WIKI_UPDATED=true` scheitert im Binding-Gate vor jeder nachfolgenden Veröffentlichung. Ein Dry-run braucht keine Wiki-Bestätigung und veröffentlicht nichts.
6. Das Gate bindet Draft/Tag/Paketversionen an einen Commit. Assets werden vor npm geprüft, der Wrapper kommt zuletzt und GitHub-Promotion folgt der vollständigen Set-Verifikation. `node scripts/publish-release-set.mjs --verify` veröffentlicht nie und prüft Registry-Sichtbarkeit in einem gemeinsamen Fünf-Minuten-Fenster (nur unfertige Pakete; Pausen bis 30 Sekunden).

Das Wiki-Häkchen ist die kleinste erzwingbare Erinnerung für ein getrennt gepflegtes Repository. Es beweist keine vollständige oder richtige Prosa; die Release-Gegenprüfung gleicht sie weiterhin mit dem Changelog ab. [Update-Anleitung für Nutzer](https://github.com/n0mad-ai/bastra-recall/wiki/Updating).
