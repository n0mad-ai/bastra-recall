# CSLS draft-repeat diagnostic (#1109)

A read-only local diagnostic over existing quote vectors changes neither scoring nor promotion. The frozen protocol was committed before inspecting ranking results. The runner uses production cosine and character-bigram Dice; CSLS subtracts each endpoint's mean cosine to its ten nearest eligible cross-session neighbors.

| Measure | Result |
|---|---:|
| Drafts / valid matched vectors | 112 / 112 |
| Rejected stale/unmatched vectors | 0 |
| Eligible cross-session pairs | 4,321 |
| Shared-session pairs excluded | 1,895 |
| Drafts lacking ten eligible neighbors | 0 |
| Cosine–CSLS top-120 overlap | 65 |
| Cosine–Dice top-120 overlap | 52 |
| Dice–CSLS top-120 overlap | 33 |
| Raw cosine p50 / p90 / p99 | 0.3008 / 0.4233 / 0.5583 |
| Script computation/read wall time (startup excluded) | 55.5 ms |
| Existing vector file / raw float32 bytes | 481,234 / 344,064 |
| Inference calls / independently labelled pairs | 0 / 0 |

This confirms that CSLS changes which pairs rank high on this snapshot. It **does not show improved durable-fact precision**. All top sets are method-selected; no precision, false-positive, prevalence or safe-promotion estimate can be made without labels. The contributor's month is not reproduced: their scoring scripts and sanitized pair labels were offered but not attached in the inspected #1084 comments. The local store is a different, small, retained single-host sample.

Inputs are matched by id, fingerprint and quote SHA-256. The aggregate registration pins a clean runner commit and both input hashes. The persisted vector provenance records `ollama-embeddinggemma`, 768 dimensions, but no historical model digest. This diagnostic is reproducible from its exact vector snapshot; it must not claim a pinned historical model version. No raw text, ids, sessions, situations, private scopes or paths are published. No store API that writes metadata or permissions was invoked.

```sh
node --import tsx packages/eval/scripts/draft-csls.mjs \
  --drafts <store> --vectors <vector-store> --out <aggregate-artifact>
```

Validation: syntax check and an isolated 12-vector control (identical vectors yield cosine 1 and CSLS 0; shared-session pair excluded). Productive inputs were only read. Remaining: independently/adjudicated same-fact/request/topic/conflict labels; contributor reproduction; translated restatements; quote-plus-situation; rare-token guard; draft-to-vault duplicate matching; seven-day-expiry recurrence. **Not evaluable for adoption; no gate passed.** Owner action: obtain sanitized labelled pairs with consent and an independent adjudication sample before choosing a promotion policy. No request was sent to the contributor by this task.
