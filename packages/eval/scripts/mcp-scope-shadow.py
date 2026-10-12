#!/usr/bin/env python3
"""#421: read-only MCP scope shadow readout; no private text/ids in output."""
import argparse
import collections
import hashlib
import json
import pathlib
import subprocess
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--logs', required=True, type=pathlib.Path)
parser.add_argument('--start', required=True)
parser.add_argument('--end', required=True)
parser.add_argument('--out', required=True, type=pathlib.Path)
args = parser.parse_args()
if args.out.resolve().is_relative_to(args.logs.resolve()):
    parser.error('output must be outside input logs')
parse_time = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
start, end = parse_time(args.start), parse_time(args.end)
if start.tzinfo is None or end.tzinfo is None or start >= end:
    parser.error('require an increasing timezone-aware half-open interval')
events = []
files = sorted(args.logs.glob('events-*.jsonl'))
if not files:
    parser.error('no event files')
fingerprint = hashlib.sha256()
invalid = 0
excluded_eval = 0
for file in files:
    # Include all calendar files that can contain interval endpoints.
    day = file.stem.removeprefix('events-')
    if not args.start[:10] <= day <= args.end[:10]:
        continue
    raw = file.read_bytes()
    fingerprint.update(file.name.encode() + b'\0' + hashlib.sha256(raw).digest())
    for line in raw.splitlines():
        try:
            event = json.loads(line)
            if not isinstance(event, dict):
                raise ValueError('non-object')
            when = parse_time(event['ts'])
            if when.tzinfo is None:
                raise ValueError('timestamp lacks timezone')
        except (ValueError, KeyError, TypeError, UnicodeDecodeError):
            invalid += 1
            continue
        if not start <= when < end:
            continue
        if event.get('kind') not in ('recall', 'hook_recall') or event.get('dimensions', {}).get('hook_source') != 'mcp':
            continue
        if event.get('origin') in ('eval', 'synthetic'):
            excluded_eval += 1
            continue
        events.append(event)
ids = [e.get('recall_id') for e in events]
with_id = [x for x in ids if isinstance(x, str) and x]
duplicates = len(with_id) - len(set(with_id))
def summarize(xs):
    observed = [e for e in xs if e.get('scope_filter_mode') == 'shadow' and isinstance(e.get('dropped_scope_count'), int) and not isinstance(e.get('dropped_scope_count'), bool)]
    applicable = [e for e in observed if not e.get('scope_filter_skipped')]
    affected = sum(e['dropped_scope_count'] > 0 for e in observed)
    return {'rows': len(xs), 'shadow_rows_with_counter': len(observed), 'applicable_rows': len(applicable),
            'rows_with_potential_drops': affected, 'potential_drops': sum(e['dropped_scope_count'] for e in observed),
            'affected_share_of_observed_rows': affected / len(observed) if observed else None,
            'affected_share_of_applicable_rows': affected / len(applicable) if applicable else None,
            'skip_reasons': dict(collections.Counter(e.get('scope_filter_skipped') or 'none' for e in observed)),
            'modes': dict(collections.Counter(e.get('scope_filter_mode') or 'missing' for e in xs)),
            'clients': dict(collections.Counter(e.get('dimensions', {}).get('client') or 'missing' for e in xs))}
git = lambda *argv: subprocess.check_output(['git', *argv], cwd=pathlib.Path(__file__).parent, text=True).strip()
result = {'measured_at': datetime.now(timezone.utc).isoformat(), 'schema_version': 1, 'issue': 421, 'harness': 'mcp-scope-shadow.py',
          'engine': {'repo_commit': git('rev-parse', 'HEAD'), 'repo_dirty': bool(git('status', '--porcelain'))},
          'code_sha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
          'input_manifest_sha256': fingerprint.hexdigest(), 'window': {'start': args.start, 'end_exclusive': args.end},
          'invalid_rows': invalid, 'excluded_eval_rows': excluded_eval,
          'duplicate_recall_ids': duplicates, 'rows_without_recall_id': len(events) - len(with_id),
          'summary': summarize(events),
          'by_origin': {origin or 'legacy-unclassified': summarize([e for e in events if e.get('origin') == origin]) for origin in sorted(set(e.get('origin') for e in events), key=str)},
          'by_date': {day: summarize([e for e in events if e['ts'][:10] == day]) for day in sorted(set(e['ts'][:10] for e in events))},
          'verdict': 'descriptive shadow readout only; relevance, causal utility and enforce safety not evaluable',
          'limitations': ['unknown client identity', 'no row-level code/configuration version', 'no independent labels for dropped/retained candidates', 'agent and legacy-unclassified traffic are separate, not human observations', 'duplicate ids, if present, require reconciliation before a per-call interpretation'],
          'inputs_modified': False}
args.out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: v for k, v in result.items() if k not in ('by_date', 'by_origin')}, indent=2))
