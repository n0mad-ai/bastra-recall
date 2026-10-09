"""Collect every measurement of the local model comparison into one slim summary.json.

Usage: python3 collect.py <results-dir> <out.json>
The results dir holds res-*.json / p2-*.json (draft meaning check), rc/recall-*.json,
rc/rerank-*.json, rc/prefix.json and lme100-*.json. Raw files are large; the summary
keeps only the numbers the documentation page shows, plus paired comparisons.
"""
import json, os, sys
from math import comb

S, OUT = sys.argv[1], sys.argv[2]

def load(name):
    path = os.path.join(S, name)
    return json.load(open(path)) if os.path.exists(path) else None

def sign_test(wins, losses):
    """Two-sided exact sign test on discordant pairs."""
    n = wins + losses
    if n == 0: return 1.0
    k = min(wins, losses)
    return min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n)

def paired(cand, base):
    """cand/base: {id: bool}. Wins = candidate right where baseline is wrong."""
    ids = [i for i in cand if i in base]
    wins = sum(1 for i in ids if cand[i] and not base[i])
    losses = sum(1 for i in ids if base[i] and not cand[i])
    return {"wins": wins, "losses": losses, "p": round(sign_test(wins, losses), 4)}

# ---------- draft meaning check ----------
JUDGE = [  # key, label, standard file, fresh file
    ("gemma3:4b", "chat", "res-gemma3-4b.json", "p2-gemma3-4b-chat.json"),
    ("qwen3-recall", "chat", "res-qwen3-recall-chat.json", "p2-qwen3-recall-chat.json"),
    ("gemma4:12b", "chat", "res-gemma4-12b.json", "p2-gemma4-12b-chat.json"),
    ("gemma4:12b-it-q4_K_M", "chat", "res-gemma4-12b-it-q4_K_M-chat.json", "p2-gemma4-12b-it-q4_K_M-chat.json"),
    ("tev1:4b", "chat", "res-tev1-4b-chat.json", "p2-tev1-4b-chat.json"),
    ("tev1:4b", "decision", "res-tev1-4b-decision.json", "p2-tev1-4b-decision.json"),
    ("qwen3.5:4b", "chat", "res-qwen3-5-4b-chat.json", "p2-qwen3-5-4b-chat.json"),
    ("qwen3.5:9b", "chat", "res-qwen3-5-9b-chat.json", "p2-qwen3-5-9b-chat.json"),
    ("granite4.2:3b", "chat", "res-granite4-2-3b-chat.json", "p2-granite4-2-3b-chat.json"),
    ("granite4.2:8b", "chat", "res-granite4-2-8b-chat.json", "p2-granite4-2-8b-chat.json"),
    ("nimble:9b", "decision", "res-nimble-9b-decision.json", "p2-nimble-9b-decision.json"),
    ("laya:322m", "decision, short criteria", "res-laya-322m-short-decision.json", "p2-laya-short.json"),
]
SETS = ["design-own", "design-codex", "holdout", "blind"]
METRICS = ["paraphrase_promoted", "task_as_durable", "fact_plus_task_promoted",
           "contradiction_as_repeat", "counterfact_as_duplicate", "same_fact_as_duplicate"]

def is_correct(a):
    v, e = a.get("verdict"), a["expect"]
    if v is None: return False
    return v != e[4:] if e.startswith("not-") else v == e

def judge_file(name):
    d = load(name)
    if not d: return None
    s = d["summary"]
    cols = {}
    for i, m in enumerate(METRICS):
        num = den = 0
        for k in SETS:
            if not any(x["set"] == k for x in d["answers"]): continue
            a, b = list(s[k].values())[i].split("/")
            num += int(a); den += int(b)
        cols[m] = [num, den]
    scored = {a["id"] + "/" + a["q"]: is_correct(a) for a in d["answers"] if not a["set"].startswith("inject")}
    right, total = (int(x) for x in s["overall"].split("/"))
    assert sum(scored.values()) == right and len(scored) == total, (name, sum(scored.values()), right, len(scored), total)
    flipped = set(s["inject"]["gekippt (gefährlich)"])
    inj = {a["id"]: a["id"] not in flipped for a in d["answers"] if a["set"] == "inject"}
    rev = s.get("inject-rev", {"probes": 0})
    return {"overall": [right, total], "metrics": cols, "unreadable": s["unreadable"],
            "inject": [len(flipped), s["inject"]["probes"]], "inject_flipped_ids": sorted(flipped),
            "inject_reverse": [len(rev.get("gekippt (ungefährlich)", [])), rev["probes"]],
            "latency": s["latency"], "_scored": scored, "_inj": inj}

judge = []
for model, mode, std, fresh in JUDGE:
    judge.append({"model": model, "mode": mode, "standard": judge_file(std), "fresh": judge_file(fresh)})
for corpus in ("standard", "fresh"):
    bases = {j["model"]: j[corpus] for j in judge if j["model"] in ("gemma3:4b", "gemma4:12b") and j[corpus]}
    for j in judge:
        if not j[corpus]: continue
        for label, b in bases.items():
            j[corpus]["vs " + label] = {"facts": paired(j[corpus]["_scored"], b["_scored"]),
                                        "inject": paired(j[corpus]["_inj"], b["_inj"])}
for j in judge:
    for corpus in ("standard", "fresh"):
        if j[corpus]:
            del j[corpus]["_scored"], j[corpus]["_inj"]

# ---------- recall ----------
def recall_file(name):
    d = load(name)
    if not d: return None
    out = {"summary": {f'{r["lane"]}/{r["kind"]}': {k: round(r[k], 3) for k in ("r_at_1", "r_at_3", "r_at_5", "mrr")}
                       for r in d["summary"]}}
    es = d.get("expansion_stats")
    t = es and (es.get("per_note_timing") or es.get("cached_source_timing"))
    if t and t.get("median_ms") is not None:
        out["expansion"] = {"notes_without_phrases": es["notes_without_usable_phrases"], "phrases": es["phrase_count"],
                            "median_ms": round(t["median_ms"]), "p95_ms": round(t["p95_ms"])}
    out["_top1"] = {f'{r["lane"]}/{r["kind"]}': {} for r in d["summary"]}
    out["_top5"] = {f'{r["lane"]}/{r["kind"]}': {} for r in d["summary"]}
    for r in d["rows"]:
        key = f'{r["lane"]}/{r["kind"]}'
        rank = r["rank"]
        out["_top1"][key][r["query_id"]] = rank == 1
        out["_top5"][key][r["query_id"]] = rank is not None and rank <= 5
    return out

EXPANDERS = ["gemma3-4b", "qwen3-recall-latest", "gemma4-12b", "gemma4-12b-it-q4_K_M", "tev1-4b",
             "qwen3-5-4b", "qwen3-5-9b", "granite4-2-3b", "granite4-2-8b"]
NAMES = {"gemma3-4b": "gemma3:4b", "qwen3-recall-latest": "qwen3-recall", "gemma4-12b": "gemma4:12b",
         "gemma4-12b-it-q4_K_M": "gemma4:12b-it-q4_K_M", "tev1-4b": "tev1:4b", "qwen3-5-4b": "qwen3.5:4b",
         "qwen3-5-9b": "qwen3.5:9b", "granite4-2-3b": "granite4.2:3b", "granite4-2-8b": "granite4.2:8b"}
none = recall_file("rc/recall-none.json")
recall = {"none": none, "embedding": {}, "expander": {}}
for tag, name in (("embeddinggemma-2-270m", "embeddinggemma-2:270m"), ("embeddinggemma-2-570m", "embeddinggemma-2:570m")):
    recall["embedding"][name] = recall_file(f"rc/recall-emb-{tag}.json")
for tag in EXPANDERS:
    recall["expander"][NAMES[tag]] = recall_file(f"rc/recall-exp-{tag}.json")
for group in ("embedding", "expander"):
    for name, r in recall[group].items():
        if not r: continue
        r["vs none"] = {key: {"top1": paired(r["_top1"][key], none["_top1"][key]),
                              "top5": paired(r["_top5"][key], none["_top5"][key])} for key in r["_top1"]}
for r in [none, *recall["embedding"].values(), *recall["expander"].values()]:
    if r: del r["_top1"], r["_top5"]
prefix = load("rc/prefix.json") or {}
recall["prefix"] = {}
for label, row in prefix.items():
    recall["prefix"][label] = {kind: {k: v for k, v in m.items() if k != "ranks"} for kind, m in row.items()}
    raw_row = prefix.get(label.replace(" prefix", " raw"))
    if label.endswith(" prefix") and raw_row:
        for kind, m in row.items():
            ids = range(len(m["ranks"]))
            recall["prefix"][label][kind]["top1 vs raw"] = paired({i: m["ranks"][i] == 1 for i in ids},
                                                                 {i: raw_row[kind]["ranks"][i] == 1 for i in ids})

lme = {}
for tag, name in (("embeddinggemma-latest", "embeddinggemma"), ("embeddinggemma-2-270m", "embeddinggemma-2:270m"),
                  ("embeddinggemma-2-570m", "embeddinggemma-2:570m")):
    d = load(f"lme100-{tag}.json")
    if d: lme[name] = {"n_questions": d["n_questions"], "summary": d["summary"]}
recall["longmemeval_100"] = lme

# ---------- reranker ----------
rerank, raw = {}, {}
for tag in EXPANDERS:
    d = load(f"rc/rerank-{tag}.json")
    if not d: continue
    name = NAMES[tag]
    rerank[name] = {f'{r["condition"]}/{r["kind"]}': {"correct": r["correct"], "n": r["n"], "unusable": r["unusable"],
                                                      "median_ms": round(r["latency"]["median_ms"])} for r in d["summary"]}
    raw[name] = {}
    for r in d["rows"]:
        raw[name].setdefault(f'{r["condition"]}/{r["kind"]}', {})[r["query_id"]] = bool(r["correct"])
for name, r in rerank.items():
    for base in ("gemma3:4b", "qwen3-recall"):
        if base in raw:
            r["vs " + base] = {key: paired(raw[name][key], raw[base][key]) for key in raw[name]}

json.dump({"draft_meaning_check": judge, "recall": recall, "reranker": rerank}, open(OUT, "w"), indent=1, ensure_ascii=False)
print("ok", OUT, os.path.getsize(OUT))
