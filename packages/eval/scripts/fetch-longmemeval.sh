#!/usr/bin/env bash
#
# Fetch the LongMemEval corpus the external arm measures (#500).
#
# LongMemEval — Zhong et al., ICLR 2025, arXiv:2410.10813 — is published under
# MIT on HuggingFace. No account, no token, no click-through: a plain HTTPS GET
# of a public LFS object. Nothing here is committed to this repo; the file lands
# in a cache directory and `longmemeval-run.ts --corpus` is pointed at it.
#
# WHICH FILE. `longmemeval_s_cleaned.json` — the "S" variant (500 questions,
# ~48 sessions each, ~115k tokens of haystack per question) from the CLEANED
# release, which removed noisy history sessions that interfered with answer
# correctness. That is the file both public numbers this arm is compared to were
# measured on:
#
#   MemPalace    96.6% R@5  -> benchmarks/longmemeval_bench.py takes
#                              longmemeval_s_cleaned.json as its argument
#   agentmemory  95.2% R@5  -> benchmark/LONGMEMEVAL.md names
#                              xiaowu0162/longmemeval-cleaned as its source
#
# The `_m` variant (2.7 GB, ~500 sessions per question) and the `_oracle` variant
# (only the gold sessions, so retrieval is trivial on it) are DIFFERENT tasks and
# their numbers are not comparable to the two above. `--variant` can fetch them
# anyway, for the record.
#
# Usage:
#   packages/eval/scripts/fetch-longmemeval.sh                 # s_cleaned -> ~/.cache/longmemeval
#   packages/eval/scripts/fetch-longmemeval.sh --dir /data     # elsewhere
#   packages/eval/scripts/fetch-longmemeval.sh --variant oracle
set -euo pipefail

DIR="${HOME}/.cache/longmemeval"
VARIANT="s_cleaned"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --variant) VARIANT="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

case "$VARIANT" in
  s_cleaned) REPO="xiaowu0162/longmemeval-cleaned"; FILE="longmemeval_s_cleaned.json" ;;
  m_cleaned) REPO="xiaowu0162/longmemeval-cleaned"; FILE="longmemeval_m_cleaned.json" ;;
  oracle)    REPO="xiaowu0162/longmemeval-cleaned"; FILE="longmemeval_oracle.json" ;;
  *) echo "unknown variant: $VARIANT (s_cleaned | m_cleaned | oracle)" >&2; exit 2 ;;
esac

mkdir -p "$DIR"
OUT="${DIR}/${FILE}"
if [ -s "$OUT" ]; then
  echo "already present: $OUT"
else
  echo "fetching ${REPO}/${FILE} -> ${OUT}"
  curl -fSL --retry 3 -o "$OUT" "https://huggingface.co/datasets/${REPO}/resolve/main/${FILE}"
fi

# A truncated download is the failure mode that costs an hour of embedding
# before it shows up, so the file is parsed before the script claims success.
node -e '
const fs = require("node:fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(d) || d.length === 0) throw new Error("not a non-empty JSON array");
const s = d.reduce((n, q) => n + q.haystack_sessions.length, 0);
console.log(`ok: ${d.length} questions, ${s} sessions`);
' "$OUT"

cat <<EOF

Run the arm:

  npm run longmemeval --workspace=@bastra-recall/eval -- \\
    --corpus ${OUT} --arms bm25,hybrid --out /tmp/longmemeval.json

The hybrid arm needs a reachable Ollama with the embedding model
(BASTRA_OLLAMA_URL, BASTRA_EMBEDDING_MODEL — same envs the daemon uses).
EOF
