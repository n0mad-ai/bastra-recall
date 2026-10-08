/** Disposable process used to terminate harvest in the middle of embedding. */
import { Vault, SearchIndex, type EmbeddingIndex, type EmbeddingProvider } from "@bastra-recall/core";
import { runSessionHarvestTick } from "../../src/daemon-jobs.js";
const vault = new Vault(process.env.BASTRA_VAULT_PATH!); await vault.init();
const search = new SearchIndex(vault); search.start();
const provider: EmbeddingProvider = { id:"ollama-fixture",dim:2,embed:async()=>{
  process.stderr.write("embedding-started\n");
  return new Promise<Float32Array[]>(()=>{});
} };
const index = { providerIdentity:()=>({id:provider.id,dim:2}), snapshot:()=>new Map<string,Float32Array>(), currentSnapshot:()=>new Map<string,Float32Array>() } as unknown as EmbeddingIndex;
setInterval(()=>{},1000); // Keep the disposable process alive until its owner kills it.
await runSessionHarvestTick({vault,search,rawProvider:provider,ollama:{baseURL:"http://127.0.0.1:11434",model:"fixture"},embIdx:()=>index},Number(process.argv[2]));
