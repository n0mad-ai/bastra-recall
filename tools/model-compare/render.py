"""Fill the tables of docs/local-model-comparison.md from results/summary.json.

Usage: python3 tools/model-compare/render.py tools/model-compare/results/summary.json docs/local-model-comparison.md
Every block between `<!-- table:NAME -->` and `<!-- /table -->` is replaced; prose stays untouched.
"""
import json, re, sys

D = json.load(open(sys.argv[1]))
PAGE = sys.argv[2]
SMALL, LARGE = "gemma3:4b", "gemma4:12b"
LANG = "en"
DE = {'Model': 'Modell', 'Questions answered correctly': 'Fragen richtig beantwortet', 'Rewording promoted ↑': 'Umformulierung befördert ↑', 'One-time task kept as durable ↓': 'Einmalauftrag als dauerhaft gewertet ↓', 'Fact + task promoted ↓': 'Fakt + Auftrag befördert ↓', 'Contradiction read as repeat ↓': 'Widerspruch als Wiederholung gelesen ↓', 'Counter-fact closed as duplicate ↓': 'Gegenfakt als Dublette geschlossen ↓', 'Same fact recognised ↑': 'Gleicher Fakt erkannt ↑', 'No verdict (of the questions)': 'Kein Urteil (von den Fragen)', 'Within production limits, 59 new probes: dangerous flips ↓': 'Innerhalb der Produktionsgrenzen, 59 neue Proben: gefährlich gekippt ↓', 'All 66 new probes: dangerous flips · no verdict · resisted': 'Alle 66 neuen Proben: gefährlich gekippt · kein Urteil · widerstanden', 'Earlier probes: dangerous flips within limits (all 30)': 'Frühere Proben: gefährlich gekippt innerhalb der Grenzen (alle 30)', 'Harmless direction flipped, 10 probes': 'In harmloser Richtung gekippt, 10 Proben', 'raw text (earlier layout, not production)': 'Rohtext (frühere Darstellung, nicht Produktion)', 'Typical answer (median, shorter bar is faster)': 'Typische Antwort (Median, kürzerer Balken ist schneller)', 'Slow answer (p95)': 'Langsame Antwort (p95)', 'First answer after loading': 'Erste Antwort nach dem Laden', 'Embedding model': 'Einbettungsmodell', 'Hybrid, other wording: first place': 'Hybrid, andere Formulierung: Platz 1', 'Hybrid, other wording: top 5': 'Hybrid, andere Formulierung: Top 5', 'Vector only, other wording: first place': 'Nur Vektor, andere Formulierung: Platz 1', 'Vector only, other language: first place': 'Nur Vektor, andere Sprache: Platz 1', 'First place': 'Platz 1', 'Top 5': 'Top 5', 'Top 10': 'Top 10', 'MRR': 'MRR', 'Input': 'Eingabe', 'Other wording: first place': 'Andere Formulierung: Platz 1', 'Other language: first place': 'Andere Sprache: Platz 1', 'raw text (as today)': 'Rohtext (wie heute)', 'with task prefixes': 'mit Aufgaben-Präfixen', 'Expansion written by': 'Erweiterung geschrieben von', 'Hybrid, other language: first place': 'Hybrid, andere Sprache: Platz 1', 'Keyword only, other wording: first place': 'Nur Stichwort, andere Formulierung: Platz 1', 'Notes left without phrases (of 180)': 'Notizen ohne Phrasen (von 180)', 'Time per note': 'Zeit je Notiz', 'none (no expansion)': 'keine (ohne Erweiterung)', 'Picks the right note: same words': 'Wählt die richtige Notiz: gleiche Wörter', '… other wording': '… andere Formulierung', '… other language': '… andere Sprache', 'Says “none” when the right note is missing: other wording': 'Sagt „keine“, wenn die richtige Notiz fehlt: andere Formulierung', 'Unusable answers (of 1080)': 'Unbrauchbare Antworten (von 1080)', 'Time per decision': 'Zeit je Entscheidung', 'Draft check: questions right': 'Entwurfs-Prüfung: Fragen richtig', 'Draft check: dangerous injection flips within production limits ↓': 'Entwurfs-Prüfung: gefährlich gekippt, innerhalb der Produktionsgrenzen ↓', 'Reranker: right note picked': 'Nachsortierung: richtige Notiz gewählt', 'Reranker: “none” when missing': 'Nachsortierung: „keine“, wenn sie fehlt', 'Expansion: hybrid first place (vs none)': 'Erweiterung: Hybrid Platz 1 (gegen ohne)', 'Draft check: typical answer': 'Entwurfs-Prüfung: typische Antwort', ' · default': ' · Standard', ' · 24 GB+ option': ' · Option ab 24 GB', ' · today': ' · heute', 'decision, short criteria': 'Entscheidung, kurze Kriterien', 'decision': 'Entscheidung'}

def T(text):
    """German table wording for the German half of the page."""
    if LANG != "de": return text
    if text.startswith("vs "): return "ggü. " + text[3:]
    return DE.get(text, text)


def bar(frac):
    full = round(max(0.0, min(1.0, frac)) * 10)
    return "`" + "█" * full + "░" * (10 - full) + "`"

def bar3(x):
    """Injection probes in three states: resisted █, no verdict ▒, dangerous flip ░."""
    empty, grey = round(10 * x["flipped"] / x["probes"]), round(10 * x["no_verdict"] / x["probes"])
    return "`" + "█" * (10 - empty - grey) + "▒" * grey + "░" * empty + "`"

def pct(num, den):
    return f"{100 * num / den:.0f} %"

def mark(pair):
    """Paired exact sign test against the baseline, 5 % level."""
    if not pair: return ""
    if pair["wins"] == pair["losses"] == 0: return "⚪"
    if pair["p"] >= 0.05: return "⚪"
    return "🟢" if pair["wins"] > pair["losses"] else "🔴"

def table(head, rows, align=None):
    align = align or ["---"] + ["---:"] * (len(head) - 1)
    out = ["| " + " | ".join(T(h) for h in head) + " |", "| " + " | ".join(align) + " |"]
    out += ["| " + " | ".join(T(c) if isinstance(c, str) else str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)

def label(j):
    name = f"`{j['model']}`"
    if j["mode"] != "chat": name += f" ({T(j['mode'])})"
    if j["model"] == SMALL and j["mode"] == "chat": name += T(" · default")
    if j["model"] == LARGE and j["mode"] == "chat": name += T(" · 24 GB+ option")
    return name

JUDGE = D["draft_meaning_check"]
def judge_rows(corpus):
    rows = []
    for j in sorted((j for j in JUDGE if j[corpus]), key=lambda j: -j[corpus]["overall"][0]):
        x = j[corpus]; right, total = x["overall"]; m = x["metrics"]
        base = j["model"] in (SMALL, LARGE) and j["mode"] == "chat"
        rows.append([label(j), f"{bar(right / total)} {right}/{total}",
                     "–" if base and j["model"] == SMALL else mark(x[f"vs {SMALL}"]["facts"]),
                     "–" if base and j["model"] == LARGE else mark(x[f"vs {LARGE}"]["facts"]),
                     "/".join(map(str, m["paraphrase_promoted"])), m["task_as_durable"][0], m["fact_plus_task_promoted"][0],
                     m["contradiction_as_repeat"][0], m["counterfact_as_duplicate"][0],
                     "/".join(map(str, m["same_fact_as_duplicate"])), x["no_verdict"]["facts"]])
    return table(["Model", "Questions answered correctly", f"vs `{SMALL}`", f"vs `{LARGE}`", "Rewording promoted ↑",
                  "One-time task kept as durable ↓", "Fact + task promoted ↓", "Contradiction read as repeat ↓",
                  "Counter-fact closed as duplicate ↓", "Same fact recognised ↑", "No verdict (of the questions)"], rows)

def inject_rows():
    rows = []
    for j in sorted((j for j in JUDGE if j["fresh"]), key=lambda j: j["fresh"]["inject"]["within_limits"]["flipped"]):
        s, f = j["standard"], j["fresh"]
        w, a = f["inject"]["within_limits"], f["inject"]["all"]
        assert w["no_verdict"] == 0, j["model"]  # the 59-probe column shows two states only
        base_s = j["model"] == SMALL and j["mode"] == "chat"; base_l = j["model"] == LARGE and j["mode"] == "chat"
        rows.append([label(j), f"{bar3(w)} {w['flipped']}/{w['probes']}",
                     "–" if base_s else mark(f[f"vs {SMALL}"]["inject_within_limits"]), "–" if base_l else mark(f[f"vs {LARGE}"]["inject_within_limits"]),
                     f"{bar3(a)} {a['flipped']} · {a['no_verdict']} · {a['probes'] - a['flipped'] - a['no_verdict']}",
                     f"{s['inject']['within_limits']['flipped']}/{s['inject']['within_limits']['probes']} ({s['inject']['all']['flipped']}/{s['inject']['all']['probes']})" if s else "–",
                     f"{f['inject_reverse'][0]}/{f['inject_reverse'][1]}"])
    return table(["Model", "Within production limits, 59 new probes: dangerous flips ↓", f"vs `{SMALL}`", f"vs `{LARGE}`",
                  "All 66 new probes: dangerous flips · no verdict · resisted",
                  "Earlier probes: dangerous flips within limits (all 30)", "Harmless direction flipped, 10 probes"], rows)

def speed_rows():
    rows = []
    slowest = max(j["standard"]["latency"]["median_ms"] for j in JUDGE if j["standard"])
    for j in sorted((j for j in JUDGE if j["standard"]), key=lambda j: j["standard"]["latency"]["median_ms"]):
        l = j["standard"]["latency"]
        rows.append([label(j), f"{bar(l['median_ms'] / slowest)} {l['median_ms']} ms", f"{l['p95_ms']} ms", f"{l['cold_ms'] / 1000:.1f} s"])
    return table(["Model", "Typical answer (median, shorter bar is faster)", "Slow answer (p95)", "First answer after loading"], rows)

R = D["recall"]
def cell(r, key, base=None, metric="r_at_1"):
    v = r["summary"][key][metric]
    m = "" if base is None else " " + mark(r["vs none"][key]["top1" if metric == "r_at_1" else "top5"])
    return f"{bar(v)} {100 * v:.1f} %{m}"

def embedding_rows():
    rows = [["`embeddinggemma`" + T(" · today")] + [cell(R["none"], k, None, m) for k, m in COLS_E]]
    for name, r in R["embedding"].items():
        if r: rows.append([f"`{name}`"] + [cell(r, k, True, m) for k, m in COLS_E])
    return table(["Embedding model", "Hybrid, other wording: first place", "Hybrid, other wording: top 5",
                  "Vector only, other wording: first place", "Vector only, other language: first place"], rows)
COLS_E = [("hybrid/far", "r_at_1"), ("hybrid/far", "r_at_5"), ("vector/far", "r_at_1"), ("vector/far_xlang", "r_at_1")]

def lme_rows():
    rows = []
    for name, x in R["longmemeval_100"].items():
        h, vs = x["summary"]["hybrid"], x.get("vs embeddinggemma", {})
        rows.append([f"`{name}`" + (T(" · today") if name == "embeddinggemma" else ""), f"{bar(h['r@1'])} {100 * h['r@1']:.0f} % {mark(vs.get('top1'))}".rstrip(),
                     f"{bar(h['r@5'])} {100 * h['r@5']:.0f} % {mark(vs.get('top5'))}".rstrip(), f"{100 * h['r@10']:.0f} %", f"{h['mrr']:.3f}"])
    return table(["Embedding model", "First place", "Top 5", "Top 10", "MRR"], rows)

def prefix_rows():
    rows = []
    for name, row in R["prefix"].items():
        model, mode = name.rsplit(" ", 1)
        cells = []
        for kind in ("far", "far_xlang"):
            m = row[kind]
            cells.append(f"{bar(m['R@1'])} {100 * m['R@1']:.1f} % {mark(m.get('top1 vs raw'))}".rstrip())
        raw = "raw text (as today)" if R["prefix_input"] == "production" else "raw text (earlier layout, not production)"
        rows.append([f"`{model}`", raw if mode == "raw" else "with task prefixes", *cells])
    return table(["Embedding model", "Input", "Other wording: first place", "Other language: first place"], rows, ["---", "---", "---:", "---:"])

def expander_rows():
    rows = [["none (no expansion)", cell(R["none"], "hybrid/far"), cell(R["none"], "hybrid/far", None, "r_at_5"),
             cell(R["none"], "hybrid/far_xlang"), cell(R["none"], "bm25/far"), "–", "–"]]
    for name, r in R["expander"].items():
        if not r: continue
        e = r.get("expansion", {})
        tag = T(" · default") if name == SMALL else ""
        rows.append([f"`{name}`{tag}", cell(r, "hybrid/far", True), cell(r, "hybrid/far", True, "r_at_5"), cell(r, "hybrid/far_xlang", True),
                     cell(r, "bm25/far", True), e.get("notes_without_phrases", "–"), f"{e['median_ms'] / 1000:.1f} s" if e else "–"])
    return table(["Expansion written by", "Hybrid, other wording: first place", "Hybrid, other wording: top 5",
                  "Hybrid, other language: first place", "Keyword only, other wording: first place",
                  "Notes left without phrases (of 180)", "Time per note"], rows)

RR = D["reranker"]
def rr(name, key, base):
    x = RR[name][key]
    m = "" if name == base else " " + mark(RR[name].get(f"vs {base}", {}).get(key))
    return f"{bar(x['correct'] / x['n'])} {pct(x['correct'], x['n'])}{m}"

def reranker_rows():
    order = sorted(RR, key=lambda n: -(RR[n]["present/far"]["correct"] + RR[n]["present/far_xlang"]["correct"]))
    rows = []
    for name in order:
        unusable = sum(v["unusable"] for k, v in RR[name].items() if "/" in k)
        tag = T(" · default") if name == SMALL else T(" · 24 GB+ option") if name == LARGE else ""
        rows.append([f"`{name}`{tag}", rr(name, "present/near", SMALL), rr(name, "present/far", SMALL), rr(name, "present/far_xlang", SMALL),
                     rr(name, "absent/far", SMALL), rr(name, "absent/far_xlang", SMALL), unusable, f"{RR[name]['present/far']['median_ms'] / 1000:.1f} s"])
    return table(["Model", "Picks the right note: same words", "… other wording", "… other language",
                  "Says “none” when the right note is missing: other wording", "… other language", "Unusable answers (of 1080)", "Time per decision"], rows)

def scorecard_rows():
    rows = []
    fresh = {j["model"]: j["fresh"] for j in JUDGE if j["mode"] == "chat" and j["fresh"]}
    std = {j["model"]: j["standard"] for j in JUDGE if j["mode"] == "chat" and j["standard"]}
    for name in sorted(fresh, key=lambda n: -(std[n]["overall"][0] if n in std else 0)):
        f, s = fresh[name], std.get(name)
        base = name == SMALL
        both = [s["overall"][0] + f["overall"][0], s["overall"][1] + f["overall"][1]] if s else f["overall"]
        within = [x["inject"]["within_limits"] for x in (f, s) if x]
        inj = [sum(x["flipped"] for x in within), sum(x["probes"] for x in within)]
        row = [f"`{name}`" + (T(" · default") if base else T(" · 24 GB+ option") if name == LARGE else ""),
               f"{pct(*both)} {'' if base else mark(s[f'vs {SMALL}']['facts'] if s else None)}",
               f"{inj[0]}/{inj[1]} {'' if base else mark(f[f'vs {SMALL}']['inject_within_limits'])}"]
        if name in RR:
            p, a = RR[name]["present/far"], RR[name]["absent/far"]
            row += [f"{pct(p['correct'], p['n'])} {'' if base else mark(RR[name][f'vs {SMALL}']['present/far'])}",
                    f"{pct(a['correct'], a['n'])} {'' if base else mark(RR[name][f'vs {SMALL}']['absent/far'])}"]
        else: row += ["–", "–"]
        e = R["expander"].get(name)
        row.append(f"{100 * e['summary']['hybrid/far']['r_at_1']:.1f} % {mark(e['vs none']['hybrid/far']['top1'])}" if e else "–")
        row.append(f"{s['latency']['median_ms']} ms" if s else "–")
        rows.append(row)
    return table(["Model", "Draft check: questions right", "Draft check: dangerous injection flips within production limits ↓", "Reranker: right note picked",
                  "Reranker: “none” when missing", "Expansion: hybrid first place (vs none)", "Draft check: typical answer"], rows)

TABLES = {"scorecard": scorecard_rows, "judge-standard": lambda: judge_rows("standard"), "judge-fresh": lambda: judge_rows("fresh"),
          "judge-inject": inject_rows, "judge-speed": speed_rows, "embedding": embedding_rows, "longmemeval": lme_rows,
          "prefix": prefix_rows, "expander": expander_rows, "reranker": reranker_rows}

page = open(PAGE).read()
def fill(match):
    global LANG
    name = match.group(1)
    LANG = "de" if name.endswith("-de") else "en"
    return f"<!-- table:{name} -->\n{TABLES[name.removesuffix('-de')]()}\n<!-- /table -->"
page, n = re.subn(r"<!-- table:([a-z-]+) -->.*?<!-- /table -->", fill, page, flags=re.S)
open(PAGE, "w").write(page)
print(f"{n} tables filled")
