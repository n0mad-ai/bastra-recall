"""Collect every measurement of the local model comparison into one slim summary.json.

Usage: python3 collect.py <results-dir> <out.json>
The results dir holds res-*.json / p2-*.json (draft meaning check), rc/recall-*.json,
rc/rerank-*.json, rc/prefix-production-input.json (or the earlier rc/prefix.json, which
used another text layout than production) and lme100-*.json. Raw files are large; the
summary keeps only the numbers the documentation page shows, plus paired comparisons.
"""
import json, os, sys
from math import comb

S, OUT = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))

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

# What production hands to the check at most: a quote is clipped to 600 characters
# (clipDraftText in packages/daemon/src/draft-store.ts), a note body is cut at 1200
# (NOTE_BODY_MAX in packages/daemon/src/draft-judge.ts). The note side also carries title
# and summary, so 1200 is a lower bound there; no probe lies between 1200 and 3000.
QUOTE_MAX, NOTE_BODY_MAX = 600, 1200

def over_limit(a):
    """A probe longer than anything the production path can send."""
    return len(a["a"]) > QUOTE_MAX or len(a.get("b") or "") > (QUOTE_MAX if a["q"] == "b" else NOTE_BODY_MAX)

def dangerous(a):
    """A one-time task read as durable, or a contradiction read as the same fact."""
    return a["verdict"] == ("durable" if a["q"] == "a" else "same")

def states(rows):
    return {"flipped": sum(1 for a in rows if dangerous(a)), "no_verdict": sum(1 for a in rows if a["verdict"] is None), "probes": len(rows)}

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
    probes = [a for a in d["answers"] if a["set"] == "inject"]
    assert flipped == {a["id"] for a in probes if dangerous(a)}, name
    # Not flipped: a safe verdict or none at all. The three states are kept apart in "inject".
    inj = {a["id"]: not dangerous(a) for a in probes}
    rev = s.get("inject-rev", {"probes": 0})
    missing = lambda keep: sum(1 for a in d["answers"] if a["verdict"] is None and keep(a["set"]))
    no_verdict = {"facts": missing(lambda k: not k.startswith("inject")), "inject": missing(lambda k: k == "inject"),
                  "inject_reverse": missing(lambda k: k == "inject-rev")}
    assert sum(no_verdict.values()) == s["unreadable"], name
    return {"overall": [right, total], "metrics": cols, "no_verdict": no_verdict,
            "inject": {"all": states(probes), "within_limits": states([a for a in probes if not over_limit(a)])},
            "inject_flipped_ids": sorted(flipped), "inject_over_limit_ids": sorted(a["id"] for a in probes if over_limit(a)),
            "known_controls_flipped": sorted(a["id"] for a in probes if a["id"] in CONTROLS and dangerous(a)),
            "inject_reverse": [len(rev.get("gekippt (ungefährlich)", [])), rev["probes"]],
            "latency": s["latency"], "_scored": scored, "_inj": inj,
            "_inj_within": {a["id"]: not dangerous(a) for a in probes if not over_limit(a)}}

# Two of the fresh injection probes repeat inputs that were known to flip Gemma before.
CONTROLS = {a["id"] for a in json.load(open(os.path.join(HERE, "data", "fresh-probes.manifest.json")))["annotations"] if a.get("known_control")}
judge = []
for model, mode, std, fresh in JUDGE:
    judge.append({"model": model, "mode": mode, "standard": judge_file(std), "fresh": judge_file(fresh)})
for corpus in ("standard", "fresh"):
    bases = {j["model"]: j[corpus] for j in judge if j["model"] in ("gemma3:4b", "gemma4:12b", "tev1:4b") and j["mode"] == "chat" and j[corpus]}
    for j in judge:
        if not j[corpus]: continue
        for label, b in bases.items():
            j[corpus]["vs " + label] = {"facts": paired(j[corpus]["_scored"], b["_scored"]),
                                        "inject": paired(j[corpus]["_inj"], b["_inj"]),
                                        "inject_within_limits": paired(j[corpus]["_inj_within"], b["_inj_within"])}
for j in judge:
    for corpus in ("standard", "fresh"):
        if j[corpus]:
            del j[corpus]["_scored"], j[corpus]["_inj"], j[corpus]["_inj_within"]

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
for base in ("gemma3:4b", "tev1:4b"):
    b = recall["expander"][base]
    for name, r in recall["expander"].items():
        if r and b: r["vs " + base] = {key: {"top1": paired(r["_top1"][key], b["_top1"][key]),
                                             "top5": paired(r["_top5"][key], b["_top5"][key])} for key in r["_top1"]}
# The same queries through the fused path and through vectors alone (ids differ only in the lane).
none["hybrid vs vector"] = {kind: {"top1": paired(none["_top1"]["hybrid/" + kind], none["_top1"]["vector/" + kind]),
                                   "top5": paired(none["_top5"]["hybrid/" + kind], none["_top5"]["vector/" + kind])}
                            for kind in ("near", "far", "far_xlang")}
dense_top1 = {kind: none["_top1"]["vector/" + kind] for kind in ("near", "far", "far_xlang")}
for r in [none, *recall["embedding"].values(), *recall["expander"].values()]:
    if r: del r["_top1"], r["_top5"]
# prefix.mts measures with the text production embeds; the earlier prefix.py used another layout.
prefix = load("rc/prefix-production-input.json")
recall["prefix_input"] = "production" if prefix else "other-layout"
prefix = prefix or load("rc/prefix.json") or {}
recall["prefix"] = {}
for label, row in prefix.items():
    recall["prefix"][label] = {kind: {k: v for k, v in m.items() if k != "ranks"} for kind, m in row.items()}
    raw_row = prefix.get(label.replace(" prefix", " raw"))
    if label.endswith(" prefix") and raw_row:
        for kind, m in row.items():
            ids = range(len(m["ranks"]))
            recall["prefix"][label][kind]["top1 vs raw"] = paired({i: m["ranks"][i] == 1 for i in ids},
                                                                 {i: raw_row[kind]["ranks"][i] == 1 for i in ids})
            recall["prefix"][label][kind]["top5 vs raw"] = paired({i: m["ranks"][i] <= 5 for i in ids},
                                                                 {i: raw_row[kind]["ranks"][i] <= 5 for i in ids})
# Control: raw text of the production model against the production dense arm of recall.mts, query by query.
raw_row = prefix.get("embeddinggemma raw")
if raw_row:
    recall["prefix_raw_vs_dense_arm"] = {}
    for kind, m in raw_row.items():
        dense = list(dense_top1[kind].values())
        assert len(dense) == len(m["ranks"]), kind
        recall["prefix_raw_vs_dense_arm"][kind] = {"same_top1": sum(1 for r, d in zip(m["ranks"], dense) if (r == 1) == d), "n": len(dense)}

lme = {}
for tag, name in (("embeddinggemma-latest", "embeddinggemma"), ("embeddinggemma-2-270m", "embeddinggemma-2:270m"),
                  ("embeddinggemma-2-570m", "embeddinggemma-2:570m")):
    d = load(f"lme100-{tag}.json")
    if not d: continue
    lme[name] = {"n_questions": d["n_questions"], "summary": d["summary"]}
    for k in (1, 5):
        lme[name][f"_top{k}"] = {q["question_id"]: any(g in q["ranked"]["hybrid"][:k] for g in q["gold"]) for q in d["questions"]}
for name, x in lme.items():
    if name != "embeddinggemma":
        x["vs embeddinggemma"] = {f"top{k}": paired(x[f"_top{k}"], lme["embeddinggemma"][f"_top{k}"]) for k in (1, 5)}
for x in lme.values():
    del x["_top1"], x["_top5"]
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
    for base in ("gemma3:4b", "qwen3-recall", "gemma4:12b", "tev1:4b"):
        if base in raw:
            r["vs " + base] = {key: paired(raw[name][key], raw[base][key]) for key in raw[name]}

json.dump({"draft_meaning_check": judge, "recall": recall, "reranker": rerank}, open(OUT, "w"), indent=1, ensure_ascii=False)
print("ok", OUT, os.path.getsize(OUT))
