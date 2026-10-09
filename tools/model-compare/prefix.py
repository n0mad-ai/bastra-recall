# Vector-only retrieval on the invented corpus: raw text vs the documented task prefixes.
# Usage: python3 tools/model-compare/prefix.py <corpus.json> <out.json>
# Expects embeddinggemma on 127.0.0.1:11434 and embeddinggemma-2:270m on 127.0.0.1:11435.
import json,urllib.request,math,sys
notes=json.load(open(sys.argv[1]))["notes"]
def emb(url,m,texts):
    out=[]
    for i in range(0,len(texts),16):
        r=urllib.request.urlopen(urllib.request.Request(url+"/api/embed",json.dumps({"model":m,"input":texts[i:i+16]}).encode(),{"Content-Type":"application/json"}),timeout=300)
        out+=json.load(r)["embeddings"]
    return out
def unit(v):
    n=math.sqrt(sum(x*x for x in v)); return [x/n for x in v]
res={}
for label,url,m in [("embeddinggemma","http://127.0.0.1:11434","embeddinggemma"),("embeddinggemma-2","http://127.0.0.1:11435","embeddinggemma-2:270m")]:
  for mode in ["raw","prefix"]:
    doc=lambda n: f'{n["summary"]}\n{" · ".join(n["recall_when"])}\n{n["body"]}'
    D=[(f'title: {n["title"]} | text: {doc(n)}' if mode=="prefix" else f'{n["title"]}\n{doc(n)}') for n in notes]
    dv=[unit(v) for v in emb(url,m,D)]
    row={}
    for kind in ["near","far","far_xlang"]:
        Q=[("task: search result | query: " if mode=="prefix" else "")+n["queries"][kind] for n in notes]
        qv=[unit(v) for v in emb(url,m,Q)]
        ranks=[]
        for i,q in enumerate(qv):
            sc=[sum(a*b for a,b in zip(q,d)) for d in dv]; ranks.append(1+sum(1 for s in sc if s>sc[i]))
        n=len(ranks); row[kind]={"R@1":round(sum(r<=1 for r in ranks)/n,3),"R@5":round(sum(r<=5 for r in ranks)/n,3),"MRR":round(sum(1/r for r in ranks)/n,3),"ranks":ranks}
    res[f"{label} {mode}"]=row; print(label,mode,{k:{x:y for x,y in v.items() if x!="ranks"} for k,v in row.items()},flush=True)
json.dump(res,open(sys.argv[2],"w"))
