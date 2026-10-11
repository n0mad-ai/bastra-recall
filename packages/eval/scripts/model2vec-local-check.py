#!/usr/bin/env python3
"""Bounded local Model2Vec inventory; no network, download or model inference."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True, type=pathlib.Path)
args = parser.parse_args()
home = pathlib.Path.home()
repo = pathlib.Path(__file__).resolve().parents[3]
roots = []
for value in (os.environ.get('HF_HOME'), os.environ.get('HUGGINGFACE_HUB_CACHE'),
              str(home / '.cache/huggingface'), str(home / '.cache/model2vec'),
              str(home / '.cache/zvec-grep'), str(home / '.cache/zvec'),
              str(home / '.local/share/uv/tools'), str(repo / '.cache'), str(repo / 'models')):
    if value and value not in roots:
        roots.append(value)
existing = candidates = complete = unreadable = 0
def onerror(_):
    global unreadable
    unreadable += 1
for root in roots:
    if not pathlib.Path(root).exists():
        continue
    existing += 1
    for current, dirs, files in os.walk(root, onerror=onerror):
        dirs[:] = [d for d in dirs if d not in ('node_modules', '.git', 'site-packages', '__pycache__')]
        if 'potion' not in current.lower() and 'model2vec' not in current.lower():
            continue
        weights = any(f.endswith(('.safetensors', '.npz', '.npy', '.bin')) for f in files)
        if weights:
            candidates += 1
            complete += int('config.json' in files and 'tokenizer.json' in files)
git = lambda *v: subprocess.check_output(['git', *v], cwd=repo, text=True).strip()
result = {'schema_version': 1, 'issue': 480,
          'engine': {'repo_commit': git('rev-parse', 'HEAD'), 'repo_dirty': bool(git('status', '--porcelain'))},
          'code_sha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
          'search_scope': ['configured HF caches', 'standard HF/Model2Vec/Potion-related caches', 'local uv tool cache excluding site-packages', 'repository cache/model directories'],
          'roots_checked': len(roots), 'existing_roots': existing, 'unreadable_directories': unreadable,
          'weight_candidate_directories': candidates, 'complete_candidate_directories': complete,
          'python_package_present': importlib.util.find_spec('model2vec') is not None,
          'network_calls': 0, 'downloads': 0, 'model_inference_calls': 0,
          'verdict': 'not evaluable under local-model-only constraint' if complete == 0 else 'local candidate found; verify identity/runtime before a scoring run',
          'limitations': ['bounded inventory, not exhaustive proof of absence in every directory/environment', 'no model quality or latency measured', 'no fallback/adoption gate passed']}
args.out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
