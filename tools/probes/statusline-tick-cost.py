#!/usr/bin/env python3
"""Compare built statusline entry points (Unix rusage, isolated synthetic repo).

python3 tools/probes/statusline-tick-cost.py --before /tmp/before/index.mjs \
  --after packages/statusline/dist/index.mjs --runs 9 --files 1639
Counts Node child_process launches, including shell-backed git commands; not
execve transitions inside a child. CPU includes the tick and reaped descendants.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import resource
import statistics
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--before', type=Path, required=True)
parser.add_argument('--after', type=Path, required=True)
parser.add_argument('--runs', type=int, default=9)
parser.add_argument('--files', type=int, default=1639)
args = parser.parse_args()
if args.runs < 9:
    parser.error('at least 9 runs are required')
entries = [('before', args.before.resolve()), ('after', args.after.resolve())]
with tempfile.TemporaryDirectory(prefix='statusline-tick-cost-') as temporary:
    base = Path(temporary)
    repo = base / 'repo'
    repo.mkdir()
    def git(*command):
        return subprocess.run(['git', '-c', 'user.name=Benchmark',
                               '-c', 'user.email=benchmark@example.invalid',
                               '-c', 'core.hooksPath=/dev/null', *command],
                              cwd=repo, capture_output=True, check=True)
    git('init', '-b', 'main')
    for number in range(args.files):
        directory = repo / f'dir-{number // 100}'
        directory.mkdir(exist_ok=True)
        (directory / f'file-{number}.txt').write_text('benchmark\n')
    git('add', '.')
    git('commit', '-m', 'fixture')
    git('clone', '--bare', str(repo), str(base / 'remote.git'))
    git('remote', 'add', 'origin', str(base / 'remote.git'))
    git('push', '-u', 'origin', 'main')
    preload = base / 'count.mjs'
    preload.write_text('''import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const calls = [];
for (const name of ['execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync']) {
  const original = cp[name];
  cp[name] = function(...args) { calls.push(String(args[0])); return Reflect.apply(original, this, args); };
}
syncBuiltinESMExports();
process.on('exit', () => console.error('TICK_CALLS=' + JSON.stringify(calls)));
''')
    config = base / 'config.json'
    config.write_text(json.dumps({'display': {'lines': [{'segments': {
        'git': {'enabled': True}, 'bastra': {'enabled': True},
    }}]}}))
    payload = json.dumps({'session_id': 'benchmark', 'cwd': str(repo),
                          'workspace': {'project_dir': str(repo), 'current_dir': str(repo)},
                          'model': {'id': 'claude-sonnet-4-5', 'display_name': 'Claude'}})
    rows = []
    for label, entry in entries:
        home = base / label
        home.mkdir()
        env = {**os.environ, 'HOME': str(home), 'USERPROFILE': str(home), 'COLUMNS': '160',
               'CLAUDE_CONFIG_DIR': str(home / '.claude')}
        def tick():
            before = resource.getrusage(resource.RUSAGE_CHILDREN)
            result = subprocess.run(['node', '--import', str(preload), str(entry),
                                     '--style=powerline', '--config=' + str(config)],
                                    input=payload, text=True, capture_output=True,
                                    cwd=repo, env=env, check=True)
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            cpu_ms = 1000 * (after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime)
            calls = json.loads(next(line.removeprefix('TICK_CALLS=')
                                    for line in result.stderr.splitlines() if line.startswith('TICK_CALLS=')))
            if not result.stdout.strip():
                raise RuntimeError('tick produced no output')
            return cpu_ms, calls
        tick()  # unmeasured cache priming; the parent PID stays stable
        for scenario in ['warm', 'after-commit']:
            samples, launches = [], []
            for run in range(args.runs):
                if scenario == 'after-commit':
                    git('commit', '--allow-empty', '-m', f'{label}-{run}')
                cpu, calls = tick()
                samples.append(round(cpu, 3))
                launches.append(calls)
            rows.append({'version': label, 'scenario': scenario,
                         'cpu_ms_median': round(statistics.median(samples), 3),
                         'cpu_ms_samples': samples,
                         'child_process_counts': [len(calls) for calls in launches],
                         'commands_first_tick': launches[0]})
    print(json.dumps({'platform': platform.platform(),
                      'node': subprocess.check_output(['node', '--version'], text=True).strip(),
                      'files': args.files, 'runs': args.runs,
                      'measurement': 'RUSAGE_CHILDREN user+system, including tick and descendants',
                      'rows': rows}, indent=2))
