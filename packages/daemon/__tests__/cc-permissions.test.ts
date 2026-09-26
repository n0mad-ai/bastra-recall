/**
 * #650: the deterministic reader of the user's Claude Code permission rules —
 * real settings files as fixtures, Claude Code's precedence (deny > ask >
 * allow, across managed / user / project / local).
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bashVerdict, ruleMatches, settingsFiles } from "../src/cc-permissions.js";

const RM = "r" + "m";

function fixture(perms: Record<string, Record<string, string[]>>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "cc-perms-"));
  const out: Record<string, string> = {};
  for (const [name, p] of Object.entries(perms)) {
    out[name] = join(dir, `${name}.json`);
    writeFileSync(out[name], JSON.stringify({ permissions: p }));
  }
  return out;
}

describe("#650 — Claude Code permission rules, read the way Claude Code reads them", () => {
  it("prefix, glob, exact and bare rules", () => {
    // Revert-check: prefix match as startsWith(prefix) without the space → `rmdir x` matches `Bash(rm:*)`.
    assert.ok(ruleMatches(`Bash(${RM}:*)`, `${RM} -rf x`));
    assert.ok(ruleMatches(`Bash(${RM}:*)`, RM));
    assert.equal(ruleMatches(`Bash(${RM}:*)`, `${RM}dir x`), false);
    assert.ok(ruleMatches(`Bash(${RM} -rf *)`, `${RM} -rf build`));
    assert.equal(ruleMatches(`Bash(${RM} -rf *)`, `${RM} -r build`), false);
    assert.ok(ruleMatches("Bash", "anything"));
    assert.ok(ruleMatches("Bash(ls)", "ls"));
    assert.equal(ruleMatches("Bash(ls)", "ls -la"), false);
    assert.equal(ruleMatches("Read(**)", "ls"), false);
  });

  it("deny beats ask beats allow, whichever file each is in (managed, user, project, local)", () => {
    // Revert-check: return the first matching rule in file order → the managed allow wins over the local deny.
    const f = fixture({
      managed: { allow: [`Bash(${RM}:*)`] },
      user: { ask: [`Bash(${RM}:*)`] },
      local: { deny: [`Bash(${RM} -rf /:*)`] },
    });
    const files = [f.managed, f.user, f.local];
    assert.deepEqual(bashVerdict(`${RM} -rf /`, files), { verdict: "deny", rule: `Bash(${RM} -rf /:*)`, file: f.local });
    assert.equal(bashVerdict(`${RM} -rf build`, files).verdict, "ask");
    assert.equal(bashVerdict(`${RM} -rf build`, [f.managed]).verdict, "allow");
    assert.equal(bashVerdict("ls", files).verdict, "none");
  });

  it("a compound command: any part denied or asked decides; allow needs every part", () => {
    // Revert-check: allow when SOME part is allowed → `rm -rf x && curl …` reads as allowed.
    const f = fixture({ user: { allow: [`Bash(${RM}:*)`], ask: ["Bash(curl:*)"] } });
    assert.equal(bashVerdict(`cd x && ${RM} -rf y`, [f.user]).verdict, "none");
    assert.equal(bashVerdict(`${RM} -rf y && curl -s z`, [f.user]).verdict, "ask");
    assert.equal(bashVerdict(`${RM} -rf y; ${RM} z`, [f.user]).verdict, "allow");
  });

  it("re-reads a file whose mtime changed, keeps nothing for a file that went away", () => {
    // Revert-check: cache without the mtime comparison → the edited rule is not seen.
    const f = fixture({ user: { ask: [`Bash(${RM}:*)`] } });
    assert.equal(bashVerdict(`${RM} x`, [f.user]).verdict, "ask");
    writeFileSync(f.user, JSON.stringify({ permissions: { deny: [`Bash(${RM}:*)`] } }));
    utimesSync(f.user, new Date(), new Date(Date.now() + 5000));
    assert.equal(bashVerdict(`${RM} x`, [f.user]).verdict, "deny");
    assert.equal(bashVerdict(`${RM} x`, [join(tmpdir(), "missing-settings.json")]).verdict, "none");
  });

  it("the files: managed first, CLAUDE_CONFIG_DIR for the user one, project and local under cwd", () => {
    // Revert-check: drop settings.local.json from settingsFiles → it has 3 files, not 4.
    const dir = mkdtempSync(join(tmpdir(), "cc-files-"));
    mkdirSync(join(dir, ".claude"));
    const files = settingsFiles(dir, { CLAUDE_CONFIG_DIR: "/cfg" });
    assert.equal(files.length, 4);
    assert.match(files[0], /managed-settings\.json$/);
    assert.equal(files[1], "/cfg/settings.json");
    assert.deepEqual(files.slice(2), [join(dir, ".claude", "settings.json"), join(dir, ".claude", "settings.local.json")]);
  });
});
