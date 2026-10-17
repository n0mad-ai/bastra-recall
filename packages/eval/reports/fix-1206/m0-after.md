[eval] vault loaded: 10 memorys

# M0 Recall-Quality Eval

Vault size: **10**  ·  Eval cases: **10**

## Aggregate
- Recall@1: **100.0%** (10/10)
- Recall@3: **100.0%** (10/10)
- MRR:      **1.000**

## What steered retrieval
- recall_when terms matched: **100.0%** (10/10)
- title-only (no recall_when overlap): **0.0%**
- other fields only (tags/body/topic_path): **0.0%**

_Note: recall_when phrases naturally share tokens with the title for many well-written memorys — these counts overlap. The signal we care about is whether recall_when terms are present in matched_terms at all._

## Misses

None. Every memory ranked in top-3 for its own trigger.

## Rank distribution
- rank 1: 10
- rank 2-3: 0
- rank 4-10: 0
- rank miss: 0
