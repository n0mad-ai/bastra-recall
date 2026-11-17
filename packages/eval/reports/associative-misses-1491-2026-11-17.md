# Associative misses in the gold set (#1491), 17 November 2026

Analysis only. Nothing in the ranking was changed for this report; any change it suggests needs its own preregistered measurement.

## Data and runs

- Vault: copy of a real vault taken 2026-11-15, 1,631 notes (fingerprint `a9faad41…`), run from a scratch copy; the live vault was not opened.
- Gold set: the 12 files of `registrations/v1-baseline.json`, minus 7 answerable cases whose ids no longer exist (rule fixed before the run). 577 answerable cases: 137 associative, 440 descriptive. Dataset sha256 `43612e62…`.
- Code: `eba66497` with the release 1.3.0 wave 2 changes laid over it (the #1567 staleness policy, the #1568 reference time 2026-11-15). The "before" column is the same code with the pre-#1567 factors. Run artefacts and hashes: `registrations/staleness-policy-1567.json` (hybrid arms) and `registrations/abstention-1463.json` (BM25 arm, results sha256 `13a7a5b7…`).
- Path: production `recallHybrid` (BM25 + embeddinggemma, RRF), k 10, score floor 30; BM25-only for the comparison column.

## How far associative questions get

| Kind | n | R@3 | R@10 (served) | R@10 before #1567 | R@10 BM25 only |
|---|---:|---:|---:|---:|---:|
| associative | 137 | 7 | 11 | 11 | 5 |
| descriptive | 440 | 246 | 310 | 249 | 278 |

The ageing change adds 61 net served hits for descriptive questions. On the associative questions, the same 11 cases find their expected note in the top ten before and after the change. The remaining 126 misses could be absent from the candidate pool or ranked below the ten served hits.

## Observed characteristics of the 126 misses

Each miss compared with its expected note(s): title, summary, `recall_when`, tags and body, tokenised the way the engine tokenises a query (`tokenizeWithIdentifiers`, words of three or more characters). No word lists.

**Vocabulary.**

| Share of query words found anywhere in the expected note | Misses |
|---|---:|
| none | 7 |
| under a quarter | 60 |
| a quarter or more | 59 |

So in about half of the misses (67) the question and the note hardly share a word: the question describes a situation ("this keeps happening when …"), the note states the rule or fact behind it. Low overlap gives lexical search fewer direct matching terms. The other 59 misses share at least a quarter of their query words with an expected note. This analysis did not measure the document frequencies of those shared terms.

**Missing trigger sentence.** Every expected note of a miss carries `recall_when` triggers. In 84 of 126 misses no query word appears in any of them; in 42 a query word does, without lifting the note into the ten. The triggers were written as topics, while associative questions arrive as situations.

**Language.** The questions of the misses are German in 97 cases and English in 29. Whether a note is written in the other language cannot be measured honestly here: Recall forbids language word lists (INV-LANG-01), and the gold labels do not record a note language. Not measured.

**Embedding off.** Not a cause on this run: every note carried a vector, and the hybrid arm was checked per query. The comparison shows what the vector arm is worth for this kind: without it associative R@10 falls from 11 to 5.

**Origin of the questions.** 115 of the misses come from issue incidents, 11 from second-person phrasings. Expected zone: core 88, orbit 37, outer orbit 1.

## Context from the 15.11.2026 measurement

The candidate-gap diagnosis of 15.11.2026 (local report `kandidaten-diagnose-2026-11-15.md`, not in this repository) found 78 gold cases whose note is in neither search arm even at depth 200, and that more candidates, other weights and several vectors per note did not help. That result establishes a candidate gap for the full gold set. The served top ten above cannot establish how many of the associative misses fall into that category.

## Proposals (each needs a preregistered measurement first)

1. Triggers as situations: guidance for `recall_when` to describe the situation in which a note is needed, not its topic; measured on the associative slice with the triggers of a sample of notes rewritten by hand, no engine change.
2. Learned bridges on the associative slice: the existing query expansion (`expandQuery`, learned bridges) is the mechanism meant for situation → note links; measure its lift on these 137 questions specifically, BM25 and hybrid.
3. A second vector per note built from its triggers rather than its body, measured only on this slice. The 15.11 measurement found several vectors per note without effect overall; it did not look at associative questions alone.
4. Gold-set hygiene: the #1567 review found that several expected notes are dated snapshots whose subject moved on. A gold label that points at an outdated snapshot makes a correct answer (the newer note) count as a miss. Recheck the expected ids of the associative cases before using them as the measuring stick for 1 to 3.

## Limits

- One vault, one gold set; the associative slice is small (137) and descriptive only.
- The overlap measure counts words, not meaning; "shares a quarter of the words" says nothing about whether the shared words are the important ones.
- Ranks beyond the ten served candidates are not in the run artefact; how deep the expected note sits in each arm was measured on 15.11 for all cases together, not per kind.
