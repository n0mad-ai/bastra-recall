# Secret redaction in local drafts

Draft storage removes structurally recognizable credential values while keeping
locations useful. It recognizes credential bindings (including nested shell
bindings), authorization headers, URL userinfo, provider token prefixes and
opaque high-entropy strings. Existing `[REDACTED]` placeholders are not counted
again. No natural-language password word lists are used.

Paths and variable references remain visible, including after `private_key`,
`token` and `--password`. Qualified names such as `API_TOKEN` are treated as
credential bindings. A bare `key` can mean a database or object key; short values
under that name are not assumed secret. Bare `token` and `secret` can also name
counts, resources or unquoted prose. Prefer explicit credential names when
describing a value that needs to be removed.

MySQL and MariaDB accept an attached password (`-pVALUE`). A separated `-p`
prompts for a password, so the following database name stays visible. Uppercase
`-P` is a port. SSH's `-p` is also a port; sshpass and docker login use it for
password values.

## Limits

This is a heuristic, not a guarantee that text contains no secrets. Do not put
actual credentials into a conversation in the first place.

- A slash-leading password such as `--password=/Sommer2024!` is indistinguishable
  from a valid absolute filename. It stays visible. Requiring an existing file
  would lose remote, future and other-machine paths; punctuation is legal in
  filenames. The filter deliberately does not consult the filesystem.
- Random Base64 values beginning with `/` share this path ambiguity. A password
  shaped like a named resource or code symbol can also survive those exemptions.
- Short values under a bare `key`, numerical bare `token`/`secret` values, and
  passwords stated in ordinary prose are ambiguous and may stay visible.
- Malformed URL userinfo and a port followed by a path containing `@` can be
  ambiguous. Normal `user:password@host` forms, including literal `?`, `#`, `/`
  and `@` inside non-numeric passwords, are removed; port/package paths survive.

## Verification on 2026-10-07

The repeated input `"eyJa-".repeat(n)` took 482 / 5,552 / 14,929 ms at 50k / 200k /
400k characters before the fix, and 7 / 12 / 27 ms afterwards on the same machine.
The JWT branch now checks a boundary before the entire token, so a missing
signature does not retry at every internal `eyJ`.

Independent synthetic samples used xorshift32 with seed `0x10882026`, 5,000
40-character Base62 values followed by 5,000 Base64 values, tested bare, under
`VALUE=` and under `API_KEY=`. The old camelCase exemption leaked 871 Base62
values bare/neutral; the corrected filter leaked 0. Base64 leakage fell from
807 to 91 bare/neutral; all 91 begin with `/` and share the documented path
ambiguity. Under `API_KEY=`, Base62 leakage was 0 and Base64 leakage 91 before
and after. None of 20 independently chosen path, host, command and identifier
examples was damaged. Four explicit ambiguous examples (slash password, path,
short bare key, prose password) remained unchanged. These finite samples do not
establish a universal detection rate.

---

## Deutsch: Grenzen des Filters

Die lokale Entwurfs-Ablage schwärzt erkennbare Zugangswerte und erhält Orte.
Das ist eine Heuristik: Ein Passwort wie `/Sommer2024!` kann auch ein gültiger
absoluter Dateiname sein und bleibt deshalb stehen. Eine Prüfung auf vorhandene
Dateien würde entfernte oder erst geplante Pfade verlieren. Auch kurze Werte
unter dem mehrdeutigen Namen `key`, Zahlen unter `token`/`secret` und Passwörter
in normalem Fließtext sind nicht sicher erkennbar. Tatsächliche Zugangsdaten
sollten gar nicht erst in ein Gespräch gelangen.
