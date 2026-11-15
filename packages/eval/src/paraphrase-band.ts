/**
 * The 0.80–0.99 containment band, enumerated — raw material for #325's gold set.
 *
 * #300 settled the collision criterion at containment 1.0, which is the end of
 * the scale rather than a chosen constant, and that is why it could ship without
 * anyone picking a number. #325 is what 1.0 leaves behind: real paraphrase
 * collisions sit at 0.80–0.99, and so do template triggers whose only difference
 * is a proper name. Both classes live in the same band, so no threshold placed
 * inside it separates them.
 *
 * Before a criterion can be evaluated, the pairs have to exist as a list. That
 * is all this does: enumerate every trigger pair in the band, with the tokens
 * that differ, so a human can label them. It deliberately does NOT classify —
 * #325 asks for a gold set first and a criterion measured against it second,
 * and a harness that guesses the answer it is meant to check is worthless.
 *
 * PAIRING MIRRORS PRODUCTION: only triggers inside the same scope×type pool are
 * compared, because that is the only place `save-quality` can ever see a
 * collision (`save-quality.ts:338`). Comparing across pools would produce pairs
 * that the real criterion cannot reach, and a gold set full of unreachable
 * cases teaches the wrong thing.
 *
 * Requires the daemon to be built (`npm run build -w @bastra-recall/daemon`).
 *
 *   BASTRA_VAULT_PATH=~/vault npx tsx src/paraphrase-band.ts --out candidates.json
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { Vault } from "@bastra-recall/core";

interface SimilarityModule {
  containedIn: (text: string, inside: string) => number;
  tokens: (text: string) => string[];
}
const daemonDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../daemon/dist");
const { containedIn, tokens } = (await import(path.join(daemonDist, "save-similarity.js"))) as SimilarityModule;

interface Pair {
  /** Directed: `a` is the trigger whose words are contained in `b`. */
  a: { id: string; trigger: string };
  b: { id: string; trigger: string };
  containment: number;
  scope: string;
  type: string;
  /** Content words of `a` missing from `b` — what the containment is short by. */
  missing: string[];
  /** Content words `b` has beyond `a`. Together with `missing`, this is what a
   *  labeller reads: a name-varied template differs by exactly one token on each
   *  side, a genuine paraphrase usually differs by several unrelated ones. */
  extra: string[];
}

/**
 * Content words of `from` that `to` does not have — the tokens the containment
 * score is short by.
 *
 * `contentTokens` is private in save-similarity.ts, and reimplementing its
 * stopword list and length cut here would drift: a first version filtered at
 * three characters while the real one cuts at two, and printed "—" for pairs
 * that differed by a timestamp. So this asks the real function instead.
 * `containedIn(t, t) === 1` says t survives the content filter at all (a
 * stopword or a one-character token reduces to the empty set and scores 0);
 * `containedIn(t, to) === 0` then means it is genuinely absent from `to`.
 */
function contentDiff(from: string, to: string): string[] {
  const out: string[] = [];
  for (const t of new Set(tokens(from))) {
    if (containedIn(t, t) !== 1) continue;
    if (containedIn(t, to) === 0) out.push(t);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string, d: string): string => {
    const i = argv.indexOf(n);
    return i === -1 ? d : (argv[i + 1] ?? d);
  };
  const min = Number.parseFloat(arg("--min", "0.80"));
  const outPath = arg("--out", "");
  const vaultRoot = (process.env.BASTRA_VAULT_PATH ?? arg("--vault", "")).replace(/^~/, os.homedir());
  if (!vaultRoot) {
    console.error("FATAL: set BASTRA_VAULT_PATH or pass --vault <path>");
    process.exit(2);
  }

  const vault = new Vault(vaultRoot);
  await vault.init();

  // Same admission rules as the collision scan: obsolete and private are masked
  // from recall, so a pair involving one of them could never be reported.
  const memories = vault.list().filter((m) => {
    const fm = m.fm as { obsolete?: boolean; sensitivity?: string };
    return !fm.obsolete && fm.sensitivity !== "private";
  });

  const pools = new Map<string, Array<{ id: string; trigger: string }>>();
  for (const m of memories) {
    const key = `${m.fm.scope}\0${m.fm.type}`;
    const bucket = pools.get(key) ?? [];
    for (const trigger of m.fm.recall_when ?? []) {
      if (trigger.trim().length > 0) bucket.push({ id: m.fm.id, trigger });
    }
    pools.set(key, bucket);
  }
  const totalTriggers = [...pools.values()].reduce((n, b) => n + b.length, 0);
  console.error(`vault ${memories.length} memories, ${totalTriggers} triggers, ${pools.size} scope×type pools`);

  const seen = new Map<string, Pair>();
  let compared = 0;
  for (const [key, bucket] of pools) {
    const [scope, type] = key.split("\0");
    for (let i = 0; i < bucket.length; i++) {
      for (let j = 0; j < bucket.length; j++) {
        if (i === j || bucket[i].id === bucket[j].id) continue; // never a memory against itself
        compared += 1;
        const c = containedIn(bucket[i].trigger, bucket[j].trigger);
        // 1.0 is already reported by save-quality; below `min` is noise.
        if (c < min || c >= 1) continue;
        // Containment is directional and asymmetric, so the same two triggers can
        // land here twice with different scores. A labeller should see the pair
        // once — keep the direction that scores higher, because that is the one a
        // future criterion would fire on.
        const key = [`${bucket[i].id}\0${bucket[i].trigger}`, `${bucket[j].id}\0${bucket[j].trigger}`]
          .sort()
          .join("\x01");
        const existing = seen.get(key);
        if (existing && existing.containment >= c) continue;
        const pair: Pair = {
          a: bucket[i],
          b: bucket[j],
          containment: Number(c.toFixed(3)),
          scope,
          type,
          missing: contentDiff(bucket[i].trigger, bucket[j].trigger),
          extra: contentDiff(bucket[j].trigger, bucket[i].trigger),
        };
        seen.set(key, pair);
      }
    }
  }
  const pairs = [...seen.values()];
  console.error(`compared ${compared.toLocaleString("en-US")} ordered trigger pairs`);

  const sorted = [...pairs].sort((x, y) => y.containment - x.containment);
  // Written BEFORE the console report on purpose: the worksheet is the artifact
  // worth having, and piping the run through `head` closes stdout, kills the
  // process on SIGPIPE and used to lose the file after a two-minute scan.
  if (outPath) {
    // `label` is left empty on purpose: this file IS the gold-set worksheet, and
    // filling it in is the human step #325 asks for.
    await fs.writeFile(
      outPath,
      JSON.stringify({ band_min: min, pairs: sorted.map((p) => ({ ...p, label: "" })) }, null, 2)
    );
    console.error(`wrote ${outPath} — fill in "label" per pair: collision | template | neither`);
  }

  console.log(`\n── containment band [${min}, 1.0) ──`);
  console.log(`  distinct pairs in band: ${pairs.length}`);
  if (pairs.length === 0) {
    console.log("  nothing to label — the band is empty on this vault.");
  }

  // The shape a labeller needs first: how much do the two sides differ at all?
  // One token on each side is the name-varied template signature from #325;
  // several unrelated tokens is what a genuine paraphrase looks like.
  const oneEach = pairs.filter((p) => p.missing.length === 1 && p.extra.length === 1);
  console.log(`  differ by exactly one token on each side: ${oneEach.length}  (template signature)`);
  console.log(`  differ by more:                           ${pairs.length - oneEach.length}`);

  // A folded-containment column used to sit here, answering "how much of this
  // band is not paraphrase at all, but one phrase split over ä/ae?". It said
  // four of 38, `containedIn` folds umlauts itself since #325, and the column
  // then measured itself — always equal to `containment`, permanently reporting
  // zero. A metric that can only ever say "none" reads as "there are none"
  // rather than "this was fixed", so it is gone rather than pinned at 0.

  for (const p of sorted.slice(0, 40)) {
    console.log(`\n  ${p.containment.toFixed(2)}  [${p.scope} · ${p.type}]`);
    console.log(`    ${p.a.id}`);
    console.log(`      "${p.a.trigger}"`);
    console.log(`    ${p.b.id}`);
    console.log(`      "${p.b.trigger}"`);
    console.log(`    only in first: ${p.missing.join(", ") || "—"}   only in second: ${p.extra.join(", ") || "—"}`);
  }
  if (sorted.length > 40) console.log(`\n  … ${sorted.length - 40} more, see --out`);

  await vault.stop();
}

void main();
