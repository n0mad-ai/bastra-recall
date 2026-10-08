#!/usr/bin/env node
/** Agent-to-agent cmux sender (#1105). stdin is always agent prose, never owner evidence. */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function agentEnvelope(text, from) {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(from ?? "")) throw new Error("--from requires an agent name (letters, digits, dot, underscore, hyphen)");
  if (!text.trim() || Buffer.byteLength(text) > 64 * 1024) throw new Error("stdin requires 1–65536 bytes of agent text");
  if (/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(text)) throw new Error("stdin must not contain terminal control or directional characters; use LF newlines");
  // Keep the marker first, including when the input already has a wrapper.
  // The receiver excludes the WHOLE agent turn even if the body quotes tags.
  // One physical line remains one marked turn even without bracketed paste.
  // JSON retains multiline payloads without terminal Enter/Tab escapes.
  return `<agent-message from="${from}" transport="cmux" id="${randomUUID()}">${JSON.stringify(text)}</agent-message>`;
}

export function sendAgentMessage({ text, from, surface, workspace, print = false }, run = spawnSync) {
  const envelope = agentEnvelope(text, from);
  if (print) return envelope + "\n";
  const target = /^(?:[a-z]+:\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
  if (!target.test(surface ?? "") || !target.test(workspace ?? "")) throw new Error("explicit --surface and --workspace refs/UUIDs are required");
  const options = { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 };
  // The installed CLI's `send` decodes literal \n/\t. Raw JSON RPC avoids
  // that transform and also works on versions without the newer paste command.
  const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  let targets = { workspace_id: workspace, surface_id: surface };
  if(!uuid.test(workspace)||!uuid.test(surface)){
    const resolved=run("cmux",["--id-format","uuids","identify","--workspace",workspace,"--surface",surface,"--json"],options);
    if(resolved.error||resolved.status!==0)throw new Error("cmux target resolution failed; no Enter was sent");
    let caller;try{caller=JSON.parse(resolved.stdout).caller;}catch{throw new Error("cmux target response invalid; no Enter was sent");}
    if(!uuid.test(caller?.workspace_id??"")||!uuid.test(caller?.surface_id??"")||caller.surface_type!=="terminal")throw new Error("cmux explicit terminal target unresolved; no Enter was sent");
    targets={workspace_id:caller.workspace_id,surface_id:caller.surface_id};
  }
  const sent = run("cmux", ["rpc", "surface.send_text", JSON.stringify({ ...targets, text: envelope })], options);
  if (sent.error || sent.status !== 0) throw new Error("cmux send failed; no Enter was sent");
  const submitted = run("cmux", ["rpc", "surface.send_key", JSON.stringify({ ...targets, key: "enter" })], options);
  if (submitted.error || submitted.status !== 0) throw new Error("cmux Enter failed; marked text may remain in the target input; inspect before retrying");
  return "";
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--print") { options.print = true; continue; }
    const key = { "--from": "from", "--surface": "surface", "--workspace": "workspace" }[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--") || options[key] !== undefined) throw new Error("usage: cmux-agent-send.mjs --from <agent> [--print | --workspace <ref> --surface <ref>] < message.txt");
    options[key] = args[++i];
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("stdin exceeds 65536 bytes");
    chunks.push(chunk);
  }
  process.stdout.write(sendAgentMessage({ ...options, text: Buffer.concat(chunks).toString("utf8") }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`error: ${error.message}\n`); process.exitCode = 1; });
}
