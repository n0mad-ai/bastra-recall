#!/usr/bin/env python3
"""#686 exact fixture-scope predicate, read-only; aggregate output only."""
import argparse
import collections
import hashlib
import json
import pathlib
import subprocess
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--logs', type=pathlib.Path, required=True)
parser.add_argument('--out', type=pathlib.Path, required=True)
args = parser.parse_args()
if args.out.resolve().is_relative_to(args.logs.resolve()):
    parser.error('output must be outside the input log directory')
scopes = set('audittest ankertest collision-test gateproj lang-a lang-b lang-c lang-d lean-test proj refile-test selftest test test-544 test-scope testlabel testproj'.split())
files = sorted(args.logs.glob('events-*.jsonl'))
if not files:
    parser.error('no daily event files')
rows = []
by_kind = collections.Counter()
invalid = 0
manifest_hash = hashlib.sha256()
for file in files:
    raw = file.read_bytes()  # fixed per-file snapshot; no writes to inputs
    digest = hashlib.sha256(raw).hexdigest()
    manifest_hash.update(file.name.encode() + b'\0' + digest.encode())
    lines = raw.splitlines()
    matches = 0
    for line in lines:
        try:
            event = json.loads(line)
            if not isinstance(event, dict):
                raise ValueError('non-object')
        except (ValueError, UnicodeDecodeError):
            invalid += 1
            continue
        if event.get('kind') in ('save_memory', 'save_hold') and event.get('scope') in scopes:
            matches += 1
            by_kind[event['kind']] += 1
    rows.append({'date': file.stem.removeprefix('events-'), 'lines': len(lines), 'matching': matches})
git = lambda *argv: subprocess.check_output(['git', *argv], cwd=pathlib.Path(__file__).parent, text=True).strip()
result = {'measured_at': datetime.now(timezone.utc).isoformat(), 'schema_version': 1, 'issue': 686, 'harness': 'recount-test-events.py',
          'engine': {'repo_commit': git('rev-parse', 'HEAD'), 'repo_dirty': bool(git('status', '--porcelain'))},
          'code_sha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
          'input_manifest_sha256': manifest_hash.hexdigest(), 'files': len(files),
          'lines': sum(x['lines'] for x in rows), 'matching': sum(x['matching'] for x in rows),
          'invalid_rows': invalid, 'matching_by_kind': dict(by_kind), 'by_date': rows,
          'verdict': 'zero matching rows' if invalid == 0 and not by_kind else 'review required',
          'inputs_modified': False}
args.out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: v for k, v in result.items() if k != 'by_date'}, indent=2))
