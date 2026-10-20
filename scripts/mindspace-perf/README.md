# Mindspace frame/CPU probe (#324)

This probe imports the **unmodified production** `boot/render-loop.js`,
`renderer.js`, `simulation.js`, `interactions.js`, `minimap.js` and
`managers/orbit-view.js` into real
Chromium Canvas2D. The renderer is under `webui/js/`, not `webui/js/boot/`.
No daemon or vault is contacted. Only a temporary loopback HTTP server is used.

## Run

Run on a quiet machine, without another benchmark or test suite:

```sh
PLAYWRIGHT_CORE_PATH=/absolute/path/to/existing/playwright-core \
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node scripts/mindspace-perf/run.mjs
```

`PLAYWRIGHT_CORE_PATH` is required and must point to an existing external
`playwright-core` package; this repository does not contain `node_modules/playwright-core`. The original baseline used an already present `playwright-core` 1.57.0
in `~/Library/Caches/ms-playwright-go/1.57.0/package` without installing a package or browser. `CHROME_PATH` defaults to the path shown above.
`DURATION_MS=3000`, `REPEATS=3`, and `OUTPUT=results.json`
are optional environment overrides. Relative output paths resolve from this script's directory, regardless of the working directory. Each size/view is run serially, `REPEATS` times (three by default).
Output is saved after each measurement, with raw frame samples and metadata.

## Workload and measurements

- Seed 324, 1,000 / 5,000 / 10,000 synthetic memory nodes, ten equal clusters,
  degree four, exactly two edges per node (half intra-cluster, half cross-cluster).
- Dark production theme including glow sprites; 1280×800 viewport, DPR 1,
  180×110 minimap; all graph nodes fitted into the viewport. No hover/focus,
  filters, live notices, or vault IO. Clouds and the default orbit universe
  are measured separately; orbit uses the real tick/decor and enables the
  production depth sort and quiet-edge loop. Ring/semantic modes are not covered.
- Busy phase: actual clouds physics is kept warm by `sim.reheat(0.5)` before
  each production frame; 30 warmup frames precede measurement. This represents
  sustained physics, not normal cooling or a measured user gesture.
- Orbit starts after 90 warmup frames (decor entry fade complete); its idle
  condition means no interaction, with normal ambient rotation still active.
  Orbit has no separate sustained-physics busy phase.
- Idle phase: physics is allowed to settle outside the measurement window,
  followed by 30 more warmup frames; no interaction occurs during measurement.
- Synthetic hidden phase: `document.hidden=true` and
  `document.visibilityState='hidden'` plus a visibility-change event, while
  native RAF continues. This isolates application visibility gating and is
  **not a measurement of native browser background throttling**.
- Native background phase: restore native visibility, open/activate another
  tab, and check `document.hidden`. If headless Chromium still reports visible,
  record a skip; never claim an actual hidden-tab result in that case.
  Playwright default flags that disable background throttling are removed.
- Frame p50/p95 = nearest-rank percentiles of successive native RAF timestamps.
  Callback p50/p95 = wall time of the entire real loop callback (physics,
  interactions, renderer, minimap), excluding synthetic reheating. These are
  separate: callback duration does not include async GPU/compositor completion.
- Main-thread task % = CDP `Performance.TaskDuration` delta / elapsed wall time.
  This is Chrome task occupancy, **not OS CPU utilization**.
- Chromium CPU % = summed CDP `SystemInfo.getProcessInfo` CPU-second deltas
  across all browser processes (renderer/GPU/browser/etc.) / wall time.
  100% equals one logical CPU core. Process type deltas are included in JSON;
  new/exited processes cannot be matched and are excluded. No Node/harness CPU
  is included. CPU snapshots bracket a few CDP commands, so short intervals
  include small instrumentation/boundary overhead.
- No `performance.mark/measure` entries or observers are created. Arrays contain
  only bounded samples for the current three-second window. Load averages are
  recorded for context; they are not CPU utilization.

These are reproducible synthetic baseline measurements on one machine/browser,
not a full application/E2E benchmark or a real-vault graph distribution. They
exclude network/startup, rich node states and user interaction latency. Native
headless RAF cadence, Canvas/GPU backend, thermal conditions and other machine
work can affect results. Compare the same fixture, machine and browser when
assessing a future renderer change. No product behavior is changed.

## Saved baseline

The official baseline is the [#324 measurement comment](https://github.com/n0mad-ai/bastra-recall/issues/324#issuecomment-6297496784).
It measured source `454668dac8446f9b51cee8d0475b85a2ff9b83ee`, on an Apple M4 Pro
with Chrome 155.0.8059.82. Load-1 ranged **4.09–7.46**; the host was not otherwise
fully idle. All 18 native-background attempts were skipped; the synthetic-hidden
rows only test application visibility gating. Chromium CPU 100% means one
logical core, not the entire machine.

Generated `results.json` is intentionally ignored by Git. It contains complete
source measurements, including raw arrays, individual repetitions, CPU process
types, visibility checks and load readings. The published baseline and its limitations are preserved in the
[#324 measurement comment](https://github.com/n0mad-ai/bastra-recall/issues/324#issuecomment-6297496784);
raw results are not included in this harness-only PR. After a new run, generate a local
pooled summary with:

```sh
node scripts/mindspace-perf/summarize.mjs > scripts/mindspace-perf/RESULTS.md
```

The measured source SHA is recorded in JSON. Keep generated summaries local
unless deliberately publishing a reviewed result alongside its source data.
Constant degree four deliberately omits hub/planet solar-system layouts; orbit
still exercises the real depth projection, per-frame array-copy/sort, quiet-edge
scan and galaxy/star decor. The probe does not attribute separate costs to those
subsystems, and does not benchmark culling under a zoomed/offscreen workload.
