# Bastra Recall – Evolution Architecture V1 → V2

> Status: release and target architecture; V1.0 is the next binding
> release contract, V2.0 the measurement-dependent long-term target
>
> As of: 29 August 2026 (contract change C-083, contract additions C-084 and
> C-085, refinement C-086; the signed-off basis of 26 July 2026 otherwise
> unchanged)
>
> Starting state: Bastra Recall 0.8.6, the current vault, real
> 30-day telemetry, and the existing eval geometry
>
> **This is a translation.** The German version at
> `docs/Evolutionsarchitektur V1 zu V2.md` is the reviewed original and the
> governing contract text; this file serves readability, not interpretation.
> Where the two diverge, the German version prevails. Every change is made
> there first and translated afterwards, never the other way round.
>
> Binding ledger state: C-001–C-086, eleven review rounds, one contract change,
> two contract additions and one refinement; C-001–C-082 signed off on 26 July
> 2026, C-083 to C-086 decided on 29 August 2026.
>
> Genesis: signed-off starting state C-001–C-028, carried forward by the
> revisions C-029–C-039, C-040–C-048, C-049–C-054, C-055–C-059, C-060–C-062,
> C-063–C-067, C-068–C-073, C-074–C-077, C-078–C-079, C-080–C-081, and C-082,
> and by the contract change C-083, the contract additions C-084 and C-085,
> and the refinement C-086.
> All twelve interim versions and the starting state are held unchanged under
> `docs/architecture-history/`; they are supporting material, not governing
> contracts. An earlier English version at state C-001–C-028 is held there as
> well and is superseded by this file.
>
> Every passage is traceable to exactly one C-ID through the ledger in 0.4 and
> the delta ledger in Section 28. No entry reinterprets an earlier verdict;
> where a new entry corrects an older one, that is recorded as a correction
> reference on the older entry.
>
> The product-owner decisions in Section 31 have been taken and bind
> the implementation.
>
> Next available ID: C-087. A new delta is carried forward in this file and is
> no longer kept as a separate revision file.

## 0. Decision and Review Status

This document separates five levels:

1. **verified current state** – substantiated directly by code, telemetry, or a
   reproducible run;
2. **V1.0 release contract** – the smallest body of work that establishes a
   robust measurement, decision, and control foundation;
3. **V1.x evolution** – individually gated, backward-compatible steps based on
   real measurements;
4. **V2.0 long-term target** – the joint promotion of the memory functions
   proven during V1.x;
5. **hypothesis** – may be measured or examined in shadow at any time, but
   becomes schema, contract, or live work only after its predefined gate.

### 0.1 V1.0 – Measurement and Control Foundation

The current state 0.8.6 does not yet fully satisfy V1. V1.0 is reached when
solely the following foundations have been implemented and proven:

1. establish measurement truth and reproducible baselines;
2. build a deterministic, explainable abstention and relevance decision from
   signals that already exist;
3. evolve the existing session-context path into one shared, project-capable,
   parallel server-side assembler;
4. introduce a global context budget and measure retrieval quality separately
   from hook wording or consumer behavior.

V1.0 contains no new memory types, claims, graph edge types, dual vectors,
chunking, HNSW, or learned-ranking live layer.

### 0.2 Release Ladder

| Release | Function | Approval logic |
|---|---|---|
| 0.8.6 | today's pre-V1 current state | diagnostic foundation, not a completed V1 contract |
| V1.0 | observable and selective measurement/control foundation | Section 0.1 and Definition of Done 26.1 fully satisfied |
| V1.x | incremental evolution | each component approved individually through its named measurement gate and delivered backward-compatibly |
| V2.0 | complete adaptive memory system | all mandatory V2 properties from 26.2 proven together |

Measurement, shadow operation, and read-only projections are permitted at any
time. Measurement gates gate solely schema/contract changes and
live activation. The exception is quality comparisons whose interpretation
requires the M0 baseline.

Accessibility/Asteroid Belt, Deep Recall, Episodic Memory, Claims, Typed
Graph, consolidation, dual vectors, HNSW, and learned ranking remain in the
document as the V2 long-term target. During V1.x, only those components may be
permanently implemented in product behavior, schema, or contracts, or activated
live, whose named measurement gate substantiates the need and the safety.
Until then they remain limited to measurement, shadow, read-only, or isolated
experiments.

V2.0 is not a blanket approval for components built in advance. It is the
promotion of the parts individually proven during V1.x into one stable overall
system.

### 0.3 Review Discipline

Counter-reviews strictly distinguish an incorrect current state, a measurement
problem, an architectural decision, and a future hypothesis. Every objection
receives a stable ID, the concrete passage, a verdict, file/line evidence or a
reproducible command, and a minimal correction. Points already resolved are
reopened only with new evidence.

### 0.4 Signed-Off Review Ledger

| ID | Verdict | Binding consequence in this document |
|---|---|---|
| C-001 | confirmed | The raw BM25 score and scaled RRF may no longer use shared absolute 30/100 bands as a relevance promise. |
| C-002 | confirmed | **Refined by C-086:** the required conditions of the evidence decision are drawn more narrowly — partial coverage counts only from 50 %, and the hard identifier anchor no longer reads the body. The current `weak_result` is only an informational MCP signal and not a hook gate; V1.0 introduces a real evidence decision with abstention. |
| C-003 | corrected | The production candidate pool is `max(k × 4, 20)`, not 20 everywhere; for out-of-pool evals it is explicitly expanded to 100/200. |
| C-004 | corrected | `GET /hook/session-context` exists, but is projectless and internally serial; it is extended, not used unchanged as a replacement for SessionStart. |
| C-005 | corrected | Bridges are opt-in and a no-op without a pool; on this instance two bridges were active and expanded 853 queries during the measurement period. This firing rate substantiates activity, not usefulness or quality lift. |
| C-006 | confirmed | `acted_on` is a token-overlap proxy and not a gold label; V1.0 therefore does not claim a `relevance_probability`. |
| C-007 | qualified | HNSW is not justified for the current vault, but remains specified as an explicitly gated later automatic-switch strategy. |
| C-008 | confirmed | A complete mutation audit exists today only on the Mac app bridge path; regular MCP/HTTP saves are not covered by it. |
| C-009 | confirmed | Load/use rates mix retrieval, hook wording, consumer behavior, and telemetry attribution; V1.0 separates these effects experimentally. |
| C-010 | confirmed | The ad hoc baseline does not yet have a versioned run artifact and becomes the official baseline only after M0. |
| C-011 | confirmed | Salience acts live on the staleness lifetime; direct ranking influence remains shadow-only by default. |
| C-012 | confirmed | Production telemetry reports p50 1 ms, p95 11 ms, and p99 25 ms for the BM25 stage; the differing ad hoc row is shown separately and marked as not archived. |
| C-013 | confirmed | Accessibility and Typed Graph Evidence are not V1.0 evidence signals; §10.2 separates available V1 signals from later V2 signals. |
| C-014 | confirmed | Context ROI is a system success metric and not a live switching gate of the evidence decision; its activation depends only on retrieval-isolated gates. |
| C-015 | confirmed | The 45.2% measurement has no archived independent provenance and is designated an ad hoc paraphrase measurement. |
| C-016 | confirmed | The absolute Recall@3 target is not a switching gate of the classifying evidence decision; that decision must preserve recall relative to the ungated arm, while absolute coverage is observed as a system target from V1.0 onward. |
| C-017 | confirmed | Typed Graph, versions, and reconsolidation require, in addition to the M4 preparation, a separate schema decision; §25 names this gate explicitly. |
| C-018 | product-owner directive | Measurement, shadow operation, and read-only projections remain permitted at any time; measurement gates restrict schema/contract changes and live activation, with an M0 caveat only for interpreted quality comparisons. |
| C-019 | confirmed | `acted_on` and the token costs computed from it are consistently designated a token-overlap proxy, not demonstrable use. |
| C-020 | confirmed | V1.0 telemetry gains `client`, `hook_source`, and a pseudonymous session dimension, so that the agreed analyses and experiment arms are executable. |
| C-021 | confirmed | M0 delivers versioned numerical M1 tolerances after the baseline run. |
| C-022 | product-owner decision | **Extended by C-085:** the decision route additionally requires spread across at least 20 sessions with at most a 25 % share per session; counting is per memory decision. Shadow sign-off after at least 14 days or 500 logged hook decisions; in addition, gold set gates must pass and all `required`/`no_answer` divergences must be explained. |
| C-023 | product-owner decision | The live evidence decision runs behind a configuration flag with immediate fallback to today's floor behavior; no hard cutover. |
| C-024 | product-owner decision | **Release assignment changed by C-083:** the assignment and minimum-N rule itself applies unchanged, but reaching the minimum N is no longer a V1.0 requirement. Retrieval/presentation experiments assign the arm deterministically per pseudonymous session ID; the minimum N per arm is fixed in versioned form after M0. |
| C-025 | product-owner decision | Private run artifacts live under `~/.bastra/eval-runs/<date>-<hash>/`; the public repository receives only aggregated reports without vault-derived query text. |
| C-026 | confirmed | Chunking is not approved by M2; it requires a separate representation decision based on a chunking on/off ablation. |
| C-027 | confirmed | Product metrics are measurable only from their respective gated data source onward; before that they explicitly remain long-term target. |
| C-028 | confirmed | §19 defines the permitted independent query sources, prohibits access to the body, summary, and `recall_when` of the target memory while a query is being authored, and makes the provenance fields binding in the dataset manifest and the private run artifact. |
| C-029 | architectural decision | Third-party system figures are carried with their evidence class and are never a measurement gate, target value, or acceptance criterion; §2.3 records the verified limits of the cited measurements. |
| C-030 | architectural decision | Cue and evidence are separated. `recall_when` remains the primary authorized cue; derived cues start as a read-only sidecar with origin and never justify `required` on their own. |
| C-031 | architectural decision | Deep Recall is a separate, deliberately triggered mode with a deterministic Tier 1 and an agentic Tier 2; it is ablated against merely larger `k` and never runs inside a hook latency budget. |
| C-032 | architectural decision | The four time axes `occurred_at`, `valid_from`/`valid_to`, `recorded_at`, and `derived_at` are named separately; `created` and `updated` remain pure file times. |
| C-033 | architectural decision | Origin is carried as `provenance_class` on claims and derived content instead of as a second memory taxonomy; a separate opinion/belief network is rejected. |
| C-034 | architectural decision | The Typed Graph receives logical views with a hop budget instead of separate physical graphs; causal and temporal edges never arise from similarity, and every view needs a no-graph control arm. |
| C-035 | architectural decision | Consolidation is expressed solely in named, non-destructive, and reversible proposal operators; every archived source remains reachable through a limited number of typed links. |
| C-036 | measurement problem | The gold set receives action-related and associative case classes; external standard benchmarks remain V1.x adapter work and are not a V1.0 release blocker. |
| C-037 | measurement problem | Usage signals are extended beyond `acted_on` and evaluated exposure-corrected; non-reaction remains a weak negative without live effect before M6. **Term corrected by C-044:** it is an exposure *normalization*, not a bias correction. |
| C-038 | measurement problem | In addition to latency and recall, M5 measures quality decay under growth, in particular abstention, contradiction resolution, and temporal questions. **Acceptance criterion replaced by C-045:** the numerical tolerances from 18.6.1 are binding. |
| C-039 | hypothesis | Gravity and hub damping are carried as additional M2 ablation arms; they supplement the existing lifecycle, Curator, doc, and salience damping, they do not replace it. |
| C-040 | measurement problem | The source matrix in 29 carries, for each third-party claim, the canonical source, version or commit, the exact location, the retrieval date, and for measurements the reader, judge, top-k, and context budget; missing details are shown as missing. |
| C-041 | architectural decision | The time model becomes fully bi-temporal: `recorded_at`/`retracted_at` represent the knowledge period as an interval. `valid_until` remains solely a lifecycle field and is neither equated with `valid_to` nor migrated automatically. |
| C-042 | current-state correction | A missing `provenance_class` never counts as `user_asserted`. Legacy inventory without an unambiguous assignment becomes `unknown_legacy`; only an explicit `write_origin: user-directed` automatically becomes `user_asserted`. **Restricted by C-049 and C-060, superseded by C-063:** the import origin takes precedence, a claimed `write_origin` is not an attestation, and `user_asserted` arises solely through the confirmed review. |
| C-043 | measurement problem | The reduction to bridge and horizon cues is a hypothesis, not a decision: M2 compares four cue arms. The provenance fields of a cue are never ablated, only its ranking effect; the cue arm and the damping arm receive separate gates. |
| C-044 | measurement problem | The division by the surfacing count is exposure normalization, not bias correction. A causal utility lift requires logged selection probabilities, controlled exploration, and the treatment of candidates that were not surfaced as censored. |
| C-045 | measurement problem | The scale and interference test is separated from the Flat/HNSW decision. M5 compares both backends on an identical corpus, identical queries, and an identical configuration; the quality categories receive numerical tolerances after the baseline. |
| C-046 | current-state correction | The `related_via` hop active in hooks today is retained as a semantic baseline and control arm until every new logical view substantiates its own lift. A graph hop alone never produces `required`. |
| C-047 | architectural decision | The Deep Recall termination conditions receive versioned maximum values and a measurable definition of evidence gain; a budget termination is reported as `inconclusive_budget_exhausted` and never as `no_answer`. **Corrected by C-052, completed by C-056:** five end conditions and four result values are binding. |
| C-048 | architectural decision | **Made precise by C-062:** Both rates apply per permission, scope, and sensitivity context. The reachability guarantee receives a versioned maximum hop count and a measurable survival/citation rate; Accessibility operators are separated from content version operators and require their own override/floor contract. |
| C-049 | current-state correction | The import origin takes precedence over `write_origin`: the import stamps machine-generated content as `user-directed` too, therefore only a non-imported save that is substantiated as user-directed automatically becomes `user_asserted`. `confidence` is indexed, but has no effect. **Restricted by C-055 and C-060, superseded by C-063:** not imported is also not sufficient, attestation is not an attribute of the write path — and the confirmation reference arises solely in the Recall surface. |
| C-050 | architectural decision | A contradiction initially produces a competing claim, not `retracted_at`; `valid_to`, `recorded_at`/`retracted_at`, `valid_until`, `obsolete`, and soft delete are five separate states without automatic equation. |
| C-051 | measurement problem | The cue arms form a 2×2 factorial design with separately evaluated main effects and interaction; scene cues need either their own stage after M4 or a defined read-only episode projection. **Supplemented by C-057:** case-number rule, exploratory labeling, and a constant experimental environment. |
| C-052 | architectural decision | Absent evidence gain closes only the branch, not the run; `no_answer` requires deterministic exhaustion of all branches. The result contract is passed unchanged through all surfaces, the hop labeling remains server-internal. **Completed by C-056:** success condition, priority rule, and a fourth result value; `limit: "other"` does not apply. |
| C-053 | architectural decision | The survival invariant is simulated before every Class A operation and either blocks or creates provenance shortcuts; `max_provenance_hops` = 2 is the starting candidate. `SUPERSEDE` remains Class A with a secondary visibility effect without an Accessibility override. **Completed by C-058 and C-059, made precise by C-062:** atomicity and fallback cascade, delimitation against the archiving primitive, rates per permission context. |
| C-054 | measurement problem | Ledger and source consistency: correction references on C-037 and C-038, source attribution of the AgentRunbook measurement row, adjusted `confidence` statement (today in 6.3), C-055 consistently as the next available ID. |
| C-055 | current-state correction | **Superseded.** Corrected by C-060, answered by C-063, tightened by C-064 and C-070, corrected by C-065 and C-069: the consequence stated below no longer applies — `user_asserted` arises solely through the confirmed review, and the review authorization depends neither on `write_origin` nor on the import status. In detail: a mutation audit is not sufficient; the confirmation reference arises in the Recall surface; a confirmation applies to exactly one memory and one content state; `not_scheduled` is no longer an exception. A `write_origin: user-directed` set by the caller is not an attestation. `user_asserted` arises automatically only through a server-side substantiated trustworthy write path; the review carries `confirmed_provenance_class` with an audit reference, and the provenance confirmation is a separate revocable contract, not a Class B override. |
| C-056 | architectural decision | The Deep Recall end-state contract is completed: `answer_found` receives its own end condition, find priority before limit, `inconclusive_budget_exhausted` only on a real resource limit, otherwise `inconclusive_interrupted` with `stop_reason`; errors remain errors. **Corrected by C-061:** `controller_defect` leaves the result values and `stop_reason`. |
| C-057 | measurement problem | **Supplemented by C-066, corrected by C-072:** The two experimental designs from 18.3 are binding. The cue generation path is carried as a separate, pre-registered factor. M0 fixes power and minimum N per cell of the 2×2 cue experiment in versioned form and provides separate descriptive and associative gold cases; if N is too small, the interaction remains exploratory and carries no live approval. |
| C-058 | architectural decision | The provenance shortcut and keeping an intermediate node visible are part of the same atomic Class A proposal; for the case that cannot be satisfied there is a defined, loop-free escape, and shortcuts preserve sensitivity boundaries. **Made precise by C-062:** The block rests on a structural fingerprint. |
| C-059 | architectural decision | `SUPERSEDE` works through claim and version status and does not correspond to today's `archive_memory`; historical predecessors remain reachable through a named Historical/Deep Recall index, and rollback also restores the storage location and indexability. **Made precise editorially:** Access may begin as a logical view on the existing index. |
| C-060 | current-state correction | **Answered by C-063:** The confirmation reference arises in the Recall surface; no write path becomes an attestor. A mutation audit substantiates the mutation, not the user action: the audit context is supplied by the caller and otherwise falls back to `actor: user`. Attestation requires a confirmation reference that the saving caller cannot assert; without it, no automatic `user_asserted` arises. |
| C-061 | architectural decision | `controller_defect` leaves the result values and becomes a structured interface error with a read-only partial state. `no_answer` means “no decision-capable answer”, not “no evidence”; partial coverage is reported. |
| C-062 | architectural decision | The survival rate and citation rate apply per permission, scope, and sensitivity context with a target value of 100% within each context; the repetition lock rests on a structural fingerprint instead of on time or cache. **Made precise by C-067:** a changed fingerprint alone is not sufficient, the proposal must be a different one in substance. |
| C-063 | product-owner decision | **Corrected by C-068 and C-069:** The surface asks progressively and maps seven provenance classes — observation, derivation, and conjecture remain separate; the review authorization depends neither on `write_origin` nor on the import status. The confirmation reference arises in the Recall surface: `user_asserted` arises solely through the explicit user confirmation during the review, never automatically in the save path. The four answer options of the surface map four provenance classes. |
| C-064 | product-owner directive | **Operationalized by C-070:** Binding to `memory_id` and the hash of the assertion-bearing content displayed in the review; retrieval, display, and operational metadata do not cause a lapse. A confirmation applies to exactly one memory in exactly one content state. It is not transferable, not reusable, and lapses when the confirmed memory changes in substance. |
| C-065 | product-owner decision | **Made precise by C-071, corrected by C-076:** The data source for review stage 2 is the existing usage sidecar; missing history means `unknown` and does not automatically lead to stage 2. The entire inventory is reviewed. `not_scheduled` now denotes only the queue position and not an exception; the review runs in four priority stages and ends, per memory, with a clarified origin or an explicitly confirmed unclear origin. |
| C-066 | product-owner decision | **Corrected by C-072:** The two designs from 18.3 apply to the cue generation path. Section 31 becomes the decision record: cue generation deferred and examined in M2 as a pre-registered factor, exactly one action-oriented external benchmark in V1.x, Deep Recall Tier 2 only after the Tier 1 measurement, origin reviewed read-only for now, and schema fields together after M4. |
| C-067 | product-owner directive | A rejected consolidation proposal returns only if it is a different one in substance; a changed fingerprint is a necessary but not sufficient condition. **Operationalized by C-073, made free of contradiction by C-075:** changed structural fingerprint, changed semantic proposal hash, and a named material change. |
| C-068 | current-state correction | The UI answer “from the agent” is not mapped wholesale to `agent_observed`. Observation, derivation, and conjecture remain separate classes; the surface asks progressively. |
| C-069 | current-state correction | **Tightened by C-077:** The suggested value is displayed and justified, but is not pre-selected. The entire inventory is capable of review and confirmation. Import status and `write_origin` determine solely the derived initial class and a suggested value of the surface, never the review authorization. |
| C-070 | architectural decision | The confirmation reference binds to `memory_id` and a hash of the assertion-bearing content displayed in the review. Retrieval, display, and operational metadata do not cause a lapse. |
| C-071 | current-state correction | **Corrected by C-076:** `unknown` does not automatically make a memory stage 2; floors and pin are not suitable as a second criterion. Per-memory usage telemetry already exists as a usage sidecar with `surfaced`, `loaded`, `acted_on`, and timestamps; review stage 2 names it as the source. Missing history means `unknown`, not zero. |
| C-072 | measurement problem | **Corrected by C-074:** Design A has two conditions instead of four cells and requires a selection/holdout split; only Design B measures interactions. The experiment on the cue generation path becomes unambiguous: either a paired agent-versus-batch comparison with the cue axes held fixed (Design A) or a fully crossed 2×2×2 with its own minimum N (Design B). The design is registered before the run. |
| C-073 | architectural decision | **Made free of contradiction by C-075, canonicalized by C-079:** The hash arises from a versioned canonical structure; instead of justification prose, a reason code enters it, and the source version is a semantic content version. The resubmission of a rejected proposal requires a changed structural fingerprint, a changed semantic proposal hash, **and** a named material change; identical proposal content remains suppressed. |
| C-074 | measurement problem | Design A is a two-condition comparison, not a four-cell design: the cue configuration is determined on a separate selection split and compared on an independent holdout, alternatively through a pre-registered nested evaluation. Only Design B has eight cells and can measure interactions. |
| C-075 | architectural decision | **Canonicalized by C-079:** The hash is formed from a versioned structure without free text. The semantic proposal hash covers the operator type, the normalized target change, source IDs and versions, affected edges, the evidence and justification state, and the protection conflict resolution; the resubmission requires all three conditions. |
| C-076 | current-state correction | **Made executable by C-078:** The structural criterion is fixed in versioned form in advance. Missing sidecar history does not automatically make a memory stage 2. Stage 2 covers substantiated high usage and history-unknown memories with demonstrably high structural impact; floors are already stage 1, and an independent pin source does not exist at HEAD. |
| C-077 | product-owner directive | No provenance answer is pre-selected. The derived class appears as a justified system suggestion; `confirmed` arises only through active selection, a click on “next” over a default is ineffective. |
| C-078 | measurement problem | **Made semantically precise by C-080, made subject to proof by C-081:** The bridge component is cross-cluster adjacency, and the snapshot is to be proven in the artifact. The boundary between review stage 2 and 4 is fixed before the queue is built, as a versioned structural criterion from a frozen graph snapshot, and stored in the manifest; it applies to history-unknown memories outside stages 1 and 3, the evaluation runs 1 → 3 → 2 → 4, and a graph failure leads conservatively to stage 4. |
| C-079 | architectural decision | **Supplemented by C-081:** A reason code outside the applicable vocabulary version triggers no resubmission. The semantic proposal hash is formed from a versioned canonical structure and contains no free explanatory text; the source version denotes a semantic content version, not `updated`. |
| C-080 | current-state correction | The field `GraphNode.bridge` substantiates neither a graph-theoretic bridge nor an articulation node: `buildGraph` sets it as soon as a node has neighbors in at least two different foreign clusters, without checking whether those clusters would be unconnected without it. It remains part of the structural criterion, but solely with this meaning; a genuine articulation analysis would be additional graph work and is not claimed. |
| C-081 | architectural decision | **Gate corrected by C-082:** The assignment and the proof artifact are sidecar/run artifacts permitted at any time under C-018 and C-025 and are bound to no measurement gate. The frozen graph snapshot is substantiated in the queue or run artifact — projection schema and version, snapshot hash, creation time, applied criterion including threshold or quantile, and per assigned history-unknown memory the ID, `degree`, foreign clusters or `bridge` value, and resulting stage; alternatively persisted content-addressed and referenced. A timestamp alone is not sufficient. During a running review nothing is recomputed or reassigned, a restart continues the same queue. An unknown reason code leads conservatively to no resubmission. |
| C-082 | current-state correction | The versioned queue or run artifact of the inventory review falls neither under M4 nor under the schema decision from 21.4: it changes neither memory content nor the vault schema and may be persisted immediately. 21.4 takes effect only when snapshot, queue, or review fields are adopted into the memory frontmatter or the persistent memory schema. |
| C-083 | contract change | Of the retrieval/presentation experiment from 17.4, V1.0 now owes only the pre-registered design, the deterministic arm assignment and the honest status report (`underpowered` or `not_evaluable` per 18.1). The adequately populated run — minimum N per arm reached, second hook wording, per-session switchable gate, query class collected, independent relevance labels — moves to 26.2. The justification is measured: the unit of randomisation is the session, and the single-user population does not carry a minimum N in reasonable time. |
| C-084 | contract addition | From V1.0 on, the frontmatter format is under an explicit promise (26.1): required fields, memory types, the meaning of the documented optional fields and the loader leniency change only with a major bump. No 1.x reader requires a format-version field. Unknown keys are tolerated on load but are not guaranteed to survive an `overwrite`. Not covered are ranking, the internal `.bastra/` storage and projection content; the shape of `recall` output falls under the separate API contract. Tightening the loader without a major bump is admissible only under the narrowly drawn security exception. |
| C-085 | contract addition | The 500-decision route of the shadow sign-off (18.2) applies only with spread: at least 20 different sessions carry the counting decisions, and no single session supplies more than 25 % of them. The 14-day route is untouched. Clarification in the same entry: counting is per memory decision, not per hook call — that is how the threshold is implemented and how it is meant. |
| C-086 | refinement | Both routes to `required` are drawn more narrowly (10.3): the partial-coverage signal of the two-of-three count applies only from 50 % trigger coverage instead of from the first shared term, and the hard identifier anchor reads title, `recall_when` and frontmatter instead of the body as well. Quantified before the change: anti-query gate from 50 % to 12.5 %, Recall@3 gated, identifier queries and false abstention unchanged, length-neutral. Open: the anti-probe set is too small, and the cost of the lost obligations is visible only to the shadow telemetry. |

**Sign-off status 24 July 2026:** full reconciliation of ledger C-001–C-027,
gate measurability, current-state claim sweep (58 claims, all covered),
implementer review. Future counter-reviews concern solely
change deltas against this state.

**Final architecture sign-off 24 July 2026:** C-028 is confirmed in the final
delta review; there are no substantive open deltas. The signed-off
basis C-001–C-027 remains unchanged. Next available ID: C-029. *(Historical
state of 24 July 2026. The currently applicable next available ID is at the
end of this section.)*

**Research delta revision 25 July 2026:** counter-check of a
research briefing against the primary sources cited there and against the
code state. All sources named in the briefing were retrieved; one URL was
dead, one series of figures was cited without a source of its own, and nine
current-state claims about Bastra were substantiated again at HEAD. The result
is the deltas C-029–C-039. The basis C-001–C-028 remained valid unchanged; no
earlier verdict was revised.

**Codex counter-review of the revision, 25 July 2026:** The
counter-review objected to nine points in C-029–C-039 — missing
reproducibility of the source matrix, a time model that is only half
bi-temporal, a dangerous provenance fallback, an unsubstantiated cue
reduction, a wrongly named exposure correction, the conflation of the scale
test and the backend decision, the impending silent loss of today's
hop baseline, non-executable Deep Recall termination conditions, and an
unmeasurable reachability guarantee. All nine are confirmed and incorporated
as C-040–C-048; three of them correct an error of the preceding revision, not
merely an imprecision. Details in Section 28, source evidence in Section 29.

**Codex delta review, 25 July 2026:** A pure delta fix with
six points. The most serious is C-049: the provenance mapping introduced in
C-042 would have reintroduced, through the import path, exactly the error that
C-042 was meant to fix — the import stamps every piece of content and
even a machine-generated navigation index as `user-directed`.
In addition, two current-state claims had to be made precise, three contracts
tightened, and five consistency points cleaned up. C-001–C-048 remain
unchanged; corrected older entries carry a correction reference in place.

**Concluding correction round, 25 July 2026:** Five points,
two of them current-state corrections against the code state. C-055 closes the
last gap in the provenance chain: a `write_origin` claimed by the caller is not
an attestation, because the regular MCP save adopts the field unchecked. C-059
decouples the future `SUPERSEDE` from today's archiving primitive, which does
not merely mark the predecessor as `obsolete` but removes it from the living
index and moves it to the trash. C-056 through C-058 complete three
contracts that still had gaps in the previous round. Two editorial
clarifications without a C-ID of their own concern `stale_status` and the last
open M5 review point.

**Last delta fix, 25 July 2026:** Three points. C-060
corrects the attestation definition from C-055: the audit context of the
bridge path is supplied by the caller and otherwise falls back to `actor: user`
— a mutation audit therefore substantiates the mutation, not the user action.
C-061 removes `controller_defect` from the result values and makes
`no_answer` precise against partial evidence. C-062 makes the survival
guarantee permission-related and the repetition lock fingerprint-based. Three
editorial corrections concern a code location, a line count, and
the permitted implementation of Historical access.

**Product-owner decisions, 25 July 2026:** The four decisions prepared in
Section 31 have been taken; the provenance question left open in C-060 is
added as a fifth. Two of them have effect beyond the section: the confirmation
reference left open in C-060 has a named source in the Recall surface (C-063),
and the complete inventory review lifts the previous suspension rule for
`not_scheduled` (C-065). Two technical points previously delegated to the
product owner become fixed quality requirements: binding a confirmation to
exactly one memory (C-064) and the return rule for rejected proposals (C-067).
Section 31 is therefore not a section of drafts but a section of record.

**Counter-review of the decision implementation, 25 July 2026:** Two
blockers and four clarifications. Both blockers concern the implementation of
C-063: the surface would have mapped three epistemically different origins onto
one class (C-068), and a leftover derivation sentence would have coupled the
review authorization to the import status and `write_origin` — contradicting
the complete inventory review from C-065 (C-069). In addition there is a
current-state finding on the usage telemetry that already exists (C-071) and
three operationalizations: confirmation binding (C-070), cue experimental
design (C-072), and proposal repetition (C-073).

**Concluding correction round, 26 July 2026 (this version):** Four points, all
of which concern rules from the previous round. C-074 corrects an
arithmetically wrong cell count: Design A has two conditions, not four cells,
and needs a holdout split or a pre-registered nested evaluation, so that the
selection of the cue configuration does not contaminate the comparison. C-075
resolves a circular argument in the resubmission contract —
the proposal hash covered only the state change, while evidence and
justification were to count as a material change. C-076 corrects an
empirically untenable stage assignment and relies on the code in doing so:
floors are already stage 1, and an independent pin source does not exist.
C-077 tightens the surface rule: no pre-selected answer.

**Delta fix on the discretion gaps, 26 July 2026:** Two points that remedy the
same weakness: a rule was formulated but not executable, and in each case the
gap lay in the implementer's discretion. C-078 fixes the boundary
between review stage 2 and 4 in advance and in versioned form, so that it does
not drift during the run. C-079 canonicalizes the semantic proposal hash, so
that a mere rewording does not move it.

**Concluding delta fix, 26 July 2026 (this version):** Two points that
both remedy the same weakness: a rule formulated executably relied
on a promise that neither the code nor the artifact delivers. C-080 pulls the
meaning of the `bridge` field back to what `buildGraph` actually
computes — cross-cluster adjacency, not proven separation.
C-081 makes the frozen graph snapshot subject to a proof obligation, so that
the stage assignment remains verifiable without the live graph that changes
later, and blocks resubmission for a reason code outside the applicable
vocabulary.

**One-sentence delta fix, 26 July 2026 (this version):** A gate contradiction
in the C-081 block. The block had placed the persistent form of the proof
artifact under the schema decision after M4, binding a rule that is to apply
immediately to a gate that falls only after several measurement stages. C-082
lifts that: the artifact is a sidecar/run artifact under C-018 and C-025.

**Contract change, 29 August 2026 (this version):** For the first time an
entry changes not a verdict but the scope of the V1.0 release contract itself.
C-083 removes reaching the minimum N in the retrieval/presentation experiment
from 26.1 and moves the adequately populated run to 26.2. The occasion is the
sample-size measurement from the experiment's registration: per 17.4 the unit
of randomisation is the session, and on today's single-user population no arm
reaches a viable count in reasonable time. What V1.0 owes remains fully
checkable — registration, deterministic assignment, and the honest statement
that an arm is not evaluable. The replaced wording remains marked as such in
26.1; no verdict from C-001–C-082 is reinterpreted.

**Contract addition, 29 August 2026 (this version):** C-084 records the
frontmatter and schema promise that V1.0 makes when the leading `0.` falls
away. It was documented nowhere until then — neither in 26.1 nor in 22 nor in
`docs/memory-schema.md` — although from 1.0 on every change to the vault format
requires a major bump. The entry promises solely what the code holds today: the
ten required fields, the recognized types, the meaning of the optional fields
and the loader leniency from the rescue path. Explicitly not promised are
ranking, internal storage, projection content and the preservation of foreign
keys across an `overwrite`; the shape of `recall` output is bound, but through
its own API contract.

**Contract addition, 29 August 2026 (this version):** C-085 binds the decision
route of the shadow sign-off to spread. The threshold "500 decisions or 14
days" knew only a quantity; in the real record 2040 of 2052 logged decisions
came from a single session, so one working day would formally have filled the
gate. From now on the decision route counts only with at least 20 different
sessions and at most a 25 % share per session; the 14-day route is untouched.
The same entry records the counting reading: per memory decision, not per hook
call.

**Refinement, 29 August 2026 (this version):** C-086 draws both routes to
`required` more narrowly. The two-of-three count treated any trigger coverage
above zero as an independent signal, so a single coincidentally shared term
helped carry an obligation; it now counts only from 50 % coverage. The hard
identifier anchor additionally searched the body and thereby turned a mention
in prose into responsibility; it now reads only title, `recall_when` and
frontmatter. Both narrowings were quantified before the change: the anti-query
gate falls from 50 % to 12.5 %, while Recall@3 gated, identifier queries and
false abstention stay unchanged. Two reservations are stated explicitly in the
entry — eight anti-probes cannot represent the 5 % threshold, and the cost of
the lost obligations is visible only to the shadow telemetry.

**Next available ID: C-087.** New delta reviews begin there. A verdict
changes only with new code, telemetry, or run evidence; matters of taste
are marked as an architectural decision instead of a factual error.

## 1. Purpose

The evolution of Bastra Recall from V1 to V2 is not merely to find more
memories. The system is to decide with increasing reliability:

1. whether any memory is relevant at all;
2. which kind of memory is responsible for the current situation;
3. how deeply the search must go;
4. whether a memory is to surface spontaneously, be found only on request, or
   be deliberately retrieved “from far away”;
5. when individual experiences are consolidated into durable knowledge;
6. when old knowledge is merely harder to access, historical, or demonstrably
   outdated.

The central product statement remains:

> The user shall not have to think on behalf of the AI.

With V1.0 at the latest, a second condition becomes operational:

> The AI shall not burden the user with memories that have no demonstrable
> relevance to the current situation.

## 2. Starting Position

Today's architecture already has strong individual components:

- a local Markdown/YAML vault as the source of truth;
- BM25 with a heavily weighted `recall_when`;
- optional semantic search via embeddings;
- RRF fusion of lexical and semantic hits;
- doc2query triggers, optional language bridges activated by opt-in, and
  automatic relationships;
- Staleness, floors, and the Curator; Salience already extends the
  staleness lifetime, its direct ranking influence is by default
  shadow-only;
- Reflex memories with explicit user approval;
- local telemetry for `surfaced`, `loaded`, and `acted_on`;
- recoverable deletion and stable memory IDs; a complete
  mutation audit currently exists only on the Mac app bridge path, not for
  regular MCP/HTTP saves.

These components, however, do not yet add up to a closed model of attention,
forgetting, remembering, and consolidation. Today's score
semantics in particular cause almost every query to produce an apparently
strong top hit.

### 2.1 Verified Snapshot, Not Yet a Reproducible Benchmark

Figures measured read-only on 24 July 2026 against the current vault with 577
memories:

| Measurement | Result |
|---|---:|
| BM25 stage, 30-day production telemetry | n 22,819 · p50 1 ms · p95 11 ms · p99 25 ms |
| BM25 ad hoc benchmark, method not archived | p50 5.1 ms · p95 13.3 ms · p99 19.3 ms |
| PreTool hook total | median 141 ms · p95 255 ms |
| recall portion in the daemon | median 95 ms · p95 223 ms |
| SessionStart | median 381 ms · p95 499 ms |
| MCP recall | median 105 ms · p95 200 ms |
| ad hoc paraphrases, provenance not archived | Recall@1 45.2% · Recall@3 57.1% · MRR 0.521 |
| anti-query top score | median 137.7 |

30-day telemetry:

| Signal | Result |
|---|---:|
| reachable PreTool calls | 4,009 |
| top score ≥ today's Required threshold | 4,006 · 99.9% |
| surfaced Required hints | 16,762 |
| of those loaded | 153 · 0.9% |
| of those counted as `acted_on` (token-overlap proxy) | 82 · 0.5% of the surfaced hints |
| estimated injected hint tokens | 519,588 |
| tokens per memory counted as `acted_on` (proxy) | approx. 6,336 |

The telemetry figures come from the existing `stats.ts` methodology. The
30-day window moves; slightly different values in a later run are
therefore not a contradiction.

The production row for the BM25 stage comes from
`recall_stages.bm25_search_ms`; during the counter-check on 24 July 2026 the
moving window contained 22,819 matching events. The separate
BM25 ad hoc, paraphrase, and anti-query values were measured with read-only
runs, but have not yet been stored as a versioned run artifact with command
line, method, and code, vault, model, configuration, and dataset hash.
In particular, no provenance independent of the memory surface is archived for
the 45.2% paraphrase measurement. These values are
diagnostic hints and may count as an official baseline only after M0.

The load and `acted_on` rates do not prove that every unloaded hint was
wrong. They measure the overall system of retrieval, hook wording,
consumer behavior, and telemetry attribution. `acted_on` is today itself a
lexical token-overlap proxy. The values nevertheless show unambiguously that
the current absolute score is not a robust relevance promise and that the
Required band is not calibrated as an internal control variable. The visible
hook text already calls the hits “hints, not obligations”; scope and
suppression bypasses internally still hang on the 100 threshold.

The two language bridges activated on this instance were not only wired up in
theory: in the evaluated 30-day snapshot they expanded
853 queries. Without opt-in or without a bridge pool the layer is by
definition a no-op. The 853 expansions measure solely how
often a bridge fired; they substantiate neither hit quality nor a causal
recall lift.

### 2.2 Main Problems

1. **Rank is not a probability.** BM25 and scaled RRF live in
   different score spaces, but use the same absolute floors.

2. **Real abstention is missing.** A ranking always has a first place,
   even when the correct answer is “nothing suitable available”.

3. **Association is stronger than inhibition.** Embeddings, query expansion,
   and graph hops increase reach, but not automatically precision.

4. **Episodes and durable knowledge compete in the same retrieval space.**

5. **Forgetting is assembled only from individual rules.** Time, salience,
   Curator demotion, and floors do not yet add up to a unified, explainable
   Accessibility.

6. **The hot path is unnecessarily serial.** SessionStart executes several
   recall and metadata queries one after another.

7. **The eval sets are in part too small or not close to production.** Small
   synthetic sets reach ceiling values, while real paraphrases perform
   markedly worse.

8. **The hybrid stress path is not reliably wired up.** A
   `packages/daemon/scripts/eval-stress.ts --hybrid` run remains structurally
   BM25-only in the current stress harness, because no `EmbeddingIndex` is
   created there. Other specialized eval arms can already use real
   embeddings; the statement explicitly concerns the stress harness.

9. **Retrieval and consumer behavior are conflated in the ROI measurement.**
   Low load rates can arise from irrelevant hits, hook language,
   consumer compliance, or incomplete telemetry attribution.

10. **The current quality measurement has no run provenance yet.** Without a
    versioned artifact, a real before/after decision is not reproducible.

Points 1, 2, and 6 through 10 are directly verified problems of the
V1.0 release contract. Points 3 through 5 justify the long-term target,
but are not yet evidence that the later components described for it must be
built now.

### 2.3 Third-Party System Evidence and Its Limits

On 25 July 2026, the sources of an external research review on comparable
agent memory systems were retrieved and their core claims examined one by one.
The result supports the direction of this document. It changes nothing about
the current state from 2.1, and no examined system supplies an independently
replicated measurement that could carry a Bastra decision.

Binding consequence:

- Every third-party figure is carried with its evidence class: peer-reviewed,
  preprint, code implemented in production or documentation,
  vendor benchmark, or the respective project's own measurement.
- Third-party figures may motivate design decisions. They are never a
  measurement gate, target value, or acceptance criterion for Bastra.
- Different readers, judges, prompts, top-k, candidate pools,
  context budgets, and dataset versions prohibit a shared ranking.

The substantiated limits of the strongest cited figures:

- Hindsight reports 91.4% LongMemEval and 89.6% LoCoMo, as well as recall
  under 200 ms at 10,000 memory units without a backbone call. The
  independent reproduction named in the paper comes from Virginia Tech and
  Washington Post; both provide co-authors of the paper. In the same table, a
  third-party system is ahead of Hindsight on LoCoMo with 90.0%.
- Zep's LoCoMo 94.7% and LongMemEval 90.2% appear solely on its
  own research page; reader and judge are the same model. The
  associated paper names older, differing values.
- MAGMA's LoCoMo lead of 0.700 over 0.590, 0.580, and 0.481 applies only
  to the LLM-as-a-judge metric. According to the appendix, the hyperparameters
  were optimized on LoCoMo, while the comparison systems ran with defaults; on
  the lexical metrics a comparison system is ahead.
- Ori Mnemos reports HotpotQA results from a run with 50 questions, and the
  figures in the main README differ from those in the `bench` directory.
- With the managed pipeline, Mem0 reaches 94.8% on LongMemEval at Top 50 and
  92.5% on LoCoMo at Top 200 — two different retrieval depths that may not be
  placed side by side; at the same depth the figures are 94.4% and
  91.8% respectively. On BEAM with ten million tokens of history, the same
  pipeline falls to a 50.5% pass rate, with averages of 0.163 for
  temporal questions, 0.325 for contradiction resolution, and 0.400 for
  abstention on a scale of 0 to 1; the associated pass rates are 20%, 25%, and
  40%. The run covers 200 of the 2,000 official BEAM questions.

The last point is the most important single finding of the research and the
reason for the delta on M5: high values on short conversational benchmarks say
nothing about interference, contradiction, and abstention under growth.
These properties are precisely Bastra's product promise.

T-Mem, All-Mem, and LongMemEval-V2 or AgentRunbook are preprints
without demonstrable acceptance; for T-Mem no code was published as of the
review date. Peer-reviewed substantiation exists, by contrast, for Hindsight
as an ACL demo, MAGMA, Mem2ActBench, and the graph counter-position from the
same conference.

## 3. Scientific Guardrails

Bastra does not simulate a biological brain. V2 adopts only principles that
translate into useful system architecture.

### 3.1 Complementary Learning Systems

Complementary Learning Systems theory distinguishes fast learning of
individual experiences from the slow build-up of structured knowledge. Replay
connects the two systems.

Transfer to Bastra:

- a fast, append-only episode store;
- a slow, stable semantic store;
- regular, evidence-based consolidation instead of immediate generalization.

Source:
[Kumaran, Hassabis & McClelland – Complementary Learning Systems Theory Updated](https://pubmed.ncbi.nlm.nih.gov/27315762/)

### 3.2 Pattern Separation and Pattern Completion

Pattern separation keeps similar experiences apart and reduces
interference. Pattern completion reconstructs a memory from incomplete
hints.

Transfer to Bastra:

- separate episodes, versions, entities, and time periods;
- no premature merging of similar memories;
- BM25, embeddings, doc2query, and the graph as pattern completion tools;
- typed edges, claims, and conflict detection as pattern separation tools.

Source:
[Yassa & Stark – Pattern separation in the hippocampus](https://pubmed.ncbi.nlm.nih.gov/21788086/)

### 3.3 Replay and Consolidation

Offline reactivation can integrate new and old experiences while at the same
time protecting existing knowledge.

Transfer to Bastra:

- the Curator as a controlled “sleep” pass;
- a mixture of new, old, successful, and contradicting episodes;
- proposals instead of autonomous rewriting of content;
- retention of the original evidence.

Source:
[Singh, Norman & Schapiro – Sleep-dependent memory consolidation](https://pubmed.ncbi.nlm.nih.gov/36279437/)

### 3.4 Reconsolidation

Reactivated memories can temporarily become modifiable and must be
stabilized again. The direct biological evidence comes among other things
from animal models; for Bastra this is a design analogy, not an equation.

Transfer to Bastra:

- a successful retrieval opens a verifiable update candidate;
- new evidence produces a version or a `supersedes` relation;
- no silent overwriting of historical truth.

Source:
[Nader, Schafe & LeDoux – Reconsolidation after retrieval](https://pubmed.ncbi.nlm.nih.gov/10963596/)

### 3.5 Adaptive Forgetting

Forgetting is not only loss. Suppressing competing memories
can reduce future interference.

Transfer to Bastra:

- reduce accessibility, do not delete;
- damp frequently ignored competitors;
- reinforce successful reuse;
- Deep Recall retains access to dormant content.

Source:
[Wimber et al. – Retrieval induces adaptive forgetting](https://pubmed.ncbi.nlm.nih.gov/25774450/)

## 4. Architecture Principles

1. **Inhibition before additional association.** Every expansion of the
   candidate space needs a stronger relevance or abstention gate.

2. **Accessibility is not existence.** A memory may become hard to reach
   without being deleted.

3. **Rank is not trust.** Internal search scores may never be issued
   directly as a promise to the user.

4. **No answer is a valid result.** `no_answer` is a normal
   system state, not an error.

5. **Working context bounds long-term memory.** Goal, project, files,
   entities, and task phase filter before the broad retrieval.

6. **Episodes are stored fast, rules are learned slowly.**

7. **Every generalization keeps its evidence.**

8. **Forgetting and remembering must be explainable.**

9. **Automatic backend choice is measured, not guessed.**

10. **Human-in-the-loop is retained for durable rules, reflexes, preferences,
    conflict resolution, and deletion.**

11. **Local-first, privacy, and survival-by-ID remain not negotiable.**

## 5. Long-Term Target

```text
Prompt / Tool Intent / Session Context
                |
                v
      Working-Memory Controller
      - goal, project, files, entities
      - task phase, recent errors, constraints
                |
                v
      Adaptive Retrieval Controller
      - exact/reflex lane
      - lexical lane
      - semantic lane
      - deep-recall lane
      - deadline + token budget
                |
       +--------+---------+
       |                  |
       v                  v
  Sparse Index       Vector Strategy
  BM25 / fields      Flat or HNSW
       |                  |
       +--------+---------+
                |
                v
        Candidate Evidence Set
        - lexical evidence
        - vector evidence
        - scope/time/source
        - accessibility
        - graph relations
                |
                v
      Deterministic Evidence Gate + Abstention
      - later: calibrated probability
                |
       +--------+---------+
       |                  |
       v                  v
  Normal Recall       Deep Recall
  Core + Orbit        Asteroid Belt
       |                  |
       +--------+---------+
                |
                v
      bounded context / load-on-demand
                |
                v
      usage, correction and outcome signals
                |
                v
       Curator / Consolidation / Review
```

## 6. Memory Layers

V2 separates the function of memories without giving up the existing markdown
vault.

### 6.1 Working Memory

Transient session state, not automatically persistent:

- current goal;
- project and worktree;
- affected files and symbols;
- active entities;
- current task phase;
- recent errors and corrections;
- confirmed constraints;
- open questions;
- memories already loaded.

Working Memory serves as an attention and filtering model. It is to be small,
timely and fully discardable.

### 6.2 Episodic Memory

New lane, or new memory type `episode`:

- `occurred_at`;
- `session_id` or a stable task reference;
- situation and context;
- action performed;
- outcome;
- successful / failed / partial;
- files, symbols and entities involved;
- source or substantiating record;
- possible emotional salience;
- links to decisions, lessons and other episodes.

Rules:

- append-only by default;
- no automatic required injection;
- primary use for Deep Recall, consolidation and root-cause search;
- old episodes may fade but are retained;
- similar episodes are linked, not silently merged.

### 6.3 Semantic Memory

Stable knowledge:

- Lessons;
- Decisions;
- Preferences;
- Project Facts;
- Workflows;
- References;
- document sidecars.

V2 adds or operationalizes:

- structured claims;
- evidence links;
- `valid_from`;
- `valid_to`;
- `confidence`;
- `supersedes`;
- `contradicts`;
- `derived_from`;
- `last_verified_at`.

Semantic memories arise from an explicit user instruction, a secured source, or
a confirmed consolidation.

#### Time axes

Bi-temporal means: both axes are **intervals**, not points in time. The world
has a validity period, the system a knowledge period — and the two can end
independently of each other:

| Field | Axis | Meaning |
|---|---|---|
| `occurred_at` | event | when the event took place |
| `valid_from` / `valid_to` | real-world validity | the period during which a statement holds in the world |
| `recorded_at` / `retracted_at` | system knowledge | the period during which Recall knew the statement and held it to be valid |
| `derived_at` | derivation | when a derived statement was produced, optional |

A single `recorded_at` point in time is not sufficient. Only the pair
`recorded_at`/`retracted_at` answers the question “what did the system hold to
be true on date X?” separately from “what was actually true on date X?”.
Without `retracted_at`, every withdrawn statement would retroactively have to be
read as if the system had never believed it — which would make past wrong
decisions impossible to reconstruct.

**A contradiction alone does not set `retracted_at`.** That would be a silent
automatic decision and would run counter to the rule from Section 13 that
contradictions are visibly declared instead of resolved. The sequence is staged:

1. A detected contradiction first produces a **visible conflict finding** and a
   `LINK` proposal for the `contradicts` edge. Both statements remain active and
   visible; the conflict is declared. The edge itself is persisted only after
   approval under 14.4 — it is a strong edge and is therefore subject to the
   evidence and approval obligation from Section 13.
2. `retracted_at` is set only by a **confirmed resolution** — an accepted
   correction or a confirmed `SUPERSEDE`.
3. If the conflict remains unresolved, it stays open. An open contradiction is
   a valid system state and counts towards memory health under Section 20, not
   towards the time axes.

No step deletes anything.

**`valid_until` is none of these fields.** It already exists today and is solely
a lifecycle or accessibility field: it is read at exactly one place and
translated there into a score multiplier — `expired` damps to 20%, `aging` to
85%. It excludes no memory from recall, and it says nothing about whether the
statement still holds in the world. An expired `valid_until` means “this memory
is to surface spontaneously less often”, a reached `valid_to` means “this
statement is no longer true”. These are not the same.

From this it follows bindingly:

- `valid_until` is **not** equated with `valid_to`;
- `valid_until` is **not** automatically migrated to `valid_to`;
- `valid_until` retains its current damping effect unchanged;
- a memory can simultaneously have `valid_to` in the future and an expired
  `valid_until` — it is then true, but hard to access. Precisely this
  combination is the reason to keep the two fields separate.

`created` and `updated` likewise retain their current semantics as write times
and are not reinterpreted after the fact. Noteworthy and deliberately left
unchanged: `updated` feeds the staleness calculation today, `created` does not.

#### Five separate states

Temporal validity, system-side knowledge, accessibility, hiding and deletion are
five different things. They are frequently confused because all of them can lead
to a memory no longer appearing:

| State | Statement | Level |
|---|---|---|
| `valid_to` reached | the statement no longer holds in the world | claim |
| `retracted_at` set | the system no longer holds the statement to be valid | claim |
| `valid_until` expired | the memory is damped in ranking | memory, accessibility |
| `obsolete` set | the memory is removed from normal recall | memory |
| soft delete | the file lies in the recoverable trash, with audit | file |

`stale_status` explicitly does **not** belong in this list. It is not a sixth
semantic lifecycle state but solely a persisted UI and cache projection: not a
truth field, not a gate, not a ranking input. It must be recomputable
reproducibly from the authoritative lifecycle fields at any time, and a
divergence between projection and recomputation is a cache error, not a state
change.

Between these states there is **no automatic equation and no automatic
migration**. An expired `valid_until` does not invalidate any claim; `obsolete`
says nothing about truth; a soft delete is not a contradiction; and no time
field ever sets `obsolete` on its own or triggers a soft delete.

For `valid_to` a clarification applies: it does not remove a memory from
retrieval, but it changes its **role**. A claim beyond its real-world validity
is Historical in the sense of 6.5 and is no longer injected as a current rule;
expired validity additionally counts under 7.3 as a negative accessibility
signal and thus enters the computed zone. Both are intended and remain an effect
on role and accessibility — not on existence, findability via the ID, or Deep
Recall.

A confirmed operation may set several of these states deliberately — an accepted
`SUPERSEDE`, for example, may set `retracted_at` on the predecessor claim and
hide it from current recall. It must then, however, **declare in the operator
contract which states it touches**, and each of them must be individually
rollbackable. What the operator does not declare, it does not set.

For rules, preferences, lessons and workflows, `occurred_at` is usually empty
and `valid_to` optional; a missing `valid_to` means “applies until revoked” and
not “proven indefinitely”.

These fields are schema work and depend on the separate schema decision from
21.4. Until then they exist at most as a derived read-only projection. The model
is a third-party system implemented in production that carries exactly these
four marks — two on the transaction timeline and two on the event timeline —
and invalidates contradicted facts temporally instead of deleting them. Bastra
deliberately deviates on one point: there, conflict detection invalidates
immediately; here, only the confirmed resolution does (see above).

#### Origin

Origin is carried as a field of its own, not as a second memory taxonomy.
`provenance_class` distinguishes:

| Value | Meaning |
|---|---|
| `user_asserted` | **confirmed** by the user — solely via the confirmed review, never derived from the write operation |
| `agent_observed` | event observed by the agent, or its own experience |
| `derived` | derived from other memories or episodes |
| `hypothesis` | conjecture without sufficient evidence |
| `approved_rule` | rule or reflex approved by the user |
| `imported_unverified` | taken over from another vault, authorship not checked |
| `unknown_legacy` | origin not unambiguously reconstructible |

Derived content additionally carries generator, version and confidence,
references its evidence via `derived_from`, and may never silently replace
`user_asserted` content. No separate opinion or belief network is introduced: a
system that maintains its own convictions with self-reinforcing confidence
contradicts the principle that Bastra manages user knowledge and does not form
positions of its own.

#### Fallback for the legacy inventory

**A missing `provenance_class` never counts as `user_asserted`.** The converse
would be the most dangerous conceivable default: it would grant the entire
legacy inventory the highest trust and protection class and thereby remove
precisely the boundary the field is meant to draw.

Today's code supports this: `write_origin` is optional with no schema default,
and all protection checks compare strictly against `user-directed`. An inventory
memory without the field is de facto `agent-session` today and therefore
unprotected; on the next save, `agent-session` is materialized. The vault thus
contains no information that would substantiate user authorship.

The mapping has **two steps and is to be evaluated in this order**. Its two
steps are called **mapping step 1 and 2** here; they have nothing to do with the
four review stages of the inventory review further below. The
order is not editorial — it carries the safety of the whole procedure:

**Mapping step 1 — check the import origin. It takes precedence over every other signal.**

| Observation | derived class |
|---|---|
| `source` with import adapter prefix `<adapter>:<label>:<relKey>` | `imported_unverified` |
| `source` with prefix `index:<label>` | `imported_unverified` |
| `topic_path` begins with `imported`, or tag `imported` set | `imported_unverified` |
| comparable machine source marking | `imported_unverified` |

If one of these conditions applies, evaluation ends here. In that case
`write_origin` is **not** evaluated.

**Mapping step 2 — only for memories that were not imported.**

| Observation | derived class |
|---|---|
| `write_origin: user-directed`, with or without audit context | `unknown_legacy` |
| `write_origin: capture-review` | `unknown_legacy` |
| `write_origin: agent-session` | `unknown_legacy` |
| `write_origin` missing | `unknown_legacy` |

The derivation performed by the mapping steps assigns **no** review status. The
status follows solely from the queue of the inventory review and not from
`write_origin`; otherwise the field would after all have a say in queue
placement again.

**No observation in mapping step 2 produces `user_asserted`.** This class arises
solely via the confirmed review — see “Where the confirmation reference arises”
below. Derivation from the write operation can only *conjecture* user
authorship, never substantiate it.

#### Why `write_origin` alone is not sufficient

`write_origin` is an input field, not a proof. The regular MCP save exposes it
in the public tool schema and passes the caller's value through to the storage
function unchanged, without audit proof — a complete mutation audit exists to
this day, per C-008, only in the Mac bridge path. An agent that sets
`user-directed` therefore merely asserts that it is writing on the user's
behalf. Precisely this assertion must not trigger the highest trust class.

#### A mutation audit is not the same as an attestation

The audited bridge path, too, is **not attested by its audit alone**.
The code substantiates why: the audit context is read there from the call
parameters and falls back to `{ actor: "user" }` if the caller sends none. The
only substantive check applies to the value `assistant`, which forces a
justification — so of all things the assertion `actor: "user"` demands nothing
at all. A caller that simply passes no audit context is handed the user stamp
for free.

From this follows the decisive distinction:

- A **mutation audit** answers: what was changed, when, and by which process?
  It is **necessary** for traceability.
- An **attestation** answers: did a human actually make or confirm this
  statement? For that, the audit is **not sufficient**.

**Attestation** therefore means: there exists a confirmation reference —
`user_action_ref` or `confirmation_ref` — which

1. was **generated server-side or by a trusted UI adapter**, not by the saving
   caller;
2. is **not self-assertable** by the saving caller, that is, cannot simply be
   passed along as a parameter;
3. points to a concrete, verifiable user action — a confirmation, an input, an
   approval — and not to the save operation itself;
4. remains resolvable later, so that the attestation is verifiable.

Without such a reference, the save falls back conservatively to
`unknown_legacy` with review required. This is not distrust of the agent but the
separation between *asserted* and *substantiated*: only substantiated user
authorship carries the protective effect that `user_asserted` promises. The
confirmed provenance review is the way there — the only one, and a visible one.

**No bypass via the class field.** If `provenance_class` is passed directly in
the save in future, the value `user_asserted` is subject to the same rule:
without an attestation reference it is not adopted but treated like a
non-attested `user-directed`. Otherwise precisely the circumvention would arise
that this rule prevents.

**The Mac bridge path, too, is not attested** — and, per the decision from 31,
is not to become so. Declaring a write path an attestor would be a trust
decision without a substantiating record; the confirmation reference arises
instead at the only place where a human is demonstrably involved. Where that is,
is stated in the next section.

#### Where the confirmation reference arises

No write path produces such a reference, and none is to. The
product-owner decision from 31 places the source instead at the only
place where a human is actually involved: **the review of a memory in the Recall
surface**.

There the user answers a single question — where did this come from? The surface
asks **progressively**: a short main choice, and only where it is necessary, a
follow-up question.

| Main choice | Follow-up question | resulting `provenance_class` |
|---|---|---|
| “Yes, that came from me.” | — | `user_asserted` |
| “From the agent or system.” | “Directly observed?” | `agent_observed` |
| “From the agent or system.” | “Derived from that?” | `derived` |
| “From the agent or system.” | “More of a conjecture?” | `hypothesis` |
| “Taken from another vault.” | — | `imported_unverified`, confirmed |
| “Unclear.” | — | `unknown_legacy`, confirmed |
| for rules, additionally: “I confirm this rule.” | — | `approved_rule` |

The follow-up question is not optional. Observation, derivation and conjecture
are **three different epistemic states**, and the class table lists them
separately for good reason: an agent observation is an event, a derivation is an
inference from other memories, a conjecture is a statement without sufficient
evidence. Mapping them jointly onto `agent_observed` would flatten the
distinction at exactly the point where, for the first time, someone with
knowledge could make it — and `derived` and `hypothesis` would remain
permanently empty classes.

Two clicks instead of one are the price for this. It is incurred only when the
user does not attribute the origin to themselves. The follow-up question is not
pre-selected either — see below.

The click on “Yes, that came from me” **is** the attested user action. It
produces the confirmation reference, and it is the only way a memory reaches the
class `user_asserted`.

The derived initial class from the fallback mapping earlier in this
section may be **displayed as a reasoned system suggestion** — for example
“This memory comes from an import, therefore presumably foreign origin”.
**No answer may be pre-selected.**

The difference is not cosmetic. A pre-selected choice turns the confirmation
click into confirming a system conjecture — and that was precisely the reason
for binding attestation to a user action in the first place. A default that is
clicked away substantiates nothing. Therefore:

- None of the answers is marked when the review is opened.
- `confirmed` arises **only** when the user actively selects an answer.
- A mere next or confirm click without a prior selection is **without effect**
  and produces no confirmation reference.
- The progressive follow-up question for “From the agent or system” remains
  mandatory and is likewise not pre-selected.

The derivation is a conjecture by the system, the answer is the user's decision
— and the surface may not make the two indistinguishable. The user can in every
case choose any answer, including “Yes, that came from me”.

From this follows a permanent property of the architecture, not merely a
transitional one:

- A save **never automatically** produces `user_asserted` — not even once a
  uniform mutation audit for MCP and HTTP saves exists later. The audit improves
  traceability and changes nothing about the origin question.
- The fallback rule to `unknown_legacy` with review required is therefore not a
  stopgap but the normal case of the write path.
- The path to `user_asserted` is not blocked but runs solely in the open: via a
  decision the user made themselves and can revoke at any time.

What is technically stored behind the click is an implementation detail; the
requirements for it are stated in the next section.

The reason for the precedence of the import check is a current state of the
code: the vault import stamps **every** imported content item with
`write_origin: "user-directed"` — including a fully machine-generated
navigation index over the import. A single-step mapping by `write_origin` would
therefore declare a foreign vault together with its generated helper nodes to be
user statements wholesale. That is exactly the error the fallback rule is meant
to prevent, only through a different door.

This derivation determines solely the **initial class** of a memory and a
suggested value for the surface — never whether it may be reviewed at all.
Every memory in the entire inventory is eligible for review and confirmation;
this follows necessarily from the decision on the complete inventory review. An
imported memory, an `agent-session` memory and a memory without `write_origin`
can become `user_asserted` after a confirmed review just like any other, if the
user so decides. Neither import status nor `write_origin` restricts review
authorization. `agent-session` means merely that the agent wrote — not that the
content is an agent observation; a rule dictated by the user and an inference
the agent drew itself are indistinguishable within it. `agent-session` is
therefore not mapped to `agent_observed` but to `unknown_legacy`.

`confidence` is explicitly **not** used for this mapping. The field has a schema
default of 1.0 and is indeed taken into the search index as metadata and stored
there, but it influences neither ranking nor filtering nor the evidence
decision. It therefore carries no information from which origin could be
derived.

#### Review status instead of a prose note

The resolution of `imported_unverified` and of `unknown_legacy` with review
status `pending` runs not via a non-binding note but via a named field of the
sidecar projection:

| Field | Values |
|---|---|
| `provenance_review` | `pending`, `confirmed`, `rejected`, `not_scheduled` |
| `confirmed_provenance_class` | mandatory field for `confirmed`: the confirmed target class from the class table |
| `provenance_reviewed_at` | date of the decision |
| `provenance_review_ref` | mandatory field for `confirmed` and `rejected`: resolvable decision and audit reference |
| `provenance_review_note` | optional justification |

`pending` is the initial value for every memory as soon as its turn comes in a
review stage — independently of `write_origin` and import status.

`not_scheduled` means solely **“not currently in turn”** — it is not a
confirmation, not a quality judgement and **not an exemption from review**. A
memory with `provenance_class: unknown_legacy` and
`provenance_review: not_scheduled` still has unknown origin; it is merely not
yet in turn. The earlier name `not_required` was misleading because it suggested
the question was settled; the earlier reading “a review would yield nothing
without new information” is void given the decision on the complete inventory
review. From here on, `not_scheduled` denotes solely the queue position.

#### The entire inventory is reviewed

Every memory ends up with a clarified origin — or an explicitly confirmed
“unclear”. The difference between a derived and a confirmed `unknown_legacy` is
essential: the first means “nobody has looked yet”, the second “someone has
looked and could not clarify it”. Only the second is a result. They are
distinguished via the review status: `pending` or `not_scheduled` versus
`confirmed` with `confirmed_provenance_class: unknown_legacy`.

The review is not a list of hundreds of entries in one go but runs in four
priority stages:

| Review stage | Membership criterion | Rationale |
|---|---|---|
| 1 | rules, preferences, reflexes and floored memories | They act on future behaviour and carry the greatest protective effect |
| 2 | memories with **substantiated** high usage, as well as **non-imported** memories of unknown history with **demonstrably high structural impact** under the criterion versioned in advance | Their origin has an effect most frequently — either via usage or via their position in the graph |
| 3 | imported memories carried as `imported_unverified` | Foreign authorship, today uniformly unclarified |
| 4 | the remaining inventory, including memories of unknown history without high structural impact | successively, without time pressure |

The table names **membership criteria**, not an ordering: it decides which
review stage a memory falls into. Within a review stage no fixed order applies.
The review stages are a prioritization of the work, not a gradation of
bindingness — review stage 4 is reviewed in full as well.

The four review stages are complete and non-overlapping. The assignment is
evaluated in the fixed order **1 → 3 → 2 → 4**, and the first matching review
stage excludes every further one. The order is not arbitrary: review stage 1
comes first because protective effect weighs more heavily than usage; review
stage 3 comes before review stage 2 because import origin takes precedence over
every other signal under 6.3 — an imported memory with cross-cluster connector
position therefore remains review stage 3 and does not migrate to review stage 2
via the structural criterion.

**Data source for review stage 2.** The per-memory usage telemetry needed for
this already exists and does not have to be built anew: the usage sidecar under
`.bastra/usage/` carries `surfaced`, `loaded` and `acted_on` per memory ID
together with timestamps of the respective last event; from this a heat
computation and a reach evaluation are available. The prioritization of the
second review stage rests on this source.

A memory **without** history in the sidecar counts as `unknown` and explicitly
not as `0`. The difference is essential: “never surfaced” and “no record
present” lead to opposite conclusions, and the sidecar has only existed since a
certain point.

The executable consequence concerns the **stage assignment**, not an ordering: a
memory without sidecar history is neither counted as “never used” nor pulled
into review stage 2 wholesale. Missing history does not substantiate usage — it
is no statement about usage at all.

For **non-imported** memories of unknown history that do not already fall under
review stage 1, a **history-independent criterion therefore decides stage
membership**: the **structural impact** in the graph, that is, a high linking
degree or the position as a **cross-cluster connector node**. A memory that
demonstrably has it falls into review stage 2; one that does not, into review
stage 4.

#### The structural criterion is fixed in advance

“High structural impact” may not be a matter of implementation discretion —
otherwise the boundary between review stage 2 and review stage 4 shifts with
every interpretation, and the processing order across the review stages would
not be reproducible. The order **within** a review stage is unaffected by this
and remains open. Therefore:

**Before the review queue is built**, a **versioned structural criterion** is
determined from a **frozen graph snapshot** and stored in the queue or run
manifest. The only permitted components are:

- the property of being a **cross-cluster connector node** — the node has
  neighbours in at least two **different foreign clusters**; this property is
  already computed by the graph projection and carried in the field `bridge`;
- a **degree threshold** fixed in advance, or a **degree quantile** over the
  edge count of a node, which the projection likewise already carries.

**What the field `bridge` substantiates — and what it does not.** The name of
the existing field suggests more than the code delivers, and this document
explicitly does not rely on the obvious reading. `buildGraph` sets `bridge` when
a node has neighbours in at least two different foreign clusters
(`packages/core/src/graph.ts:302`–`:305`). What is **not** checked is whether
these clusters would actually be unconnected without the node. The field
therefore substantiates neither a graph-theoretic bridge — an edge whose removal
breaks a component apart — nor an articulation node whose removal separates the
graph. It substantiates exactly one property: **cross-cluster adjacency**.

This property remains permitted as a component of the structural criterion, but
solely with this meaning. A genuine articulation or bridge analysis would be
additional graph work — it would have to check the connectivity of the graph
without the respective node — it is not delivered by the current code and is
nowhere claimed in this document. Where **connector position** is mentioned in
what follows, cross-cluster adjacency is always meant, never a proven separating
effect.

The concrete numeric starting value — whether an absolute threshold or a
quantile, and at what level — may be derived from the read-only distribution of
the inventory. It must, however, **be fixed before the assignment** and **must
not move during this review run**. A criterion that moves along while the
inventory is being reviewed produces a processing order across the review stages
that nobody can reconstruct.

From this follows the sign-off condition: every memory of unknown history that
falls under **neither review stage 1 nor review stage 3** must be assignable by
the criterion recorded in the manifest **deterministically to exactly one** of
the two remaining review stages — review stage 2 or review stage 4, with no
remainder and no discretion. Floored rules and imported memories without usage
history are already covered by review stage 1 or review stage 3 respectively;
for them the question does not arise.

**Graph outage.** If the graph snapshot is unavailable or incomplete, the
affected memory falls **conservatively into review stage 4**. A structural
impact that cannot be substantiated is not a structural impact; promoting in
case of doubt would fill review stage 2 with memories about which nothing is
known.

This case is decided **when the queue is built**. A later graph outage does not
move an assignment already made — in a running review nothing is reassigned in
any case.

#### The snapshot must substantiate the assignment made at the time

“Frozen” is not a property that can be established via a timestamp. A timestamp
says **when** the computation ran, but not **on what** — and the live graph
changes with every save, every new link and every cluster recomputation. An
assignment that refers only to a point in time is no longer verifiable weeks
later: anyone who wants to recompute it computes on a different graph and gets a
different result. The proof must therefore lie in the artifact itself.

The artifact lies in the same sidecar projection as the review fields; the proof
obligation therefore does not turn the inventory review into a write operation
on memory content. It is thus an operational sidecar/run artifact in the sense
of C-018 and C-025 and may be persisted **immediately** — it depends neither on
M4 nor on the separate schema decision from 21.4. Only when snapshot, queue or
review fields are to be taken into the memory frontmatter or into the persistent
memory schema does 21.4 apply. The queue or run artifact stores at least:

- **the graph and projection schema together with its version** — by which rules
  clusters, edges and degrees were formed in the first place;
- the **snapshot hash** — which concrete graph state underlay it;
- the **creation time** of the snapshot;
- the **applied structural criterion** together with its absolute threshold or
  its quantile, in the wording of the versioned form;
- for each assigned memory of unknown history, its **ID**, its **`degree`**,
  its **foreign clusters or its `bridge` value** and the **resulting review
  stage**.

**Permitted alternative.** Instead of the individual values, the complete
snapshot may be **persisted content-addressed** and referenced from the manifest
via its hash. Both variants are equivalent because both satisfy the same
condition: the assignment made at the time remains reconstructible **without the
later-changed live graph**. What is not sufficient is a reference to “the graph
at time X” without a recorded state — that is exactly the gap this rule closes.

**No recomputation during a running review.** While a review run is open,
neither a recomputation of the snapshot nor a reassignment of memories already
queued takes place. A memory that fell into review stage 4 when the queue was
built remains in review stage 4, even if it gains links in the meantime and
would satisfy review stage 2 according to the current graph. That is intended: a
queue that reorders itself while it is being worked through is neither workable
nor verifiable. New structural impact can take effect only in a **later** run
with a new snapshot and a new criterion version. Nothing is lost in the process:
review stage 4 is reviewed in full as well under C-065 — the review stage
decides only when a memory's turn comes, not whether.

**A restart resumes.** A restart of the daemon or an abort mid-run does not
begin a new queue but resumes **the same one with the same assignments** — the
manifest is the authoritative source for this, not the live graph. Otherwise a
different order would arise on every restart, and the progress of the review
would no longer be comparable.

Floor and pin status are explicitly **not** used as a criterion. Floored
memories are already covered by review stage 1 — carrying them in review stage 2
again would be a double assignment. And a pin source independent of the floor
does not exist at HEAD: the Curator input sets the field hard to `false`, and in
the session hook “pinned” is merely the display name of the floor block. A
criterion that reads a permanently empty field is not a criterion.

Review stage 2 thus has two membership routes — substantiated high usage where a
history exists, and proven structural impact where none exists. Both are
questions of membership, not orderings.

`confirmed` may be set solely by an explicit user decision. It names the
confirmed target class in `confirmed_provenance_class` and the decision and
audit reference in `provenance_review_ref`; without both fields the confirmation
is incomplete and remains without effect.

**A confirmation applies to exactly one memory in exactly one content state.**
This is a safety requirement and not implementation latitude: consent to memory
A may under no circumstances take effect for memory B, and it may not continue
to apply to A either once A has changed in content. Three properties of the
confirmation reference follow from this:

- **Unambiguously bound.** It points to `memory_id` and to a hash of the
  **assertion-bearing content as it was displayed in the review**. The user
  confirms what they saw — not an abstract data record.
- **Not reusable.** It is valid for exactly this one decision and cannot be
  applied to a second memory or a second decision.
- **Lapsing on a change of content.** If the assertion-bearing content changes,
  the confirmation loses its effect; the memory falls back to the derived class
  and receives the review status `pending`. A rewording may not slip a different
  statement under an old consent.

What counts as assertion-bearing content is delimited bindingly — otherwise the
confirmation would be either worthless or uselessly short-lived:

| counts towards the hash | does **not** count towards the hash |
|---|---|
| Title | Tags |
| Summary | `topic_path` |
| Body | `recall_when` and derived cues |
| Type and scope, insofar as displayed in the review | folder and file location |
| the confirmed statement itself | timestamps, `updated`, `last_reviewed_at` |
| | heat, reach and all usage signals |
| | `stale_status` and other projections |

The right-hand column comprises retrieval, presentation and operational
metadata. These change constantly in normal operation — a single recall hit
already moves the usage signals. If they triggered the lapse, every confirmation
would be extinguished within hours and the review would be Sisyphean labour.
Conversely: if the body changes, the confirmation lapses — even if the title
stays the same.

These three points are binding; the choice of technical means is not.

**Provenance override contract.** A confirmation is a persisted user decision
and not a derived projection — otherwise every recomputation would throw the
memory back to `imported_unverified`, because the signals of mapping step 1 in
`source`, `topic_path` and tags remain unchanged. It is,
however, **not a Class B accessibility override** under 14.4: it changes nothing
about accessibility, only the origin statement. A separate contract applies to
it:

- The override acts on `provenance_class` alone and there overrules the
  derivation from mapping steps 1 and 2 until revocation or until the confirmed
  memory changes in content.
- It is bound to `confirmed_provenance_class` and `provenance_review_ref` and is
  not valid without them.
- It is **revocable at any time**: a revocation resets `provenance_review` to
  `rejected` or `pending`, and the derived class applies again.
- It changes neither floors nor pins nor zones and produces no Class B state.
- It lapses automatically as soon as the confirmed content state changes;
  `provenance_review` then falls to `pending`, and the derived class applies
  again (C-064).
- It is logged separately from accessibility overrides, so that a revocation of
  origin does not drag an accessibility decision along with it.

The derived status values live in the sidecar projection, not in the
markdown — they therefore depend on the same schema decision as the remaining
provenance fields and cause no vault change before it. The confirmed override
itself, by contrast, is persisted because it is a user decision.

`unknown_legacy` and `imported_unverified` are not trust classes but the
admission that the origin is unknown or unchecked. They do not protect the way
`user_asserted` does and do not qualify for overwriting the way `derived` does.
A memory leaves this state only through an explicit user confirmation or through
a new save with an explicit class. No mass rewrite of the vault takes place.

### 6.4 Procedural / Reflex Memory

The existing reflex lane remains the procedural layer:

- deterministic triggers;
- small budget;
- no fuzzy self-injection;
- promotion only after user confirmation;
- high precision over reach;
- revocable at any time.

### 6.5 Historical Memory

Historical is not a deletion state but a retrieval role:

- explicitly replaced;
- no longer temporally valid;
- relevant only for history, root-cause analysis or old project states;
- still reachable via ID, version, citation and Deep Recall;
- never inject as a current rule.
## 7. Adaptive Memory Accessibility

### 7.1 Definition

Accessibility is explicitly not a sixth damping layer. If it goes live after a
successful evaluation, it unifies and explains the long-term memory mechanisms
that today act separately as staleness, Curator demotion, floors, salience,
validity and, later, possibly confidence. These mechanisms must not then
additionally multiply the same score independently a second time.

Session dedup, empty-streak backoff and turn context remain separate attention
and surfacing mechanisms. They do not describe a memory's long-term
accessibility and therefore do not enter its Accessibility.

Every memory receives a computed `accessibility` between 0 and 1. It is not a
permanently stored truth but a reproducible projection from stable fields and
usage data.

```text
accessibility =
    type_durability
  + successful_use_reinforcement
  + bounded_salience
  + source_confidence
  + explicit_floor
  + recent_verification
  - time_decay
  - repeated_non_use
  - contradiction_penalty
  - superseded_penalty
```

For now the formula describes the signal groups, not an already implemented
score function. Exact weights, zones, and even the question whether a
continuous number is more stable than explainable states are decided only in
M3. The corresponding V1.x stage begins solely as a read-only projection in the
sidecar and Mindspace.

### 7.2 Positive signals

- an explicit floor or pin;
- a successful `loaded` → `acted_on` path;
- repeated successful use in different contexts;
- a recent confirmation of content or a currency review — not the provenance
  review under 6.3, which has no effect on accessibility;
- high and substantiated source confidence;
- moderately bounded salience;
- an explicit user instruction;
- an active dependency from a current decision or a workflow.

### 7.3 Negative signals

- an explicit `superseded_by`;
- expired validity;
- a confirmed contradiction;
- repeatedly surfaced but not loaded;
- loaded, then discarded or corrected;
- not successfully used for a long time;
- an outdated project state;
- low or unknown source quality.

Not loading is only a weak negative signal. The system cannot reliably observe
whether a hint helped indirectly. An explicit correction or a demonstrably
superseding claim is considerably stronger.

### 7.4 Hard rules

- Age alone must not delete a memory or declare it Historical.
- Floors prevent automatic descent into the Asteroid Belt.
- `user-directed` content must not be changed automatically.
- Salience must not override missing query relevance.
- An invalid memory must not become “current” again through high usage.
- Exact ID, citation and version retrievals bypass the accessibility floor.
- Accessibility affects spontaneous accessibility, not the existence of data.

### 7.5 Accessibility zones

The following boundaries are starting ranges for the evaluation, not final
product constants:

| Accessibility | Zone | Behavior |
|---:|---|---|
| 0.80–1.00 | Core | spontaneously injectable at high query relevance |
| 0.50–0.79 | Orbit | normal recall |
| 0.20–0.49 | Outer Orbit | only on a clear query match |
| 0.00–0.19 | Asteroid Belt | no automatic injection; Deep Recall |
| explicitly superseded | Historical | only temporally/historically or via the successor |

The zones must not be computed directly from age. They arise from the
Accessibility function as a whole.

## 8. Asteroid Belt and Deep Recall

### 8.1 Meaning

The Asteroid Belt visualizes memories whose spontaneous accessibility has
dropped sharply. It is:

- not a trash bin;
- not a deletion state;
- not a separate archive of truth;
- fully searchable;
- deliberately separated from automatic context injection.

It corresponds to a state familiar to humans:

> “I know there was something there, but I have to search deeper for it.”

### 8.2 Visual representation in the Mindspace

- Core memories lie bright and central.
- Orbit memories form the regular systems and galaxies.
- Outer Orbit memories are drawn smaller, darker and further out.
- Dormant memories form an Asteroid Belt around the active inner galaxy.
- Salient memories keep a recognizable colored core.
- Superseded memories appear broken or transparent and show a directed link to
  their successor.
- Contradictions appear as a tensioned or color-contrasted edge.
- When a memory is opened, the reason for its accessibility is explained.

Example:

```text
Asteroid Belt
  accessibility: 0.14
  last successful use: 214 days ago
  surfaced: 11
  loaded: 1
  acted_on: 0
  status: dormant, not outdated
```

### 8.3 Interaction

The user can deliberately enter the belt:

- “Search deeper”;
- “Search faded memories as well”;
- “I know we had something on this earlier”;
- a click on the Asteroid Belt in the Mindspace.

On entry it becomes visible that the retrieval depth changes:

1. normal results are retained as a reference;
2. dormant results appear step by step;
3. old versions and episodes are grouped;
4. relations and contradictions are explained;
5. the user can reactivate a hit, confirm it, or leave it Historical.

### 8.4 Technical Deep Recall path

Deep Recall:

1. opens the dormant filter;
2. increases the candidate pool;
3. activates query expansion and language bridges;
4. searches episodes and Historical memories;
5. allows controlled typed graph traversal;
6. uses a stronger local reranker where available;
7. groups by time, entity, claim and version;
8. returns exactly one of the four result values from 8.5 — `answer_found`,
   `no_answer` only on deterministic exhaustion, otherwise
   `inconclusive_budget_exhausted` or `inconclusive_interrupted`;
   a controller defect is signalled instead as `DeepRecallDefect`
   and is not a result.

Deep Recall may be slower than Normal Recall. It is a deliberate interaction,
not an implicit hook hot path.

### 8.5 Two tiers instead of “the same retrieval with a larger k”

Deep Recall is explicitly not Normal Recall with an increased `k`, a lowered
floor and more tokens. It has two clearly separated tiers:

**Tier 1 – structured Deep Recall, deterministic.** Dormant filter, larger
candidate pool, query expansion and bridges, time and scope manifest, exact
identifiers, grouped output by time, entity, claim and version. Reproducible,
without an agent loop, in the range of seconds.

**Tier 2 – agentic Deep Recall, iterative.** Decomposition of the query into
sub-questions, a visible search tree, targeted combination of exact, lexical,
semantic, temporal and graph search per branch, marking of dead ends,
collection of evidence over IDs and sources, convergence detection, a budget
manager, and solely deliberately confirmed budget extension.

Both tiers deliver their search path with the result. The termination
conditions of Tier 2 are explicit, executable and not negotiable.

**Budget limits.** Every Deep Recall run starts with a versioned set of limit
values. The concrete numbers are fixed after the M0 baseline run and stored,
versioned, together with the configuration; the quantities themselves are
binding:

| Limit | Kind | Effect when reached |
|---|---|---|
| maximum runtime | hard | run ends |
| maximum token budget | hard | run ends |
| maximum number of open branches | soft | no new branches |
| maximum depth per branch | soft | branch is closed |
| maximum number of provider calls | soft | no semantic arm any more |
| maximum number of candidates considered | soft | no further pool expansion |

Hard limits end the run immediately. Soft limits do not end it but narrow the
search space — and precisely there lies a trap: if no new branches are opened
because a soft limit has been reached, the search tree can formally run empty
without the vault having been exhausted. The controller therefore records
whether a soft limit has taken effect.

**Evidence gain.** A step counts as productive exactly when it yields at least
one previously unseen evidence ID or answers at least one open sub-question. A
step that only finds already known IDs again counts as unproductive —
regardless of how high the scores are.

**Termination on two levels.** Branch and run end by different rules, and
confusing the two would have consequences:

*Branch level.* Two consecutive steps without evidence gain close **the
affected branch**. They do not end the run. As long as other branches are open,
the controller keeps working there — a single exhausted branch says nothing
about the rest of the search tree.

*Run level.* The run ends when one of the following conditions occurs:

0. **sufficient, validated evidence found** — all sub-questions are answered
   with robust evidence checked against the evidence rules from Section 10;
1. every sub-question is answered or abandoned and **no admissible branch is
   open any longer**, without a soft limit having taken effect — deterministic
   exhaustion;
2. a **hard** limit has been reached;
3. the search tree ran empty **after** a soft limit took effect;
4. the run was **ended from outside** without a limit being reached — user
   cancellation, shutdown or revocation of the approval.

Condition 0 is the success case and was tacitly assumed in the previous
version; it is stated here explicitly so that the contract covers all outcomes.
Condition 1 is the only one that permits a negative statement about the vault.
From the outside, condition 3 looks deceptively similar to it — the tree is
empty in both cases — but says only that the controller was not allowed to
search further.

**Priority on simultaneity.** If the occurrence of **end condition 0** — that
is, the complete answering of all sub-questions with validated evidence — and
the reaching of a limit coincide in the same step, **end condition 0 wins**:
the run ends with `answer_found`. The evidence is collected and validated;
discarding it because the budget ran out at the same moment would throw away
work and report a worse outcome to the user than was actually achieved. The
limit reached is not suppressed but is carried in the result.

A single new evidence hit that does **not** satisfy end condition 0 is not a
find in the sense of this rule. If sub-questions are still open, the run ends
at the limit with `inconclusive_budget_exhausted`; the evidence already
collected is carried in the result but not returned as an answer.

**Four distinguishable results.** The outcome is never conflated:

| Result | End condition | Meaning |
|---|---|---|
| `answer_found` | 0 | robust, validated evidence found and returned with the search path |
| `no_answer` | 1 | the search was **deterministically exhausted** and yielded no sufficiently complete, decision-capable answer |
| `inconclusive_budget_exhausted` | 2 or 3 | a budget or resource limit was actually reached; nothing is stated about the existence of evidence |
| `inconclusive_interrupted` | 4 | the run was ended from outside without a limit being reached; nothing is stated about the existence of evidence |

`no_answer` presupposes condition 1 and nothing else. Every other unsuccessful
outcome is **inconclusive** — even when several branches were closed one after
another without gain and the tree looks empty at the end.

The two inconclusive values are not mixed:

- `inconclusive_budget_exhausted` is permitted solely when one of the six
  limits from the budget table was **actually reached**. The `limit` field
  names it: runtime, tokens, branches, depth, provider calls or candidates. A
  catch-all value `other` no longer exists — it would have reported any
  arbitrary termination as a budget problem.
- `inconclusive_interrupted` applies solely to **regular external
  interruptions**. The structured field `stop_reason` names the cause:
  `user_cancelled`, `shutdown` or `permission_revoked`.

**A controller defect is not a result.** A run that stops while branches are
still open and no limit has taken effect should have kept searching. That is a
fault of the implementation and not a state of the vault — it therefore belongs
neither under the result values nor under `stop_reason`. It is signalled as a
**structured interface error**.

So that the caller nonetheless receives an honest diagnosis, this error may
carry a **read-only partial state**:

```ts
interface DeepRecallDefect {
  error: "controller_defect";
  defect_id: string;          // internal defect identifier for the telemetry
  partial: {
    evidence: EvidenceRef[];  // evidence collected so far
    search_path: BranchNode[];
    open_branches: number;
    limits_reached: string[]; // soft limits already reached, if any
  };
}
```

The partial state is explicitly **not a result**: it is not counted in the
abstention or success statistics, not returned as an answer, and not translated
into one of the four result values. It serves diagnosis and nothing else.

In this object `no_answer` carries a **stronger proof obligation** than the
value of the same name in the evidence decision from 10.3: there it means that
the available evidence is not sufficient for any surfacing; here, that the
search was deterministically exhausted. The two values are not translated into
one another and are not offset against one another.

**`no_answer` does not mean “no evidence”.** It means: after complete,
deterministic exhaustion there is **no sufficiently complete or
decision-capable answer**. Partial robust evidence may very well exist — for
instance when three of five sub-questions are answered. It is then reported as
such and not concealed: the result object carries it in `evidence` and names
the sub-questions that remained open in `unresolved_subquestions` as well as
the share of answered sub-questions in `coverage`. A `no_answer` with
`coverage: 0.6` is a different statement from one with `coverage: 0` — and the
user is entitled to that difference.

**Errors remain errors.** Transport errors, connection timeouts,
deserialization errors and internal exceptions are **not** recall results. They
are signalled as errors of the respective interface and never translated into
`no_answer` or into either of the two inconclusive values. A caller must be
able to distinguish whether the vault yielded nothing or whether the request
did not run to completion.

A budget termination may never be reported as `no_answer`. Both would look
similar to the user but mean the opposite: one is a statement about the vault,
the other a statement about search cost. Confusing them would additionally
distort the abstention metrics from 18.2 and the Deep Recall figures from 18.4,
because terminated runs would be counted there as correct abstention.

With `inconclusive_budget_exhausted`, deliberate budget extension remains the
only continuation; it never happens automatically.

**Surface contract.** The result is an explicit enumeration field in a result
object of its own, not a phrasing in the answer text:

```ts
interface DeepRecallResult {
  outcome:
    | "answer_found"
    | "no_answer"
    | "inconclusive_budget_exhausted"
    | "inconclusive_interrupted";
  /** 0 = evidence found, 1 = exhausted, 2 = hard limit,
   *  3 = ran empty after a soft limit,
   *  4 = ended from outside without a limit being reached. */
  end_condition: 0 | 1 | 2 | 3 | 4;
  /** Mandatory for outcome === "inconclusive_budget_exhausted".
   *  Additionally set for "answer_found" when a limit was reached in the
   *  same step — the find wins, the limit stays visible. */
  limit?: "runtime" | "tokens" | "branches" | "depth" | "provider_calls" | "candidates";
  /** Mandatory for outcome === "inconclusive_interrupted".
   *  A controller defect does NOT belong here — see DeepRecallDefect. */
  stop_reason?: "user_cancelled" | "shutdown" | "permission_revoked";
  evidence: EvidenceRef[];
  /** Sub-questions that remained open; meaningful with no_answer.
   *  Tier 1 does not decompose — there the query itself counts as the only
   *  sub-question, so the field is empty or contains exactly it. */
  unresolved_subquestions: string[];
  /** Share of answered sub-questions, 0–1. In Tier 1 therefore 0 or 1. */
  coverage: number;
  search_path: BranchNode[];
  open_branches: number;
}
```

This object is passed **unchanged** through MCP, REST, CLI and Mindspace. For
each of these surfaces the following applies:

- all four `outcome` values remain distinguishable, and `end_condition`,
  `limit` and `stop_reason` are carried through unchanged;
- a budget status is converted into `no_answer` neither by HTTP or MCP error
  handling nor by UI text;
- a transport or internal error is none of the four values but an error of the
  respective interface; a controller defect is signalled as a structured error
  with a read-only partial state and never as a result;
- `unresolved_subquestions` and `coverage` are carried with `no_answer` so that
  partial evidence remains visible;
- no surface merges the two inconclusive values into one; where a surface shows
  only a text, the distinction is preserved at least in the structured response
  and in the telemetry.

The hooks are **not a consumer of Deep Recall** — neither Tier 1 nor Tier 2 is
started from a hook; per 8.4 both are deliberate interactions and are in any
case incompatible with the PreTool budget from 18.3. The surface contract
therefore does not touch the hook response.

Without these conditions Tier 2 is not approvable. A Deep Recall that runs
without a termination criterion is not a feature but a cost risk.

The tiering follows a substantiated measurement from the field of agentic
experience stores: there a structured multi-pool approach reaches around 58.6%
at about 27 seconds per query, while the fully agentic variant reaches around
74.9% at 108 to 140 seconds. Both are the authors' own measurements on their
own benchmark and therefore not a target value for Bastra (see 2.3). What is
usable is the structure of the statement: the surcharge of the agent loop is
considerable and must be proven separately against Tier 1 in Bastra, instead of
being assumed as given.

## 9. Adaptive Retrieval Controller

The controller decides not only what ranks, but which retrieval path is needed
at all.

### 9.1 Inputs

- query;
- tool intent;
- Working Memory;
- project and scope;
- files, symbols and entities;
- time budget;
- token budget;
- desired recall depth;
- vault size and index health;
- available local models;
- hit strength so far and abstention signal.

### 9.2 Routing

```text
Exact ID / citation / filename
  -> direct lookup + BM25 evidence

Hard reflex trigger
  -> deterministic reflex lane

Clear lexical query
  -> BM25 first

Ambiguous or paraphrased query
  -> BM25 + semantic lane

Large vector set
  -> selected vector backend: Flat or HNSW

Explicit deep-memory intent
  -> full Deep Recall including Asteroid Belt
```

### 9.3 Normal Recall cascade

1. Normalize the query.
2. Determine the Working Memory context and the hard filters.
3. Check exact IDs, symbols, paths and reflex triggers.
4. Run BM25.
5. Assess the lexical evidence.
6. Skip the semantic arm on an unambiguous result.
7. Run vector search on ambiguity or paraphrase.
8. Merge candidates without feigning shared score spaces.
9. Optionally rerank the top candidates locally.
10. Diversify duplicates and near variants.
11. Classify candidates via a deterministic evidence decision as `required`,
    `optional` or `no_answer`.
12. Abstain on insufficient evidence.
13. Surface only a limited result and token budget.

A calibrated probability replaces this step only later, when M0/M1 provide an
independent, versioned gold inventory and enough calibration cases.

### 9.4 Deadline behavior

- BM25 is the guaranteed fast path.
- Semantic search receives its own sub-budget.
- On a deadline a vector call is aborted or ignored.
- An incomplete hybrid path must not pretend to be complete.
- The response marks `lexical_only`, `hybrid`, `degraded` or
  `deep_recall`.
- Hooks never block on a slow reranker.
- A cross-encoder does not run in the PreTool or SessionStart budget as a
  matter of principle. It remains restricted to Deep Recall and to runs with
  demonstrably free remaining latency. Comparable third-party systems rerank
  every recall with a cross-encoder; but they also do not have to meet a hook
  budget of 150 ms.

## 10. Relevance evidence, abstention and later calibration

### 10.1 New result object

Raw search scores remain diagnostic values. In V1.0 the consumable decision
uses no feigned probability but a deterministic, explainable evidence decision:

```ts
interface RecallDecisionHit {
  id: string;
  decision: "required" | "optional" | "no_answer";
  abstain_reason?: string;
  evidence: {
    exact_identifier: boolean;
    recall_when_coverage: number;
    lexical_rank?: number;
    lexical_score?: number;
    vector_rank?: number;
    vector_similarity?: number;
    arm_agreement: boolean;
    scope_match: boolean;
    temporal_status: string;
    source_confidence?: number;
  };
  // Only after independent calibration and sufficient labels:
  relevance_probability?: number;
  // Only from the later gated Accessibility stage onwards:
  accessibility?: number;
}
```

The existing `acted_on` events are not sufficient to assert a relevance
probability: the current signal is a token-overlap proxy and the 30-day window
contains only a small number of positive hook episodes. `relevance_probability`
therefore remains absent until M0 provides an independent gold set and a real
calibration measurement.

### 10.2 Evidence signals by maturity stage

Available for V1.0 or deterministically derivable within the approved release
contract:

- full and partial `recall_when` coverage;
- a phrase instead of an arbitrary single word;
- exact identifier, path, symbol and entity matches;
- scope- and project-specific match;
- normalized BM25 evidence;
- actual vector similarity;
- rank agreement of the arms;
- query type;
- source quality; substantiated source confidence only after the schema
  decision from 21.4, since today's `confidence` field carries a default of 1.0
  and contains no origin or quality information (see 6.3);
- temporal validity;
- successful historical use;
- novelty and degree of duplication.

Only in later V1.x/V2 stages, to be approved separately:

- Accessibility after the M3 gate has been passed;
- typed graph evidence after the edge schema has been introduced and evaluated;
- hits on derived cues after a passed cue ablation and a separate
  representation decision under 11.4.

A hit on a derived cue opens at most the candidate path to the actual evidence.
On its own it never justifies `required` and is never itself returned as
substantiation.

### 10.3 Decisions

Product semantics of V1.0:

- `required`: a hard anchor or several mutually independent, deterministically
  substantiated signals;
- `optional`: plausible relevance, but no certain obligation;
- `no_answer`: the available evidence is not sufficient for any surfacing.

`deep-only` and `historical` are added only with the gated Accessibility and
Deep Recall stage.

The old absolute thresholds `30` and `100` are not carried over to the new
semantics.

**Refinement of the required conditions (C-086).** Both routes to `required`
were drawn too widely, and in each case the fault lay in the quality of the
justification, not in the quality of the hit.

*Independent signals.* The two-of-three count — trigger coverage, arm rank
agreement, scope match — previously treated any coverage above zero as a
signal. A single coincidentally shared term thus sufficed as one of the two
pillars of an obligation. The partial-coverage signal now counts only **from
50 % coverage of the query terms by the hand-written trigger**. Full coverage
remains a hard anchor unchanged.

> Replaced reading: ~~the partial-coverage signal counts as soon as one query
> term occurs in `recall_when` (`recall_when_coverage > 0`)~~.

*Hard anchor.* The exact identifier, path and symbol match previously searched
the memory **body** as well. An identifier occurring anywhere in the prose — in
a code block, a quotation, a list of files — thereby justified an obligation on
its own. The anchor now reads **title, `recall_when` and frontmatter**; the
body no longer counts.

> Replaced reading: ~~the identifier haystack comprises title, `recall_when`
> and the memory body~~.

The justification is the separation 10.2 already draws: title, triggers and
frontmatter are authorized text that someone wrote as a retrieval signal. Prose
in the body is content. A match there substantiates that the memory mentions
the topic — not that it is responsible for this query. Reading the body as an
anchor confuses mention with responsibility.

**Measurement basis.** Both narrowings were quantified before the change (runs
`2026-08-29-0e1dd5659433` and `2026-08-29-f5d803104893`, ten gold files, 679
cases, all variants computed on the same served pool). The anti-query gate
falls from 50 % to 12.5 % misinjection. Recall@3 gated (0.4743 against 0.4777
ungated), Recall@3 on identifier queries (0.7429) and false abstention (0.0000)
are unchanged in **all** variants examined: none of the narrowings takes the
gold hit out of the top three ranks. The coverage threshold is moreover
length-neutral — the drop in obligations lies between 58 % and 65 % across all
query lengths — whereas the examined alternative "at least two matched terms"
barely bites precisely where the evidence is weakest: a 12 % drop at eleven or
more terms.

361 obligations depended on the body anchor. 49 of them fall away; the
remaining 312 stay obligations but now draw their justification from the
two-of-three count instead of from a find in prose.

**What this measurement does not show.** Two reservations belong to the
decision and are not written away. First, the 5 % threshold of the anti-query
gate cannot be represented on eight probes at all: only 0 %, 12.5 %, 25 % and
so on are reachable, and the threshold lies between the first two values.
Whether the narrowed version holds it cannot be answered by this probe set; the
probe set is being extended to about twenty anti-queries. Second, the gold set
is blind to the cost of the lost obligations: what is measured is whether the
gold hit survives at rank ≤ 3, not whether the memories that are no longer
obligations would have helped in a sitting. Both narrowings together remove
71 % of all obligations. That cost is visible only to the shadow telemetry
after the deploy — the decision is deliberately taken under this reservation.

### 10.4 Training and calibration

Stages:

1. a deterministic, explainable rule-based decision;
2. shadow logging of its decisions;
3. an independent, versioned gold set and controlled consumer experiments;
4. offline calibration only with sufficient and suitable labels;
5. only after that, optionally a logistic model or a small gradient booster;
6. output `relevance_probability` only with proven calibration;
7. no autonomous online learning without rollback and drift monitoring.

`surfaced-but-not-loaded` is at most a weak negative. `acted_on` is
stronger, but still not a gold label. Explicit correction, re-query,
user rejection and independently labelled relevance are more robust signals.

## 11. Embedding and vector architecture

### 11.1 Field-aware representation

A single monolithic vector mixes “when is this supposed to fire?” and “what is
it about?”. V2 separates:

#### Cue Vector

- `recall_when`;
- title;
- tags;
- aliases;
- entities;
- symbols;
- optionally reviewed `recall_when_expanded`.

#### Content Vector

- summary;
- semantic claims;
- body chunks;
- document sections;
- episodic context.

#### Structure remains a filter

- Scope;
- Type;
- time;
- Sensitivity;
- accessibility zone;
- Historical status.

Structural fields are not merely embedded into free text; they are filtered
before or during the search.

### 11.2 Chunking

- long bodies are embedded section by section;
- every chunk keeps memory ID, heading and offset;
- memory ranking aggregates chunk evidence;
- a single arbitrary start of a body no longer represents the entire
  document;
- the result still loads the memory, not all chunks in an uncontrolled way.

Offline measurements and a chunking on/off ablation on long bodies are
permitted at any time. M2 does not test chunking and therefore cannot approve
it. A persistent change to the vector/index representation through cue/content
dual vectors or chunking requires a separate representation decision on the
basis of these ablations; a live activation subsequently requires the
associated quality and migration gate.

### 11.3 Query embedding cache

- a dedicated cache independent of the final recall response;
- the key contains model, dimension and normalized query;
- bounded LRU size;
- safe invalidation on a model change;
- SessionStart queries can be pre-warmed;
- no permanent storage of sensitive query texts without an explicit decision.

### 11.4 Cue layer and trust classes

A cue and evidence are different things. A cue answers “when is this supposed
to show up?”, the evidence answers “what does it say and why is it true?”.
`recall_when` is already today a hand-written future cue, carries the highest
field weight in the BM25 index and remains the primary authorized cue source.
It is neither replaced nor abolished.

Additional cues may be derived. Four families come into consideration for
this:

| Cue family | Question | Axis |
|---|---|---|
| `descriptive_entity` | Which superordinate term can this single fact be assigned to? | Item, descriptive |
| `associative_bridge` | In which future situation would this single fact be important? | Item, associative |
| `descriptive_scene` | How can the situation of this episode be described? | Scene, descriptive |
| `associative_horizon` | Which larger situation or task makes this whole episode relevant? | Scene, associative |

The expectation is that only the associative axis makes a contribution of its
own, because title, tags, `topic_path` and summary already cover the
descriptive axis in the existing index. This is, however, a **hypothesis and
not a decision**: it rests on a third-party work and on the structure of
today's BM25 index, not on a Bastra measurement. Which families become
persistent is decided by the ablation in 18.3 and by the subsequent separate
representation decision under 11.2; until then all four remain within the
scope of review.

A stage dependency has to be observed here: `descriptive_entity` and
`associative_bridge` refer to a single memory and can be formed directly on
today's inventory. `descriptive_scene` and `associative_horizon`, by contrast,
refer to an episode or scene — an object that the vault schema only knows from
the M4 stage onwards. The cue ablation must therefore state at which stage it
tested; see 18.3.

Rules:

- every derived cue **always** carries the target ID of the memory, origin,
  generator version, `derived_at`, confidence and the connection to the
  evidence; these fields are part of the cue and are never the subject of an
  ablation — solely its ranking impact is ablated;
- hand-written `recall_when` and a derived cue have different trust classes
  and are never merged into one field;
- cues open up candidates, but are never the evidence that is delivered;
- the layer starts as a read-only sidecar projection without any markdown
  change;
- persistent inclusion in the vault schema requires the same separate
  representation decision as dual vectors and chunking under 11.2;
- Sensitivity, Scope and egress rules apply unchanged to derived cues;
- a cue whose target memory changes is marked as stale instead of continuing
  to fire silently.

A cue without a resolvable target ID or without a connection to evidence is
not an incomplete cue but an invalid one. It is discarded, not used in a
degraded form.

Rollback: the sidecar file is ignored. Retrieval then behaves exactly as it
does today, because `recall_when` and the BM25 index remain unchanged.

## 12. Flat Search and HNSW

This section is a later target architecture. The vault, with 577 memories at
the time of measurement, does not justify a live activation of HNSW.
Measurements, prototypes and shadow comparisons are permitted at any time.
Recall is to switch between Flat and HNSW autonomously and with quality
assurance once the vector volume actually grows; this switch may go live only
once controlled profiling substantiates a Flat search bottleneck and M5
substantiates the quality and latency advantage. Provider latency alone is not
an argument for HNSW.

### 12.1 Terms

Flat, or brute force, compares the query vector with every stored vector. That
is exact, simple and fast for small vaults.

HNSW stands for **Hierarchical Navigable Small World**. It organizes vectors in
a multi-level neighbourhood graph and, during the search, jumps quickly into a
probably relevant region. That is considerably more scalable, but
approximative.

### 12.2 Shared interface

```ts
interface VectorSearchBackend {
  kind: "flat" | "hnsw";
  build(snapshot: VectorSnapshot): Promise<void>;
  upsert(items: VectorItem[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  search(query: Float32Array, options: VectorSearchOptions): Promise<VectorHit[]>;
  health(): VectorBackendHealth;
  snapshotId(): string;
}
```

The retrieval controller knows no backend-specific logic outside this
interface.

### 12.3 Automatic choice

The backend switch does not hang on a magic memory count alone:

- number of vectors;
- number of chunks;
- vector dimension;
- measured Flat p95 latency;
- available amount of RAM;
- current hardware;
- HNSW recall against Flat gold;
- build and update costs;
- error rate and index health.

Start logic:

1. Flat is always available and the reference.
2. From a configurable size or latency threshold onwards, Recall builds HNSW in
   the background.
3. Shadow queries run against both backends.
4. HNSW is activated only if speed and the quality gate pass.
5. The switch is atomic onto a complete snapshot.
6. On corruption, drift or poor quality, Recall falls back to Flat.
7. Manual forcing remains possible for diagnostics.

Practical expectation, not a hard rule:

- below a few thousand vectors, usually Flat;
- between a few thousand and 10,000, decide on the basis of a real p95
  measurement;
- from considerably larger chunk/memory volumes onwards, usually HNSW;
- Deep Recall may run Flat afterwards for verification in critical cases.

### 12.4 Quality gate for HNSW

HNSW may go live only once:

- Recall@10 reaches at least 98% relative to Flat;
- gold Recall@3 does not decline materially;
- no scope/sensitivity errors occur;
- p95 is measurably better;
- index build and incremental updates are stable;
- restart and snapshot restoration have been tested.

The precise parameters such as `M`, `efConstruction` and `efSearch` are
determined by benchmarking and stored as part of the snapshot manifest.

## 13. Typed Memory Graph

`related_via` is retained as weak semantic proximity, but may not stand in for
all relation types.

V2 relations:

| Type | Meaning |
|---|---|
| `related_to` | general semantic proximity |
| `supports` | supplies evidence for a claim |
| `contradicts` | contradicts a claim |
| `supersedes` | replaces an older version |
| `derived_from` | was consolidated from an episode or source |
| `caused_by` | cause and effect |
| `resolved_by` | the problem was solved by this |
| `applies_to` | applies to an entity, project, file or symbol |
| `example_of` | concrete episode of a semantic pattern |

Rules:

- automatic cosine proximity produces at most `related_to`;
- strong edges require structural evidence or a confirmation;
- Normal Recall traverses at most controlled typed edges;
- Deep Recall may traverse more broadly;
- contradicting or historical edges are explained visibly;
- graph hops do not receive a blanket score-multiplier model.

### 13.1 Logical views instead of separate graphs

The edge types are bundled into logical views — semantic, temporal, causal and
entity — not into separate physical graphs. A vault of this order of magnitude
does not justify fourfold storage; the gain lies in being able to evaluate them
separately, not in separate databases. The query intent determines which views
are active at all and with which hop budget:

- Normal Recall uses at most the entity and the temporal view with a hard hop
  budget of one;
- Deep Recall may combine views more broadly and traverse repeatedly;
- causal and temporal edges never arise from mere similarity; they require
  structural evidence or a confirmation;
- every view is ablated individually and measured against a no-graph control
  arm;
- an improvement in the overall result without a passed control arm does not
  count as substantiation that the graph was the cause.

#### Today's hop baseline is preserved

This restriction must not lead to an already productive capability quietly
disappearing. The hook path today traverses **one `related_via` hop** by
default — and not at the hooks' request, but because the hook endpoint sets
`expand_hops` to 1 of its own accord unless the caller explicitly sends 0. No
hook sends the parameter. The MCP path, conversely, never hops; the forwarder
sets it explicitly to 0. This asymmetry is today's current state.

The traversed edge type is solely `related_via`, that is, the automatically
generated semantic proximity — not the wikilink array `related`, which only
feeds into the graph projection. In the language of 13.1 this is precisely the
**semantic view**, and it is therefore the only one tested live today. It is
preserved:

- The semantic view with a hop budget of one remains the productive state and
  at the same time the **control arm** that every new view must compete
  against.
- A new view does not replace it but takes its place alongside it, as long as
  it has not substantiated its own lift.
- Only once a view shows its lift against this baseline and against the
  no-graph arm may a reallocation of the hop budget be decided.

#### A hop alone never produces `required`

A hit that was reached only via an edge is a candidate and not a
substantiation. The target memory must pass the regular evidence decision from
Section 10 under its own power in order to become `required`.

This rule closes a gap that exists today. The current state:

- A hop neighbour receives at most half of the raw seed score.
- The origin marker `hop` is projected out of the response on the way to the
  hook; the hook sees only title, type, scope, summary and score.
- The `required` decision is taken solely via the score threshold 100 and is
  thus hop-blind.
- On the hybrid path the score is a scaled rank sum with an upper bound around
  164, so that a hop neighbour can arithmetically reach at most about 82 and
  cannot exceed the threshold.
- On the **BM25-only path**, by contrast, the scores are unbounded. There the
  neighbour of a very strong hit can exceed the 100 and is then surfaced as
  `required` without being recognizable to the hook as a hop.

The separation today therefore hangs on an accidental property of the score
scaling — and of all paths it is the degraded one without embeddings, the one
that takes effect on a provider outage, that lacks this safeguard. V1.0
therefore makes the rule explicit instead of relying on the cap.

This presupposes that the hop origin is available to the decision point. The
evidence decision is taken **server-side**, before the response is projected —
the marker therefore only has to reach that far and must **not** become part of
the public lean response. Today's lean projection (ID, title, type, scope,
summary, score) remains unchanged; in addition, the hop origin is available in
telemetry and debug output, where it is needed for the evaluation under 18.2
and 18.5. Backward compatibility for existing clients is preserved.

The control arm is not a formality. A peer-reviewed comparative analysis
decomposes graph-based and non-graph memory systems into comparable components
and shows both: unsuitable graph construction makes results worse, and strong
flat baselines frequently remain competitive — but well-constructed edges
derived from entity descriptions beat flat indexes in some cases by a clear
margin. That forbids a dogma in both directions: neither “graph always” nor
“flat suffices”. The decision is taken per view and per query class, not
globally.

## 14. Consolidation as a controlled sleep pass

### 14.1 Input

The pass considers a mixture of:

- new episodes;
- older similar episodes;
- memories frequently used successfully;
- repeatedly ignored candidates;
- corrections;
- contradictions;
- Decisions that have expired in time;
- existing semantic rules.

Looking only at the largest topic-path clusters is not sufficient.

### 14.2 Operations

1. Cluster episodes by entity, claim, cause, solution and outcome.
2. Deliberately keep similar episodes apart.
3. Identify recurring patterns.
4. Include counterexamples and failures.
5. Detect contradictions.
6. Produce a candidate for a new Lesson, Decision or Workflow.
7. Preserve the originating substantiations via `derived_from`.
8. Propose confidence and validity range.
9. Obtain user confirmation.
10. Leave episodes in place and adjust only their accessibility.

### 14.3 Replay mix

The replay sampler must not select only what has recently been frequent:

- a share of new episodes;
- a share of old but still relevant episodes;
- a share of rarely used but highly salient memories;
- a share of contradicting or corrected cases;
- a share of random control cases.

This prevents the system from merely reinforcing further what is already
dominant.

### 14.4 Non-destructive topology operators

Consolidation expresses itself solely in named, reversible proposals. There is
no free-form rewriting of content. The operators fall into two classes that
must not be mixed.

**Class A – topology and content operators.** They change inventory or
relations and create versions:

| Operator | Effect |
|---|---|
| `SPLIT` | a memory that is too broad is decomposed into several successors |
| `MERGE` | several memories are merged into one successor |
| `UPDATE` | the content or validity of a memory is carried forward |
| `LINK` | a typed edge is proposed |
| `SUPERSEDE` | a memory is marked as replaced and remains citable |

For every Class A operator the following applies:

- it references all inputs completely;
- it creates a new version or derived representation and deletes no evidence;
- it carries a justification and a confidence;
- the user approves it before persistence;
- it can be rolled back individually, because the predecessor state remains
  citable;
- a proposal that is not accepted leaves no state in the vault.

**Class B – accessibility decisions.** `DORMANT` and `REACTIVATE` are not
content operations. They create no version and change no text and no edge;
they act on accessibility:

| Operator | Effect |
|---|---|
| `DORMANT` | accessibility is lowered, content and edges remain unchanged |
| `REACTIVATE` | accessibility is raised after a substantiated need |

For Class B the following applies separately:

- Per 7.1, Accessibility is a reproducible projection and not a stored truth.
  An operator that wrote it as a version would cancel exactly this property.
- A **permanent** accessibility decision by the user is therefore not executed
  as a consolidation proposal but recorded via a separate override contract: an
  explicit floor or pin under 7.2 and 7.4, which overrides the computed
  projection, is visible at any time and can be revoked at any time.
- A Class B proposal without such an override takes effect only until the
  projection is next recomputed. That is intended and is displayed to the user
  as such.
- `user-directed` memories and floored memories are exempt from automatic
  `DORMANT` proposals.

**Reachability guarantee.** Every archived, dormant or consolidated source
remains reachable from the visible inventory via at most
`max_provenance_hops` typed links. The initial value of two is a **candidate to
be tested**, not a settled constant: an originating source that runs first
through `SPLIT` and then through `MERGE` lies exactly two hops away afterwards
— the limit is reached, but not yet exceeded. One further generation from
`UPDATE`, `MERGE` or `SPLIT` already exceeds it. The value is stored versioned
and is changed only with a documented justification.

**Preservation rule.** Because the limit already takes effect in the second
generation, naming it is not sufficient — it must be enforced:

1. Before **every** Class A operator is accepted, the survival invariant is
   simulated for the state *after* the operation.
2. If the simulation shows that a source would lie outside
   `max_provenance_hops`, the proposal must restore the invariant by its own
   means: through typed **provenance shortcuts** from the new visible memory to
   the original leaf sources, or by keeping a suitable intermediate node
   visible.
3. The shortcut or the visible intermediate node is **part of the same atomic
   proposal** and is approved together with it. There is no automatic
   subsequent `LINK`: a shortcut that arose separately and unasked after the
   operation would be an autonomous graph mutation and would violate 13 and
   the approval obligation of Class A.
4. The proposal is accepted as a whole or discarded as a whole. A partial state
   — operation executed, shortcut missing — must not arise.
5. Shortcuts are additive. They **do not replace and do not delete the original
   provenance chain**; the complete derivation history remains traversable.
6. Shortcuts respect **sensitivity and scope boundaries**. A shortcut that
   would make a private source accessible to a less protected visibility area
   is not permitted — even if it would restore the invariant. In that case the
   proposal counts as unfulfillable; the sensitivity rule from 23 takes
   precedence over the reachability guarantee.
7. The check applies after **every single operation**, not only at the end of a
   consolidation run. A run that violates the invariant in the meantime is not
   permitted even if its final state satisfies it again.

**If none of this takes effect.** If neither the operation itself nor a
permissible, privacy-compliant shortcut can satisfy the invariant, a fixed
order applies:

1. The operation is **aborted without a partial state**. No vault state, no
   half shortcut, no orphaned version arises.
2. The affected intermediate node remains visible instead of falling into
   dormancy — reachability takes precedence over the tidying effect of
   consolidation.
3. If the same conflict arises repeatedly for the same structure, the Curator
   produces **one** proposal to raise `max_provenance_hops`. This proposal is a
   separate, measured change under 18.5 and not a silent adjustment.

**No loops.** A rejected or blocked proposal is not repeated automatically. The
Curator remembers the rejection via a **structural fingerprint** of exactly
those data that are relevant to the invariant:

- operator type;
- the memory IDs involved and their semantic content version — the same
  quantity as in the hash, not `updated`;
- the affected provenance edges;
- visibility, sensitivity and scope of the nodes involved;
- the applicable value of `max_provenance_hops`.

The same operation is proposed again only once this fingerprint changes.
Changes to cache contents, telemetry counters, `stale_status` or timestamps are
explicitly **not** sufficient: they do not touch the invariant and must not
approve a blocked proposal again.

A changed fingerprint is here a **necessary but not sufficient** condition.
From the user's point of view the rule reads: the same rejected proposal does
not come back; a genuinely different, improved proposal may appear again.

So that this is checkable, the Curator stores a **semantic proposal hash**
alongside the structural fingerprint. It may not be restricted to the proposed
state change: if evidence, the reason code of the justification and a resolved
protection conflict count as a material change, they must also lie in the hash
in canonical form — otherwise a material change could be present while the hash
remains unchanged, and the conditions would contradict each other.

The hash is formed from a **versioned canonical structure** and contains **no
freely worded explanatory text**. Otherwise a mere rewording of the
justification could trigger a resubmission — exactly what the rule is meant to
prevent. The structure comprises at least:

| Component | Form |
|---|---|
| Operator | enum value, no free text |
| Target state | normalized diff against the initial state |
| Sources | sorted source IDs with their **semantic content version** |
| Edges | sorted tuples of the edges created and removed |
| Evidence | sorted evidence references or evidence hashes |
| Justification | **reason code** from a fixed vocabulary, no prose |
| Protection conflict | structured status and, if present, its resolution |
| Schema | version of the hash schema itself |

Three points about this are not negotiable:

- **Sorting and normalization.** All sets are sorted and normalized before
  hashing; the order in which a proposal came about must not move the hash.
- **Reason code instead of prose.** The human-readable justification is
  **logged separately** and does not enter the hash. It remains visible to the
  user and is retained for traceability — it merely does not decide the
  resubmission. If the situation really changes, the reason code changes.
- **Semantic content version.** The source version carried in the hash denotes
  a version of **what is asserted in terms of content**, not the field
  `updated`. A save operation without a change of content moves `updated`, but
  not the semantic version — and therefore not the hash either.

**Unknown reason code.** The vocabulary is versioned and therefore finite. If
the Curator encounters a code that the applicable vocabulary version does not
know — after a downgrade, for instance, or from a proposal produced by a newer
version —, that does **not** count as a named material change: there is **no
resubmission** until the versioned vocabulary has been extended. An unknown
code does not substantiate a material change, only that it cannot be judged.
The opposite direction — resubmit in case of doubt — would turn every gap in
the vocabulary into exactly the loop that C-067 and C-073 were set up against.

The semantic content version rests on the same delimitation of
assertion-bearing content as the confirmation reference from 6.3 — the left
column of the table there governs; retrieval, presentation and operational
metadata count in neither case. The two quantities nevertheless remain separate
and are not interchanged: the confirmation reference additionally binds
`memory_id` and the concrete presentation in the review, because it records a
user decision; the semantic content version identifies only the content state
of a source within a proposal. Same definition of the content, different
purposes.

It follows immediately: a mere rewording, a timestamp update or a metadata
change enables **no** resubmission. They move neither the structural
fingerprint nor the semantic proposal hash.

A resubmission requires all three conditions:

1. a **changed fingerprint** per the list above,
2. a **changed semantic proposal hash**, and
3. a **named material change** to the proposal.

A change to at least one of these quantities counts as material:

- the proposed **target state** — what is to hold after the operation;
- the **source version** of the memories involved;
- the **set of edges** that the operation creates or removes;
- the **reason code** of the justification, insofar as it changes on the basis
  of new evidence — a merely differently worded justification does not count;
- a previously **resolved protection conflict** — for instance a sensitivity or
  invariant violation that has fallen away.

If the semantic proposal hash is unchanged, the proposal stays suppressed —
regardless of how the fingerprint has moved. Pure time, cache, telemetry and
projection changes as well as rewordings of the justification move neither the
fingerprint nor the hash and are therefore excluded on both routes. If none of
the five quantities can be named as changed, the proposal counts as the same
one. In case of doubt, the resubmission does not take place: a missed
improvement proposal costs less than a proposal that returns every week in a
slightly different form. Otherwise exactly the loop that this rule prevents
would arise — a proposal that appears anew every night because a projection
timestamp has moved.

A consolidation run that is blocked on one structure skips it and continues; it
does not repeat it within the same run and does not block the remaining
proposals.

The guarantee is measured via two quantities:

- **Survival rate:** the share of archived or consolidated sources that are
  reachable within `max_provenance_hops` from a visible root. Target value
  100%; any shortfall is an error, not noise.
- **Citation rate:** the share of derived memories all of whose inputs are
  referenced via resolvable IDs and are retrievable.

**Both rates apply per permission, scope and sensitivity context**, not
globally. A global rate would be either wrong or dangerous: if it counts
private sources in the denominator of a less privileged caller, it reports an
error that is not one — or it invites establishing reachability via a
permission-crossing shortcut. Therefore:

- A private source must remain reachable from a visible root **of the same or a
  more strongly protected context**.
- It **never belongs in the denominator** of a rate that is computed for a less
  privileged caller — there it simply does not exist.
- The target value remains **100% within every permissible context**.
- If no safe path exists, the source or a suitable intermediate node remains
  **visible within its own protected context**. No permission-crossing shortcut
  arises — privacy under Section 23 continues to take absolute precedence over
  the reachability guarantee.

A visible memory may represent an archived source, but may never silently
replace its content. The Asteroid Belt is thus a statement about accessibility
and not a deletion — consolidation must not undermine this property.

#### Special case `SUPERSEDE`

`SUPERSEDE` remains a Class A operator: it creates a version and shifts the
state of truth. Alongside this, however, it possesses a **secondary visibility
effect** that is clearly bounded:

- The predecessor is no longer the current truth and is no longer surfaced in
  Normal Recall as a statement in force.
- It remains historical, reachable via its ID and via Deep Recall.
- This effect is **not a Class B `DORMANT` decision**. It follows from the
  version state and not from an accessibility assessment.
- It creates **no permanent accessibility override**. A floor or pin arises
  only via the route from the Class B section.
- That the accessibility projection from 7.1 contains the term
  `superseded_penalty` and that 7.5 assigns the Historical zone to “explicitly
  superseded” is not in contradiction with this: both are **computed
  projections** from the version state, not stored decisions. `SUPERSEDE` sets
  the version; the zone follows from that, without an operator writing it.

**Delimitation from today's archiving primitive.** `SUPERSEDE` works
fundamentally via claim and version status. It does **not** correspond to
today's `archive_memory` and does **not** set `obsolete: true`. This
delimitation is necessary because the existing primitive does far more than its
name suggests:

- It moves the predecessor's file into the vault trash under `.bastra/`.
- It additionally removes it from the living vault index, so that it can no
  longer be found by the regular route even via its ID.
- It stamps the trash copy best-effort with `obsolete: true` and
  `superseded_by`.
- Normal Recall filters out `obsolete` completely in any case.

A `SUPERSEDE` that reused this primitive would therefore not make the
predecessor historical but effectively remove it — and thereby break the
promise that old versions remain citable.

**Migration rule.** The predecessor remains in the living vault. Its
historicity arises from the version and claim status, not from a change of
location. It remains reachable via an explicitly named **Historical and Deep
Recall access** that resolves it by ID, version and citation. It is the
technical counterpart of the Historical retrieval role from 6.5.

The architecture here fixes only the **access contract**, not the storage form:
the access may start as a logical view on the existing index. A physical
separation only becomes necessary once a measurement justifies it or permission
requirements enforce it.

If `obsolete` is nevertheless used in a transitional phase, the following
applies:

- The historical loader reads `obsolete` memories in **explicitly** —
  otherwise they would no longer be reachable by any route.
- Normal Recall continues to filter them out; nothing changes about that.
- In this phase a predecessor is not additionally moved into the trash and not
  removed from the index.

**Rollback.** The rollback of a `SUPERSEDE` must restore five things:

1. the **version status** — the predecessor is the current version again;
2. the **time status** — in particular, a `retracted_at` set on the
   predecessor claim does not apply;
3. the **storage location** — the file lies in the living vault again, not in
   the trash;
4. the **indexability** — the predecessor is regularly indexed again and can be
   found via its ID;
5. the **visibility** — it is surfaced again as a statement in force.

A rollback that takes back only the version is incomplete and counts as failed.

## 15. Reconsolidation and versions

A successful retrieval can produce a review candidate:

```text
memory loaded
  -> used in the tool context
  -> new evidence or correction observed
  -> reconsolidation candidate
  -> no-op, confirm, patch or new version
```

Rules:

- no automatic overwriting on the basis of a single tool call;
- the old version remains citable;
- the current version points to the predecessor;
- the predecessor points to the successor;
- historical queries can retrieve the state as it was then;
- normal queries prefer claims that are currently valid;
- conflicts are not decided by recency alone.

## 16. Hook and session orchestration

### 16.1 SessionStart

A `GET /hook/session-context` already exists. Today it serves the MCP forwarder
for hookless clients, is deliberately project-less, excludes project-related
and `all-projects` hints, and likewise assembles its sources largely
sequentially. It is therefore not a drop-in replacement for the Claude Code
SessionStart hook.

V1.0 does not build a second, competing session-context path. The existing
server assembler is extended into the shared implementation:

```text
GET  /hook/session-context
  -> backward-compatible, project-less forwarder path

POST /hook/session-context
  -> cwd / project / source / budgets
  -> preferences
  -> project context
  -> cross-project rules
  -> floors
  -> taxonomy
  -> care/import/onboarding state
  -> health
```

The Claude Code hook then calls the project-capable path once. Hookless clients
keep the existing GET contract. Server-side, independent steps run in parallel.
The response has:

- a global time budget;
- a global token budget;
- prioritized blocks;
- clear degraded marking;
- termination of non-critical parts at the deadline.

### 16.2 PreToolUse and prompt

- exact and lexical checking first;
- semantic arm only when needed;
- no blanket multi-hop;
- `no_answer` is respected;
- Required solely from the deterministic evidence decision; a calibrated
  probability only comes into consideration after M1 label evidence;
- backoff also applies to apparently strong hits when their relevance is not
  independently substantiated;
- identical routing logic is shared centrally.

### 16.3 Context budget

A global Context Governor decides:

- how many memories are surfaced;
- how many tokens are consumed;
- whether only title/summary or a full load is necessary;
- whether an already loaded memory may be mentioned again;
- which zones are automatically excluded.

## 17. Learning from usage

### 17.1 Positive signals

- `loaded` and subsequently `acted_on`;
- an explicit “That was right”;
- repeated successful use in different situations;
- a memory demonstrably prevents a previously recurring error;
- a Deep Recall hit is reactivated.

### 17.2 Negative signals

- the user discards or corrects the hit;
- immediate re-query with different wording;
- loaded, but marked as unsuitable;
- repeatedly surfaced and never loaded;
- the claim is replaced by new evidence.

### 17.3 Selection bias

Only surfaced memories can be loaded. Therefore:

- `surfaced-not-loaded` is not certain proof of irrelevance;
- `acted_on` is today a lexical proxy, not a ground-truth label;
- out-of-pool cases supply no direct ranking labels;
- learned ranking is initially operated solely in shadow;
- coverage and ranking quality are measured separately;
- exploration remains small, controlled and transparent.

### 17.4 Measure retrieval and presentation separately

The hook load rate does not depend on ranking alone. For the V1.0 release
contract, separate arms are needed:

1. identical hits with different hook wording;
2. identical wording with and without a deterministic abstention gate;
3. independent relevance labels for a sample of surfaced and withheld
   candidates;
4. task/tool success in addition to `loaded` and `acted_on`;
5. evaluation broken down by client, hook source and query class.

Arm assignment is deterministic per pseudonymous session ID. A session remains
in the same arm for all events belonging to it. The minimum N per arm is fixed
after the M0 baseline run and is stored versioned together with the assignment
function and the experiment configuration.

**Release assignment changed by C-083.** The five points above describe the
complete experiment; as of 29 August 2026 they are no longer the V1.0 contract
in that completeness. V1.0 owes the pre-registered design, the deterministic
assignment and the honest status report per 18.1; the adequately populated run
— minimum N reached, second hook wording, per-session switchable gate, query
class collected and independent relevance labels — is moved to 26.2. Binding
are 26.1 and 26.2 in their amended form.

Tokens per `acted_on` remains an important system ROI metric, but is not
interpreted as pure retrieval precision.

### 17.5 Usage signals beyond `acted_on`

`acted_on` remains a token-overlap proxy. The following signals are more robust
and are collected as soon as they are available without a schema change:

- explicit acceptance or rejection of a hint;
- a later mention of a memory ID in the further course;
- an edit, after the recall, to a file that the hint concerns;
- a new memory that recognizably arose from the hint;
- repeated recall of the same memory via differently worded queries;
- task or tool success;
- a demonstrably avoided rule or security violation;
- a correction after a wrong recall;
- reactivation of a dormant memory after Deep Recall;
- a documented dead end in a Deep Recall branch.

Obligations for every evaluation of these signals:

- **Exposure normalization.** A frequently surfaced memory automatically
  collects more positive events and is therefore not considered better
  substantiated. Every signal is normalized to the number of its surfacings,
  and this normalization is reported as such.
- **It is not a correction of the selection bias.** Dividing by the number of
  surfacings makes rates comparable; it says nothing about why a memory was
  surfaced. The actual bias lies in the fact that the selection itself depends
  on the ranking so far. A robust bias correction presupposes:
  1. logged selection probabilities, or propensities, per candidate and
     surfacing;
  2. controlled exploration or a suitable randomized arm, so that
     counter-observations arise at all;
  3. treating candidates that were not surfaced as censored and not as
     negative.
  As long as these three preconditions are not met, **no causal utility lift**
  may be claimed from the signals — neither in the report nor as a
  justification for a live activation. Descriptive statements about observed
  rates remain permitted.
- Non-response remains a weak negative and is never used as a certain negative
  label.
- Every signal carries client, hook source, pseudonymous session and experiment
  arm.
- No signal acts live on the ranking before M6 is passed.
- Raw query texts do not enter a long-term learning database without a separate
  data-protection decision.

## 18. Measurement gates on the way from V1 to V2

The measurement gates do not check Recall@k alone. They check the entire
decision chain of coverage, relevance, abstention, accessibility, latency and
context cost.

### 18.0 Approval status

The V1.0 release contract covers M0, the deterministic part of M1, the shared
project-capable session assembler and the context/consumer experiment from
Section 17.4. Measurements, prototypes, shadow operation and read-only
projections for M2 through M5 may begin at any time; quality comparisons that
claim a reference effect are interpreted only against a robust M0 baseline. A
pure M6 shadow model presupposes M0 and M1, but not M3 through M5. Schema and
contract changes and live activations remain blocked until the gate named in
each case and an explicit approval.

The label `M` stands for measurement gate. It is deliberately kept separate from
the product versions V1/V2.

### 18.1 M0 – Establishing measurement truth

Goal:

- ensure that every eval arm actually executes the production code path.

Work:

- `packages/daemon/scripts/eval-stress.ts --hybrid` must create a real
  `EmbeddingIndex`;
- the model and backend used are reported in the report;
- the current production formula `max(k × 4, 20)` is reported in the report
  (for the paraphrase slice with `k=10` this is 40 today, for smaller `k`
  usually 20);
- the candidate pool is explicitly widened to at least 100 or 200 solely for
  the corresponding evals;
- Near, Far-in-pool and Far-out-of-pool are labelled separately;
- outdated gold IDs are removed or versioned;
- eval queries are created independently of the current memory surface;
- the dataset manifest and the private run artifact carry `origin_type`,
  `authoring_mode` and `origin_ref_hash` for every gold case;
- label-shuffle null and control arm are implemented in the harness and
  reported in the report;
- every run receives a code, vault, model, configuration and dataset hash;
- command line, raw stdout/stderr, manifest and structured JSON results are
  stored under `~/.bastra/eval-runs/<date>-<hash>/` as a versioned run
  artifact;
- after the baseline run, the numeric M1 tolerances are fixed and stored
  versioned;
- the public repository stores solely aggregated reports without
  vault-derived query texts. The lower third-party reproducibility is accepted
  in favour of vault privacy;
- every third-party number cited in the report carries its evidence class
  under 2.3;
- a later standard-benchmark run is archived only with harness version, model,
  judge and prompt version, context budget, top-k, and with retrieval and
  answer metrics reported separately;
- for the 2×2 cue experiment from 18.3, a power assumption and a minimum N
  **per cell** are fixed and stored versioned — separately for the main
  effects and for the interaction, whose proof requires the larger N;
- the gold set receives separately reported descriptive and associative case
  sets, so that both axes are measurable independently of one another;
- for the cue generation path from 18.3, it is registered before the run and
  stored versioned **which of the two permitted designs** is being run: Design
  A as a paired two-condition comparison with the cue configuration held fixed
  — then additionally the division into selection split and holdout, or the
  nested evaluation scheme — or Design B as a fully crossed 2×2×2 with eight
  cells. In both cases, the condition or cell structure, the minimum N per
  condition or cell and the evaluation rule are fixed in advance; for Design A,
  any interaction evaluation does not apply.

Gate:

- no silent arm fallback;
- no unknown gold IDs;
- reproducible report;
- label-shuffle null and control arm present;
- no third-party number without an evidence class and no shared ranking built
  from measurements with different reader, judge, top-k or context budget;
- one registered cue experimental design (A or B) is available versioned — for
  Design A with two conditions, selection/holdout separation and a minimum N
  per condition, for Design B with eight cells and a minimum N per cell, in
  each case together with the evaluation rule.

### 18.2 M1 – Relevance and abstention

Hypothesis:

> A deterministic, explainable relevance and no-answer gate strongly reduces
> false injections without relevantly degrading the recall of genuine gold
> memories.

Datasets:

- genuine independent paraphrases;
- anti-hallucination queries;
- cross-scope cases;
- identifiers and technical symbols;
- German, English and mixed queries;
- hard semantic distractors;
- deliberately empty queries with no matching memory.

Metrics:

- Recall@1/@3/@10;
- MRR and nDCG;
- precision of the required band;
- false-interrupt rate;
- abstention precision/recall;
- independent human or curated relevance labels;
- context tokens per `acted_on`;
- rate of genuine golds that were wrongly abstained on;
- load/use rate separated by hook wording, client and hook source;
- argument fidelity in action-related cases, that is, the correct carrying of
  stored paths, limits, preferences and safety rules into the arguments of a
  tool call;
- correct non-application of an irrelevant memory;
- premise awareness on queries with a false presupposition;
- wrong application of a memory that is correct in content.

The action-related metrics have a concrete occasion: a peer-reviewed paper on
the application of memory in tool calls measures roughly 30.7 argument F1 for
passive retrieval against roughly 53.8 for perfect oracle retrieval. Finding the
right evidence is therefore the **dominant** bottleneck — but not the only one:
even with perfect retrieval, close to half the arguments remain wrong. The
correct application of a correctly found memory is a separate, unsolved problem.
For Bastra, both follow from this: retrieval is the quantity V1.0 sets out to
improve and must therefore be measured; and progress in retrieval may not be
presented as progress in application. That is why argument fidelity and correct
non-application stand as their own metrics alongside Recall@k.

Definitions:

- `nDCG@k` uses the versioned relevance scale `0 = irrelevant`,
  `1 = optional relevant`, `2 = clearly relevant`; cases without a graded gold
  label are evaluated only with MRR/recall.
- `False-Interrupt-Rate` is the share of gold `no_answer` queries in which the
  hook nevertheless automatically injects at least one memory.

AUROC, calibration error and `relevance_probability` are used only in a later
calibration stage, once M0/M1 supply enough suitable labels.

Preliminary component switching gates for the evidence decision:

- anti-query false injections < 5%;
- no relevant Recall@3 loss against the same ungated retrieval arm;
- Required needs a hard anchor or independent arm evidence;
- no relevant loss on identifier queries;
- false abstention stays below the tolerance fixed in M0;
- a hit on a derived cue does not by itself produce a `required`;
- a hit reached only via a graph hop does not by itself produce a `required`;
  the report states the hop origin of the required hits.

Recall@3 ≥ 85% on independent real paraphrases, context tokens per successful
use, load/use rate and the initially targeted tenfold context-ROI improvement
are observed as system goals from V1.0 onwards. They are neither live switching
gates of the evidence decision nor blanket V1.0 release conditions before M0 is
complete: absolute coverage also depends on the retrieval arm; the remaining
quantities measure retrieval, hook wording, consumer behaviour and telemetry
attribution jointly.

The numeric component limits and the system goals are finalized only after the
reproducible M0 baseline run.

Shadow sign-off:

- at least 14 calendar days or at least 500 logged hook decisions; the
  decision route applies only when those decisions come from **at least 20
  different sessions** and **no single session supplies more than 25 %** of
  them (C-085);
- all retrieval-isolated component gates pass on the versioned gold set;
- every observed `required`/`no_answer` divergence between the legacy decision
  and the evidence decision is explainable by features, reason code or review;
- unexplained divergences block live activation.

**Spread requirement on the decision route (C-085).** Until now the threshold
knew only a quantity, not a distribution. The purpose of shadow operation,
however, is to observe the predicate against the distribution of real usage,
and a quantity drawn from a single sitting is not a distribution: it carries
one vault state, one project, one way of working and one daily rhythm. A single
intensive working day could formally fill the gate. The 14-day route is
untouched by this — time produces spread on its own and needs no additional
condition.

**What is counted.** Counting is per **memory decision**, not per hook call: a
call that decides over eight candidates yields eight counting decisions. That
is how the threshold is implemented (`packages/daemon/scripts/stats.ts`,
`shadowDecisions`) and how it is meant; the phrase "logged hook decisions" in
C-022 denotes the same quantity. The session attribution follows the same
count: a session counts as soon as it carries at least one counting decision,
and its share is measured against the decisions, not against the calls.

Rollout and rollback:

- live activation takes place behind a configuration flag;
- on error, drift or operational uncertainty, recall falls back immediately to
  today's score/floor behaviour;
- there is no hard cutover;
- the legacy path is removed only after documented stable live operation and a
  separate approval.

### 18.3 M2 – Adaptive retrieval cascade

Hypothesis:

> BM25-first with conditional semantic recall lowers p95 without losing
> semantic coverage.

Arms:

- today's always-hybrid path;
- BM25-only;
- adaptive cascade;
- adaptive cascade plus conditional local reranker;
- adaptive cascade plus gravity and hub damping;
- flat control arm without any graph view as a reference for later graph
  experiments.

The cue layer is compared read-only or in shadow as a **2×2 factorial design
over the two cue axes** — not as four arbitrary variants:

| Arm | descriptive axis | associative axis |
|---|---|---|
| 1 — reference | off | off |
| 2 | on | off |
| 3 | off | on |
| 4 | on | on |

Evaluated separately are:

- the **main effect of the descriptive axis** from the comparisons (2 against
  1) and (4 against 3);
- the **main effect of the associative axis** from (3 against 1) and (4 against
  2);
- the **interaction** from the difference of the two main effects.

This evaluation is the reason for the design: arm 4 obscures arms 2 and 3 only
if it is read as a fifth variant against the reference arm. As a cell of a
factorial plan it contributes, on the contrary, to both main effects and
additionally yields the interaction. If the interaction comes out clearly
negative, the axes do not belong live together, even if each shows a lift on its
own.

**Stage problem and permitted variants.** The descriptive and the associative
axis each exist once at item level and once at scene level, and the scene level
presupposes the episode and claim schema from M4. M2 may therefore run only one
of the following two variants and must state in the report which one:

**Variant (a) — staged, without new infrastructure.** M2 tests the 2×2 at item
level with `descriptive_entity` and `associative_bridge`. The scene level with
`descriptive_scene` and `associative_horizon` follows after M4 as its own,
identically constructed ablation. This is the recommended path, because it
requires no preliminary work.

**Variant (b) — complete, with preliminary work.** M2 tests all four families,
but presupposes a clearly defined read-only episode or scene projection,
including a named data source and its own gold cases for scene-related hits.
Without this projection, scene cues cannot be formed.

**Generation path: two permitted experimental designs.** The product-owner
decision from 31 defers the choice between agent-generated and batch-generated
cues and hands it to M2 for controlled testing. There are exactly two permitted
designs for this, and **before the run it is registered which one is run**:

**Design A — paired two-condition comparison (recommended).** The cue axes are
held fixed at **one** configuration; exactly **two conditions** are compared —
agent cues against batch cues. Design A therefore has **two conditions and no
four cells**: the four cells of the 2×2 belong to the cue axis experiment and no
longer exist here, because the axes are held fixed. The comparison is paired,
because both generation paths run on the same gold cases; that lowers the
required N considerably.

The fixed configuration may **not** be determined on the same cases on which the
comparison is subsequently made — otherwise the comparison would be contaminated
by the selection. Exactly one of the two is permitted:

- a **selection split** separated in advance, on which the cue configuration is
  determined, and a **holdout** independent of it, on which the generation path
  is compared; or
- a pre-registered **nested evaluation** that cleanly separates selection and
  comparison within the same case set.

The division or the nesting scheme is part of the registration under 18.1.

The result of Design A applies **only to the fixed configuration**. It permits
**no interaction claim**: whether a generation path performs differently on
another cue configuration remains unanswered and may not be asserted.

**Design B — fully crossed 2×2×2.** The generation path enters as a third factor
alongside the two cue axes. **Only this design has eight cells, and only it can
measure interactions between generation path and cue axis.** For this it
requires **its own, correspondingly larger minimum N per cell**, which is to be
fixed before the run under 18.1.

There is no third possibility. In particular, it is not permitted to add the
generation path as an additional arm during the run or afterwards: that would
produce an incompletely filled design whose main effects would be confounded
with the generation path.

Without variant (a) or (b), an M2 report may **not** claim to have tested all
four cue families. A finding measured at item level is not transferred to the
scene level.

**Statistical executability.** A factorial design is only worth as much as its
case count. Therefore:

- The minimum N per cell versioned after M0 is a precondition for any statement
  about main effects and interaction. For the generation-path experiment under
  Design A it applies correspondingly per **condition**; interaction claims do
  not apply there at all. For the interaction it is higher than for the main
  effects — it is the weaker quantity.
- If the attainable N is not sufficient for the interaction, it is explicitly
  marked as **exploratory** in the report. An exploratory result describes an
  observation; it carries **no live approval** and no gate. The main effects
  remain unaffected by this, provided their own minimum N is reached.
- If the N is not sufficient for the main effects either — or, under Design A,
  for the condition comparison — the arm is not evaluable and is reported as
  such, not as a null finding.

**Constant environment in the generation-path experiment.** Within the
registered generation-path experiment, cascade, damping, reranker, pool and
query classes remain constant across **all conditions of the registered design**
and correspond to the reference setup fixed for M2 — two conditions under Design
A, eight cells under Design B. What is varied there is solely what the
registered design carries as a factor: under Design A the generation path alone,
under Design B the two cue axes and the generation path.

The constancy rule for the **2×2 cue axis experiment** remains unaffected by
this: there, the remaining retrieval configuration stays constant across all
four cells, and solely the two cue axes are varied. The two rules apply
alongside one another for two different experiments. The experiment is **not**
crossed in full with the remaining M2 arms in an unplanned way: such a crossing
multiplies the cells, dilutes the case count per cell and makes any interaction
claim worthless. It is permitted only under a **pre-registered design** that
fixes the cell structure, the minimum N per cell and the evaluation rule before
the run and stores them versioned.

What is ablated is solely the ranking effect of a cue, never its provenance:
target ID, origin, generator version and evidence link are fully present in
every arm. An arm that surfaces cues without an evidence link would not be a
negative control but a violation of 11.4 and is not run.

Gravity and hub damping are separate arms and no reissue of the damping already
in production: today, lifecycle, curator, doc and salience multipliers act on
the full candidate pool before the k cut. Gravity damping instead addresses
semantically close hits without query-term overlap, hub damping the dominance of
heavily linked nodes. Both remain a hypothesis until the ablation arm shows a
precision gain without recall loss.

Metrics:

- p50/p95/p99;
- provider calls per recall;
- query cache hit rate;
- energy/model residency;
- recall quality per query class;
- timeout and degraded rate;
- bridge and horizon Recall@k on associative gold cases;
- cue-to-evidence precision and rate of false associations;
- associative false-interrupt rate;
- cue transfer between German and English queries.

Live gates:

- PreTool p95 < 150 ms;
- SessionStart p95 < 300 ms;
- BM25-unambiguous queries do not trigger an unnecessary provider call;
- semantic query classes lose no more than the defined tolerance.

Cue arms and damping arms pursue different goals and therefore receive separate
gates:

- **Cue arm.** Associative coverage rises measurably, while the
  false-interrupt rate does not get worse and recall on the remaining query
  classes does not get worse. A lowered false-interrupt rate alone does not
  qualify a cue arm — it is not built for that.
- **Damping arm.** The false-interrupt rate falls measurably, without relevant
  recall loss against the identical arm without the additional gravity/hub
  damping.

The numeric tolerances of both gates are, like all the others, fixed only after
the M0 baseline run and stored versioned.

M2 still approves no persistent representation change. Permanent storage of
derived cues requires the same separate representation decision as chunking and
dual vectors under 11.2 and 11.4.

### 18.4 M3 – Accessibility and Asteroid Belt

Hypothesis:

> A zoned Accessibility model reduces spontaneous interference, while Deep
> Recall reliably finds old memories again.

Test cases:

- current memories frequently used successfully;
- old memories never used;
- old but highly salient memories;
- floored memories;
- replaced decisions;
- contradicting claims;
- dormant memory with an exact identifier;
- deliberate Deep Recall query;
- the same Deep Recall query against a control arm with merely quadrupled `k`
  and a lowered floor.

Metrics:

- correct zone classification;
- spontaneous false-injection rate out of the belt;
- Deep Recall@k for dormant golds;
- explainability of the zone decision;
- reactivation rate after successful Deep Recall;
- survival-by-ID and citability;
- time to the first robust evidence;
- number of search branches, dead-end rate and convergence rate;
- budget overruns and number of deliberate budget extensions;
- evidence coverage and citation completeness;
- quality of the `no_answer` cases, kept separate from the rate of the
  `inconclusive_budget_exhausted` and the `inconclusive_interrupted` cases;
- coverage distribution of the `no_answer` cases, so that complete nil results
  remain distinguishable from partially answered runs;
- rate of controller defects, kept separate from all result values;
- share of runs that end at a budget limit instead of at exhaustion, broken
  down by the limit reached first;
- false reactivations.

Live gates:

- floors never drop automatically in Deep-only;
- Historical is never surfaced as a current rule;
- exact IDs remain reachable;
- Deep Recall finds defined dormant golds;
- Normal Recall injects no Belt memories without exceptionally strong,
  explicitly measurable evidence;
- neither Tier 1 nor Tier 2 from 8.5 is triggered out of a hook;
- Tier 1 beats the `k` control arm measurably, otherwise the Deep Recall mode
  is not justified;
- Tier 2 goes live only if it shows a benefit of its own against Tier 1,
  measured in cost and latency, and its termination conditions from 8.5
  demonstrably take effect;
- no run reports a budget termination as `no_answer`; the four results from 8.5
  are distinguishable in the telemetry;
- no controller defect appears as a result value or as a `stop_reason`; it is
  signalled as a structured error with a read-only partial state and is not
  counted in the result statistics;
- `no_answer` is never reported as “no evidence present” as long as
  `coverage` is greater than zero **or** `evidence` is not empty;
- the budget limits are stored versioned and reported in the report;
- an absent evidence gain demonstrably closes only the affected branch: no run
  ends with `no_answer` while the telemetry reports open branches;
- the result object from 8.5 arrives distinguishably at MCP, REST, CLI and
  Mindspace; no consumer maps a budget status onto `no_answer` and none merges
  the two inconclusive values;
- `inconclusive_budget_exhausted` occurs solely with a limit actually reached
  and `limit` set; a regular external interruption reports
  `inconclusive_interrupted` with a `stop_reason` from `user_cancelled`,
  `shutdown` or `permission_revoked`; a controller defect reports no result
  value but `DeepRecallDefect`;
- a find in the same step as a limit reached yields `answer_found` with `limit`
  carried along.

### 18.5 M4 – Episodes and consolidation

Hypothesis:

> Separating episodes and semantics reduces interference and produces better
> durable lessons.

Metrics:

- cluster precision;
- share of generalizations with complete evidence;
- counterexample coverage;
- contradiction detection;
- user acceptance of the proposals;
- rate of wrong or premature generalizations;
- retrieval quality before and after consolidation;
- correctness of point-in-time queries across the four time axes from 6.3;
- discriminatory power of the `provenance_class` in samples;
- rate of wrong edges and entity-linking errors per logical view;
- result of each view against the no-graph control arm;
- reversibility of every executed topology operation.

Schema/live gates:

- no autonomous rule change;
- every lesson refers to its episodes or source;
- contradictions are displayed, not silently overwritten;
- the episode is retained after consolidation;
- a detected contradiction produces a visible conflict finding and a `LINK`
  proposal for the `contradicts` edge, but sets no `retracted_at`; temporal
  invalidation happens solely through a confirmed resolution;
- a historical statement remains reachable after `SUPERSEDE` by ID, version and
  citation;
- the survival rate under 14.4 reaches 100% within `max_provenance_hops`
  inside every permission, scope and sensitivity context, and the citation rate
  of derived memories is complete per context;
- no rate counts a source in the denominator of a context in which it may not
  be visible;
- the repetition lock reacts to the structural fingerprint from 14.4 and not to
  cache, telemetry, `stale_status` or timestamp changes;
- a rejected proposal returns only if the structural fingerprint **and** the
  semantic proposal hash have changed and at least one of the five material
  quantities from 14.4 is named; the semantic hash covers operator type,
  normalized target change, source IDs and versions, affected edges, sorted
  evidence references, reason code, structured protection-conflict status
  including its resolution and the hash schema version, formed from a versioned
  canonical structure without free explanatory text; the source version is a
  semantic content version and not `updated`; rejection log, hash and proposal
  comparison are provable per structure;
- the survival invariant is simulated before every single Class A operation;
  shortcut or visible intermediate node are part of the same atomic proposal,
  and no intermediate state of a consolidation run violates it;
- no shortcut arises as a separate automatic `LINK`, and none carries a private
  source into a less protected visibility scope;
- a blocked proposal leaves no partial state and is not repeated within the
  same run;
- a change to `max_provenance_hops` takes place solely as a separate, measured
  proposal and never as a silent adjustment;
- `SUPERSEDE` moves the predecessor neither into the trash nor out of the
  index; it remains resolvable via Historical/Deep Recall access by ID, version
  and citation;
- a `SUPERSEDE` rollback restores version status, time status, storage
  location, indexability and visibility;
- a graph view goes live only if it beats its no-graph control arm;
- every Class A topology operation is approved before persistence and can be
  rolled back individually;
- no Class B operator produces a version, and no permanent accessibility
  decision arises without an explicit floor or pin override;
- `user_asserted` arises only with a confirmation reference that the saving
  caller cannot assert and that is resolvable later — subordinate to the
  following line, which conclusively fixes the place of origin;
- a directly passed `provenance_class: user_asserted` is subject to the same
  check and constitutes no bypass;
- `user_asserted` arises solely via a confirmed review; no save path produces
  the class automatically;
- every confirmation is bound to `memory_id` and to the hash of the
  assertion-bearing content as displayed in the review, and lapses when that
  content changes; a change to retrieval, presentation or operational metadata
  triggers no lapse;
- no memory is excluded from review authorization; import status and
  `write_origin` determine only the initial class and the suggested value;
- the surface can reach `agent_observed`, `derived` and `hypothesis`
  individually; no path merges them into one class, and the follow-up question
  is not skippable;
- no answer is pre-selected; `confirmed` arises only after an active selection,
  and a next click without a selection produces no confirmation reference;
- no memory remains permanently unreviewed: at the end of the inventory review,
  every one carries either a clarified class or a confirmed `unknown_legacy`;
- the structural criterion for the boundary between review stage 2 and 4 is
  available versioned in the queue manifest before the queue is built, comes
  from a frozen graph snapshot and does not move during the run; every memory
  of unknown history that falls under neither stage 1 nor stage 3 is thereby
  deterministically assigned to exactly one of the two remaining stages, and if
  the snapshot is missing it falls to stage 4;
- the stage assignment is evaluated in the order 1 → 3 → 2 → 4;
- no document and no manifest claims that the `bridge` field substantiates a
  graph-theoretic bridge or an articulation node; it enters the structural
  criterion solely as cross-cluster adjacency — neighbours in at least two
  different foreign clusters;
- the queue or run artifact substantiates the assignment without the live
  graph: projection schema and version, snapshot hash, creation time, applied
  criterion including threshold or quantile, and, per assigned memory of
  unknown history, its ID, `degree`, foreign clusters or `bridge` value and
  resulting stage — alternatively a content-addressed persisted snapshot
  including a reference;
- during a running review, neither a recomputation of the snapshot nor a
  reassignment of queued memories takes place, and a restart continues the same
  queue with the same assignments;
- a reason code that the applicable vocabulary version does not know triggers
  no resubmission.

The conditions on the inventory review stand here because they are checked
together with the provenance fields — not because they depended on M4.
Assignment, snapshot and proof artifact are sidecar/run artifacts under C-018
and C-025 and are permitted at any time; M4 binds solely the persistent schema
fields.

### 18.6 M5 – Scale and interference test plus the Flat/HNSW decision

M5 answers two different questions that are measured separately because they
have separate causes: how does quality decay as the vault grows — and is a
different vector backend worth it? A joint run would mix the two and make every
finding unusable.

#### 18.6.1 Scale and interference test (backend-agnostic)

Hypothesis:

> A growing vault produces interference that shows up not in latency but in
> abstention, contradiction resolution and temporal accuracy.

This test is a measurement in the sense of C-018 and may run at any time. It
gates nothing and hangs on no backend: it is run on the **same** backend across
all scale steps, so that an observed decline is attributable to growth and not
to the index.

Scales: current vault, 1,000, 3,000, 10,000, 50,000 memories or chunks.

Categories measurable today:

- abstention precision and recall on the existing anti-query and `no_answer`
  cases;
- interference from semantically adjacent memories;
- Recall@1/@3/@10 and false-interrupt rate per scale step;
- latency and degraded behaviour per scale step.

Measurable only after M4, because they presuppose the claim, version and time
schema:

- resolution of contradicting claims;
- temporal questions with a version or validity reference;
- correct ordering of chronologically ordered events.

This second group is explicitly not asserted before M4, not approximated and not
concealed as a gap in the report; it appears as “not yet measurable, dependent
on M4”.

The previously open question of whether four of seven categories are sufficient
for a meaningful test has been decided: **they are sufficient.** This test gates
nothing — it is a measurement in the sense of C-018 and supplies a trajectory,
not an approval decision. Four independently measurable categories show a rise
in interference under growth reliably enough to recognize a need to act. The
three M4-dependent categories are added after M4 and may under no circumstances
be asserted before then.

Tolerances: for every category measurable today, a numeric maximum decline per
doubling of scale is fixed after the M0 baseline run and stored versioned. A
description of the cause documents a finding, but never replaces an observed
tolerance: a missed target stays missed, even when the cause is known.

The occasion is substantiated: a widespread third-party system reaches values
above 90% on short conversation benchmarks, but falls to a 50.5% pass rate at
ten million tokens of history, with markedly worse sub-values for temporal
questions, contradiction resolution and abstention (see 2.3 for the exact
scale). These figures come from **different benchmarks with different tasks,
question sets and retrieval depths** and are therefore not an isolated proof of
scaling: they do not show that growth is the cause, only that no one has
produced the counterproof. They are the reason to measure for oneself — nothing
more. Absolute values of the third-party system are not a target value (see
2.3); what is relevant is solely one's own trajectory across one's own scale
steps with an otherwise identical setup.

#### 18.6.2 Flat/HNSW decision (live gate)

Hypothesis:

> Automatic backend choice improves large vaults without losing relevant hits
> compared to exact Flat search.

The comparison runs on an **identical corpus, identical queries and identical
configuration**; the only variable is the backend. A comparison across
different corpus sizes or configurations is not a backend comparison.

Metrics:

- build time;
- RAM;
- index size;
- update and delete latency;
- search p50/p95/p99;
- Recall@3/@10 against Flat gold;
- snapshot recovery;
- automatic switch decision;
- fallback time.

Live gates:

- Recall@10 against Flat ≥ 98% with an identical corpus and identical
  configuration;
- no sensitivity or scope leaks;
- p95 actually better;
- atomic, repeatable switch;
- Flat fallback functional at any time;
- no degradation of the quality categories measured in 18.6.1 beyond the
  tolerances fixed there, measured on the same corpus with both backends.

### 18.7 M6 – Learned ranking and Accessibility

A pure shadow model may begin after M0 and M1 are complete. M3 through M5 are no
precondition for it; signals from stages that do not yet exist remain absent
from the model:

- shadow model;
- no live mutation;
- time split instead of random split;
- evaluate projects and persons separately;
- distinguish positive, negative and censored feedback;
- drift monitoring;
- reproducible rollback;
- reported exposure normalization under 17.5 on every usage signal;
- a statement about causal lift only once propensity logging, controlled
  exploration and the censoring treatment of candidates not surfaced are in
  place; until then, solely descriptive rate comparisons are permitted;
- minimum N per query, client and hook class before any statement about lift;
- co-occurrence projections solely in shadow and only with hub control;
- a stage decision between executing, skipping and suspending may become active
  at the earliest once the minimum N is reached, and the base stages BM25 and
  exact retrieval always remain guaranteed available.

Live approval only after M6 has been passed, with a demonstrated incremental
lift over the deterministic evidence decision, explainable behaviour and a
reproducible rollback. The fallback is the deterministic ordering of the
evidence decision and not the legacy score behaviour.
## 19. Eval datasets

The growing V1→V2 gold inventory requires at least:

- independent real paraphrases;
- genuine no-answer queries;
- hard semantic distractors;
- cross-scope and cross-project cases;
- time and version questions;
- contradicting memories;
- exact IDs, paths and symbols;
- German, English and mixed technical language;
- episodes against semantic rules;
- dormant and Deep Recall cases;
- private and team/public sensitivity;
- documents with long bodies;
- query types from real hook telemetry;
- action-related cases in which an earlier rule, a path, a limit or a
  security directive must enter the arguments of a tool call, including cases
  in which the correct answer is not to apply an existing memory;
- associative cases whose query resembles the target memory neither lexically
  nor semantically and which can be resolved only through the situational
  context;
- descriptive cases whose query names the target memory via a term, an entity
  or a scene description. Descriptive and associative cases are reported
  separately, because they must make the two axes of the cue experiment from
  18.3 independently measurable.

Each case receives:

- query;
- independent origin;
- expected IDs;
- acceptable alternatives;
- expected zone;
- `no_answer` yes/no;
- scope;
- point in time or version view;
- permitted retrieval depth;
- justification of the gold label.

Permitted independent query sources are real session transcripts prepared in a
privacy-compliant way, original task texts, issue/incident descriptions, search
queries formulated directly by the user, and an independently working second
person. When formulating or selecting the query, the body, summary and
`recall_when` of the target memory must not be opened. The assignment to the
gold memory happens only afterwards, through a separate labelling step.

For every gold case, the following provenance fields are mandatory in the
dataset manifest and in the private run artifact:

- `origin_type`: `session_transcript`, `task_text`, `issue_incident`,
  `user_query` or `second_person`;
- `authoring_mode`: how the query was independently obtained or formulated;
- `origin_ref_hash`: privacy-compliant hash of the local origin reference.

Raw text or a resolvable local origin reference remains private and is not
carried over into aggregated public reports.

### 19.1 External standard benchmarks

The local gold set remains the authoritative yardstick for Bastra's product
scope. External standard benchmarks for long-term memory answer a different
question — external comparability — and are therefore adapter work in V1.x, not
part of the V1.0 release contract. In particular, no full run of a large-scale
trajectory benchmark is a V1.0 release condition; a representative local subset
is sufficient for the first assessment.

**Decided (31, decision 2):** **Exactly one** external benchmark is adapted,
and it is an **action-oriented** one — one that measures whether an earlier
statement correctly enters a later action, not whether it can be reproduced. It
is adapter work in V1.x and explicitly not a V1.0 release blocker. The smaller
comparison base of action-oriented benchmarks is deliberately accepted, because
it lies closer to Bastra's product scope than a conversation-oriented test.

For every external run, the rules from 2.3 and M0 apply: evidence class,
harness and model versions, context budget and top-k are carried along, and
retrieval quality is reported separately from answer quality. An external score
is never a live gate. There is explicitly no optimization for a single headline
score.

## 20. Product metrics

The Recall evolution does not optimize search hits alone:

Metrics only become measurable with the data source of their respective gated
stage. Until then they describe the long-term target and must not be reported
as existing product telemetry.

### Quality

- Recall@k;
- MRR/nDCG;
- required precision;
- no-answer quality;
- conflict and temporal accuracy;
- Deep Recall success.

### Attention

- hook emissions;
- loaded hints;
- `acted_on`;
- tokens per successful use;
- repetition and backoff rate;
- share of disruptive hints.

### Speed

- p50/p95/p99 per retrieval lane;
- provider time;
- cache hit rate;
- SessionStart time;
- timeout and degraded rate.

### Memory health

- episodes per consolidated lesson;
- unresolved contradictions;
- historical versions;
- dormant share;
- reactivated memories;
- stale sources;
- share of memories without reliable evidence.

## 21. Migration

### 21.1 V1.0 – approved release contract, no schema change

- repair the M0 eval harness and produce reproducible run artifacts;
- extend score, evidence, abstention and no-answer telemetry with `client`,
  `hook_source` and a pseudonymous `session_id`;
- run the deterministic evidence decision in shadow at first and switch it
  active only after the retrieval-isolated M1 component gates have been passed;
- extend the existing session context into a shared, project-capable
  assembler;
- parallelize independent server parts within this assembler;
- introduce a global context and latency budget;
- measure retrieval quality and the effect of the hook wording in separate
  experiment arms.

### 21.2 V1.x/M2 – adaptive retrieval, not yet approved for live

Measurement, prototype and shadow operation are permitted at any time. A
quality comparison is interpreted only against the M0 baseline. A live
activation follows only once M2 meets its quality and latency gate:

- BM25-first cascade;
- conditional semantic arm;
- query embedding cache;
- deadline and degraded behaviour;
- no degradation of the semantic query classes.

### 21.3 V1.x/M3 – Accessibility and Deep Recall, not yet approved for live

Read-only projections and Deep Recall experiments are permitted at any time. A
live activation follows only once M1 demonstrates relevant age-, conflict- or
accessibility-related interference and M3 meets its gate. The stage begins
without a schema change:

- Accessibility solely as a read-only sidecar projection;
- no mass markdown change;
- display zone and reasons in the UI;
- Asteroid Belt as a read-only projection;
- Deep Recall experimental and live only after the M3 gate has been passed.

### 21.4 V1.x/M4 – memory lanes, claims and consolidation, schema/live not yet approved

Isolated measurements, fixture/sidecar prototypes and read-only projections are
permitted at any time. Every persistent vault schema or contract change
requires a separate schema decision on the basis of the evidence available at
that point. A live migration follows solely after M4 has been passed:

Memory lanes and schema:

- add `episode`;
- optional claim/evidence fields;
- version and typed-edge schema;
- old memories remain fully compatible;
- defaults are derived from the existing type.

Consolidation:

- replay sampler;
- cluster and contradiction proposals;
- human review;
- no autonomous semantic mutation;
- a Historical/Deep Recall access path that resolves superseded predecessors by
  ID, version and citation before `SUPERSEDE` goes live — permitted at first as
  a logical view on the existing index. Without this access path there would be
  no route that redeems the citability of old versions; the existing archiving
  primitive explicitly does not achieve that (see 14.4).

### 21.5 V1.x/M5 – vector strategy, not yet approved for live

Measurement, prototype and shadow implementation are permitted at any time. A
live activation follows only once controlled profiling on the target hardware
substantiates a real Flat search bottleneck and M5 substantiates the quality
and latency advantage. Provider latency alone is no reason for HNSW:

- backend abstraction;
- Flat as reference;
- HNSW in shadow;
- automatic quality and latency gate;
- atomic switch with fallback.

### 21.6 V1.x/M6 – learned layer, not yet approved for live

- pure shadow start after a stable measurement geometry and completed M0/M1;
- M3–M5 are not a precondition for the shadow model;
- shadow-first;
- time-based offline evaluation;
- live activation only after M6 has been passed, an explicit approval and a
  demonstrated rollback.

### 21.7 V2.0 – promotion instead of big bang

V2.0 is awarded only once the mandatory properties from 26.2 have been
demonstrated together. Experimental V1.x functions do not become V2 components
by their existence alone. They require stable contracts, backward
compatibility, documented migration, rollback and their respective passed
measurement gates.

## 22. Backward compatibility

- Markdown remains the source of truth.
- Existing memory types remain valid.
- `recall_when` remains the primary hand-written retrieval signal.
- Existing IDs remain stable.
- Old clients can still receive lean hits.
- New decision and evidence fields are introduced additively.
- A `relevance_probability` is offered additively only after successful
  calibration; before that it stays absent.
- Without embeddings, BM25 works fully.
- Without HNSW, Flat search works fully.
- Without the accessibility sidecar, conservative default zones apply.
- Without Mindspace, Deep Recall remains reachable via API/CLI.
- `valid_until` retains its present lifecycle semantics and is not migrated;
  new time fields are added additively alongside it.
- Inventory memories without `provenance_class` count as `unknown_legacy`,
  imported inventories as `imported_unverified`; neither is rewritten en masse.
- A `write_origin: user-directed` loses no function — it merely does not lead
  to `user_asserted`. Since no write path creates an attestation reference and
  none is supposed to, this applies permanently to all paths; the class arises
  solely through the confirmed review under 6.3.
- A `provenance_class` passed directly in future changes nothing about this;
  the value `user_asserted` is subject to the same attestation rule.
- The inventory review changes no memory content. It sets solely provenance and
  review fields in the sidecar projection; an unreviewed memory remains fully
  findable and usable.
- `SUPERSEDE` moves no predecessor into the trash and does not remove it from
  the index; the existing archiving primitive remains untouched by this and
  keeps its present meaning.
- The present `related_via` hop in the hook path stays active until a
  measurement substantiates a better view.
- From V1.0 on, the frontmatter format is under the promise from 26.1:
  required fields, memory types and the meaning of the documented optional
  fields change only with a major bump (C-084).
- The loader leniency is part of that promise. Repair of missing required
  fields, entry-by-entry rescue of a block that does not parse, dropping an
  invalid optional field, clamping an over-long `summary` and the
  inconsequence of unknown keys all remain; tightening them is a breaking
  change. The only admissible exception is the narrowly drawn security
  exception from 26.1.
- Unknown keys are tolerated on load, but are not guaranteed to survive a
  `save_memory` with `overwrite`: that path rebuilds the frontmatter from its
  known field list.
- No 1.x reader requires a format-version field in the frontmatter. A
  hand-written file need declare nothing to be fully valid; a version field
  introduced additively later would have to be optional.
- All V2 fields named in this section — in particular `provenance_class` and
  the provenance/review projection including `unknown_legacy` and
  `imported_unverified` — are planned additively and do **not** exist in the V1
  schema. Their absence is the defined state, not a migration backlog.
- No release in the 1.x line rewrites existing files in bulk to produce its own
  format.

## 23. Privacy and security

- No new cloud requirement.
- Query and memory embeddings respect existing provider and egress rules.
- Sensitivity is checked before retrieval and again before output.
- HNSW must not leak filtered-out private IDs via neighbourhood or diagnostics.
- Working Memory is by default not stored permanently.
- Episode capture follows the same capture and injection protection rules.
- User content is never treated as executable instructions coming from the
  vault.
- Pseudonymous experiment session IDs contain no query or vault content.
- Raw artifacts from eval runs stay local; public reports contain no
  vault-derived query texts.
- Deep Recall extends reach, not permissions.
- Soft delete and survival-by-ID are retained.
- The existing audit of the Mac bridge mutation path is retained. A uniform
  audit for regular MCP/HTTP mutations is separate later work and is not
  presupposed here as an already existing property.
- Derived cues, manifests and graph projections are subject to the same scope,
  sensitivity and egress rules as the underlying content. A manifest must not
  bypass a filter by aggregating.
- Deep Recall and manifests extend reach within existing permissions; they
  create no new ones.
- Usage signals and utility history contain no raw query texts as long as no
  separate data protection decision exists for that.

## 24. What is explicitly not built first

- no larger embedding model as an answer to wrong required hits;
- no deeper untyped graph hops;
- no aggressive automatic trigger proliferation;
- no more aggressive automatic saving;
- no autonomous rewriting of user knowledge;
- no HNSW live activation without a Flat comparison;
- no live salience weighting without sufficient shadow evidence;
- no learned ranker on a faulty or drifting candidate pool;
- no opinion or belief network with its own self-reinforcing confidence;
- no separate physical graph databases per relation type;
- no cross-encoder in the PreTool or SessionStart budget;
- no automatic execution of consolidation operators without approval;
- no live weighting from Q values or co-occurrence edges without exposure and
  hub control;
- no second epistemic memory taxonomy alongside the existing types;
- no full run of a large-scale trajectory benchmark as a V1.0 blocker;
- no replacement of evidence by cue or trigger texts;
- no adoption of a foreign system's target value as a Bastra gate;
- no claim of a causal utility lift without propensity logging, controlled
  exploration and censoring treatment of candidates that were not surfaced;
- no Deep Recall budget termination that is reported as `no_answer`;
- no derived cue and no graph hop that produces `required` on its own;
- no ablation that removes the provenance fields of a derived cue;
- no automatic migration of `valid_until` into a validity field;
- no legacy inventory that counts as a user statement without an explicit
  origin;
- no imported content that counts as a user statement solely because of its
  import `write_origin`;
- no `user_asserted` from a merely asserted, unattested `write_origin`;
- no `user_asserted` that rests on a mutation audit alone;
- no directly passed `provenance_class: user_asserted` as a bypass of the
  attestation rule;
- no `SUPERSEDE` that removes the predecessor from the living index or moves it
  into the trash;
- no automatic `LINK` addition outside an approved proposal;
- no live approval that rests on an interaction reported as exploratory;
- no transport or internal error that is reported as a recall result;
- no controller defect that is carried as a result value or `stop_reason`;
- no `no_answer` that conceals partial reliable evidence;
- no `user_asserted` without an explicit user confirmation in the surface;
- no confirmation that is transferred to a second memory or to changed
  assertion-bearing content;
- no confirmation lapse triggered by pure metadata, usage or timestamp changes;
- no merging of observation, derivation and conjecture into one provenance
  class;
- no restriction of review authorization by import status or `write_origin`;
- no pre-selected provenance answer and no `confirmed` from a next-click on a
  default;
- no retroactive or ongoing addition of the cue generation path as an extra arm
  outside the registered experimental design;
- no interaction claim from Design A;
- no free-form explanatory text in the semantic proposal hash;
- no resubmission from a rewording, a timestamp update or a metadata change;
- no determination of the fixed cue configuration on the same cases on which
  the comparison is subsequently made;
- no treatment of missing usage history as zero usage and no automatic
  assignment of memories with unknown history to review stage 2;
- no review criterion that falls back on floor or pin status — floors are
  review stage 1, and no independent pin source exists;
- no structural criterion that arises only during the review run or changes
  within it;
- no upgrade to review stage 2 when the graph snapshot is missing or
  incomplete;
- no claim that the field `bridge` substantiates a graph-theoretic bridge or an
  articulation node;
- no assignment proof that rests on a timestamp alone and does not record the
  underlying graph state;
- no recomputation of the snapshot and no reassignment of queued memories
  during a running review, and no newly rebuilt queue after a restart;
- no resubmission on the basis of a reason code that the applicable vocabulary
  version does not know;
- no memory that remains permanently exempt from the provenance review;
- no resubmission of a rejected proposal that is substantively the same.

## 25. Implementation order

V1.0:

1. Measurement truth and reproducible baselines.
2. Deterministic relevance evidence and genuine abstention.
3. Shared, project-capable session assembler with internal parallelization.
4. Global context budget and a separate retrieval/presentation experiment.

Up to and including item 4, the implementation is approved as V1.0. All
following numbers order schema/contract changes and live activations.
Measurement, shadow operation and read-only projections remain permitted
independently of that; quality claims with reference effect presuppose M0:

5. BM25-first cascade and query embedding cache live after M2 has been passed.
6. Derived accessibility and Asteroid Belt live after the M1 proof and after M3
   has been passed. The provenance review of the inventory under 6.3 runs
   independently of that as read-only sidecar work and is bound to no gate.
7. Deep Recall Tier 1 live after M3 has been passed; Tier 2 only after
   additional proof of its own benefit over Tier 1 under 8.5.
8. Cue/content vectors, the derived cue layer and chunking persistent or live
   only after a separate representation decision under 11.2 and 11.4; M2 alone
   is not sufficient.
9. Episodic Memory, structured claims, the time axes from 6.3 and the
   `provenance_class` persistent only after a separate schema decision, live
   after M4 has been passed.
10. Typed graph, logical views, versions and reconsolidation persistent only
    after a separate schema decision under 21.4, live after M4 has been passed
    and, per view, after the no-graph control arm has been passed.
11. Controlled consolidation with the proposal operators from 14.4 live after
    M4 has been passed.
12. Flat/HNSW strategy live only once controlled profiling substantiates a Flat
    search bottleneck and M5 substantiates the quality and latency advantage.
13. Learned ranking in shadow after M0/M1, live only after M6 has been passed.

## 26. Definition of Done

### 26.1 Release contract V1.0

V1.0 is finished when:

- every eval run exists as a reproducible, versioned artifact with code, vault,
  model, configuration and dataset hash;
- the hybrid stress eval demonstrably uses a real `EmbeddingIndex` and does not
  report a silent BM25 fallback as hybrid;
- no unknown gold IDs or unlogged candidate pool sizes enter the evaluation;
- every gold case carries the mandatory provenance fields in the dataset
  manifest and in the private run artifact;
- the numeric M1 tolerances are fixed in versioned form after the M0 baseline
  run;
- run artifacts in the private eval directory are complete and public reports
  contain no vault-derived query texts;
- the deterministic evidence decision was first checked in shadow;
- the shadow operation reaches the specified minimum duration or minimum case
  count and has passed the retrieval-isolated M1 component gates before the
  live activation;
- the live activation sits behind a configuration flag and the score/floor
  legacy path is retained as a tested fallback;
- hook and session context respect `no_answer` and do not treat weak hits as
  required solely because of an incompatible raw score;
- the shared session assembler takes over project path and scope correctly,
  executes its independent server parts in parallel and stays compatible for
  existing clients;
- a global token and latency budget bounds the entire session response;
- retrieval quality, hook wording and consumer behaviour are evaluated
  separately;
- `client`, `hook_source` and the pseudonymous session assignment deliver the
  telemetry dimensions required for that;
- the retrieval/presentation experiment from 17.4 is registered before every
  run, its arms are assigned deterministically per pseudonymous session, and
  its evaluation reports an arm below the minimum N explicitly as **not
  evaluable** rather than as a null result;
- context ROI is reproducibly measurable as a system metric without circularly
  governing the live activation of a correct retrieval decision;
- neither vault schema, memory types nor vector backend are migrated for that.

**Contract change C-083, 29 August 2026 — requirement replaced.** Until that
date the experiment point above read:

> ~~experiment arms are assigned deterministically per session and have reached
> their minimum N versioned after M0;~~

That wording no longer applies. V1.0 owes the **registration**, the
**deterministic assignment** and an **honest status report** — `underpowered`
or `not_evaluable` with a stated justification. Reaching the minimum N, and
with it the evaluated, adequately populated run, is no longer part of V1.0;
both move to 26.2. The reason is measured rather than weighed: per 17.4 the
unit of randomisation is the session, and on a single-user population no arm
reaches a viable sample size in reasonable time. A release contract demanding a
number the population cannot supply is either unfulfillable or an invitation to
present an underpopulated run as a finding. The reporting rule from 18.1 is
untouched by this and is made an explicit part of the V1.0 contract by this
entry.

**Frontmatter and schema promise from V1.0 on (C-084).** With V1.0 the beta
signal of the leading `0.` falls away, and from that version the vault format
is under an explicit promise. Markdown with YAML frontmatter remains the source
of truth. The ten required fields — `id`, `title`, `type`, `summary`,
`topic_path`, `tags`, `scope`, `recall_when`, `created`, `updated` — keep their
name, type and meaning; the recognized memory types stay valid; the documented
optional fields are not reinterpreted. A vault written by a 1.x version stays
readable by every later 1.x version, with no migration step.

A 1.x reader requires **no format-version field** in the frontmatter. A file
carrying none is fully valid, today and in every later 1.x version. Whether a
version field is introduced additively later is left open; it would then have
to be optional and never become a load requirement.

The loader leniency is promised as well, because it is the actual pledge to a
hand-maintained vault: missing required fields are repaired from filename, body
and file time, a frontmatter block that does not parse is rescued entry by
entry, an invalid optional field is dropped instead of costing the memory, an
over-long `summary` is clamped on load, and unknown keys remain
inconsequential. Repairs are in-memory and are never written back to disk.
Tightening the loader is therefore a breaking change and not a bug fix.

Unknown keys are tolerated on **load**. They are **not guaranteed** to survive
a `save_memory` with `overwrite`, however: that path rebuilds the frontmatter
from its known field list and carries forward only the fields it knows. The
promise covers reading, not the preservation of foreign fields across a
rewrite.

Breaking, and therefore requiring a major bump: removing, renaming or retyping
a required field; deleting or reinterpreting a memory type; removing a
documented optional field; tightening the loader such that a file that used to
load no longer loads; breaking resolution by `id`; or requiring a migration
without which an existing vault no longer loads. Additive, and therefore minor:
new optional fields, new types, further loader leniency, new projections, and
new write routes alongside the existing ones.

Not part of this promise are ranking, hit order, staleness curves and trigger
weights; the internal storage under `<vault>/.bastra/`; and the
machine-written projection fields, whose computation may change at any time
while field name and rough meaning stay covered. The **shape of `recall`
output** does not fall under the schema promise but under its own API contract,
which follows the same SemVer rules; it is bound, just elsewhere.

**Security exception, narrowly drawn.** Tightening the loader is admissible
without triggering a major bump when all four conditions hold: it closes a
specific, named vulnerability; it is called out in the changelog as a
security-driven tightening; the affected file produces a **visible error**
instead of being dropped silently; and the rest of the inventory stays as
readable as the vulnerability allows. The exception is no licence for parser
cleanup — it covers the real case and nothing else.

Within 1.x there is no forced migration step. No release rewrites existing
files in bulk to produce its own format; where new fields are needed, their
absence counts as a defined default — as a missing `write_origin` reads as
`agent-session` and a missing `recall_mode` as `deliberate` today.

### 26.2 Promotion to V2.0

V2.0 does not count as finished merely because new components exist. The
promotion follows only when:

- Recall reliably says nothing when nothing fits;
- required is again a reliable relevance promise;
- real independent paraphrases meet the quality gate;
- hook context consumes markedly fewer tokens per successful use;
- Normal Recall stays within the latency budget;
- the Asteroid Belt explains accessibility without losing memories;
- Deep Recall can deliberately bring back dormant memories;
- episodes and durable rules have separate roles;
- every consolidation retains its evidence;
- old versions remain citable;
- derived content carries its origin and silently replaces no user fact;
- event, validity, knowledge and derivation time can be answered separately;
- Deep Recall distinguishes an exhausted search, a budget termination, an
  interruption from outside and an implementation error;
- a memory carried as a user statement has a substantiated and not merely
  asserted origin, namely an explicit user confirmation;
- the inventory is fully reviewed and every memory carries a clarified or
  confirmed unclear origin, with observation, derivation and conjecture
  remaining distinguishable;
- accessibility decisions stay separate from content versions;
- the retrieval/presentation experiment from 17.4 has run **adequately
  populated** at least once: arm A with a second hook wording, arm B with a
  per-session switchable gate, both with the minimum N per arm versioned after
  M0 reached, with the query-class dimension collected and with independent
  relevance labels for surfaced and withheld candidates (C-083, moved here from
  26.1);
- HNSW is activated automatically only when it is measurably worthwhile on the
  current hardware and qualitatively safe;
- every adaptive decision is shadow-tested, explainable and reversible.

## 27. Short version

Bastra Recall 0.8.6 becomes V1.0 first: a reproducibly measurable, selective
and controllable recall system. During V1.x, further memory functions are added
only after passed measurement gates. V2.0 finally denotes the jointly proven,
adaptive and multi-layered memory system:

- Working Memory steers attention.
- Episodic Memory stores experiences quickly and separately.
- Semantic Memory holds confirmed, stable knowledge.
- Reflex Memory carries deliberately approved routines.
- Accessibility steers how easily something surfaces spontaneously.
- The Asteroid Belt keeps dormant memories visible and findable.
- Deep Recall permits deliberate “rummaging” in old contexts.
- An adaptive controller selects BM25, Flat Vector, HNSW or Deep Recall
  according to query, vault, hardware, quality and time budget.
- Deterministic relevance evidence and abstention prevent, at first, rank being
  confused with truth; a calibrated probability may later build only on
  independent labels.
- Consolidation and reconsolidation develop knowledge further without erasing
  its history.

The goal is not maximum recall. The goal is:

> The right memory at the right time – and otherwise silence.

## 28. Delta ledger (C-029–C-086)

This section documents eleven consecutive rounds of deltas against the
signed-off state C-001–C-028 as well as four later entries on contract and
predicate. Every entry
names the affected passage, the type
of the delta, the supporting evidence, the gate, the data source, the
acceptance criterion and the rollback. No entry reinterprets an earlier verdict.

**Round 1 — C-029 to C-039** arose from the cross-check of a research briefing
on comparable agent memory systems. These entries are carried over unchanged;
where a later correction touches them, this is noted in the respective entry of
round 2.

**Round 2 — C-040 to C-048** arose from the Codex counter-review of round 1.
Three of these entries correct an error and not merely an imprecision: C-042
reverses a default that was wrong in a security-relevant way, C-046 prevents
the silent loss of a productive capability and at the same time uncovers an
existing gap on the BM25-only path, and C-040 uncovered two miscitations from
round 1.

Which entry of round 1 is refined or corrected by which entry of round 2 — in
case of divergence, the version of round 2 always applies:

| Round 1 | is refined by | Type |
|---|---|---|
| C-029 | C-040 | Refinement: the substantiation obligation is operationalized |
| C-030 | C-043 | Correction: the cue reduction was a hypothesis, not a decision |
| C-031 | C-047 | Refinement: termination conditions become executable |
| C-032 | C-041 | Refinement: the knowledge axis becomes an interval, `valid_until` delimited |
| C-033 | C-042 | Correction: the fallback was wrong in a security-relevant way |
| C-034 | C-046 | Correction: today's hop baseline would have silently disappeared |
| C-035 | C-048 | Refinement: reachability becomes measurable, operator classes separated |
| C-036 | editorial | Refinement: retrieval is the dominant, not the sole bottleneck |
| C-037 | C-044 | Correction: normalization is not a bias correction |
| C-038 | C-045 | Correction: scale test and backend gate were conflated |
| C-039 | editorial | Refinement: the comparison arm is not “undamped” |

**Round 3 — C-049 to C-054** arose from the Codex delta review of round 2 and is
a pure delta fix. C-049 is the most serious entry: the mapping introduced in
C-042 would have reintroduced, via the import path, exactly the error that
C-042 was meant to fix. The assignment to round 2:

| Round 2 | is refined by | Type |
|---|---|---|
| C-042 | C-049 | Correction: import origin must take precedence over `write_origin` |
| C-041 | C-050 | Refinement: a contradiction sets no `retracted_at`; five states delimited |
| C-043 | C-051 | Refinement: 2×2 design with stage reporting instead of an arm list |
| C-047 | C-052 | Correction: closing a branch wrongly ended the run |
| C-046 | C-052 | Refinement: hop marking remains server-internal |
| C-048 | C-053 | Refinement: the invariant is enforced, `SUPERSEDE` delimited |
| C-040, C-044, C-045 | C-054 | Consistency: correction references, source assignment, ID state |

**Round 4 — C-055 to C-059** is the final correction round. It closes two
remaining current-state gaps and completes three contracts. The assignment to
round 3:

| Round 3 | is refined by | Type |
|---|---|---|
| C-049 | C-055 | Correction: an asserted `write_origin` is not an attestation |
| C-052 | C-056 | Correction: `limit: "other"` reported non-budget terminations as a budget problem |
| C-051 | C-057 | Refinement: case-count rule and constant experimental environment |
| C-053 | C-058 | Refinement: shortcut atomic, escape route defined, sensitivity preserved |
| C-053 | C-059 | Correction: `SUPERSEDE` was not delimited against the archiving primitive |
| C-050 | editorial | Clarification: `stale_status` is not a sixth state |
| C-045 | editorial | Clarification: four of seven categories are sufficient in 18.6.1 |

**Round 5 — C-060 to C-062** refines three entries from round 4. The assignment
to round 4:

| Round 4 | is refined by | Type |
|---|---|---|
| C-055 | C-060 | Correction: a mutation audit is not an attestation |
| C-056 | C-061 | Correction: `controller_defect` was carried as a `stop_reason` and thereby a regular terminal state |
| C-058 | C-062 | Refinement: fingerprint-based blocking instead of “changed memories” |
| C-048, C-053 | C-062 | Refinement: survival rate and citation rate per permission context |
| C-059 | editorial | Clarification: Historical access may be a logical view |

**Round 6 — C-063 to C-067** implements the product-owner decisions that were
taken. The assignment to the previous rounds:

| Previous round | is answered or refined by | Type |
|---|---|---|
| C-060 | C-063 | Decision: the confirmation reference arises in the Recall surface |
| C-055 | C-064 | Tightening: a confirmation applies to exactly one memory and one content state |
| C-055 | C-065 | Correction: `not_scheduled` was an exemption, now a queue position |
| C-057 | C-066 | Refinement: cue generation path as a pre-registered factor |
| C-062 | C-067 | Refinement: a changed fingerprint is necessary, not sufficient |

**Round 7 — C-068 to C-073** is the counter-review of the decision
implementation. The assignment to round 6:

| Round 6 | is corrected or operationalized by | Type |
|---|---|---|
| C-063 | C-068 | Correction: three origins were mapped onto one class |
| C-063, C-065 | C-069 | Correction: review authorization was coupled to `write_origin` |
| C-064 | C-070 | Operationalization: binding to `memory_id` and content hash |
| C-065 | C-071 | Current-state correction: the usage telemetry already exists |
| C-066 | C-072 | Correction: “factor, but not an arm” was not an experimental design |
| C-067 | C-073 | Operationalization: semantic proposal hash and material change |

**Round 8 — C-074 to C-077** corrects four entries from round 7. The assignment
to round 7:

| Round 7 | is corrected by | Type |
|---|---|---|
| C-072 | C-074 | Correction: Design A had four cells instead of two conditions |
| C-073 | C-075 | Correction: hash scope and material change were mutually exclusive |
| C-071 | C-076 | Correction: `unknown` led wholesale to review stage 2; no pin source exists |
| C-068, C-069 | C-077 | Tightening: no pre-selected provenance answer, not even in the follow-up question |

**Round 9 — C-078 and C-079** closes two discretion gaps: both entries make a
rule executable whose application had until then been left to the
implementation:

| Round 8 | is made executable by | Type |
|---|---|---|
| C-076 | C-078 | Refinement: structural criterion versioned in advance instead of at discretion |
| C-075 | C-079 | Refinement: canonical hash structure instead of free text |

**Round 10 — C-080 and C-081** corrects two entries from round 9. Both concern
the same weakness: a rule was formulated executably but relied on a promise
that neither the code nor the artifact redeems:

| Round 9 | is corrected by | Type |
|---|---|---|
| C-078 | C-080 | Current-state correction: `bridge` substantiates cross-cluster adjacency, no separating effect |
| C-078, C-079 | C-081 | Proof obligation: snapshot substantiated in the artifact, restart resumes, unknown reason code blocks |

**Round 11 — C-082** is a one-sentence delta fix with exactly one entry. It
removes a gate contradiction that round 10 had introduced:

| Round 10 | is corrected by | Type |
|---|---|---|
| C-081 | C-082 | Current-state correction: the proof artifact was tied to M4 although it touches no schema field |

**Contract change — C-083**, 29 August 2026, is not a review round. It corrects
no verdict but changes the scope of the V1.0 release contract, after the
experiment's registration measured its sample size:

| Previous contract | is changed by | Type |
|---|---|---|
| C-024, 26.1 experiment point | C-083 | Contract change: reaching the minimum N moves from 26.1 to 26.2 |

**Contract addition — C-084**, 29 August 2026, adds to the V1.0 contract a
promise that until now existed only in the code and in no document:

| Previous gap | is closed by | Type |
|---|---|---|
| 26.1 and 22 without a frontmatter promise | C-084 | Contract addition: schema promise, loader leniency, breaking/additive boundary |

**Contract addition — C-085**, 29 August 2026, binds an existing threshold to a
condition its purpose always required:

| Previous contract | is extended by | Type |
|---|---|---|
| C-022, 18.2 shadow sign-off | C-085 | Contract addition: spread across sessions as a condition of the decision route |

**Refinement — C-086**, 29 August 2026, narrows the required predicate after
both narrowings had been quantified on the same pool:

| Previous reading | is refined by | Type |
|---|---|---|
| C-002, 10.3 required conditions | C-086 | Refinement: partial coverage only from 50 %, identifier anchor without the body |

### C-029 – Evidence classes for third-party system numbers

- **Passage:** 2.3 (new), 18.1 M0 under work and gate.
- **Type:** Architectural decision with measurement consequences.
- **Evidence:** Source review of 25 July 2026 (Section 29). The independent
  reproduction named in the Hindsight paper comes from institutions that
  supply co-authors. Zep's best figures appear only on its own
  research page and use the same model as reader and as judge.
  According to the appendix, MAGMA's hyperparameters were optimized on the
  comparison benchmark while the baselines ran with defaults. Ori's numbers
  diverge between the main README and the `bench` directory.
- **Gate:** M0.
- **Data source:** report metadata of the eval harness, source matrix 29.
- **Acceptance criterion:** No report contains a third-party number without an
  evidence class; no shared ranking across measurements with a differing
  reader, judge, top-k, or context budget.
- **Rollback:** Purely a documentation and report rule with no runtime effect.

### C-030 – Separation of cue and evidence

- **Passage:** 10.2, 11.4 (new), 18.2 M1 switching gates, 18.3 M2 arms and
  metrics, Section 25, item 8.
- **Type:** Architectural decision.
- **Evidence:** T-Mem (preprint) substantiates the distinction by granularity and
  orientation as well as the deliberate decoupling of trigger and evidence path.
  Bastra's `recall_when` already carries the highest BM25 field weight today
  (`packages/core/src/search.ts:179`), the machine-expanded field a markedly
  lower one — the trust classes are therefore already implemented
  and are only carried forward consistently here.
- **Gate:** M2 ablation and subsequently the same separate
  representation decision as for chunking and dual vectors.
- **Data source:** associative gold cases from 19, sidecar projection,
  M2 report.
- **Acceptance criterion:** The bridge/horizon arm raises associative coverage
  or lowers the false-interrupt rate without degrading Recall@3 relative to the
  arm without cues; a cue hit never produces `required` on its own.
- **Rollback:** Ignore the sidecar file. Since `recall_when` and the BM25 index
  remain unchanged, this corresponds exactly to today's behavior.
- **Acceptance criterion replaced by C-043.** The preceding or-criterion
  (“raises associative coverage or lowers the false-interrupt rate”) would have
  let a cue arm pass on lowered mis-injections alone.
  Binding are the separate gates per arm type from 18.3.

### C-031 – Deep Recall as a separate two-tier mode

- **Passage:** 8.5 (new), 9.4, 18.4 M3, Section 25, item 7.
- **Type:** Architectural decision.
- **Evidence:** The LongMemEval-V2 preprint measures around 58.6% at about
  27 seconds for a structured multi-pool approach, against around 74.9% at
  108 to 140 seconds for the fully agentic variant. Both are
  self-measurements and not target values; what is usable is the substantiated
  cost jump between the two construction types. In addition: Hindsight and Zep
  rerank every recall via cross-encoder without having to meet a hook budget.
- **Gate:** M3, with separate approval for Tier 2.
- **Data source:** dormant gold cases, branch and convergence telemetry,
  control arm with merely quadrupled `k`.
- **Acceptance criterion:** Tier 1 measurably beats the `k` control arm; Tier 2
  shows, relative to Tier 1, a benefit of its own measured against latency and
  cost; the termination conditions from 8.5 demonstrably take effect.
- **Rollback:** Switch off Tier 2 or disable Deep Recall entirely. Normal
  Recall is unaffected because Deep Recall is a separate mode.

### C-032 – Four separately named time axes

- **Passage:** 6.3 time axes, 18.5 M4, Section 25, item 9, 26.2.
- **Type:** Architectural decision as schema preparation.
- **Evidence:** Graphiti implements a bi-temporal model with
  four timestamps in production and invalidates contradicted facts temporally
  instead of deleting them — substantiated in preprint, repository, and product
  documentation. Bastra today knows only file times plus `valid_until`.
- **Gate:** M4 and the separate schema decision from 21.4.
- **Data source:** point-in-time gold cases, read-only projection.
- **Acceptance criterion:** Point-in-time queries return the state that was
  valid at the time; no field carries two meanings; legacy inventory without
  the new fields remains valid without restriction.
- **Rollback:** The fields are additive and optional. Discarding the projection
  restores today's behavior.

### C-033 – Origin as a field instead of as a second taxonomy

- **Passage:** 6.3 origin, 18.5 M4, 24, 26.2.
- **Type:** Architectural decision, including an explicit
  rejection.
- **Evidence:** Hindsight maintains an Opinion Network with mutable confidence
  and states in its own limitations that the opinion development was never
  validated with users. Such a layer contradicts the
  principle that Bastra manages user knowledge and does not form positions of
  its own. The five epistemic memory types proposed by the briefing
  would moreover duplicate the existing type taxonomy.
- **Gate:** M4 and schema decision.
- **Data source:** sample classification, consolidation reviews.
- **Acceptance criterion:** The classes can be assigned unambiguously in a
  sample; no `derived` content silently replaces `user_asserted` content.
- **Rollback:** Field additive; without the field, `user_asserted` applies
  conservatively, which corresponds to today's behavior.
- **Corrected by C-042.** The preceding rollback line is wrong and
  is no longer applied: a missing `provenance_class` counts as
  `unknown_legacy`, never as `user_asserted`. The entry remains in its original
  wording because the ledger reflects the history; binding
  is the version in C-042 and 6.3.

### C-034 – Logical graph views and no-graph control arm

- **Passage:** 13.1 (new), 18.3 M2 control arm, 18.5 M4, Section 25, item 10.
- **Type:** Architectural decision.
- **Evidence:** MAGMA substantiates, peer-reviewed, the benefit of orthogonal
  views with an intent router, though with hyperparameters optimized on the
  benchmark against baselines running with defaults. The counter-analysis of
  graphs from the same conference shows that unsuitable graph construction
  degrades results and that strong flat baselines often remain competitive, but
  that well-constructed edges derived from entity descriptions beat flat
  indexes markedly in some cases.
- **Gate:** M4, individually per view.
- **Data source:** ablation per view against the flat control arm.
- **Acceptance criterion:** A view goes live only if it beats its control arm;
  causal and temporal edges possess structural evidence; the
  hop budget of one in Normal Recall is observed.
- **Rollback:** Disable the view. `related_via` then behaves as it does today.
- **Supplemented by C-046.** The restriction of Normal Recall described here
  would have silently removed the semantic hop baseline that is in production
  today. It is retained as a control arm, and a hop never produces
  `required` on its own.

### C-035 – Non-destructive proposal operators

- **Passage:** 14.4 (new), 18.5 M4, 24, Section 25, item 11.
- **Type:** Architectural decision.
- **Evidence:** All-Mem (preprint) substantiates a limited visible surface with
  hop-limited expansion into archived evidence, as well as the operators Split,
  Merge, and Update with immutable evidence. This confirms the
  Asteroid Belt independently and supplies the missing operator semantics for
  Section 14.
- **Gate:** M4.
- **Data source:** consolidation runs, review logs.
- **Acceptance criterion:** Every operation is individually reversible,
  evidence remains complete, the reachability guarantee via typed links
  applies, and no vault state comes into being without approval.
- **Rollback:** Do not apply proposals. A proposal that is not accepted
  leaves no state behind by definition.

### C-036 – Action-related and associative evaluation

- **Passage:** 18.2 M1 metrics, 19, 19.1 (new).
- **Type:** Measurement problem.
- **Evidence:** A peer-reviewed paper on applying memory in
  tool calls measures around 30.7 argument F1 for passive retrieval against
  around 53.8 with perfect oracle retrieval. Finding the evidence is therefore
  the dominant but not the sole bottleneck — even oracle retrieval
  stays at 53.8. T-Mem additionally substantiates cases whose cue resembles the
  target neither lexically nor semantically.
- **Gate:** M0 for the dataset and manifest, M1 for the metrics.
- **Data source:** local gold set, optional external adapters in V1.x.
- **Acceptance criterion:** Both case classes are present in the gold set with
  complete provenance; argument fidelity and correct non-application are
  reproducibly measurable.
- **Rollback:** Remove the case classes from the evaluation; the existing
  metrics remain untouched.

### C-037 – Usage signals and exposure correction

- **Passage:** 17.5 (new), 18.7 M6.
- **Type:** Measurement problem.
- **Evidence:** Ori Mnemos specifies Q-value rewards with exposure correction
  and a bias cap. C-006 and C-019 already record that `acted_on` is only a
  token-overlap proxy; without exposure correction, any evaluation based on it
  measures the system's own prior selection.
- **Gate:** M6 in shadow, live effect only after M6 has been passed.
- **Data source:** extended telemetry with `client`, `hook_source`, and a
  pseudonymous session per C-020.
- **Acceptance criterion:** The exposure correction is disclosed in the report,
  the minimum N per query, client, and hook class is reached, and no signal
  takes live effect before M6.
- **Rollback:** Only log the signals. The fallback is the deterministic
  ordering of the evidence decision.
- **Term corrected by C-044.** This entry speaks throughout of
  “exposure correction”. Binding is the designation
  **exposure normalization**: dividing by the number of surfacings makes
  rates comparable and does not fix the selection bias. The entry remains in its
  original wording because the ledger reflects the history; C-044 and 17.5
  govern.

### C-038 – M5 measures quality decay under growth

- **Passage:** 18.6 M5.
- **Type:** Measurement problem.
- **Evidence:** A widely used third-party system reaches 94.8% (Top 50) and
  92.5% (Top 200) on short conversation benchmarks, but drops to a 50.5% pass
  rate with ten million tokens of history; the sub-categories
  temporal questions, contradiction resolution, and abstention sit at
  averages of 0.163, 0.325, and 0.400 on a 0-to-1 scale. See
  also C-040: the percentage reading of these three values in the predecessor
  document was wrong.
- **Gate:** M5.
- **Data source:** the existing scale stages up to 50,000 memories,
  enriched with gold cases per quality category.
- **Acceptance criterion:** No disproportionate drop in abstention,
  contradiction, or temporal quality between two scale stages without a named
  cause.
- **Rollback:** Purely a measurement extension with no product effect.
- **Acceptance criterion replaced by C-045.** The preceding criterion “no
  disproportionate drop … without a named cause” is not executable: it
  can be neither passed nor missed, and a description of the cause would have
  excused every miss. Binding are the numerical tolerances per category to be
  set after the baseline, from 18.6.1.

### C-039 – Gravity and hub damping as ablation arms

- **Passage:** 18.3 M2 arms.
- **Type:** Hypothesis.
- **Evidence:** Ori Mnemos documents both mechanisms as a post-fusion step.
  Bastra today damps solely via lifecycle, Curator, doc, and
  salience multipliers on the full candidate pool before the k cut
  (`packages/core/src/search.ts:311`); the proposed mechanisms act
  at a different point and do not replace the existing damping.
- **Gate:** M2.
- **Data source:** M2 ablation arms on the versioned gold set.
- **Acceptance criterion:** Precision gain or lowered false-interrupt rate
  without Recall@3 loss relative to the identical arm without the additional
  gravity and hub damping. The comparison arm is explicitly not “undamped”: the
  existing lifecycle, Curator, doc, and salience damping remains active in both
  arms.
- **Rollback:** Switch off the arm; the existing damping remains unchanged.

---

*From here on, round 2: the deltas from the Codex counter-review of the
preceding entries.*

### C-040 – Reproducible source matrix

- **Passage:** 29 completely rewritten, with subsections 29.1 to
  29.5; additionally 18.1 M0 under work and gate.
- **Type:** Measurement problem.
- **Evidence:** The matrix in the predecessor revision named only system,
  evidence class, and verdict per third-party claim. Without version, source
  location, and measurement configuration, none of these statements is
  verifiable. Retrieving all sources on 25 July 2026 confirmed this and at the
  same time uncovered two of the document's own miscitations: the reading
  of three BEAM averages as percentages, and the claim that Ori
  documents no convergence criterion. Of nineteen measurements checked,
  three name all four configuration parameters; most frequently the
  context budget is missing, most consequentially the judge.
- **Gate:** M0.
- **Data source:** the primary sources themselves as well as the report
  metadata of the eval harness.
- **Acceptance criterion:** Every cited third-party statement carries canonical
  location, version or commit, source location, and retrieval date; every cited
  measurement additionally carries reader, judge, top-k, and context budget, or
  the explicit note that the source does not give the detail. Estimated values
  or values carried over from other sources are not permitted.
- **Rollback:** Purely a documentation and report rule with no runtime effect.

### C-041 – Fully bi-temporal time model

- **Passage:** 6.3 subsection time axes; 18.5 M4; 22; 24; Section 25, item 9.
- **Type:** Architectural decision.
- **Evidence:** The predecessor revision maintained `recorded_at` as a point in
  time. That makes the knowledge axis not an interval, and the question “what
  did the system hold to be true on cutoff date X?” remains unanswerable. A
  third-party system implemented in production maintains four marks at this
  point — two on the transaction timeline and two on the event timeline — and
  invalidates contradicted facts temporally instead of deleting them. On
  today's `valid_until`, the code substantiates: it is read at exactly one
  place and there translated solely into a score multiplier — 20% for expired
  validity, 85% for aging validity. No code path excludes a memory on that
  basis. A field with real-world-validity semantics does not exist today, nor
  does a field with event-time semantics.
- **Gate:** M4 and the separate schema decision from 21.4.
- **Data source:** point-in-time gold cases across both axes; read-only
  projection before the schema decision.
- **Acceptance criterion:** A point-in-time query returns separately what was
  true on the cutoff date and what the system held to be true at the time; no
  field carries two meanings; `valid_until` keeps its damping effect unchanged
  and is not migrated.
- **Rollback:** All fields are additive and optional. If the projection is
  discarded, the system behaves exactly as it does today, because `valid_until`
  was left untouched.

### C-042 – Safe provenance fallback

- **Passage:** 6.3 subsection origin, new block “Fallback for the
  legacy inventory”; 18.5 M4; 22; 24; rollback line in C-033.
- **Type:** Current-state correction of an error in the predecessor revision.
- **Evidence:** The predecessor revision wrote as rollback “without the field,
  `user_asserted` applies conservatively”. That is the most dangerous possible
  default and at the same time factually wrong. The code substantiates the
  opposite: `write_origin` is optional with no schema default, the write
  cascade ends at `agent-session`, and all protection checks compare strictly
  against `user-directed`. An existing memory without the field is in fact
  unprotected today. The vault therefore contains precisely no information that
  would substantiate user authorship. In addition: `confidence` has a
  schema default of 1.0 and is never read anywhere in the retrieval path, so it
  is unfit as an origin signal; `source` is set by machine only by the vault
  import.
- **Gate:** M4 and schema decision; the rule itself applies immediately to every
  derivation.
- **Data source:** sample classification across the inventory;
  consolidation reviews.
- **Acceptance criterion:** No memory automatically receives `user_asserted`
  unless it explicitly carries `write_origin: user-directed`; everything else
  becomes `unknown_legacy`; `confidence` enters no mapping; no mass rewrite
  takes place.
- **Rollback:** The field is additive. Without it, the system behaves as it does
  today; `unknown_legacy` produces no special treatment whatsoever, only the
  refusal of an unsubstantiated classification.
- **Corrected by C-049 in two respects.** First, the single-step mapping
  described here is unsafe: the vault import also stamps machine-generated
  content as `write_origin: user-directed`, which is why the import check takes
  precedence and only a non-imported save automatically becomes `user_asserted`.
  Second, the wording that `confidence` is “never read anywhere in the retrieval
  path” is factually wrong — the field is read during indexing and held in the
  search index, but has no effect there. Additionally restricted by
  C-055 and C-060: without a confirmation reference that cannot be
  self-asserted, no `user_asserted` arises even for non-imported memories — and
  attestation is not an attribute of a write path. Under C-063,
  `user_asserted` arises at all only via the confirmed review. The entry remains
  in its original wording; C-049, C-055, C-060, C-063,
  and 6.3 govern.

### C-043 – Cue ablation instead of anticipated reduction

- **Passage:** 11.4; 18.3 M2 arms, metrics, and gates.
- **Type:** Measurement problem.
- **Evidence:** The predecessor revision reduced the four cue families to two
  and justified this with the coverage of the descriptive axis by title, tags,
  `topic_path`, and summary. This justification is plausible, but it rests
  on a third-party paper and on the structure of the index — not on a
  Bastra measurement. In doing so it anticipated the result of the ablation
  that it ordered in the same document. Second, the same version provided for
  arms “with and without a link back to the evidence”; an arm without
  provenance violates the rule from 11.4 and would not be a negative control
  but a breach of the rule. Third, a single gate joined the cue and the damping
  arms with an or — so a cue arm could have passed on lowered mis-injections
  alone, without ever delivering associative coverage.
- **Gate:** M2, with separate gates per arm type.
- **Data source:** associative gold cases under 19; four cue arms as a read-only
  or shadow projection.
- **Acceptance criterion:** Cue arm — associative coverage rises measurably,
  without degradation of false-interrupt rate and recall. Damping arm — the
  false-interrupt rate falls without relevant recall loss. Every derived
  cue carries, in every arm, target ID, origin, generator version, and
  evidence link.
- **Rollback:** Ignore the sidecar; retrieval behaves as it does today.

### C-044 – Exposure normalization is not a bias correction

- **Passage:** 17.5; 18.7 M6; 24.
- **Type:** Measurement problem.
- **Evidence:** The predecessor revision called the division by the
  number of surfacings “exposure correction” and with that implicitly claimed
  that it fixes the selection bias. It makes rates comparable, no more: why a
  candidate was surfaced at all depends on the ranking so far, and
  precisely that remains unobserved. The third-party system cited as a model
  likewise merely normalizes — it divides the reward by the exposure count
  raised to the power 0.5 — and claims no propensity correction.
- **Gate:** M6; before the three preconditions are met, no causal
  statement is permitted.
- **Data source:** telemetry with `client`, `hook_source`, and a pseudonymous
  session under C-020; additionally logged selection probabilities and a
  randomized or exploration arm.
- **Acceptance criterion:** The report discloses the normalization as such. A
  causal utility lift is claimed only once propensities are logged,
  controlled exploration is running, and candidates that were not surfaced are
  treated as censored. Until then, solely descriptive
  rate comparisons are permitted.
- **Rollback:** Continue logging signals, no live effect; the fallback is
  the deterministic ordering of the evidence decision.

### C-045 – Scale test and backend decision separated

- **Passage:** 18.6 restructured into 18.6.1 and 18.6.2.
- **Type:** Measurement problem.
- **Evidence:** The predecessor revision attached the quality categories to the
  Flat/HNSW gate. That would have mixed growth effects and backend effects in
  one run, and no finding could have been attributed to a cause any longer.
  Second, three of the five categories — contradiction resolution, temporal
  questions, event order — presuppose a claim, version, and time schema that
  only M4 delivers; they were listed in the gate without being measurable.
  Third, “no disproportionate drop without a named cause” is not an executable
  criterion: it cannot be passed or missed, and a
  description of the cause would have excused every miss.
- **Gate:** 18.6.1 gates nothing and is permitted at any time as a measurement;
  18.6.2 remains the live gate M5.
- **Data source:** scale stages up to 50,000 memories on an identical backend
  for the interference test; an identical corpus with both backends for the
  backend comparison.
- **Acceptance criterion:** The backend comparison varies solely the
  backend. For every quality category measurable today, a numerical maximum
  drop per doubling of scale is available in versioned form after the baseline;
  a missed value stays missed, regardless of the description of the cause.
  Until then, M4-dependent categories appear as “not yet measurable”.
- **Rollback:** Purely a measurement restructuring with no product effect.

### C-046 – Preservation of today's hop baseline and hop rule for `required`

- **Passage:** 13.1, new subsections on the hop baseline and on the
  `required` rule; 18.2 M1; 18.5 M4; 22; 24.
- **Type:** Current-state correction.
- **Evidence:** Restricting Normal Recall to the entity and the
  temporal view would have silently removed a capability that is in production
  today. The code substantiates: the hook endpoint sets `expand_hops` on its own
  to 1 unless the caller explicitly sends 0; no hook sends the parameter.
  Only `related_via` is traversed, that is, exactly the
  semantic view. The MCP path, by contrast, never hops. On the `required` rule,
  the same code substantiates an open gap: a hop neighbor receives at most
  half of the raw seed score, the origin marker `hop` is projected out of the
  response before delivery to the hook, and the
  `required` decision is made solely via the threshold 100. On the
  hybrid path, only the upper bound of the scaled rank sum at around
  164 prevents a neighbor from reaching this threshold. On the BM25-only path —
  the fallback when embeddings are missing or have failed — this safeguard
  does not exist.
- **Gate:** M1 for the `required` rule; M4 for the view comparison.
- **Data source:** gold cases whose target is reachable only via a hop;
  hook telemetry with the hop marker preserved; view ablation against the
  semantic baseline and against the no-graph arm.
- **Acceptance criterion:** The semantic view with a hop budget of one remains
  active and serves as the control arm; no new view displaces it without a
  substantiated lift of its own. No hit becomes `required` on the basis of an
  edge alone; the hop origin is available to the evidence decision.
- **Rollback:** Disable views; `related_via` with a hop budget of one is
  today's state and remains the fallback point.

### C-047 – Executable Deep Recall termination conditions

- **Passage:** 8.5, blocks on budget limits, evidence gain, termination, and the
  three results; 18.4 M3 metrics and gates; 24; 26.2.
- **Type:** Architectural decision.
- **Evidence:** The predecessor revision named three qualitative
  termination conditions. “No new evidence gain” was undefined, and for
  runtime, tokens, branches, depth, provider calls, and candidates no upper
  bound existed. More serious is that both exhaustive outcomes and the
  budget termination would have collapsed into a single `no_answer`. That is
  not only misleading for the user — it distorts the abstention metrics
  from 18.2, because terminated runs would be counted there as correct
  abstention.
- **Gate:** M3, with separate approval for Tier 2.
- **Data source:** branch, convergence, and budget telemetry; dormant
  gold cases; control arm with merely quadrupled `k`.
- **Acceptance criterion:** The limits are available in versioned form and
  appear in the report. Evidence gain is defined via new evidence IDs or newly
  answered sub-questions. The three results are distinguishable in the
  telemetry, and no budget termination is reported as `no_answer`.
- **Rollback:** Switch off Tier 2; Tier 1 and Normal Recall remain
  untouched.
- **Corrected by C-052.** The termination condition introduced here, “two
  consecutive steps without evidence gain”, ended the entire run
  and was assigned to `no_answer`. Binding is the version in 8.5: it
  closes only the branch, and `no_answer` presupposes deterministic exhaustion.
- **Completed by C-056.** The “three results” named here and in C-052
  are obsolete. Binding are the five end conditions and four
  result values from 8.5.

### C-048 – Measurable reachability, separate Accessibility operators

- **Passage:** 14.4, structured into Class A and Class B as well as the block on
  the reachability guarantee; 18.5 M4; 26.2.
- **Type:** Architectural decision.
- **Evidence:** “A limited number of typed links” is not checkable without a
  number; the third-party paper cited as a model likewise carries only
  a symbol and no value at this point. Second, `DORMANT` and `REACTIVATE` stood
  in the same operator list as `SPLIT`, `MERGE`, and `UPDATE`, although they
  change no content. That contradicts 7.1: Accessibility is explicitly a
  reproducible projection there and not a stored truth — an operator
  that wrote it as a version would abolish precisely this property.
- **Gate:** M4.
- **Data source:** consolidation runs; reachability check across the
  archived inventory; review logs.
- **Acceptance criterion:** `max_provenance_hops` is available in versioned form
  and starts at two. The survival rate reaches 100%, the citation rate of
  derived memories is complete.
- **Made precise by C-062.** Both rates are defined globally here. A
  global rate counts private sources in the denominator of a caller for whom
  they do not exist, or invites a permission-crossing shortcut.
  Binding is the version in 14.4: both rates apply per permission,
  scope, and sensitivity context, with a target value of 100% within
  each context. No Class B operator creates a version, and
  a permanent accessibility decision arises solely via an
  explicit floor or pin override.
- **Rollback:** Do not apply proposals. Without an override, Class B proposals
  take effect only until the next recomputation of the projection anyway.

---

*From here on, round 3: the deltas from the Codex delta review of round 2. A
pure delta fix — passages without findings were not touched.*
### C-049 – Import origin before `write_origin`, corrected `confidence` statement

- **Passage:** 6.3, fallback block completely recast as a two-step mapping with
  the new subsection “Review status instead of a prose note”; new class
  `imported_unverified` in the class table; correction of the `confidence`
  statement in 6.3, in 10.2, in the delta entry C-042 including its ledger row,
  and in 32; addition of the import class in 22 and of the prohibition row in 24.
- **Type:** current-state correction.
- **Evidence:** The vault import stamps every adopted content item with
  `write_origin: "user-directed"` — substantiated in
  `packages/daemon/src/import/adapters.ts:153`, there together with
  `source: "<adapter>:<label>:<relKey>"`. The same applies in
  `packages/daemon/src/import-vault.ts:369` for a **fully machine-generated
  navigation index**, there with `source: "index:<label>"`,
  `topic_path: ["imported", <label>]` and the tag `imported`. The single-step
  mapping introduced in C-042 would thereby have declared a foreign vault,
  including generated helper nodes, wholesale to be user assertions — precisely
  the error C-042 was meant to fix, only through a different door. On the second
  correction: `confidence` is in fact read, namely during indexing
  (`packages/core/src/search.ts:724`), and is held as a `storeField` in the
  search index (`search.ts:106` and `search.ts:175`). The statement “is read
  nowhere during retrieval” was wrong; what is correct is that the field
  influences neither ranking nor filtering nor the evidence decision.
- **Gate:** M4 and schema decision; the precedence rule applies immediately to
  every derivation.
- **Data source:** `source`, `topic_path` and tags of the inventory memory for
  step 1; `write_origin` solely for step 2; review status in the sidecar
  projection.
- **Acceptance criterion:** No imported memory automatically receives
  `user_asserted`; the import check demonstrably runs before the `write_origin`
  evaluation; `capture-review` lands conservatively on `unknown_legacy` with
  review status `pending`; `confidence` enters no mapping and is no longer
  described in the document as unread.
- **Rollback:** Additive sidecar fields. Without them the system behaves as it
  does today; `imported_unverified` produces no special handling, only the
  refusal of an unsubstantiated classification.
- **Supplemented and restricted by C-055 and C-060, overtaken by C-063.**
  This entry secures the import origin, but still treats a non-imported
  `write_origin: user-directed` as sufficient. Binding is the version in 6.3:
  attestation is not an attribute of a write path, no write path fulfils it —
  none in the future either —, and `user_asserted` arises at all only through
  the confirmed review. The review status is now called `not_scheduled` instead
  of `not_required`, and confirmation runs through a separate provenance
  override contract instead of through 14.4 Class B.

### C-050 – Contradiction, time axes and the remaining states delimited

- **Passage:** 6.3 time axes, staged contradiction procedure, delimitation of
  `valid_to` against role and accessibility, plus the new subsection “Five
  separate states”; gate row updated to match in 18.5.
- **Type:** architectural decision.
- **Evidence:** The formulation “A contradiction therefore sets `retracted_at`”
  was too strong. It would have derived an automatic truth decision from a mere
  conflict detection and would thereby have violated the rule from Section 13
  that contradicting edges are explained visibly and not resolved silently.
  Second, `valid_to`, `recorded_at`/`retracted_at`, `valid_until`, `obsolete`
  and soft delete stood side by side without connection, although they resemble
  one another in effect — all five can cause a memory to stop appearing — and
  do not in meaning.
- **Gate:** M4 and schema decision.
- **Data source:** gold cases with open and with resolved contradictions;
  operator logs.
- **Acceptance criterion:** A detected contradiction produces a competing claim
  or a `contradicts` edge and sets no `retracted_at`; the latter is set solely
  by confirmed resolution, accepted correction or confirmed `SUPERSEDE`. No
  automatic equation or migration between the five states; an operation that
  touches several of them declares this in the operator contract.
- **Rollback:** An open contradiction is the initial state. If the resolution is
  withdrawn, `retracted_at` does not apply and both assertions are active again.

### C-051 – Cue ablation as a 2×2 design with stage declaration

- **Passage:** 18.3, cue section recast; 11.4 extended by the stage dependency;
  30 reworded.
- **Type:** measurement problem.
- **Evidence:** The four arms from the previous revision were formulated as a
  list. Read as four variants against a reference arm, the combination arm masks
  the individual arms; read as cells of a factorial design across the two axes
  it does not, but additionally yields the interaction. Second,
  `descriptive_scene` and `associative_horizon` refer to episodes or scenes — an
  object the vault schema only knows from M4 onward. M2 would thus have reported
  on two families it cannot form at all. Third, the deferral in Section 30 read
  like an already taken rejection of the descriptive axis.
- **Gate:** M2 for the item level; M4 for the scene level, provided variant (a)
  is chosen.
- **Data source:** associative and descriptive gold cases under 19; for variant
  (b) additionally a named read-only episode or scene projection with its own
  gold cases.
- **Acceptance criterion:** The report states the main effect per axis and the
  interaction separately and names which of the two variants was run. A finding
  measured at the item level is not transferred to the scene level. No report
  claims, without one of the two variants, to have tested all four families.
- **Rollback:** Ignore the sidecar; retrieval behaves as it does today.
- **Supplemented by C-057.** The design remains valid; the sample-size rule, the
  exploratory labelling and the constancy of the remaining retrieval
  configuration are added in 18.1 and 18.3.

### C-052 – Branch termination and run termination separated, result contract across all surfaces

- **Passage:** 8.5, termination section recast, budget limits split into hard
  and soft limits and extended by the surface contract; 8.4 item 8 updated to
  match; 13.1, closing paragraph on hop labelling; 18.2 and 18.4.
- **Type:** architectural decision.
- **Evidence:** The previous revision let “two consecutive steps without
  evidence gain” end the entire run and additionally assigned this outcome to
  `no_answer`. Both are wrong: an exhausted branch says nothing about the
  remaining open branches, and a run that stops with open branches has precisely
  not shown that the search was exhausted. In this form the rule would have
  produced the same metric distortion that C-047 was meant to prevent. Second,
  the result contract was described only for the Deep Recall tier, not for the
  surfaces through which it is delivered.
- **Gate:** M3.
- **Data source:** branch and convergence telemetry with the number of open
  branches per termination; surface logs from MCP, REST, CLI and Mindspace.
- **Acceptance criterion:** Absent evidence gain closes only the branch.
  `no_answer` occurs solely after deterministic exhaustion of all sub-questions
  and admissible branches. The result object is passed unchanged through MCP,
  REST, CLI and Mindspace; no budget status is converted into `no_answer` by
  error handling or UI handling. The hooks are not a consumer of Tier 2.
- **Rollback:** Switch off Tier 2; Tier 1 and Normal Recall remain untouched.
  The lean projection of the hook response remains unchanged in every case,
  since the hop labelling stays server-internal.
- **Completed by C-056, made precise by C-061.** The contract fixed here
  did not cover the success condition and made terminations not caused by budget
  appear as a budget problem via `limit: "other"`. Binding is the version in 8.5
  with five end conditions and four result values; there `no_answer` means “no
  decision-capable answer” and not “no evidence”.

### C-053 – Preservation rule for the survival invariant, special case `SUPERSEDE`

- **Passage:** 14.4, reachability guarantee extended by the preservation rule,
  new subsection on `SUPERSEDE`; 18.5.
- **Type:** architectural decision.
- **Evidence:** `SPLIT` followed by `MERGE` brings an originating source to
  exactly two provenance hops — the limit is reached, but not exceeded. A single
  further generation exceeds it. A starting value without an enforcement
  mechanism would therefore be without effect in the second consolidation round.
  On the second point: `SUPERSEDE` shifts the truth state and thereby also acts
  on the visibility of the predecessor. Without explicit delimitation it would
  be unclear whether a Class B accessibility decision follows from it — which
  would contradict the separation from C-048.
- **Gate:** M4.
- **Data source:** simulation of the invariant per operation; reachability run
  over the archived inventory after every consolidation step; rollback logs.
- **Acceptance criterion:** `max_provenance_hops` = 2 counts as a starting
  candidate and is confirmed or corrected by the measurement. Before every
  single Class A operation the invariant is simulated; the operation is blocked
  or produces additive provenance shortcuts, which do not replace the original
  chain. No intermediate state of a run violates the invariant. `SUPERSEDE`
  remains Class A, produces no permanent accessibility override, and its
  rollback restores version status and time status as well as current
  visibility.
- **Rollback:** Do not apply proposals. A blocked operation leaves no state
  behind.
- **Completed by C-058 and C-059, made precise by C-062.** The relationship
  between operation and shortcut, the case that cannot be satisfied and the
  sensitivity barrier are added in 14.4; the delimitation of `SUPERSEDE` against
  today's archiving primitive follows from C-059. Survival rate and citation
  rate apply per permission context under C-062.

### C-054 – Ledger and source consistency

- **Passage:** 0.4 ledger rows on C-037 and C-038; the delta entries C-037 and
  C-038 in Section 28; 29.3 row on AgentRunbook; 32; all statements of the next
  free ID.
- **Type:** measurement problem or editorial error.
- **Evidence:** Five inconsistencies from the previous version: C-037 still
  spoke of “exposure correction”, although C-044 corrects the term; C-038 still
  carried the acceptance criterion that C-045 replaced as non-executable; the
  AgentRunbook measurement row in 29.3 named only “Table 2” without a source
  reference and was thus resolvable only indirectly; the summary in 32 relied on
  the `confidence` statement that has since been corrected; and the next free ID
  stood at the old value in three places.
- **Gate:** does not apply — document consistency.
- **Data source:** the document itself.
- **Acceptance criterion:** Every corrected old entry carries, in place, a
  correction reference to the correcting entry, analogous to the already
  existing treatment of C-033 by C-042. Every measurement row in 29.3 is
  resolvable via source, version and locus. The next free ID reads C-055 in all
  places.
- **Rollback:** Purely editorial, without runtime or contractual effect.

---

*From here round 4: the deltas of the concluding correction round.*

### C-055 – Provenance attestation and review contract

- **Passage:** 6.3, step 2 table extended by the attestation condition, new
  subsection “Why `write_origin` alone is not sufficient”; review status block
  extended by `confirmed_provenance_class`, `provenance_review_ref` and the
  provenance override contract, `not_required` renamed to `not_scheduled`; 22;
  24; 26.2.
- **Type:** current-state correction.
- **Evidence:** `write_origin` is exposed in the public MCP tool schema
  (`packages/daemon/src/tool-handlers.ts:1338`), and the save handler passes the
  input through unchanged to `saveMemory`
  (`packages/daemon/src/tool-handlers.ts:857`) — without an audit wrapper. Under
  C-008 a complete mutation audit exists to this day only in the Mac bridge
  path. A `user-directed` set via MCP is therefore an assertion of the caller
  and not proof of a user action. C-049 had secured the import origin but left
  this second gap open: a non-imported save can also set the field freely.
- **Gate:** M4 and schema decision; the attestation rule applies immediately to
  every derivation.
- **Data source:** write path and audit reference of the respective save; review
  decisions with `confirmed_provenance_class` and `provenance_review_ref`.
- **Acceptance criterion:** `user_asserted` arises automatically only with an
  attested write path with a resolvable audit reference; an asserted
  `user-directed` without attestation falls back to `unknown_legacy` with review
  status `pending`. The import check retains absolute precedence. A confirmation
  without `confirmed_provenance_class` and `provenance_review_ref` is without
  effect. The provenance override touches neither floors nor pins nor zones and
  is revocable at any time. `not_scheduled` is read nowhere as a confirmation.
- **Rollback:** Additive sidecar and override fields. Without them the system
  behaves as it does today; the fallback rule tightens solely the derivation and
  changes no write path. As soon as a uniform mutation audit exists, the
  fallback rule does not apply to the then attested paths.
- **Answered by C-063, tightened by C-064 and C-070, corrected by C-065 and
  C-069.** The confirmation reference arises in the Recall surface; a
  confirmation binds to `memory_id` and the hash of the assertion-bearing
  content displayed in the review; `not_scheduled` is no longer an exemption
  from the review, but only the queue position; and the review authorization
  depends neither on `write_origin` nor on the import status.
- **Corrected by C-060.** This entry equates the audited Mac bridge path with an
  attested path and ties the lifting of the fallback rule to the uniform
  mutation audit. Both are too weak: the audit context is supplied by the caller
  and otherwise falls back to `actor: user`. Binding is the version in 6.3 —
  attestation requires a confirmation reference that cannot be self-asserted,
  and no path today fulfils it.

### C-056 – Complete Deep Recall end-state contract

- **Passage:** 8.4 item 8; 8.5, run end conditions extended by condition 0 and
  4, priority rule for simultaneity, result table extended by
  `inconclusive_interrupted`, interface extended by `end_condition` and
  `stop_reason` and `limit: "other"` removed, surface contract updated to match;
  18.4; 24; 26.2; correction references on C-047 and C-052 in 0.4 and 28.
- **Type:** architectural decision.
- **Evidence:** The contract from C-052 covered only the negative outcomes
  completely. The success condition was tacitly presupposed, the case “find and
  limit in the same step” was unregulated, and the catch-all value
  `limit: "other"` introduced in the previous round would have declared any
  arbitrary termination a budget problem — including a user cancellation or a
  shutdown. This would have produced the same confusion that C-052 was meant to
  prevent between `no_answer` and budget termination, only one level deeper.
- **Gate:** M3.
- **Data source:** branch, convergence and budget telemetry with
  `end_condition`, `limit` and `stop_reason`; surface logs from MCP, REST, CLI
  and Mindspace.
- **Acceptance criterion:** Every run ends in exactly one of the five end
  conditions and reports exactly one of the four result values. A find wins
  against a limit reached at the same time, which then remains visible in the
  field `limit`. `inconclusive_budget_exhausted` occurs only with an actually
  reached limit. Transport errors and internal errors appear as errors of the
  interface, never as a result value. No surface merges the two inconclusive
  values.
- **Rollback:** Switch off Tier 2; Tier 1 and Normal Recall remain untouched.
  The contract is additive relative to C-052 — existing consumers that know only
  three values treat `inconclusive_interrupted` like an unknown value and must
  not map it onto `no_answer`.
- **Corrected by C-061.** The `stop_reason` value `controller_defect` introduced
  here made an implementation error into a regular end state. Binding is the
  version in 8.5: a controller defect is a structured interface error with a
  read-only partial state.

### C-057 – Statistically executable 2×2 cue experiment

- **Passage:** 18.1 M0 extended by the power rule and minimum N rule as well as
  separate gold case sets; 18.3 extended by “Statistical executability” and
  “Constant environment”; 24.
- **Type:** measurement problem.
- **Evidence:** C-051 introduced the factorial design, but no sample-size rule.
  The interaction is the weakest quantity of the design and requires the largest
  N; without a minimum N fixed in advance an interaction finding could not be
  distinguished from noise — and would nevertheless decide a live approval.
  Second, it was not regulated whether the cue experiment is crossed with the
  remaining M2 arms; an unplanned complete crossing multiplies the cells and
  makes every interaction statement worthless.
- **Gate:** M0 fixes it, M2 evaluates it.
- **Data source:** the descriptive and associative case sets stated separately
  in 19; versioned power assumption and minimum N per cell.
- **Acceptance criterion:** The minimum N per cell is available in versioned
  form before the evaluation, separately for main effects and interaction. If it
  is not reached for the interaction, the interaction is labelled as exploratory
  and carries neither a gate nor a live approval. The remaining retrieval
  configuration is constant across all four cells; a crossing with other M2 arms
  takes place only under a pre-registered design.
- **Rollback:** Pure experimental planning without product effect.
- **Supplemented by C-066, corrected by C-072 and C-074.** The sample-size rule
  and constancy rule of this entry apply to the 2×2 cue axis experiment. For the
  generation path the two designs from 18.3 are binding; with Design A the
  minimum N per condition applies, and an interaction is not evaluated there.

### C-058 – Atomic survival invariant and a non-deadlockable way out

- **Passage:** 14.4, preservation rule extended from five to seven points, new
  blocks “If none of this takes effect” and “No loops”; 18.5; 24.
- **Type:** architectural decision.
- **Evidence:** C-053 left open the relationship between operation and shortcut.
  A shortcut added separately afterwards would be an autonomous graph mutation
  and would violate the approval obligation from 13 and 14.4; an operation
  without its shortcut would leave behind a partial state that violates the
  invariant. Second, the case in which neither operation nor shortcut is
  admissible was unregulated — there either a permanently blocked consolidation
  run or an automatic repetition loop threatened. Third, the sensitivity barrier
  was missing: a shortcut that establishes reachability by linking a private
  source into a less protected area would violate Section 23.
- **Gate:** M4.
- **Data source:** simulation log per operation; rejection and blocking log per
  structure; sensitivity check per shortcut.
- **Acceptance criterion:** Shortcut or visible intermediate node are part of
  the same atomic proposal; no automatic subsequent `LINK`; no partial state
  after termination; no shortcut across a sensitivity boundary; no repetition of
  the same blocked operation within one run; a change to
  `max_provenance_hops` takes place only as a separate, measured proposal.
- **Rollback:** Do not apply proposals. A blocked proposal leaves no state
  behind, and the run continues past the skipped structure.
- **Made more precise by C-062.** The barrier named here, “until the underlying
  memories or `max_provenance_hops` have changed”, was too imprecise; binding is
  the structural fingerprint from 14.4. Likewise, survival rate and citation
  rate apply per permission context.

### C-059 – `SUPERSEDE`, `obsolete` and trash decoupled

- **Passage:** 14.4, `SUPERSEDE` section extended by delimitation, migration
  rule and a five-part rollback; 18.5; 21.4; 22; 24.
- **Type:** architectural decision with current-state correction.
- **Evidence:** Today's archiving primitive does far more than a marking:
  `archiveMemoryHandler` moves the file with `moveToTrash` into the vault trash
  (`packages/daemon/src/tool-handlers.ts:928`), removes it from the living index
  via `forgetFile` (`:929`) and stamps the trash copy best-effort with
  `obsolete: true` and `superseded_by` (`:934`). Normal Recall filters
  `obsolete` out completely anyway (`packages/core/src/search.ts:746`). A
  `SUPERSEDE` that reused this primitive would not make the predecessor
  historical, but unfindable — and would break the citability of old versions
  promised in 15 and 26.2.
- **Gate:** M4; the Historical index is a precondition of live activation.
- **Data source:** resolution samples by ID, version and citation against the
  Historical/Deep Recall index; rollback logs with all five restored quantities.
- **Acceptance criterion:** `SUPERSEDE` works solely via claim status and
  version status, moves nothing into the trash and removes nothing from the
  index. Every superseded predecessor is resolvable via the Historical index by
  ID, version and citation. If `obsolete` is set on an interim basis, the
  historical loader explicitly reads it in, while Normal Recall continues to
  exclude it. A rollback restores version status, time status, storage location,
  indexability and visibility.
- **Rollback:** Without a Historical index, `SUPERSEDE` does not go live; the
  existing archiving primitive remains unchanged and retains its present
  meaning — according to its documentation in the code, the closing primitive of
  intake adoption (`packages/daemon/src/tool-handlers.ts:899`).

---

*From here round 5: the concluding delta fix.*
### C-060 – Attestation is more than a mutation audit

- **Passage:** 6.3, mapping step 2 table, attestation definition completely
  recast as the subsection “A mutation audit is not the same as an
  attestation”, class table; 18.5 gates; 22; 24.
- **Type:** current-state correction.
- **Evidence:** C-055 had classified the audited Mac bridge path as attested.
  The code does not support that: the audit context is read there from the
  call parameters and, if the caller does not supply one, defaults to
  `{ actor: "user" }` — `packages/daemon/src/bridge.ts:322` and
  `:325`, identically at two further places (`:350`, `:379`). The only
  substantive check applies to the value `assistant`, which forces a
  justification (`packages/core/src/audit-save.ts:49`); the assertion
  `actor: "user"` demands nothing at all. An audit therefore substantiates the
  mutation, not the user action.
- **Gate:** M4 and schema decision; the rule applies immediately to every
  derivation.
- **Data source:** confirmation reference `user_action_ref` or
  `confirmation_ref` of the respective save; provenance reviews.
- **Acceptance criterion:** `user_asserted` arises automatically only with a
  confirmation reference that was produced server-side or by a trusted UI
  adapter, cannot be asserted by the saving caller, points to a concrete user
  action and remains resolvable. A complete mutation audit alone is not
  sufficient. A directly passed `provenance_class: user_asserted` is subject
  to the same rule. If the Mac client is to count as an attestor, the trust
  boundary is named and substantiated by a user action reference separate from
  the save call.
- **Rollback:** pure derivation rule; no write path is changed. The confirmed
  provenance review remains the open route to `user_asserted`.
- **Answered by C-063.** This entry leaves open whether a write path can attest
  in future, and names the Mac client as a possible attestor. Binding is the
  version in 6.3: the confirmation reference arises solely in the Recall
  surface, no write path becomes an attestor, and a uniform mutation audit does
  not cancel the fallback rule.

### C-061 – A controller defect is not a result, `no_answer` is not a prohibition on evidence

- **Passage:** 8.4 item 8; 8.5, end condition 4 narrowed to external
  interruptions,
  `controller_defect` removed from the result table and from `stop_reason`, new
  error contract `DeepRecallDefect`, `no_answer` delimitation extended by
  partial coverage, result object extended by `unresolved_subquestions` and
  `coverage`, surface contract brought into line; 18.4 metrics and gates; 24;
  26.2.
- **Type:** architectural decision.
- **Evidence:** C-056 introduced `controller_defect` as a `stop_reason` and
  thereby made an implementation fault a regular end state — it would have
  entered the result statistics and produced the same metric distortion that
  C-047 and C-052 had set out against. Second, the `no_answer` definition
  claimed “there is demonstrably no robust evidence”. That is stronger than
  what an exhausted run can show: it shows that no decision-capable answer came
  about — partial evidence may be present and has so far been silently
  discarded.
- **Gate:** M3.
- **Data source:** telemetry with a separate defect rate, coverage distribution
  of the `no_answer` cases and `unresolved_subquestions` per run.
- **Acceptance criterion:** no controller defect appears as a result value or
  `stop_reason`; it is signalled as a structured error with a read-only partial
  state and is not counted into the result statistics.
  `inconclusive_interrupted` remains restricted to `user_cancelled`, `shutdown`
  and `permission_revoked`. `no_answer` is never reported as “no evidence
  present” as long as `coverage` is greater than zero or `evidence` is not
  empty.
- **Rollback:** switch off Tier 2. The error contract is additive: consumers
  that do not know it see an interface error instead of a result — which
  matches the intended semantics.

### C-062 – Permission-related survival guarantee, stable repetition lock

- **Passage:** 14.4, rate definition extended by permission, scope and
  sensitivity context, block “No loops” switched to a structural fingerprint;
  18.5.
- **Type:** architectural decision.
- **Evidence:** C-048 introduced survival rate and citation rate as global
  quantities (measurement block in 14.4); C-053 and C-058 adopted them
  unchanged. A global rate is either wrong — it counts private sources in the
  denominator of a caller for whom they do not exist — or dangerous, because it
  invites establishing reachability via a permission-crossing shortcut. That is
  exactly what C-058 item 6 already forbids, without the rate reflecting it.
  Second, the repetition lock introduced by C-058 was tied to “changed
  memories” without saying which change counts: a moved
  timestamp or a recomputed `stale_status` would have released the same blocked
  proposal again every night.
- **Gate:** M4.
- **Data source:** reachability run per permission, scope and sensitivity
  context; fingerprint log per blocked proposal.
- **Acceptance criterion:** both rates reach 100% within every permitted
  context; no source stands in the denominator of a context in which it must
  not be visible; if no safe path exists, the source or an intermediate node
  remains visible within its own protected context, without a
  permission-crossing shortcut. The lock responds solely to the structural
  fingerprint and not to cache, telemetry, `stale_status` or timestamp changes.
- **Rollback:** pure measurement and locking rule without product impact;
  without it the global rate of the previous version applies, which, however,
  does not correctly reflect the privacy precedence from 23.
- **Made precise by C-067.** The acceptance criterion formulated here makes the
  structural fingerprint the sole condition. It is necessary but not
  sufficient; binding is the return rule from 14.4.

---

*From here on round 6: the implementation of the product-owner decisions taken
on 25 July 2026.*

### C-063 – The confirmation reference arises in the Recall surface

- **Passage:** 6.3, new subsection “Where the confirmation reference arises”
  with the assignment of the four answer options to four provenance classes;
  opening sentence of the attestation definition; 18.5 gates; 31 decision 5.
- **Type:** product-owner decision.
- **Evidence:** C-060 had established that no write path produces a
  confirmation reference, and explicitly left open, as a product decision,
  where one is to arise. It is decided: the reference arises at the visible
  review of a memory, not in the save.
- **Gate:** M4 and schema decision for the persistent fields; the rule itself
  applies immediately.
- **Data source:** review decisions with `confirmed_provenance_class` and
  `provenance_review_ref`.
- **Acceptance criterion:** `user_asserted` arises solely via a confirmed
  review. No save path produces the class automatically — not even after the
  introduction of a uniform mutation audit. The four answer options of the
  surface map to `user_asserted`, `agent_observed`, confirmed `unknown_legacy`
  and `approved_rule`.
- **Rollback:** without the surface, the inventory stays on the derived
  classes; that is today's state and no loss. A granted confirmation is
  revocable at any time (provenance override contract, 6.3).
- **Corrected by C-068 and C-069.** The assignment of the four answer options
  named here collapses observation, derivation and conjecture into
  `agent_observed`; binding is the progressive selection from 6.3.
  Furthermore, neither import status nor `write_origin` restricts review
  authorization — every memory of the inventory is eligible for confirmation.

### C-064 – One confirmation applies to exactly one memory

- **Passage:** 6.3, review contract extended by the three binding properties;
  18.5 gates; 24; 31 preliminary note.
- **Type:** product-owner directive, adopted as a security requirement.
- **Evidence:** the review contract so far demanded only a “resolvable decision
  and audit reference”. That did not exclude a consent for memory A taking
  effect on memory B, or a confirmation outliving a later rewording of the same
  memory. Both would hollow out the protective effect of `user_asserted`
  without anyone noticing.
- **Gate:** M4 and schema decision.
- **Data source:** confirmation references and content states of the confirmed
  memories.
- **Acceptance criterion:** every confirmation reference is bound to the
  identity and content state of exactly one memory, is not reusable and lapses
  on a change of content; the affected memory then falls back to the derived
  class with review status `pending`.
- **Rollback:** additive fields; without them the derived state applies. A
  lapsed reference causes no damage, only renewed need for review.
- **Operationalized by C-070.** “Content state” is not delimited here; binding
  is the binding to `memory_id` and the hash of the assertion-bearing content
  as displayed in the review, whereby retrieval, presentation and operational
  metadata do not trigger a lapse.

### C-065 – Complete inventory review in four priority stages

- **Passage:** 6.3, `not_scheduled` newly defined, new subsection “The entire
  inventory is reviewed” with the stage table; 18.5 gates; 22; 24; Section 25,
  item 6; 26.2; 31 decision 5.
- **Type:** product-owner decision.
- **Evidence:** the previous version exempted `agent-session` and a missing
  `write_origin` from the review — on the grounds that a case-by-case review
  would yield nothing without new information. That was an assumption about the
  benefit, not about feasibility, and it left the greater part of the inventory
  permanently unclarified. The decision reverses that.
- **Gate:** none — the review is read-only sidecar work in the sense of C-018
  and is tied to no measurement gate.
- **Data source:** the vault inventory itself; for the prioritization of the
  second stage, the existing usage sidecar with `surfaced`, `loaded`,
  `acted_on` and timestamps (see C-071).
- **Acceptance criterion:** no memory remains permanently unreviewed. At the
  end, each carries either a clarified class or a confirmed `unknown_legacy`
  with review status `confirmed`. `not_scheduled` appears solely as a queue
  position and never as a result.
- **Rollback:** the review changes no memory contents and can be interrupted at
  any time; an unreviewed memory remains fully findable and usable.
- **Made precise by C-071, corrected by C-076, made executable by
  C-078.** The data source for review stage 2 is the existing usage sidecar; no
  new telemetry is to be built, and missing history means `unknown`, not zero.
  It does not, however, automatically make a memory a stage 2 memory — there
  the structural impact decides, according to the pre-versioned criterion from
  6.3.

### C-066 – Section 31 becomes a decision record

- **Passage:** 31 completely recast; 18.1 extended by the registration of the
  generation path; 18.3 extended by the generation path as a pre-registered
  factor; 19.1 extended by the decided benchmark type.
- **Type:** product-owner decision.
- **Evidence:** Section 31 listed four decisions as a template with the
  explicit status “none of these four decisions has been taken”. All four are
  decided, and the provenance question left open in C-060 is added as a fifth;
  the section therefore describes an outdated state. Two decisions entail
  substantive consequences that cannot stand in the section itself: the choice
  of benchmark type belongs in 19.1, and the review of the cue generation path
  touches the experimental design from C-057.
- **Gate:** M0 fixes the registration of the generation path and M2 evaluates
  it; V1.x for the benchmark; M3 for Deep Recall Tier 2; M4 for the joint
  schema decision.
- **Data source:** per decision, the one named in 31.
- **Acceptance criterion:** the generation path is tested as a separate,
  pre-registered factor with its own cell structure and its own minimum N, and
  is not crossed with the 2×2 of the cue axes in an unplanned way. Exactly one
  external benchmark is adapted, namely an action-oriented one outside the
  V1.0 contract. Tier 2 of Deep Recall is built only after the Tier 1
  measurement. Time axes and origin are migrated together after M4; the
  origin review begins immediately, read-only.
- **Rollback:** a decision is not withdrawn but replaced by a new one with its
  own C-ID. The record character of the section is preserved.
- **Corrected by C-072.** The registration of a “separate factor, but no
  additional arm” demanded here describes no evaluable experimental design.
  Binding are the two designs from 18.3.

### C-067 – Resubmission rule for rejected proposals

- **Passage:** 14.4, block “No loops” extended by the sufficiency condition;
  24; 31 preliminary note.
- **Type:** product-owner directive, adopted as a quality requirement.
- **Evidence:** C-062 ties resubmission to a changed structural fingerprint.
  That is necessary but not sufficient: a proposal that differs only in a
  marginal quantity has a different fingerprint and would nevertheless be the
  same rejected proposal for the user. From a product perspective, what counts
  is not the data change, but whether the proposal is substantively a different
  and better one.
- **Gate:** M4.
- **Data source:** rejection log per structure; comparison of proposal and
  predecessor.
- **Acceptance criterion:** the same rejected proposal does not return. A
  substantively different, improved proposal may appear. A changed fingerprint
  alone is not sufficient; in case of doubt the resubmission is omitted.
- **Rollback:** the conservative fallback is the omission of the resubmission —
  a missed proposal instead of a recurring one.
- **Operationalized by C-073.** “Substantively a different one” is not a
  testable quantity here; binding are the semantic proposal hash and the five
  material quantities from 14.4.

---

*From here on round 7: the counter-review of the decision implementation.*

### C-068 – Observation, derivation and conjecture remain separate

- **Passage:** 6.3, table of the surface selection switched to a progressive
  main selection with a follow-up question and extended by the answer for
  imported content; 7.2 terminological clarification; 18.5 gates; 24; 26.2; 31
  decision 5.
- **Type:** current-state correction.
- **Evidence:** C-063 mapped the answer “The agent observed or derived that”
  entirely to `agent_observed`. The class table in 6.3, however, lists
  `agent_observed`, `derived` and `hypothesis` as three different epistemic
  states — an observed event, an inference from other memories and a statement
  without sufficient evidence. The consolidation would have levelled the
  distinction at precisely the one point at which a human can make it;
  `derived` and `hypothesis` would have remained permanently empty classes.
- **Gate:** M4 and schema decision for the persistent fields; the rule applies
  immediately to the design of the review.
- **Data source:** review decisions with `confirmed_provenance_class`.
- **Acceptance criterion:** on the selection “From the agent or system”, the
  surface asks whether it was directly observed, derived or conjectured; the
  three answers lead to `agent_observed`, `derived` and `hypothesis`. No
  consolidation into one class. The follow-up question is neither pre-selected
  nor skippable.
- **Rollback:** without the follow-up question, the class remains
  `unknown_legacy` with review status `pending` — the state before the review.
  A wrong unification would be worse than no answer.

### C-069 – The entire inventory is eligible for review and confirmation

- **Passage:** 6.3, derivation sentence after the mapping step tables replaced,
  review status removed from the mapping step 2 derivation, paragraph on the
  suggested value added in the section “Where the confirmation reference
  arises”; 18.5 gates; 24; correction references at C-055 in 0.4 and 28.
- **Type:** current-state correction.
- **Evidence:** after C-063 had been incorporated, the sentence remained that a
  non-imported save with `write_origin: user-directed` is “the only
  constellation that comes into consideration at all for a later confirmation”.
  That contradicts C-065 directly: if the entire inventory is reviewed, review
  authorization cannot depend on import status or `write_origin`. The wording
  would have excluded three quarters of the inventory from confirmation in
  practice and thereby hollowed out the decision.
- **Gate:** M4 and schema decision; the rule applies immediately.
- **Data source:** review queue across the entire inventory.
- **Acceptance criterion:** no memory is excluded from the review. Import
  status and `write_origin` determine solely the derived starting class and the
  suggested value of the surface; every answer remains selectable in every
  case, including “Yes, that came from me”.
- **Rollback:** none needed — the rule removes a restriction that was never
  intended.
- **Tightened by C-077.** The suggested value introduced here was allowed to
  “pre-select” the choice. Binding is the version in 6.3: the suggestion is
  displayed and justified, but no answer is pre-selected; a click on Next over
  a default produces no `confirmed`.

### C-070 – Confirmation bound to memory ID and content hash

- **Passage:** 6.3, the three binding properties made precise and extended by
  the delimitation table; 18.5 gates; 24.
- **Type:** architectural decision.
- **Evidence:** C-064 bound the confirmation to “identity and content state”
  without saying what belongs to the content state. Without that delimitation,
  the rule would have become unusable in one of two directions: if every field
  counts, every confirmation expires within hours, because a single recall hit
  already moves the usage signals. If too little counts, an alien statement can
  be slipped under an old consent.
- **Gate:** M4 and schema decision.
- **Data source:** the content displayed in the review and its hash.
- **Acceptance criterion:** the confirmation reference binds to `memory_id` and
  a hash of the assertion-bearing content displayed in the review — title,
  summary, body and the confirmed statement. Tags, `topic_path`, `recall_when`,
  derived cues, folders, timestamps, heat, reach and usage signals do not
  belong to it and trigger no lapse. A change of the body makes the
  confirmation lapse, even with an unchanged title.
- **Rollback:** additive fields; without them the derived class applies. A
  lapsed reference creates a need for review, not damage.

### C-071 – The usage telemetry for review stage 2 already exists

- **Passage:** 6.3, new paragraph “Data source for review stage 2” after the stage
  table, together with the history-independent second criterion; 24; C-065 data
  source field.
- **Type:** current-state correction.
- **Evidence:** the prioritization of the second review stage by usage
  frequency was carried as an open point, because per-memory telemetry seemed
  to be missing. It exists: the usage sidecar under `.bastra/usage/` keeps, per
  memory ID, `surfaced`, `loaded` and `acted_on` as well as the timestamps of
  the respective last event; a heat computation and a reach computation are
  available, and the sink is connected in the daemon. No new telemetry is to be
  built.
- **Gate:** none — the source exists and is read, not created.
- **Data source:** the usage sidecar.
- **Acceptance criterion:** review stage 2 names the usage sidecar as its
  source. A memory without history counts as `unknown` and not as `0`; such
  memories are carried separately and not sorted to the end of the stage. No
  document claims that new telemetry is required for stage 2.
- **Rollback:** if the source fails, the history-independent criterion from 6.3
  decides for all memories — the structural impact according to the
  pre-versioned standard from C-078; if the graph snapshot fails as well, they
  fall into stage 4. The review remains complete in both cases, only its
  prioritization becomes coarser.
- **Corrected by C-076.** Missing history does not automatically lead to
  stage 2, and floor or pin status are unfit as a second criterion — floors
  are stage 1, and an independent pin source does not exist at HEAD.
  Binding is the stage assignment from 6.3.

### C-072 – Two permitted designs for the cue generation experiment

- **Passage:** 18.1 work and gate list; 18.3, section on the generation path
  completely recast and paragraph “Constant environment” conditioned on the
  registered design; 24; 31, decision 1, stipulation.
- **Type:** measurement problem.
- **Evidence:** C-066 carried the generation path as a “separate,
  pre-registered factor” and at the same time stated that it is “not an
  additional arm in the 2×2”. That is not an experimental design but its
  avoidance: a factor that is neither crossed nor run separately has no defined
  cell structure, and the wording left open how it is to be evaluated at all.
- **Gate:** M0 registers, M2 evaluates.
- **Data source:** the same gold cases as the cue experiment; for Design A,
  paired across both generation paths.
- **Acceptance criterion:** before the run it is registered which of the two
  designs is run — paired comparison with the cue axes held fixed, or a fully
  crossed 2×2×2 with its own, larger minimum N per cell. Adding the generation
  path as an additional arm after the fact is not permitted.
- **Rollback:** the experiment does not take place; the decision about the
  generation path remains postponed, which corresponds to today's state.
- **Corrected by C-074.** Design A has two conditions instead of four cells,
  requires a selection/holdout split or a registered nested evaluation, and
  permits no statement about the interaction. Binding is the version in 18.3.

### C-073 – Resubmission requires a change of content, not only of the fingerprint

- **Passage:** 14.4, block on the return rule extended by the content
  hash and the five material quantities; 18.5 gates.
- **Type:** architectural decision.
- **Evidence:** C-067 laid down that a changed fingerprint is not sufficient,
  without saying what must additionally hold. “Substantively a different one”
  was therefore itself not a testable quantity: every implementation would have
  drawn the line somewhere else, and in case of doubt the fingerprint would have
  decided — that is, precisely what C-067 wanted to exclude.
- **Gate:** M4.
- **Data source:** rejection log per structure with structural fingerprint and
  semantic proposal hash.
- **Acceptance criterion:** a resubmission presupposes a changed fingerprint
  **and** a changed semantic proposal hash **and** at least one named material
  change — to the target state, source version, edge set, reason code of the
  justification on the basis of new evidence, or a resolved protection
  conflict. With an unchanged content hash
  the proposal remains suppressed, independently of the fingerprint. If none of
  the five quantities can be named, the proposal counts as the same one.
- **Rollback:** the conservative fallback is the omission of the resubmission.
- **Made contradiction-free by C-075, canonicalized by C-079.** The “hash of
  the normalized proposal content” named here covered only the change of state,
  while evidence, justification and protection conflict resolution counted as a
  material change — a material change could therefore have left the hash
  untouched. Binding are the scope and the canonical form from 14.4: reason code
  instead of prose, semantic content version instead of `updated`.

---

*From here on round 8: the closing correction round.*
### C-074 – Design A has two conditions, not four cells

- **Passage:** 18.3, Design A and B recast, paragraph “Statistical
  feasibility” extended by Design A, paragraph “Constant environment” switched
  from cells to conditions and delimited in its scope; 18.1
  work and gate list; 24; 31 decision 1 stipulation; ledger row C-072
  and delta blocks C-057 and C-072.
- **Type:** measurement problem.
- **Evidence:** C-072 described Design A as a comparison “with the cue axes
  held fixed” and at the same time left the talk of four cells in place. The two
  together do not work: if the axes are held fixed, the 2×2 no longer
  exists, and exactly two conditions remain — agent cues against batch cues.
  Secondly, any separation between the selection of the configuration to be held
  fixed and the subsequent comparison was missing; if both are done on the same
  cases, the comparison is contaminated by the selection. Thirdly, the
  wording suggested that Design A too could say something about interactions
  — only a crossed design can do that.
- **Gate:** M0 registers, M2 evaluates.
- **Data source:** separate selection split and independent holdout,
  or a pre-registered nested evaluation scheme.
- **Acceptance criterion:** Design A is conducted as a two-condition comparison,
  with a pre-registered selection/holdout separation or nesting. Its
  result applies only to the configuration held fixed; an interaction claim
  is not asserted. Only Design B carries eight cells and may evaluate
  interactions.
- **Rollback:** Without a registered design the experiment does not take place; the
  decision about the generation path remains deferred.

### C-075 – The semantic proposal hash also covers evidence and justification

- **Passage:** 14.4, hash definition extended by six components and
  supplemented with the exclusion of pure time, cache, telemetry and projection
  changes; 18.5 gates; C-073 data source and acceptance criterion.
- **Type:** architectural decision.
- **Evidence:** C-073 defined the hash as the “hash of the normalized
  proposal content — that is, of the proposed state change itself, not
  of its surroundings” and at the same time counted justification on the basis of new
  evidence and a resolved protection conflict among the material changes. That is
  self-contradictory: a material change to the justification would have left the hash
  untouched, so that condition 2 and condition 3 excluded one another —
  a resubmission would have been impossible for two of the five variables.
- **Gate:** M4.
- **Data source:** rejection log per structure with fingerprint and
  semantic proposal hash.
- **Acceptance criterion:** The semantic proposal hash covers at least
  operator type, normalized target change, source IDs and versions, affected
  edges, evidence and justification state, and the protection conflict resolution; the
  canonical form is governed by C-079. A
  resubmission requires a changed fingerprint, a changed hash and a
  named material change. Pure time, cache, telemetry and
  projection changes move neither the fingerprint nor the hash.
- **Rollback:** The conservative fallback remains that the
  resubmission does not take place.
- **Canonicalized by C-079.** This entry names the components of the
  hash, but not their form. Binding is the canonical structure from
  14.4: reason code instead of prose, semantic content version instead of `updated`,
  sorted sets and a hash schema version.

### C-076 – `unknown` does not automatically lead to stage 2

- **Passage:** 6.3, stage table switched to membership criteria and extended by
  the completeness statement, paragraph on missing history
  recast; 24; C-071 rollback and correction reference; ledger rows C-065 and
  C-071.
- **Type:** current-state correction.
- **Evidence:** C-071 pulled all memories with unknown history into stage 2 and
  offered as a secondary criterion “floor or pin status and linking degree”.
  Both are untenable. Missing history is no statement about usage — it
  justifies no promotion, only a different assignment rule.
  Floors are already covered by stage 1; reusing them in stage 2
  would be a double assignment. And a pin source independent of the floor
  does not exist at HEAD: the Curator input sets `pinned` hard to `false`
  (`packages/daemon/src/curator-run.ts:108`), and in the session hook “pinned” is
  only the display name of the floor block
  (`packages/daemon/src/session-hook.ts:36` and `:174`).
- **Gate:** none — the assignment is read-only sidecar work.
- **Data source:** usage sidecar for the substantiated usage; graph structure for the
  structural impact.
- **Acceptance criterion:** Stage 2 comprises memories with substantiated high usage
  as well as memories with unknown history and demonstrably high structural impact —
  high linking degree or cross-cluster connector position.
  Imported memories remain
  stage 3, the remaining unknown inventory stage 4. No criterion falls back on
  floor or pin status. The four stages are complete and
  non-overlapping, and their criteria are distinguished from the ordering within
  a stage.
- **Rollback:** If the structural evaluation fails, memories with unknown history
  fall to stage 4; the review remains complete.
- **Made executable by C-078, semantically made precise by C-080.**
  “Demonstrably high structural impact” was not defined here and thus lay at the
  discretion of the implementation. Binding is the criterion versioned in advance
  from 6.3; “connector position” there denotes solely
  cross-cluster adjacency.

### C-077 – No pre-selected provenance answer

- **Passage:** 6.3, paragraph on the system suggestion recast, reference to a
  pre-selected follow-up question removed; 18.5 gates; 24; 31 decision 5;
  correction references on C-068 and C-069 as well as ledger row C-069.
- **Type:** product-owner directive.
- **Evidence:** C-069 permitted the derived initial class to be
  “pre-selected” as a suggested value. A pre-selected choice makes the
  confirmation click into clicking away a system conjecture — and thereby cancels exactly
  the property for whose sake the attestation under C-063 was tied to
  a user action in the first place. A default that one confirms substantiates no
  authorship.
- **Gate:** M4; the rule applies immediately to the design of the review.
- **Data source:** review log with the distinction between active
  selection and mere click-through.
- **Acceptance criterion:** No answer is marked when the review is opened.
  `confirmed` arises only after an active selection; a continue or
  confirm click without a prior selection creates no confirmation reference. The
  progressive follow-up question remains mandatory and is likewise not pre-selected.
  The system suggestion may be displayed and given reasons.
- **Rollback:** Without a selection the review status remains `pending` — the state
  before the review. An unanswered review is better than an
  apparently answered one.

---

*From here round 9: the final delta fix.*

### C-078 – The structural criterion is fixed in advance in versioned form

- **Passage:** 6.3, stage table row 2 made precise, new subsection “The
  structural criterion is fixed in advance” including the evaluation order
  1 → 3 → 2 → 4; 18.5 gates; 24; ledger rows C-076 and C-078;
  correction references on the delta entries C-065, C-071 and C-076.
- **Type:** measurement problem.
- **Evidence:** C-076 moved the boundary between review stage 2 and 4 to
  “demonstrably high structural impact” without saying what that means. The boundary
  thereby lay at the discretion of the implementation: two runs over the same inventory
  would have produced different queues, and a threshold readjusted during the run
  would have produced an ordering that nobody
  can reconstruct. The two admissible components are already
  present: the graph projection carries the edge count per node and marks
  a node in the field `bridge` as soon as it has neighbours in at least two
  different foreign clusters.
- **Gate:** none — the assignment is read-only sidecar work in the sense of
  C-018. The proof obligation lies with the queue manifest.
- **Data source:** a frozen graph snapshot; the read-only
  inventory distribution for deriving the starting value.
- **Acceptance criterion:** The criterion is present in versioned form in the queue or
  run manifest before the queue is built and consists
  solely of cross-cluster connector position and
  degree threshold or degree quantile. The numeric value is fixed before the assignment
  and does not move during the run. Every memory with unknown history outside
  stages 1 and 3 is thereby deterministically assigned to exactly stage 2 or stage 4;
  the evaluation runs in the order 1 → 3 → 2 → 4. If the
  snapshot is missing or breaks, the memory falls to stage 4.
- **Rollback:** Without a snapshot the entire inventory with unknown history falls to
  stage 4; the review remains complete, only its prioritization becomes coarser.
- **Semantically made precise by C-080, made subject to proof by C-081.**
  The bridge property named here is cross-cluster adjacency
  and no proof of a separating effect. “Frozen” additionally requires the
  proof in the queue or run artifact; a timestamp alone is
  not sufficient.

### C-079 – The semantic proposal hash is formed canonically

- **Passage:** 14.4, hash definition replaced by the canonical structure,
  material variable “justification” switched to the reason code,
  exclusion list extended by rephrasings; 18.5 gates; 24; C-075
  acceptance criterion; ledger row C-075.
- **Type:** architectural decision.
- **Evidence:** C-075 listed **what** belongs in the hash, but not **in
  what form**. “Evidence and justification state” left open whether the justification
  enters as prose — in that case a mere rephrasing would have moved the hash and
  enabled a resubmission, that is, produced exactly the loop that
  C-067 and C-073 set out against. Equally open was whether “source version” means the field
  `updated`; since a save without a change in content moves `updated`,
  that too would have triggered a resubmission.
- **Gate:** M4.
- **Data source:** the canonical structure itself, versioned via the
  hash schema version; the separate justification log.
- **Acceptance criterion:** The hash is formed from a versioned canonical
  structure comprising the operator enum, the normalized target-state diff,
  sorted source IDs with semantic content versions, sorted
  edge tuples, sorted evidence references, the reason code, the structured
  protection conflict status including its resolution, and the schema version. It
  contains no free explanatory text. The human-readable justification is
  logged separately and does not move the hash. A rephrasing, a
  timestamp update or a metadata change enables no
  resubmission.
- **Rollback:** The conservative fallback remains that the
  resubmission does not take place. A change to the hash schema version does not invalidate existing
  rejection logs, but carries them forward under their old version.
- **Supplemented by C-081.** The reason code presupposes a finite, versioned
  vocabulary. A code outside the applicable vocabulary version triggers
  no resubmission until the vocabulary has been extended.

---

*From here round 10: the concluding delta fix.*

### C-080 – `bridge` substantiates cross-cluster adjacency, no separating effect

- **Passage:** 6.3, component of the structural criterion recast and extended by the
  delimiting paragraph “What the field `bridge` substantiates — and what it does not”,
  stage 3 precedence sentence and history-independent criterion brought into line; 18.5
  gates; 24; 32 current-state claims; ledger row C-078; correction references on the
  delta entries C-076 and C-078.
- **Type:** current-state correction.
- **Evidence:** C-078 took the bridge property into the structural criterion with the
  reading “connects at least two otherwise separated clusters”. The
  code does not bear this out: `bridgeFor` collects the clusters of a node's neighbours,
  removes its own and returns the remaining list as soon as two
  different foreign clusters are left
  (`packages/core/src/graph.ts:302`–`:305`). Whether these clusters **without** the
  node would be unconnected is never checked — for that the connectedness
  of the graph without it would have to be computed. A node whose foreign clusters are connected via
  a dozen other paths thus carries the same field as a
  genuine articulation node. The field is a usable structural feature,
  but not what its name suggests.
- **Gate:** none — pure semantic correction to a read-only evaluation; the
  criterion itself remains unchanged.
- **Data source:** the graph projection itself. `bridge` is the sorted
  list of foreign neighbouring clusters, not a proof of separation.
- **Acceptance criterion:** No document and no manifest claims that `bridge`
  substantiates a graph-theoretic bridge or an articulation node. Where the
  property enters the structural criterion, it is named as
  **cross-cluster adjacency** — neighbours in at least two
  different foreign clusters. A genuine articulation or
  bridge analysis is explicitly marked as additional graph work not performed
  today.
- **Rollback:** None needed — the correction withdraws a claim without
  changing the criterion. Were the property to fall away entirely, the
  degree threshold would remain as the sole component; the assignment would become coarser,
  but not wrong.

### C-081 – The frozen snapshot is substantiated in the artifact

- **Passage:** 6.3, new subsection “The snapshot must substantiate the assignment
  made at the time”; 14.4, paragraph “Unknown reason code”; 18.5 gates; 24;
  ledger rows C-078 and C-079; correction references on the delta entries C-078
  and C-079.
- **Type:** architectural decision.
- **Evidence:** C-078 demanded a “frozen graph snapshot” without
  saying by what the freezing is recognizable. A timestamp says **when**
  the computation was made, not **on what**; the live graph moves with every save,
  every new link and every cluster recomputation. An assignment that
  only points to a point in time can no longer be recomputed weeks later
  — whoever tries computes on a different graph and obtains a different
  result. Secondly, C-078 left open what a restart in the middle of a run does;
  without a rule every restart would have produced a different queue and made the
  progress incomparable. Thirdly, C-079 presupposes a reason code
  from a fixed vocabulary without governing the case that a code
  is missing from it.
- **Gate:** none. Assignment and proof artifact are sidecar/run artifacts
  permitted at any time under C-018 and C-025. If the artifact cannot be
  written, the run does not start.
- **Data source:** the queue or run artifact; alternatively the
  content-addressed persisted snapshot including a reference from the manifest.
- **Acceptance criterion:** The artifact stores at least the graph and
  projection schema including version, the snapshot hash, the creation time,
  the applied structural criterion including absolute threshold or quantile,
  and, for each assigned memory with unknown history, its ID, `degree`, foreign
  clusters or `bridge` value and the resulting review stage;
  a permitted alternative is the complete, content-addressed persisted
  snapshot with a reference. In both variants the assignment made at the time is traceable without
  the live graph that has since changed. During a running
  review neither a recomputation nor a reassignment takes place, and a
  restart continues the same queue with the same assignments. A
  reason code outside the applicable vocabulary version triggers no resubmission.
- **Rollback:** The proof obligation is additive and does not change the assignment rule.
  If the artifact cannot be written, the run is not started
  — a queue that cannot be substantiated is worse than none. For the
  reason code, the conservative fallback remains that the
  resubmission does not take place.
- **Gate corrected by C-082.** The original version placed the
  persistent form of the artifact under the schema decision after M4. That was
  wrong: the artifact touches no memory frontmatter and no vault schema.
  Binding is the gate text above.

---

*From here round 11: the one-sentence delta fix.*

### C-082 – The proof artifact hangs on no measurement gate

- **Passage:** 6.3, paragraph on the sidecar position of the artifact extended by the
  immediate permissibility and the 21.4 delimitation; 18.5 closing remark on gate membership;
  ledger row C-081; gate and correction reference in the delta entry C-081; 32.
- **Type:** current-state correction.
- **Evidence:** The C-081 block recorded that the assignment remains read-only
  sidecar work in the sense of C-018, but in the same breath placed the
  “persistent form of the artifact” under the schema decision after M4. The two
  together are contradictory: the proof obligation is to apply immediately — without
  an artifact the run does not start at all under the same rule —, while M4 falls only
  after several measurement stages. On the gate's reading, the
  inventory review would not have been allowed to run at all until M4, although C-065
  explicitly binds it to no gate and C-066 lets it begin “read-only immediately”.
  The contradiction rests on a confusion: the artifact is an
  operational run artifact in the sidecar projection, no persistent
  schema field. It changes neither memory content nor vault schema; private
  run artifacts are provided for under C-025 in any case.
- **Gate:** none. Assignment and proof artifact are sidecar/run artifacts
  permitted at any time under C-018 and C-025. If the artifact cannot be
  written, the run does not start.
- **Data source:** the artifact itself; the delimitation between sidecar
  projection and persistent memory schema from 21.4.
- **Acceptance criterion:** No gate reference binds the queue or
  run artifact, the graph snapshot or the stage assignment to M4 or to the
  schema decision from 21.4. They may be persisted immediately. 21.4 applies
  solely when snapshot, queue or review fields are to be taken over into the
  memory frontmatter or into the persistent memory schema.
- **Rollback:** None needed — the correction removes a gate binding that was never
  intended and had no protective effect. The proof obligation from C-081
  remains unchanged in force.

---

*From here the contract change of 29 August 2026. It is not a review round: no
verdict is reinterpreted; what changes is the scope of the release contract.*

### C-083 – In V1.0 the presentation experiment owes the design, not the populated run

- **Passage:** 26.1 experiment point rewritten, replaced wording marked as
  such; 26.2 extended by the adequately populated run; 17.4 release
  assignment; ledger row C-024 with a change reference, new ledger row C-083;
  0.4 sign-off block and next free ID; 28 heading, assignment and this entry;
  33.
- **Type:** Contract change.
- **Evidence:** The experiment's registration
  (`packages/eval/registrations/presentation-experiment.json`, #267) measured
  the sample size rather than estimating it. Over 14 days on the single-user
  vault: 3876 hook recall events, but only 80 distinguishable sessions, 16 of
  them with any loaded event at all. Per 17.4 the unit of randomisation is the
  session — the arm-stable assignment clusters all events of one sitting —
  which is why the counter-calculation over surfacings does not hold. With two
  conditions this yields 18 days for 50, 35 days for 100 and 88 days for 50
  outcome-bearing sessions per arm; at base rates around 1% none of these
  counts carries a statement. The structural reason stands above the
  arithmetic: 17.4 presupposes a population, and this vault has one user. Added
  to that are three preconditions that are not questions of sample size — arm A
  has no second hook wording (`band-wording.ts` carries exactly one version per
  case), arm B requires a per-session switchable gate and must await the shadow
  acceptance, because half-armed sessions would contaminate the very
  observation the activation depends on, and the query-class dimension binding
  under 17.4 is not collected today.
- **Gate:** none. The change removes a requirement from the V1.0 contract and
  adds no live effect. Registration, assignment and status report are
  measurement and sidecar work permitted at any time under C-018.
- **Data source:** the registration itself including its
  `underpowered_fallback`; the event logs under `~/.bastra/logs/events-*.jsonl`
  for the window 15–28 August 2026; the assignment function `assignArm` in
  `packages/daemon/src/telemetry-dimensions.ts`.
- **Acceptance criterion:** V1.0 counts as fulfilled on this point when the
  design is registered before every run, the arm assignment is deterministic
  and session-stable, and the evaluation reports an arm below its minimum N as
  not evaluable — with a stated justification and without a null result. No
  report may turn an underpopulated arm into a "no difference found". For V2.0
  the point from 26.2 applies.
- **Rollback:** The change is purely contractual and without effect on code; it
  can be undone by reverting these passages. Should the reason fall away — a
  multi-user population arises, or the unit of randomisation is deliberately
  changed — the requirement returns to 26.1 after a new entry. A change to the
  unit of randomisation would itself be a change to 17.4 and not a
  configuration.

---

*From here the contract addition of 29 August 2026.*

### C-084 – The frontmatter promise from V1.0 on

- **Passage:** 26.1 new promise block; 22 extended by six bullets; ledger row
  C-084; 0.4 sign-off block and next free ID; 28 heading, assignment and this
  entry; 34. Outside this file: `docs/memory-schema.md`, section "Compatibility
  Promise (1.0)".
- **Type:** Contract addition.
- **Evidence:** With 1.0.0 the SemVer beta signal of the leading `0.` falls
  away; from then on every breaking change to the vault format requires a major
  bump. What the format promises was documented in no document until then —
  neither in 26.1 nor in 22 nor in `docs/memory-schema.md`. The content of the
  promise is substantiated in the code: the ten required fields in
  `packages/core/src/schema.ts`, the repair and rescue logic in
  `packages/core/src/frontmatter-rescue.ts`, the dropping of invalid optional
  fields and the clamping of over-long `summary` values in the parser, and the
  fixed field list of the overwrite path in `packages/core/src/save.ts`. The
  same review produced a clarification for section 22: `provenance_class`,
  `unknown_legacy` and `imported_unverified` do not exist in the V1 schema; 22
  read as though they were present stock.
- **Gate:** none. The addition documents existing behaviour and changes neither
  code nor schema.
- **Data source:** the code itself; `docs/memory-schema.md` as the user-facing
  documentation of the same promise.
- **Acceptance criterion:** The three versions — 26.1, 22 and
  `docs/memory-schema.md` — say the same thing, and none of them promises
  anything the code does not hold. In particular: no promise that a
  format-version field will never be introduced, only that a 1.x reader
  requires none; no promise about preserving unknown keys across an
  `overwrite`; and no claim that the shape of `recall` output is unbound — it
  falls under its own API contract.
- **Rollback:** Purely documentary and without effect on code. Should the
  loader leniency turn out to be an attack surface, the narrowly drawn security
  exception from 26.1 applies — four conditions, among them a visible error
  instead of a silent drop; it replaces no major bump for anything else.

---

*From here the contract addition C-085 of 29 August 2026.*

### C-085 – The decision route of the shadow sign-off requires spread

- **Passage:** 18.2 shadow sign-off extended by the spread condition and the
  counting reading; ledger row C-022 with an extension reference, new ledger
  row C-085; 0.4 sign-off block and next free ID; 28 heading, assignment and
  this entry; 35.
- **Type:** Contract addition.
- **Evidence:** The threshold from C-022 names a quantity and not a
  distribution. In the real record across 91 log days the `evidence_decision`
  events carry 2052 memory decisions — **2040 of them from a single session**,
  with the three remaining sessions contributing twelve between them. The
  500-decision threshold would thus be met fourfold without a second working
  situation ever having been observed. That contradicts the purpose of shadow
  operation recorded in 18.2, namely to observe the predicate against the
  distribution of real usage: one sitting carries one vault state, one project,
  one way of working and one daily rhythm. To calibrate the number: in the same
  14-day window 132 different sessions carry `hook_call` events, on average
  about nine per day and on individual days up to 27. Twenty different sessions
  are therefore reachable on this usage without a single working day reliably
  supplying them alone — and the share limit catches the observed case where
  many sessions count but one of them contributes practically everything.
- **Gate:** none. The addition tightens a sign-off condition and activates
  nothing live; it can apply immediately.
- **Data source:** the event logs under `~/.bastra/logs/events-*.jsonl`
  (`kind: "evidence_decision"`, field `session_id`); the evaluation in
  `packages/daemon/scripts/stats.ts`.
- **Acceptance criterion:** The decision route counts as fulfilled when the
  counting decisions come from at least 20 different sessions and no single
  session supplies more than 25 % of them. The 14-day route remains without an
  additional condition. Counting is per memory decision, not per hook call; a
  session counts as soon as it carries one counting decision.
- **Rollback:** Purely contractual, without effect on code. Should the session
  count prove too low on a larger population, or the share limit too strict,
  both are carried forward in versioned form after the M0 baseline run together
  with the other numeric quantities; until then the values fixed here apply.
  Whoever does not reach the faster route loses nothing — the 14-day route
  stays open.

---

*From here the refinement C-086 of 29 August 2026.*

### C-086 – Both routes to `required` are drawn more narrowly

- **Passage:** 10.3 extended by the refined required conditions, the
  measurement basis and the reservations, replaced readings marked as such;
  ledger row C-002 with a refinement reference, new ledger row C-086; 0.4
  sign-off block and next free ID; 28 heading, assignment and this entry; 36.
- **Type:** Refinement.
- **Evidence:** Both routes to `required` were too wide in the quality of their
  justification, not in the quality of the hit. The two-of-three count treated
  any trigger coverage above zero as one of the two required signals — a single
  coincidentally shared term sufficed. The hard identifier anchor additionally
  searched the body; an identifier in a code block or a file listing thereby
  justified an obligation on its own, although a find in prose substantiates
  only that the memory mentions the topic, not that it is responsible. 10.2
  already separates authorized retrieval text from content; the predicate did
  not. Both narrowings were quantified **before** the change (runs
  `2026-08-29-0e1dd5659433` and `2026-08-29-f5d803104893`, ten gold files, 679
  cases, six variants on the same served pool, so that a difference between two
  rows is the rule and nothing else): the anti-query gate falls from 0.5000 to
  0.1250, while Recall@3 gated (0.4743 against 0.4777 ungated), Recall@3 on
  identifier queries (0.7429) and false abstention (0.0000) stay identical in
  all six variants. The coverage threshold is length-neutral (58–65 % drop in
  obligations across all query lengths); the examined alternative "at least two
  matched terms" is not: it bites with only a 12 % drop at eleven or more
  terms, that is, weakest precisely where a single shared term is the weakest
  evidence. 361 obligations rested on the body anchor; 49 fall away, 312 remain
  obligations on the two-of-three count.
- **Gate:** none for the shadow measurement; live activation of the evidence
  decision stays bound to 18.2 and the configuration flag from C-023.
- **Data source:** the two private run artifacts under `~/.bastra/eval-runs/`
  including their `NOTES.md`; the verification run `2026-08-29-50163fb9a0d0`
  after implementation; the predicate in
  `packages/core/src/evidence-decision.ts`.
- **Acceptance criterion:** The partial-coverage signal counts only from a
  coverage of 0.5; full coverage remains a hard anchor. The identifier anchor
  reads title, `recall_when` and frontmatter and not the body. Both are to be
  reported in the component-gate report per 18.2. Implemented in `b30486e`
  (`MIN_TRIGGER_COVERAGE = 0.5`, body removed from the identifier haystack) and
  checked against the prediction: the run `2026-08-29-50163fb9a0d0` reproduces
  the variant computation across all 679 cases with zero deviations.
- **Rollback:** Both thresholds are constants of the predicate and can be
  reverted without data migration. Two reservations remain explicitly open and
  are not carried as settled: the 5 % threshold of the anti-query gate cannot
  be represented on eight probes — only 0 %, 12.5 %, 25 % and so on are
  reachable — which is why the probe set is being extended to about twenty
  anti-queries; and the cost of the lost obligations (both narrowings together
  remove 71 % of all obligations) is not visible to the gold set but only to
  the shadow telemetry after the deploy. Should it show that removed
  obligations were missed in sittings, the coverage threshold is the first
  quantity to be turned back.

## 29. Source and claim matrix

All data were collected on **25 July 2026** by retrieving the respective primary
source. This version replaces the terse matrix of the previous revision, which
contained neither versions nor locations nor measurement configurations and was
therefore not verifiable.

### 29.1 Citation rule

Every third-party statement that appears in this document as a justification
must be substantiable by:

1. the canonical source location — DOI where assigned, otherwise the stable
   arXiv `abs`, Anthology or repository URL;
2. the version — arXiv version number with date, commit SHA with date, or
   proceedings page numbers; for undated vendor pages the note “not
   versioned” together with any `dateModified`;
3. the exact location — table, section, page or README section;
4. the retrieval date;
5. for measurements additionally reader, judge, top-k and context budget.

If one of these details is missing in the source, it is **reported as missing**
and is not supplied, estimated or carried over from another source. The list of
gaps in 29.3 is part of the substantiation, not a defect in it.

### 29.2 List of sources

| Short name | Canonical location | Version / status |
|---|---|---|
| Hindsight (Demo) | `doi:10.18653/v1/2026.acl-demo.27` | ACL 2026 System Demonstrations, pp. 275–285 |
| Hindsight (full version) | `doi:10.48550/arXiv.2512.12818` | v1, 2025-12-14, 28 pages |
| Hindsight (code) | `github.com/vectorize-io/hindsight` | `ed120a2`, 2026-07-24, MIT |
| Zep/Graphiti (paper) | `doi:10.48550/arXiv.2501.13956` | v1, 2025-01-20, 12 pages |
| Zep (vendor figures) | `getzep.com/research` | not versioned, `dateModified` 2026-05-28 |
| Graphiti (code) | `github.com/getzep/graphiti` | `3bb2d0b`, 2026-07-23 |
| Mem0 (benchmarks) | `github.com/mem0ai/memory-benchmarks` | `4b61c5d`, 2026-05-13, Apache 2.0 |
| Mem0 (SDK) | `github.com/mem0ai/mem0` | `d653b63`, 2026-07-24 |
| Mem0 (paper) | `doi:10.48550/arXiv.2504.19413` | v1, 2025-04-28 |
| BEAM | `doi:10.48550/arXiv.2510.27246` | v2, 2026-02-21; ICLR 2026 |
| T-Mem | `arxiv.org/abs/2606.15405` | v1, 2026-06-13; no DOI, no code |
| All-Mem (paper) | `arxiv.org/abs/2603.19595` | v2, 2026-06-15; no DOI |
| All-Mem (code) | `github.com/LvCan926/All-Mem` | `f5d6912`, 2026-06-15, MIT |
| MAGMA (paper) | `doi:10.18653/v1/2026.acl-long.1709` | ACL 2026 Long Papers, pp. 36848–36865 |
| MAGMA (code) | `github.com/FredJiang0324/MAGMA` | `467cb70`, 2026-07-10 |
| Mem2ActBench | `doi:10.18653/v1/2026.acl-long.370` | ACL 2026 Long Papers, pp. 8173–8190 |
| Graph counter-analysis | `doi:10.18653/v1/2026.acl-long.1232` | ACL 2026 Long Papers, pp. 26758–26782 |
| Graph counter-analysis (code) | `github.com/AvatarMemory/UnifiedMem` | `3df9428`, 2026-04-18 |
| LongMemEval-V2 (paper) | `arxiv.org/abs/2605.12493` | v1, 2026-05-12; no DOI |
| LongMemEval-V2 (code) | `github.com/xiaowu0162/LongMemEval-V2` | `6f020ac`, 2026-07-19 |
| Ori Mnemos | `github.com/aayoawoyemi/Ori-Mnemos` | `8afc915`, 2026-07-22, v0.6.0, Apache 2.0 |

Not reachable as of the retrieval date: the code and data repository promised in
the Mem2ActBench paper (`github.com/Cantaloupe-M/Mem2ActBench`, HTTP 404). The
Mem0 graph documentation page cited in the research briefing at
`/open-source/features/graph-memory` no longer exists; the function was removed
from the open-source SDK, not merely the page moved.

### 29.3 Measurements and their setup

| Measurement | Location | Reader | Judge | Top-k | Context budget |
|---|---|---|---|---|---|
| Hindsight 91.4% LongMemEval / 89.6% LoCoMo (Gemini-3); 83.6 / 83.2 (20B) | Demo, Table 2, p. 280 | differs per row; Gemini-3 Pro only as the final answer generator, memory stack GPT-OSS-120b | **not stated** in the demo; the full version names GPT-OSS-120b, temperature 0.0, binary | **not stated** | **not stated**; at this point the full version contains an unfilled placeholder |
| Hindsight recall under 200 ms at 10,000 units | Demo, §4.2, p. 279 | does not apply, backbone call explicitly excluded | does not apply | 20–50 candidates before reranking | **not stated** |
| Zep LoCoMo 94.7% / LongMemEval 90.2% | `getzep.com/research`, metric blocks | gpt-5.4, reasoning medium | gpt-5.4 with chain-of-thought — **reader and judge identical** | 20 edges, 10 nodes, 10 episodes, 5 thread summaries, 5 observations, then cross-encoder | no prescribed budget; measured median of 5,760 or, respectively, 4,408 tokens |
| Mem0 LongMemEval 94.8% | benchmarks README, platform table | **not stated**; CLI default gpt-4o | **not stated**; CLI default gpt-4o | Top 50 | **not stated** |
| Mem0 LoCoMo 92.5% | benchmarks README, platform table | **not stated** | **not stated** | Top 200 | **not stated** |
| Mem0 BEAM 10M, pass rate 50.5% | benchmarks README, BEAM table | **not stated** | **not stated** | Top 200 | **not stated**; "10M" is the conversation length, not the context window |
| MAGMA LoCoMo 0.700 | Table 1, p. 36854 | gpt-4o-mini, temperature 0.0, for all systems | gpt-4o-mini, temperature 0.0, continuous scale | vector top-k 20, RRF-k 60, max. depth 5, max. 200 nodes | no configured budget; measured 3.37k tokens/query |
| MAGMA lexical F1/BLEU-1 | Table 9, Appendix F, p. 36864 | gpt-4o-mini | no LLM judge, token-level F1 and BLEU-1 | as in Table 1 | **not stated** |
| Mem2ActBench A-Mem 35.93 / LTMemory 35.32 | Table 3, p. 8179 | Qwen2.5-7B/32B/72B-Instruct, temperature 0.0 | no LLM judge; argument F1, BLEU-1, tool accuracy | **not stated** | **not stated** |
| Mem2ActBench oracle 53.8 / best passive retriever 30.7 | Table 4, p. 8179 | **not stated** | no LLM judge | hybrid at k=5 as the best passive result; oracle without k | **not stated** |
| Graph counter-analysis DescGraph against flat | Table 4, p. 26763 | LLaMA-3.1-8B for extraction and answer | no judge, pure retrieval metrics R@5/R@10 | top-k of the initial activation **not quantified** | **not stated** |
| Graph counter-analysis end-to-end | Tables 7 and 8, p. 26765 | two configurations: LLaMA-3.1-8B with Contriever, plus gpt-4o-mini for extraction and GPT-4o for the answer | gpt-4o for LongMemEval, gpt-4o-mini for HaluMem | top-5 or, respectively, top-20 values in the answer context | **not stated** |
| AgentRunbook-C 72.5% / -R 57.8% with latencies | LongMemEval-V2, `arXiv:2605.12493` v1, Table 2 | Qwen3.5-9B throughout; controller Qwen3.5-9B or GPT-5.4-mini | deterministic evaluators plus GPT-5.2 for gotchas and abstention | **not stated** | 200k tokens truncation |
| T-Mem LoCoMo | §4.3 | GPT-4o-mini | GPT-4o-mini | operating point (15, 5, 15, 10) | **not stated** |
| T-Mem LoCoMo-Plus | §4.3 | GPT-4o | Gemini-2.5-Flash — **a different pair than on LoCoMo** | operating point (15, 5, 15, 10) | **not stated** |
| All-Mem LoCoMo / LongMemEval-s | §4.3, Table 2 | GPT-4o-mini, temperature 0 | GPT-4o | k=10 anchors, L=40 expansion, K=16 final | no token cap; "matched budget" without a number |
| Ori HotpotQA, n=50 | `bench/README.md` | **not stated** | **not stated** | k=5 implicit via R@5 | **not stated** |
| Ori LoCoMo, n=695 | `bench/README.md` | GPT-4.1-mini | **not stated** | **not stated** | **not stated** |
| BEAM main measurement | §4, Table 1, p. 8 | GPT-4.1-nano, Gemini-2.0-flash, Qwen2.5-32B-AWQ, Llama-4-Maverick-fp8 | nugget-based LLM judge, **model not named** | RAG baseline top 5; ablation over 5/10/15/20 | 1M for the proprietary models, 128k or 32k for Qwen |

Of nineteen measurements reviewed, **three** state all four configuration
parameters. The context budget is missing most often, the judge most
consequentially. That is the substantive reason for the rule from C-029 not to
use any third-party figure as a gate: most of them could not be reproduced at all.

### 29.4 Substantiating locations for the adopted statements

| Statement in the document | Source | Location | Verdict |
|---|---|---|---|
| Four epistemic networks with confidence on opinions | Hindsight Demo | §3.1, pp. 276–277 | confirmed |
| Two timestamps per unit: event interval and time of learning | Hindsight Demo | §3.3, pp. 277–278 | confirmed; the source itself does not use the word “bi-temporal” |
| Four-channel recall with RRF, cross-encoder and token budget | Hindsight Demo | §3.2, p. 277; §4.1, p. 278 | confirmed |
| Observation consolidation with proof count and freshness trend | Hindsight Demo | §3.3, p. 278; Appendix D, p. 285 | confirmed |
| Reproduction by institutions that supply co-authors | Hindsight Demo | Acknowledgements, p. 282; affiliations p. 275 | confirmed |
| Bi-temporal model with four edge timestamps | Zep/Graphiti | §2.1, p. 2; §2.2.3, p. 3 | confirmed; names `t'_created`, `t'_expired`, `t_valid`, `t_invalid` |
| Invalidation instead of deletion | Zep/Graphiti + README | §2.2.3, p. 3; README “Temporal Fact Management” | confirmed |
| Four orthogonal views with intent router | MAGMA | §3.2, p. 36851; §3.3, p. 36851 | confirmed |
| Hyperparameters optimized on the reported benchmark | MAGMA | Appendix B.1, p. 36860 | confirmed |
| On lexical metrics MAGMA does not lead | MAGMA | Table 9, Appendix F, p. 36864 | confirmed |
| Unsuitable graph construction degrades results | Graph counter-analysis | §5, p. 26766 | confirmed |
| Well-constructed entity descriptions beat flat indexes | Graph counter-analysis | §4.4, Table 4, p. 26763 | confirmed |
| Findings do not generalize to non-dialogue tasks | Graph counter-analysis | Limitations, p. 26766 | confirmed |
| Retrieval is the dominant bottleneck | Mem2ActBench | §5.1, p. 8178 | confirmed |
| Application remains a problem even with perfect retrieval | Mem2ActBench | Abstract p. 8173; §5.2, §5.4, §5.5, pp. 8178–8180 | confirmed |
| Two axes, four trigger families, write-time generation | T-Mem | Figure 1, §1; §3.2.3; §3.1 | confirmed |
| Triggers remain separate from the evidence path | T-Mem | §3.1 | confirmed |
| Limited visible surface with hop-limited expansion | All-Mem | §3.1, §3.2 | confirmed |
| Split/Merge/Update preserve immutable evidence | All-Mem | §3.3 | confirmed |
| Structured multi-pool approach against agentic search | LongMemEval-V2 | Table 2 | confirmed: 58.6% at 26.9 s and 57.0% at 25.8 s for the RAG variant; 74.9% at 108.3 s and 70.1% at 139.9 s for the agentic one |
| Gravity and hub damping | Ori Mnemos | README, Retrieval Intelligence section | confirmed; gravity halves at zero query-term overlap, hub penalizes from P90 degree upward |
| Exposure handling is a normalization | Ori Mnemos | `RETRIEVAL_INTELLIGENCE_SPEC.md`, Exposure-aware correction section | confirmed: division by the exposure count to the power of 0.5 — not a propensity correction |
| Recursive exploration with a termination criterion | Ori Mnemos | `docs/recursive-explore.md` | **corrected**: a criterion is documented, with depth limit 2 and note limit 30 |
| BEAM measures ten capabilities up to ten million tokens | BEAM | §2.2; Table 1, p. 8 | confirmed; 100 conversations, 2,000 questions |

### 29.5 Corrected miscitations

The following statements appeared in this form in the previous revision or in
the underlying research briefing, and they are wrong. They are corrected in this
version:

1. **BEAM sub-scores as percentages.** 0.163, 0.325 and 0.400 are averages on a
   0-to-1 scale, not percentages. The corresponding pass rates are 20%, 25% and
   40%. The phrasing “16.3% Temporal Reasoning” was a misreading.
2. **Mixed retrieval depths.** 94.8% on LongMemEval is a Top-50 figure, 92.5%
   on LoCoMo a Top-200 figure. Placed side by side they suggest a comparability
   that does not exist.
3. **Ori without a convergence criterion.** The previous revision recorded that
   a termination criterion for the recursive exploration could not be found. It
   is documented, only not in the README or the specification, but in
   `docs/recursive-explore.md`. The preliminary review had not read that file.
4. **“Multi-Session Reasoning” as a BEAM capability.** The benchmark lists ten
   capabilities; this one is not among them. The closest in substance is called
   “Multi-Hop Reasoning”. The label comes from the results README of the vendor
   doing the measuring.
5. **The Mem0 paper as substantiation for the current figures.** The 2025 paper
   covers only the older LoCoMo evaluation. Anyone substantiating 94.8% or 92.5%
   with it is citing incorrectly.

Items 1 and 3 are this document line's own errors, not the briefing's. Neither
would have arisen under the requirements from 29.1 — which supplies the
justification for C-040.

## 30. Explicitly rejected or deferred

Rejected because it contradicts Bastra's principles:

- an opinion or belief network with its own self-reinforcing confidence;
- five additional epistemic memory types alongside the existing types;
- four separate physical graph databases;
- cross-encoder reranking on every hook call;
- live learning from Q-values or co-occurrence without exposure and hub control;
- automatic execution of consolidation operators without approval;
- adopting a third-party system's score as a Bastra gate or target value.

Deferred because the benefit for today's scope is not substantiated:

- the **persistence** of descriptive item and scene cues as separate fields,
  for as long as the ablation from 18.3 has not substantiated their own
  contribution and the separate representation decision under 11.2 has not been
  taken. The conjecture that title, tags, `topic_path` and summary already cover
  this axis is the reason for the deferral — not for dispensing with the check.
  The descriptive axis remains a full factor of the 2×2 design;
- multimodal episodes and screen experience;
- a multi-agent consolidation apparatus;
- full runs of large-scale trajectory benchmarks;
- HNSW, unchanged from C-007 and M5;
- a learning stage controller that skips or suspends pipeline steps, before the
  minimum N is reached.

## 31. Product-owner decisions taken

**Status: decided on 25 July 2026.** The five decisions bind implementation; the
affected passages have been brought in line in this version. Two items that were
previously prepared as decisions are not product-owner questions but quality
requirements: binding a confirmation to exactly one memory (C-064, elaborated in
6.3) and the return rule for rejected proposals (C-067, elaborated in 14.4).
They stand there as a fixed requirement and no longer as a choice.

### Decision 1 – Generation of the derived cues

**Decided: postponed, with a stipulation.** Whether derived cues are generated by
the writing agent at save time or by a reproducible offline batch is not settled
now. Instead, the generation path is examined under controlled conditions in M2.

**Stipulation:** Under 18.3 there are exactly two permitted experimental designs —
Design A, the paired agent-against-batch comparison with **two conditions** at a
fixed cue configuration and with a separate selection split and holdout, or with
a pre-registered nested evaluation (recommended), or Design B, a fully crossed
2×2×2 with eight cells and its own, larger minimum N. Which design is run is to
be registered before the run. Only Design B permits statements about
interactions. Adding it afterwards as an additional arm is not permitted,
because the main effects would then be confounded with the generation path.

**Impact:** none on release or schema. The decision is taken after the M2 run on
the basis of measurement rather than conjecture.

### Decision 2 – External benchmark

**Decided: yes, exactly one, action-oriented, in V1.x.** Bastra adapts one
external benchmark that measures whether an earlier statement correctly feeds
into a later action — not whether it can be reproduced.

**Rationale:** An action-oriented test is closer to Bastra's product scope than
a conversation-oriented one; the smaller basis for comparison is accepted
deliberately. Exactly one, because every further adapter creates ongoing
maintenance effort for harness, model and judge versions.

**Impact:** Not a V1.0 release blocker; the assignment is given in 19.1. Every
run meets the metadata obligation from C-040. The proof gap named in 2.3 is
thereby closed in principle, not completely.

### Decision 3 – Deep Recall Tier 2

**Decided: only after the Tier 1 measurement.** The agentic Tier 2 will be built
only if it shows a benefit of its own over Tier 1, measured against cost and
latency.

**Rationale:** The third-party measurement suggests a considerable jump in cost
for the agent loop, whose benefit for a vault of this size is unsubstantiated.
Tier 1 could already deliver on the Deep Recall promise from Section 8.

**Impact:** none. Tier 1 is usable independently; the ordering is already given
in Section 25, item 7 and in the M3 gate in 18.4.

### Decision 4 – Time and origin schema

**Decided: review origin read-only now, persistent schema fields jointly after
M4.** The provenance review under 6.3 starts immediately in the sidecar
projection. The persistent fields for time axes and origin are migrated later in
**one** joint schema decision after M4 preparation.

**Rationale:** The origin question is a correctness question and is pressing;
the time model is a question of expressiveness and can wait. Both field groups
have the same consumers, which makes one joint migration cheaper than two.

**Impact:** The review runs without any vault change. `valid_until` is not
touched in any variant — see C-041. Backward compatibility under 22 remains
preserved.

### Decision 5 – Confirmation of user origin

**Decided: by explicit confirmation on the Recall surface; the entire inventory
is reviewed.** A memory reaches the class `user_asserted` solely by the user
selecting “Yes, that came from me” in the review. The save path never creates it
automatically — not even after a uniform mutation audit is introduced.

**Rationale:** Today an agent can itself assert that a statement came from the
user, and the code does not check this (see C-060). The only place where a human
is demonstrably involved is the visible review. This makes the fallback rule not
a stopgap but the normal case.

**Impact:** The surface maps origin progressively onto seven provenance classes
and keeps observation, derivation and conjecture separate (6.3). Eligibility for
review applies to the entire inventory; import status and `write_origin` supply
only a displayed, not pre-selected system suggestion. `not_scheduled` now
denotes queue position only; the earlier exemption for `agent-session` and
missing `write_origin` does not apply. The review runs in four priority stages
and ends, per memory, with origin clarified or explicitly confirmed as unclear.

### What remains open

These decisions fix the product behaviour, not its implementation. What remains
open in particular: the concrete form of the confirmation reference on the
surface; the ordering within the four review stages; the choice of the concrete
action-oriented benchmark; and all numeric quantities that only come into
existence after the M0 baseline run.

## 32. Handover after the one-sentence delta fix

**What was changed.** This version adds the delta C-082. Solely the following
line ranges were changed. The line numbers refer to the German original, which
is where the change was made; they do not map onto this translation.

| Passage | Lines | Delta |
|---|---|---|
| Title and preamble | 1–31 | C-082, promotion |
| 0.4 correction reference and ledger row C-081, new row C-082 | 183–184 | C-082 |
| 0.4 sign-off block and next free ID | 296–302 | C-082 |
| 6.3 immediate admissibility of the proof artifact and 21.4 delimitation | 1251–1256 | C-082 |
| 18.5 closing remark on gate assignment | 3418–3423 | C-082 |
| 28 heading and number of rounds | 4063–4065 | C-082 |
| 28 round label 10 unbracketed, round 11 assignment table | 4182–4196 | C-082 |
| 28 gate in delta entry C-081 | 5720–5722 | C-082 |
| 28 correction reference on C-081 and delta block C-082 | 5742–5782 | C-082 |
| 32 this section | from 6058 | — |

All other passages are untouched. Product code and the twelve versions under
`docs/architecture-history/` were not changed. Title and preamble additionally
carry the promotion of the German original to the canonical path: it no longer
bears a revision number and names itself as the governing version.

**What the delta fixes.** C-081 had introduced the proof obligation for the
frozen graph snapshot and recorded in the same block that the assignment remains
read-only sidecar work in the sense of C-018 — but placed the persistent form of
the artifact under the schema decision after M4. That is contradictory: without
the artifact the run does not start at all under that same rule, while M4 falls
only after several measurement stages. Read as a gate, the inventory review would
therefore not have been allowed to run until M4, even though C-065 binds it to no
gate and C-066 explicitly lets it start immediately, read-only.

The contradiction rested on a confusion of the sidecar projection with the
persistent memory schema. The queue or run artifact touches neither memory
frontmatter nor the vault schema; private run artifacts are provided for under
C-025 in any case. The binding gate text now reads: none — assignment and proof
artifact are sidecar/run artifacts permitted at any time under C-018 and C-025,
and if the artifact cannot be written, the run does not start. Section 21.4
applies only when snapshot, queue or review fields are to be taken over into the
memory frontmatter or into the persistent memory schema.

**What is to be examined with particular care.**

1. Whether the degree threshold makes more sense as an absolute value or as a
   quantile — the document permits both and leaves the choice to the derivation
   from the inventory distribution.
2. Which of the two proof variants permitted by C-081 is chosen — the individual
   values in the manifest or the content-addressed persisted snapshot. The first
   is more compact, the second also allows a later recomputation with a
   different criterion.
3. Whether the reason code vocabulary is complete enough to represent every
   material change of justification without degenerating into free text — the
   block on an unknown code from C-081 makes a gap harmless, but not
   inconsequential: every missing code suppresses a possibly legitimate
   resubmission.
4. Whether the semantic content version can be derived from the existing schema
   or needs a field of its own — in which case it would fall under the schema
   decision from 21.4. This question is left untouched by C-082: it concerns a
   persistent schema field, not a run artifact.
5. Whether a true articulation analysis is worth the effort. C-080 does not rule
   it out; it only records that it does not exist today. Whether the coarser
   signal is sufficient for the stage assignment will be shown only by the first
   run.

**Still open.** The concrete form of the confirmation reference on the surface;
the ordering within the four review stages; the choice of the concrete
action-oriented benchmark; all numeric quantities after the M0 baseline run, now
including the degree threshold from C-078; `max_provenance_hops` = 2 as the
starting candidate. This English translation carries the same state; the earlier
English version at state C-001–C-028 has moved to the archive. Side finding
without a C-ID:
the daemon README describes expired memories as "(or excluded if expired)"; the
code merely damps them to 20%.

**Next free ID: C-083.** *(Historical state of 26 July 2026. The currently
valid next free ID is at the end of Section 36.)*

## 33. Handover after the contract change C-083

**What was changed.** This version adds the contract change C-083. Solely the
following passages were changed:

| Passage | Delta |
|---|---|
| Preamble: ledger state, genesis, as-of date, next free ID | C-083 |
| 0.4 change reference on C-024, new ledger row C-083 | C-083 |
| 0.4 sign-off block and next free ID | C-083 |
| 17.4 release assignment of the experiment | C-083 |
| 26.1 experiment point rewritten, replaced wording marked | C-083 |
| 26.2 adequately populated run added | C-083 |
| 28 heading, preamble, assignment table, delta entry C-083 | C-083 |
| 32 parenthetical note on the historical ID | C-083 |
| 33 this section | — |

All other passages are untouched. Product code, the experiment's registration
and the versions under `docs/architecture-history/` were not changed.

**What the change effects.** The V1.0 release contract required the experiment
arms to have "reached their minimum N versioned after M0". That requirement is
unfulfillable on today's population, and since the experiment's registration
this is measured rather than presumed: the unit of randomisation is the
session, the vault has one user, and even 50 outcome-bearing sessions per arm
would be some 88 days away. A contract demanding an unreachable number either
blocks the release or invites presenting an underpopulated run as a finding —
both worse than the honest statement.

V1.0 therefore owes three checkable things from now on: the design registered
before every run, the deterministic and session-stable arm assignment, and the
honest status report per 18.1 that reports an underpopulated arm as **not
evaluable** rather than as a null result. The adequately populated run is in
26.2 and remains a precondition of the promotion to V2.0. The replaced wording
stays visible in 26.1; the assignment and minimum-N rule from C-024 applies
unchanged, only its release assignment has moved.

**What to check in particular.**

1. Whether resumption stays tied to a multi-user population or whether the unit
   of randomisation is deliberately changed — per turn instead of per session
   would be a change to 17.4 and requires its own entry, not a configuration.
2. Whether the status report needs its own acceptable output as a contract
   component — today the registration carries the verdict and no report exists
   yet.
3. Whether the three preconditions unrelated to sample size — second hook
   wording, per-session switchable gate, query-class dimension — are gated
   individually in 26.2 or signed off together with the run.

**Still open.** Unchanged the open points from Section 32, now additionally the
second hook wording for arm A as a product and text decision, and the
activation decision that arm B depends on.

**Next free ID: C-084.** *(State of this section. The currently valid next free
ID is at the end of Section 36.)*

## 34. Handover after the contract addition C-084

**What was changed.** This version adds the contract addition C-084. Solely the
following passages were changed:

| Passage | Delta |
|---|---|
| Preamble: ledger state, genesis, as-of date, next free ID | C-084 |
| 0.4 new ledger row C-084 | C-084 |
| 0.4 sign-off block and next free ID | C-084 |
| 22 six bullets on the promise and the status of the V2 fields | C-084 |
| 26.1 promise block | C-084 |
| 28 heading, preamble, assignment table, delta entry C-084 | C-084 |
| 33 note on the ID | C-084 |
| 34 this section | — |

Outside this file, `docs/memory-schema.md` carries the same content as the
section "Compatibility Promise (1.0)". Product code was not changed.

**What the addition effects.** With 1.0.0 the beta signal of the leading `0.`
falls away, and from then on every breaking change to the vault format requires
a major bump. What exactly is promised was documented nowhere. C-084 closes
that gap and promises solely what the code holds: required fields, types, the
meaning of the optional fields — and the loader leniency, because it is the
actual pledge to a hand-maintained vault. Four points are deliberately drawn
narrowly: a 1.x reader requires no format-version field, without thereby ruling
out an optional field later. The shape of `recall` output is bound, but through
the API contract rather than the schema. Unknown keys are tolerated on load and
are not guaranteed to survive an `overwrite`. And the security exception
carries four conditions, among them a visible error instead of a silent drop.

**What to check in particular.**

1. ~~Whether the preservation gap on `overwrite` is to remain or whether the save
   path should pass unknown keys through in future~~ — **decided on 29 August
   2026: the save path passes them through.** On an `overwrite` every key the
   save path does not manage itself is carried over from the existing
   frontmatter unchanged; the managed fields keep their present semantics and
   win any name collision. The contract wording in C-084 stays as it is: the
   gap is closed in the code, not turned into a promise — a key can still be
   lost through paths other than this one, and a guarantee would have to name
   all of them.
2. Whether each application of the security exception should receive a C-ID.
   The text currently requires only the changelog callout.
3. Whether `docs/memory-schema.md`, as user-facing documentation, should also
   reference 26.1 so that the two versions do not drift apart.

**Next free ID: C-085.** *(State of this section. The currently valid next free
ID is at the end of Section 36.)*

## 35. Handover after the contract addition C-085

**What was changed.** This version adds the contract addition C-085. Solely the
following passages were changed:

| Passage | Delta |
|---|---|
| Preamble: ledger state, genesis, as-of date, next free ID | C-085 |
| 0.4 extension reference on C-022, new ledger row C-085 | C-085 |
| 0.4 sign-off block and next free ID | C-085 |
| 18.2 shadow sign-off: spread condition and counting reading | C-085 |
| 28 heading, preamble, assignment table, delta entry C-085 | C-085 |
| 34 note on the ID | C-085 |
| 35 this section | — |

All other passages are untouched. Product code was not changed; the evaluation
in `packages/daemon/scripts/stats.ts` does not yet satisfy the new condition
and has to follow.

**What the addition effects.** The shadow sign-off knew two equivalent routes:
500 logged decisions or 14 calendar days. The first counted only a quantity. In
the real record 2040 of 2052 decisions come from one session — the threshold
would be met fourfold without a second working situation ever having been
observed. That is precisely what shadow operation is meant to prevent. The
decision route therefore now requires at least 20 different sessions and at
most a 25 % share per session. The 14-day route is unchanged: time produces
spread on its own.

The same entry records the counting reading that until now existed only in the
code: counting is per memory decision, not per hook call. A call over eight
candidates yields eight counting decisions — that is how `stats.ts` computes
it, and the phrase "logged hook decisions" in C-022 denotes the same quantity.

**What to check in particular.**

1. Whether 20 sessions and 25 % are confirmed or carried forward as versioned
   numbers after the M0 baseline run. Both values are calibrated from today's
   single-user usage and share its limits.
2. Whether `stats.ts` should report the condition as its own line — today the
   output names only decisions and days, so a threshold reached without spread
   would appear as "REACHED".
3. Whether the same spread requirement should apply to the presentation
   experiment arm from 17.4. There the session is already the unit of
   randomisation, so the question poses itself differently — but it poses
   itself.

**Next free ID: C-086.** *(State of this section. The currently valid next free
ID is at the end of Section 36.)*

## 36. Handover after the refinement C-086

**What was changed.** This version adds the refinement C-086. Solely the
following passages were changed:

| Passage | Delta |
|---|---|
| Preamble: ledger state, genesis, as-of date, next free ID | C-086 |
| 0.4 refinement reference on C-002, new ledger row C-086 | C-086 |
| 0.4 sign-off block and next free ID | C-086 |
| 10.3 required conditions, measurement basis, reservations | C-086 |
| 28 heading, preamble, assignment table, delta entry C-086 | C-086 |
| 35 note on the ID | C-086 |
| 36 this section | — |

All other passages are untouched. The product code now carries the change:
`packages/core/src/evidence-decision.ts` exports `MIN_TRIGGER_COVERAGE = 0.5`
and no longer carries the body in the identifier haystack (commit `b30486e`).
Verified by the run `2026-08-29-50163fb9a0d0`: the changed predicate reproduces
the prediction of the variant computation across all 679 cases without a single
deviation — eight compared fields per case, 5432 values. In the daemon the
change takes effect only after a restart; the shadow observation therefore
starts afresh.

**What the refinement effects.** The product semantics of `required` — a hard
anchor or several independent signals — is unchanged; what is corrected is what
passed as an anchor and what passed as an independent signal. A single shared
term is not independent evidence, and an identifier in prose is not an anchor.
Together the two produced obligations whose justification did not withstand
scrutiny: 361 obligations rested on a find in the body alone.

The measurement is the actual substance of the entry. It ran **before** the
change and across six variants on the same pool, so a difference between two
rows is the rule and not a second run. The result is unusually clear: the
anti-query gate quarters itself, and not one of the three quality figures moves
by a single digit.

**What to check in particular.**

1. Whether the 5 % threshold of the anti-query gate holds after the extension
   to about twenty anti-queries. Before that the question cannot be answered,
   and today's value of 1/8 must not be read as a pass.
2. Whether the shadow telemetry misses obligations after the deploy that now
   fall away. 71 % fewer obligations is a large intervention whose cost this
   gold set structurally cannot see.
3. Whether the 0.5 threshold is confirmed in versioned form after the M0
   baseline run. Today it is justified from the length breakdown, not from a
   calibration.

**Next free ID: C-087.**
