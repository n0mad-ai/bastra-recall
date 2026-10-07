# Secret redaction in local drafts

The local draft store removes recognizable credential values and keeps useful
locations. It uses technical binding names, provider prefixes, private-key
blocks, URL userinfo and opaque strings. It does not use natural-language
password word lists. Existing `[REDACTED]` placeholders are idempotent.

Paths and `$NAME` / `${NAME}` references remain visible. Draft fields are clipped
before redaction (quote: 600 characters; context: 160; other fields: 160 or 200).
A token crossing the bound is discarded rather than persisted as incomplete URL
userinfo. Nested bindings are scanned without repeatedly parsing the same
neutral wrapper. Query and flag scans skip already processed value spans.

URL userinfo is separated from its host before considering later `@` characters
in paths or queries. Quoted authorization headers stop at their enclosing quote;
Digest parameters inside that quote are removed together. Code-symbol shape
exemptions include PascalCase and acronyms. Named command/field contexts can
retain technical identifiers; those exemptions never suppress an explicit
credential binding.

## Fixed acceptance corpus

`packages/core/__tests__/redact-secrets-corpus.test.ts` retains every literal and
performance input from the seven reviewer scripts (`verify-a/adv`,
`verify-a2/adv` and `adv2`, `verify-a3/red`, `verify-1091/classes`, `reach` and
`port`). Duplicate inputs are retained with their source labels. Provider-shaped
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
The remaining limits below are recorded, not expanded into more filter rules.

| Corpus section | Entries | Worse than main | Known limits |
| --- | ---: | ---: | ---: |
| Literal/property rows | 748 | 0 | 76 |
| Seeded token rows | 226,000 | 0 | 17,965 |
| Runtime rows | 66 | 0 | 0 |
| Total | 226,814 | 0 | 18,041 |

The runtime rows must finish below two seconds each. Local measurements after
the correction: 50k `a=` characters about 4 ms, 100k about 8 ms (the previous PR
measured 6,879 / 27,595 ms); 400k `eyJa-` characters about 21 ms (main measured
about 14,924 ms). These are individual local measurements, not universal speed
guarantees.

## Known limits, with examples

This is a heuristic, not a guarantee that a conversation contains no secrets.
Avoid placing actual credentials in conversations.

| Ambiguity or unsupported form | Example and current behavior |
| --- | --- |
| Slash-leading password / path | `--password=/Sommer2024!` stays visible: it is also a valid absolute filename. Filesystem checks would lose remote or planned paths. Slash-leading Base64 shares this ambiguity. |
| Numeric password with literal URL delimiter | `https://user:12?34@host.internal/x` stays visible because `user:12` can be a host/port preceding a query. |
| Ordinary prose, short PIN | `the password is tiny123`, `die PIN ist 482913` stay visible. No language-specific interpretation is attempted. |
| Credential name outside the recognized syntax | `secret_key_base: abc999xyz`, `pw=hunter2`, `credentials: hunter2` can stay visible. |
| Other command grammars | `mysqldump -phunter2`, `/usr/bin/mysql -ppw1`, `curl -u admin:hunter2`, `redis-cli -a hunter2`, netrc prose, scp-like `me:password@host` can stay visible. |
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

Der feste Korpus prüft 226.814 Einträge in beiden Richtungen gegen `226dd628`:
keine Verschlechterung, 18.041 markierte Grenzen einschließlich synthetischer
Zufallstoken. Die Grenzen werden nicht durch weitere Sonderregeln verfolgt.
Ein slashbeginnendes Passwort ist auch ein gültiger Pfad; nackte Labels wie
`Token: <Prosa>` sind mehrdeutig. Zusätzliche Befehlsgrammatiken, kurze Werte,
Signaturfelder und manche öffentliche Bezeichner bleiben ebenfalls Grenzen.
Entwurfsfelder werden vor dem Schwärzen gekürzt; angeschnittene Tokens werden
weggelassen. Tatsächliche Zugangsdaten gehören nicht in ein Gespräch.
