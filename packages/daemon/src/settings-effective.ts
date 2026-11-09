/** Presentation uses the same precedence rules as the existing runtime. */
import { isOffValue, isOnValue } from "./env.js";
import { archiveCap, archiveMaxItem, retainDays } from "./rm-archive-reconcile.js";
import { settingEntries, storedSetting, type CliSettings, type SettingEntry } from "./settings-registry.js";

export function effectiveSetting(entry: SettingEntry, settings: CliSettings, env: NodeJS.ProcessEnv = process.env): { value: unknown; envNames: string[] } {
  const stored = storedSetting(settings,entry);
  let value = stored ?? entry.default;
  const names = entry.env ? [entry.env] : [];
  if (entry.key === "generation.model") names.push("BASTRA_RERANK_MODEL");
  if (entry.key === "telemetry.enabled") names.push("NEXUS_TELEMETRY");
  let envNames = names.filter(name => env[name] !== undefined && env[name] !== "");
  let raw = envNames.length ? env[envNames[0]] : undefined;
  if(entry.key === "tasks.enabled" && env.BASTRA_TASKS !== undefined) envNames=["BASTRA_TASKS"];
  if(entry.key === "generation.model") {
    const name=env.BASTRA_EXPAND_MODEL !== undefined ? "BASTRA_EXPAND_MODEL" : "BASTRA_RERANK_MODEL";
    raw=env[name];envNames=raw?.trim()?[name]:[];
  }
  if (entry.key === "update.mode") { if (isOffValue(raw)) value = "off"; }
  else if (entry.key === "embedding.provider") {
    const requested = raw && ["none","openai","ollama"].includes(raw.toLowerCase()) ? raw.toLowerCase() : stored ?? "none";
    value = requested === "openai" && !(env.OPENAI_API_KEY ?? env.BASTRA_EMBEDDING_KEY) ? "none" : requested;
  }
  else if (entry.key === "generation.model") value = raw !== undefined ? raw.trim() || value : value;
  else if (entry.key === "tasks.enabled") { if (env.BASTRA_TASKS !== undefined) value = env.BASTRA_TASKS === "1"; }
  else if (entry.key === "telemetry.enabled" || entry.key === "reflex.enabled") { if(raw !== undefined) value = !isOffValue(raw); }
  else if (["evidenceGate.enabled","battery.saver","promptImpact.enabled","coverageMap.enabled","archive.enabled"].includes(entry.key)) {
    if (isOnValue(raw)) value = true; else if (isOffValue(raw)) value = false;
  }
  else if (entry.key === "reflex.maxPerTurn") {
    const parsed = raw === undefined ? Number(value) : Number.parseInt(raw,10);
    value = Math.min(5,Math.max(1,Number.isFinite(parsed) ? Math.trunc(parsed) : Number(value)));
  }
  else if (entry.key === "cors.origins") { if(raw) value=raw.split(",").map(v=>v.trim()).filter(Boolean); }
  else if (entry.key === "archive.retain") { const r=retainDays(env,typeof stored==="string"?stored:undefined);value=`junk=${r.junk},in-git=${r["in-git"]},user=${r.user}`; }
  else if (entry.key === "archive.cap") value=archiveCap(env,typeof stored==="string"?stored:undefined);
  else if (entry.key === "archive.max-item") value=archiveMaxItem(env,typeof stored==="string"?stored:undefined);
  else if (entry.key === "size.guide" || entry.key === "size.critical") {
    const storedNumber=typeof stored === "number" && stored >= 100 && stored <= 5000 ? Math.round(stored) : entry.default;
    const parsed = raw === undefined ? NaN : Number(raw); value=Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : storedNumber;
    if (entry.key === "size.critical") {
      const guide=settingEntries().find(e=>e.key==="size.guide")!;
      value=Math.max(Number(effectiveSetting(guide,settings,env).value),Number(value));
    }
  }
  else if (raw !== undefined) { const parsed=entry.schema.safeParse(raw); if(parsed.success)value=parsed.data; }
  return {value,envNames};
}
