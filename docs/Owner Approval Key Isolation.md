# Owner approval keys: macOS isolation

## Status and implementation stop

**OS-owned key isolation is not implemented.** Current signing uses passphrase-encrypted Ed25519 JSON files, unlocked inside the Node CLI. Private file modes and hidden passphrase entry do not isolate an unrestricted same-UID agent. `protected_boundary` remains an unverified Owner assertion. Notify, prepare and task management grant no signing authority.

The [#1420](https://github.com/n0mad-ai/bastra-recall/issues/1420) investigation stopped at the handover's native-dependency boundary: the package has no native Security/LocalAuthentication bridge or separately signed approval application. No actual Keychain, account, key or approval protocol was changed. The implementation checkbox remains open. This is source/documentation review, not proof of a working OS boundary.

## Apple mechanisms

macOS file-based Keychains use `SecAccess` ACLs; the data-protection Keychain uses code-signing access groups and optional `SecAccessControl`. The latter requires authorized entitlements/provisioning and a login context. A generic Node or `security` executable is not a distinct approval-app identity. See [Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains) and [Keychain access groups](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps).

Security and LocalAuthentication can gate access on user authentication. Authentication contexts can reuse an earlier authentication event, so a future signer must explicitly prevent blanket approval. Authentication proves presence, not consent to task bytes shown by another program. See [Apple's authenticated Keychain example](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id).

Secure Enclave supports P-256 keys generated inside supported hardware; existing Ed25519 keys cannot be imported. That option needs new enrollment and a versioned signature/registry protocol. See [Apple's Secure Enclave guide](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave).

A candidate is a separately signed native approval app with restricted Keychain access and OS authentication. Keep key material and signing inside it; return only the signature and bound context. Do not share its Keychain group with the agent, daemon or general-purpose runtime. Retaining encrypted Ed25519 behind a native broker versus new hardware-backed P-256 is an unresolved design choice. Neither is delivered here.

## Transport threat model

Assume arbitrary agent commands as the same user, ordinary user-file access, loopback calls, helper invocation, malicious proposals and replayed messages. Treat daemon previews and task content as untrusted. The desired additional guarantee is that these actions alone cannot expose a key or obtain a new signature without informed Owner consent.

The signer's trusted view must show the concrete target, exact before/after bytes, domains, decision and complete canonical binding. Check protocol, key/domain identity, registry pin, task/proposal/source revisions, nonce and expiry before authentication. Bind consent to the exact bytes ultimately signed. An agent-controlled terminal, browser or authentication reason string is insufficient. Bound IPC input and reject substitution; expose no silent signing, export or debug path. Caller checks alone are insufficient because an agent can invoke a permitted client.

Preserve all-domain signatures, final freshness/CAS checks, spent proofs, leases and reconciliation. Key protection alone does not protect an agent-writable verifier, registry, executable or target from direct modification; the eventual guarantee must state their trust and protection. Compromised OS/root/admin, signer replacement/injection, stolen authentication and misled or coerced consent remain outside a key-storage-only guarantee. There is no whole-machine same-UID integrity claim.

## Independent verification before enabling

Use disposable keys/profiles. An independent verifier must attack direct read/export/signing from arbitrary Node/shell processes, unauthorized access groups, caller substitution, helper launch without a person, denial/cancellation, locked/headless operation, authentication reuse, preview/binding tampering, registry/key replacement, stale/replayed signatures, crashes and concurrent requests. Unsupported hardware/login contexts must fail closed. Inspect actual entitlements and IPC policy in the packaged signed artifact on supported macOS versions.

Record attacker permissions and observed outcomes. Unit fixtures establish message/signature rules; real native integration tests with human authentication are required to substantiate OS isolation. Those tests were not run here. No real Keychain was changed.

---

## Deutsch

### Stand und Umsetzungsstopp

**Eine OS-seitige Schlüsselisolation ist nicht umgesetzt.** Heute werden passphrasenverschlüsselte Ed25519-JSON-Dateien in der Node-CLI entsperrt. Private Dateirechte und verborgene Passphrase-Eingabe trennen keinen uneingeschränkten Agenten unter derselben Benutzerkennung ab. `protected_boundary` bleibt eine ungeprüfte Owner-Zusicherung. Erinnern, Vorbereiten und Aufgabenverwaltung geben keine Signierrechte.

Die Untersuchung zu [#1420](https://github.com/n0mad-ai/bastra-recall/issues/1420) stoppte an der Handover-Grenze für native Abhängigkeiten: Das Paket hat weder eine native Security-/LocalAuthentication-Anbindung noch eine separat signierte Freigabe-App. Echte Schlüsselbunde, Konten, Schlüssel und Freigabeprotokolle wurden nicht geändert. Die Umsetzungs-Checkbox bleibt offen. Dies ist Quelltext-/Dokumentationsprüfung, kein Nachweis einer funktionierenden OS-Grenze.

### Apple-Verfahren

Dateibasierte macOS-Schlüsselbunde verwenden `SecAccess`-ACLs; der Data-Protection-Schlüsselbund verwendet signaturgebundene Zugriffsgruppen und optional `SecAccessControl`. Letzterer braucht autorisierte Entitlements/Provisionierung und eine angemeldete Nutzersitzung. Ein allgemeines Node- oder `security`-Programm ist keine eigene Freigabe-App-Identität. Siehe [Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains) und [Schlüsselbund-Zugriffsgruppen](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps).

Security und LocalAuthentication können Zugriff an Nutzerauthentifizierung binden. Authentifizierungskontexte können frühere Authentifizierung übernehmen; eine spätere Signier-App muss Pauschalfreigaben ausdrücklich verhindern. Authentifizierung belegt Anwesenheit, keine Zustimmung zu Aufgabenbytes aus einem anderen Programm. Siehe [Apples Schlüsselbundbeispiel mit Authentifizierung](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id).

Secure Enclave unterstützt in geeigneter Hardware neu erzeugte P-256-Schlüssel; bestehende Ed25519-Schlüssel lassen sich nicht importieren. Dieser Weg braucht neue Einschreibung und ein versioniertes Signatur-/Registry-Protokoll. Siehe [Apples Secure-Enclave-Anleitung](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave).

Ein möglicher Weg ist eine separat signierte native Freigabe-App mit eingeschränktem Schlüsselbundzugriff und OS-Authentifizierung. Schlüsselmaterial und Signieren bleiben darin; zurück kommen nur Signatur und Bindung. Agent, Daemon und allgemeine Laufzeit erhalten ihre Schlüsselbundgruppe nicht. Verschlüsseltes Ed25519 hinter nativer Vermittlung oder neues hardwaregeschütztes P-256 bleibt eine offene Entwurfsentscheidung. Beides wird hier nicht geliefert.

### Transport-Bedrohungsmodell

Angenommen werden beliebige Agentenbefehle unter derselben Benutzerkennung, gewöhnlicher Nutzer-Dateizugriff, lokale API-Aufrufe, Hilfs-App-Start, bösartige Vorschläge und wiederholte Nachrichten. Daemon-Vorschauen und Aufgabentexte gelten als nicht vertrauenswürdig. Die gewünschte zusätzliche Garantie: Diese Handlungen allein geben weder Schlüssel noch neue Signatur ohne informierte Owner-Zustimmung heraus.

Die vertrauenswürdige Ansicht der Signier-App muss konkretes Ziel, exakte Vorher-/Nachher-Bytes, Domänen, Entscheidung und vollständige kanonische Bindung zeigen. Vor Authentifizierung sind Protokoll, Schlüssel-/Domänenidentität, Registry-Pin, Aufgaben-/Vorschlags-/Quellrevisionen, Nonce und Ablauf zu prüfen. Zustimmung bindet exakt die später signierten Bytes. Agentengesteuerte Terminals, Browser oder Authentifizierungsbegründungen reichen nicht. IPC-Eingaben begrenzen und Austausch ablehnen; keine stillen Signier-, Export- oder Debugpfade anbieten. Aufruferprüfung allein reicht nicht, weil ein Agent zugelassene Clients starten kann.

Signaturen aller Domänen, abschließende Frische-/CAS-Prüfungen, verbrauchte Nachweise, Leases und Abgleich bleiben nötig. Schlüsselschutz schützt agentenbeschreibbare Prüfer, Registry, Programme und Ziele nicht vor direkter Änderung; deren Vertrauen und Schutz muss die spätere Garantie erklären. Kompromittiertes OS/Root/Admin, Austausch/Injektion der Signier-App, gestohlene Authentifizierung sowie irregeführte oder erzwungene Zustimmung liegen außerhalb einer reinen Schlüsselablage-Garantie. Eine Integritätsgarantie für den ganzen Rechner unter derselben Benutzerkennung wird nicht behauptet.

### Unabhängige Prüfung vor Freischaltung

Wegwerfschlüssel/-profile nutzen. Unabhängig zu prüfen sind direkte Lese-/Export-/Signierversuche aus beliebigen Node-/Shell-Prozessen, fremde Zugriffsgruppen, Aufruferaustausch, Hilfs-App-Start ohne Person, Ablehnen/Abbrechen, gesperrter/headless Betrieb, Authentifizierungswiederverwendung, manipulierte Vorschauen/Bindungen, Registry-/Schlüsselaustausch, alte/wiederholte Signaturen, Absturz und gleichzeitige Anfragen. Nicht unterstützte Hardware/Sitzungskontexte müssen geschlossen ablehnen. Tatsächliche Entitlements und IPC-Regeln am gepackten signierten Artefakt auf unterstützten macOS-Versionen prüfen.

Angreiferrechte und beobachtete Ergebnisse festhalten. Unit-Fixtures belegen Nachrichten-/Signaturregeln; OS-Isolation braucht echte native Integrationstests mit menschlicher Authentifizierung. Diese Tests wurden hier nicht ausgeführt. Kein echter Schlüsselbund wurde geändert.
