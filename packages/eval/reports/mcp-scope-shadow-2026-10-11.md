# MCP scope-filter shadow week (#421)

Read-only interval: **2026-09-29T03:32:59Z ≤ timestamp < 2026-10-06T03:32:59Z**. Start is the owner-decision comment's timestamp; there is no separately recorded deployment timestamp. This is a seven-day calendar proxy, not proof of a homogeneous versioned deployment.

| Measure | Count |
|---|---:|
| MCP recall/hook_recall rows | 255 |
| Rows with shadow mode and numeric drop counter | 255 |
| Applicable rows (no skipped reason) | 217 |
| Calls with potential drops | 92 |
| Potential dropped hits | 214 |
| Calls affected / all observed calls | 36.08% |
| Calls affected / applicable calls | 42.40% |
| Duplicate recall ids / missing ids / invalid rows | 0 / 0 / 0 |
| Marked eval/synthetic rows excluded | 0 |

Skip reasons: 14 no-scope-evidence, 13 no-project, 11 explicit-scope. All 255 have unknown client identity. The registration separates `agent` traffic and legacy rows with no origin classification; neither constitutes independently observed human reliance. No private scopes, ids, queries or local paths are published.

No row-level code/configuration version exists in these records. Mode is consistently shadow; a version-invariant causal comparison cannot be recovered. There are no independent relevance labels for retained/withheld candidates, no measured task outcome and no preregistered success threshold. **Enforce safety and utility remain not evaluable.** The readout measures potential filtering, not improved relevance, and changes no configuration. The recommended owner action is to retain shadow until representative dropped/retained candidates are independently labelled, or explicitly choose the tradeoff without calling it a passed gate.

```sh
python3 packages/eval/scripts/mcp-scope-shadow.py --logs <logs> \
  --start 2026-09-29T03:32:59Z --end 2026-10-06T03:32:59Z --out <artifact-outside-inputs>
```

The registration pins a clean runner commit, script and interval-input hashes. Validation: isolated fixture checks exact interval selection, eval exclusion and skipped/applicable denominators. Productive protocols were only read.
