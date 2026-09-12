/**
 * #525 — does the LIVE Homebrew formula still match the one in this repo?
 *
 * `distribution/homebrew/bastra-recall.rb` says of itself that it is the source
 * of truth for everything except `url` and `sha256`, and that every other
 * change has to be copied into n0mad-ai/homebrew-tap by hand. Nothing checked
 * whether that copying happened. It had not: the live caveat told users that
 * `bastra install all` registers "Claude Code, Claude Desktop, Cursor", leaving
 * out Codex/ChatGPT Desktop, which this repository has shipped and advertised
 * since v1.0 preparation.
 *
 * This script fetches the live formula and compares it with the repository one,
 * ignoring exactly the two lines the tap owns (`url`, `sha256`) and the header
 * comment, which deliberately differs per copy. Exit 0 when they agree, 1 when
 * they do not, 2 when the live copy could not be fetched.
 *
 * It needs the network, so it is NOT part of `npm test`; the
 * `formula-drift` workflow runs it. Fixing a reported drift means editing the
 * tap repository — never this file, and never the other way round.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  REPO_ROOT,
  REPO_FORMULA_PATH,
  LIVE_FORMULA_URL,
  formulaWithoutTapOwnedLines,
  formulaCaveatClients,
} from "./support-matrix.mjs";

const repoSource = readFileSync(resolve(REPO_ROOT, REPO_FORMULA_PATH), "utf8");

let liveSource;
try {
  const response = await fetch(LIVE_FORMULA_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  liveSource = await response.text();
} catch (err) {
  console.error(`could not fetch the live formula (${LIVE_FORMULA_URL}): ${err.message}`);
  process.exit(2);
}

const repo = formulaWithoutTapOwnedLines(repoSource).split("\n");
const live = formulaWithoutTapOwnedLines(liveSource).split("\n");

const differences = [];
for (let i = 0; i < Math.max(repo.length, live.length); i += 1) {
  if (repo[i] !== live[i]) differences.push({ line: i + 1, repo: repo[i], live: live[i] });
}

if (differences.length === 0) {
  console.log("formula in sync: the live tap matches distribution/homebrew/bastra-recall.rb");
  process.exit(0);
}

console.error(
  `formula DRIFT: ${differences.length} line(s) differ between the live tap and ${REPO_FORMULA_PATH}.`,
);
console.error("The repository copy is authoritative for everything but url/sha256 — fix the tap.\n");
for (const d of differences.slice(0, 40)) {
  console.error(`  ${d.line}`);
  console.error(`    repo: ${d.repo ?? "(absent)"}`);
  console.error(`    live: ${d.live ?? "(absent)"}`);
}

const repoClients = formulaCaveatClients(repoSource);
const liveClients = formulaCaveatClients(liveSource);
if (repoClients && liveClients && repoClients.join("|") !== liveClients.join("|")) {
  console.error(
    `\ncaveat client list: repo says [${repoClients.join(", ")}], live says [${liveClients.join(", ")}]`,
  );
}
process.exit(1);
