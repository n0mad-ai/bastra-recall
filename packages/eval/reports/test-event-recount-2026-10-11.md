# Test-event contamination follow-up (#686)

Read-only recount at 2026-10-11 08:28 UTC, more than one week after the documented September 27 purge/deploy. The completed #305 readout and that deploy are documented in the issue comments; no purge or daemon change was performed here.

**0 matching rows**, 93 daily files, 206,449 total lines, 0 invalid rows. The exact predicate is `kind in {save_memory, save_hold}` **and** a fixture scope from #686. `hook_recall` and `taxonomy` are deliberately excluded from that predicate, not removed. This meets the issue's due one-week recount condition on the retained daily logs. It cannot certify days already removed by normal retention.

The aggregate registration pins a clean runner commit, script hash and an input-manifest hash. File dates/line counts are aggregate only; raw records stay local. The active daily file can grow after the snapshot. No raw query, memory id, private text or local path is published.

```sh
python3 packages/eval/scripts/recount-test-events.py --logs <logs> --out <artifact-outside-inputs>
```

Validation: controlled five-row fixture finds only the two save-path fixture rows and leaves hook/taxonomy/real rows unmatched; all scanned rows parse. Inputs are only opened for reading.

**Cleanup proposal: remove 0 lines; perform no cleanup.** If fresh contamination appears later, first preserve originals, apply the inverse predicate line-wise without reserializing retained records, and verify `original = kept + removed` per file. That conditional procedure was not run and is not needed for this snapshot. Closing #686 is left to the owner; this PR only registers evidence.
