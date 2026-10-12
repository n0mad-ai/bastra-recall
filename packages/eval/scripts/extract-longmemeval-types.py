#!/usr/bin/env python3
"""Read-only derivation of aggregate per-type retrieval values from a full run."""
import argparse
import collections
import hashlib
import json
import pathlib

parser = argparse.ArgumentParser()
parser.add_argument('--artifact', required=True, type=pathlib.Path)
parser.add_argument('--out', required=True, type=pathlib.Path)
args = parser.parse_args()
if args.artifact.resolve() == args.out.resolve():
    parser.error('output must differ from source artifact')
raw = args.artifact.read_bytes()
run = json.loads(raw)
rows = run['questions']
if len(rows) != run['n_questions'] or len({r['question_id'] for r in rows}) != len(rows):
    raise ValueError('incomplete or duplicate question rows')
groups = collections.defaultdict(list)
for row in rows:
    groups[row['question_type']].append(row)
result = {}
for kind, subset in sorted(groups.items()):
    arms = {}
    for arm in run['summary']:
        ranks = [next((i + 1 for i, item in enumerate(r['ranked'][arm]) if item in set(r['gold'])), 0) for r in subset]
        counts = {f'r@{k}': sum(0 < rank <= k for rank in ranks) for k in (1, 3, 5, 10, 20)}
        arms[arm] = {'hit_counts': counts,
                     'summary': {**{key: value / len(subset) for key, value in counts.items()},
                                 'mrr': sum(1 / rank if rank else 0 for rank in ranks) / len(subset)}}
    result[kind] = {'n': len(subset), 'arms': arms}
for arm, summary in run['summary'].items():
    for k in (1, 3, 5, 10, 20):
        total = sum(group['arms'][arm]['hit_counts'][f'r@{k}'] for group in result.values())
        if abs(total / len(rows) - summary[f'r@{k}']) > 1e-12:
            raise ValueError('per-type counts do not recover source aggregate')
payload = {'schema_version': 1, 'source_artifact_sha256': hashlib.sha256(raw).hexdigest(),
           'derivation_code_sha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
           'source_engine': run['engine'], 'n_questions': len(rows),
           'rule': 'For each question type and arm, first ranked id in gold determines rank; hit@k iff 0 < rank <= k. Counts/n gives recall_any@k.',
           'by_type_metrics': result}
args.out.write_text(json.dumps(payload, indent=2) + '\n')
print(json.dumps({'n_questions': len(rows), 'hybrid_rank1_hits': sum(g['arms']['hybrid']['hit_counts']['r@1'] for g in result.values()),
                  'by_type_hybrid_rank1': {kind: {'n': group['n'], 'hits': group['arms']['hybrid']['hit_counts']['r@1']} for kind, group in result.items()}}, indent=2))
