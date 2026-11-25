/**
 * #222 — a broken FIELD must not cost the whole node. Reported by zzallirog:
 * 28 editor-written notes dropped at daemon load, and the only trace was a
 * `console.warn` a launchd-started daemon never shows anyone.
 *
 * The causes split into two layers, and the issue text only names the second:
 *
 *   A. YAML never parses at all — unknown escape sequences inside double-quoted
 *      values (`"it\'s"`), and unquoted scalars containing `:` or `·`. These
 *      throw out of gray-matter, so `parseMemoryWith` never sees a `data`
 *      object. 24 of the 28 reported files are this class.
 *   B. YAML parses but the frontmatter is incomplete — missing required keys.
 *      4 of the 28.
 *
 * Structural strictness stays: no frontmatter, or no recognizable `type:`, is
 * still NotAMemoryFile. Everything below that is a flagged degradation.
 *
 * Runner: `tsx --test __tests__/loader-field-leniency.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import matter from "gray-matter";
import { parseMemoryWith, NotAMemoryFile } from "../src/schema.js";
import { rescueFrontmatter } from "../src/frontmatter-rescue.js";
import { computeStaleness, pastValidUntil } from "../src/search-staleness.js";

const parse = (raw: string, path = "/vault/memories/note.md", mtime = Date.UTC(2026, 4, 17)) =>
  parseMemoryWith((input) => matter(input), raw, path, mtime);

test("A: an unknown escape sequence costs its own field, not the node", () => {
  const m = parse(
    `---\nid: note\ntitle: "it\\'s here"\ntype: lesson\nsummary: Intakte Zusammenfassung\ntopic_path: [a]\ntags: [t]\nscope: s\nrecall_when: ["wenn x"]\ncreated: 2026-05-01\nupdated: 2026-05-01\n---\nDer Body bleibt.`
  );
  assert.equal(m.fm.id, "note");
  assert.equal(m.fm.summary, "Intakte Zusammenfassung", "the healthy fields must survive intact");
  assert.deepEqual(m.fm.recall_when, ["wenn x"]);
  assert.match(m.body, /Der Body bleibt/);
  assert.ok(
    m.damaged?.some((d) => d.field === "title"),
    `title should be flagged, got ${JSON.stringify(m.damaged)}`
  );
  assert.ok(m.fm.title.length > 0, "a damaged title still needs some value");
});

test("A: an unquoted value containing a colon or a middot costs its own field only", () => {
  const m = parse(
    `---\nid: note\ntitle: Titel bleibt\ntype: lesson\nsummary: Foo · Bar: baz\ntopic_path: [a]\ntags: [t]\nscope: s\nrecall_when: ["wenn x"]\ncreated: 2026-05-01\nupdated: 2026-05-01\n---\nbody`
  );
  assert.equal(m.fm.title, "Titel bleibt");
  assert.equal(m.fm.scope, "s");
  assert.ok(m.damaged?.some((d) => d.field === "summary"));
});

test("A: multi-line blocks survive the rescue — a list is not torn apart by a broken neighbour", () => {
  const m = parse(
    `---\nid: note\ntitle: "bad\\'escape"\ntype: lesson\nsummary: ok\ntopic_path:\n  - alpha\n  - beta\ntags:\n  - eins\n  - zwei\nscope: s\nrecall_when:\n  - erster trigger\n  - zweiter trigger\ncreated: 2026-05-01\nupdated: 2026-05-01\n---\nbody`
  );
  assert.deepEqual(m.fm.topic_path, ["alpha", "beta"], "the list after the broken field must stay whole");
  assert.deepEqual(m.fm.tags, ["eins", "zwei"]);
  assert.deepEqual(m.fm.recall_when, ["erster trigger", "zweiter trigger"]);
  assert.ok(m.damaged?.some((d) => d.field === "title"));
});

test("B: missing required keys are filled from what is knowable, and flagged", () => {
  const m = parse(`---\nid: note\ntype: lesson\n---\nErste Zeile des Bodys.\n\nZweiter Absatz.`);
  assert.equal(m.fm.id, "note");
  assert.equal(m.fm.type, "lesson");
  assert.ok(m.fm.title.length > 0);
  assert.ok(m.fm.summary.length > 0);
  assert.ok(m.fm.topic_path.length > 0);
  assert.ok(m.fm.tags.length > 0);
  assert.ok(m.fm.scope.length > 0);
  assert.ok(m.fm.recall_when.length > 0);
  assert.ok(m.fm.created, "created must be derivable from the file mtime");
  const fields = new Set(m.damaged?.map((d) => d.field));
  for (const f of ["title", "summary", "topic_path", "tags", "scope", "recall_when"]) {
    assert.ok(fields.has(f), `${f} should be flagged as degraded, got ${[...fields].join(",")}`);
  }
});

test("B: a missing id falls back to the filename, so the node keeps a stable identity", () => {
  const m = parse(
    `---\ntitle: Ohne id\ntype: lesson\nsummary: s\ntopic_path: [a]\ntags: [t]\nscope: s\nrecall_when: [x]\ncreated: 2026-05-01\nupdated: 2026-05-01\n---\nbody`,
    "/vault/memories/Mein Merk-Satz.md"
  );
  assert.equal(m.fm.id, "mein-merk-satz");
  assert.ok(m.damaged?.some((d) => d.field === "id"));
});

test("a healthy file is untouched — no damaged marker, no behaviour change", () => {
  const m = parse(
    `---\nid: clean\ntitle: Sauber\ntype: lesson\nsummary: Alles gut\ntopic_path: [a, b]\ntags: [t]\nscope: proj\nrecall_when: ["wenn y"]\ncreated: 2026-05-01\nupdated: 2026-05-02\n---\nbody text`
  );
  assert.equal(m.damaged, undefined, "a healthy memory must carry no damage marker at all");
  assert.equal(m.fm.title, "Sauber");
  assert.deepEqual(m.fm.topic_path, ["a", "b"]);
  assert.equal(m.fm.created, "2026-05-01");
  assert.equal(m.fm.updated, "2026-05-02");
});

test("structural strictness stays: no frontmatter and no recognizable type are still NotAMemoryFile", () => {
  assert.throws(() => parse("Just a plain Obsidian note.\n"), NotAMemoryFile);
  assert.throws(() => parse(`---\nid: x\ntitle: T\n---\nbody`), NotAMemoryFile, "no type: → not a memory");
  assert.throws(() => parse(`---\nid: x\ntype: notatype\n---\nbody`), NotAMemoryFile);
});

test("structural strictness stays through the rescue path too — a type that only survives as garbage is not a memory", () => {
  // The whole frontmatter is unparseable AND carries no usable `type:`.
  assert.throws(() => parse(`---\ntitle: "a\\'b"\nfoo: [unclosed\n---\nbody`), NotAMemoryFile);
});

test("a type that is only readable after the rescue still identifies the memory", () => {
  const m = parse(
    `---\ntitle: "kaputt\\'hier"\ntype: decision\nid: rescued\nsummary: s\ntopic_path: [a]\ntags: [t]\nscope: s\nrecall_when: [x]\ncreated: 2026-05-01\nupdated: 2026-05-01\n---\nbody`
  );
  assert.equal(m.fm.type, "decision");
  assert.equal(m.fm.id, "rescued");
});

test("an id that is present but path-unsafe is repaired rather than dropped", () => {
  const m = parse(
    `---\nid: ../../etc/passwd\ntitle: T\ntype: lesson\nsummary: s\ntopic_path: [a]\ntags: [t]\nscope: s\nrecall_when: [x]\ncreated: 2026-05-01\nupdated: 2026-05-01\n---\nbody`,
    "/vault/memories/safe-name.md"
  );
  assert.equal(m.fm.id, "safe-name", "a path-unsafe id must not reach the filesystem layer");
  assert.ok(m.damaged?.some((d) => d.field === "id"));
});

test("damaged entries name the field and carry a reason a human can act on", () => {
  const m = parse(
    `---\nid: note\ntitle: "x\\'y"\ntype: lesson\nsummary: ok\ntopic_path: [a]\ntags: [t]\nscope: s\nrecall_when: [x]\ncreated: 2026-05-01\nupdated: 2026-05-01\n---\nbody`
  );
  const entry = m.damaged?.find((d) => d.field === "title");
  assert.ok(entry);
  assert.ok(entry!.reason.length > 0, "a bare flag without a reason is not actionable");
});

test("A: a column-zero list is not torn off its key by an item that contains a colon", () => {
  // #365/9. The entry splitter started a new top-level entry on any line whose
  // first character is not whitespace and that contains a `:` — which a list
  // item written at column zero (`- "when the daemon: restarts"`) satisfies.
  // The key `recall_when:` was then left alone and parsed as `null`, and the
  // orphaned list parsed as an ARRAY that got Object.assign'd over the data
  // map. zod strips the resulting `"0"`/`"1"` keys, so nothing visibly broke:
  // the authored triggers were simply gone, and the damage report claimed
  // "missing recall_when" — pointing the user at a field they had written.
  // Obsidian and hand-written frontmatter put lists at column zero routinely;
  // Bastra's own writer indents, which is why this never showed up in-house.
  const m = parse(
    `---\nid: note\ntitle: "bad\\'escape"\ntype: lesson\nsummary: ok\ntopic_path: [a]\ntags: [t]\nscope: s\nrecall_when:\n- "when the daemon: restarts"\n- second trigger\ncreated: 2026-05-01\nupdated: 2026-05-01\n---\nbody`
  );
  assert.deepEqual(
    m.fm.recall_when,
    ["when the daemon: restarts", "second trigger"],
    "the authored triggers must survive the rescue"
  );
  assert.ok(
    !m.damaged?.some((d) => d.field === "recall_when"),
    `an intact field must not be reported as damaged, got ${JSON.stringify(m.damaged)}`
  );
  assert.ok(
    m.damaged?.some((d) => d.field === "title"),
    "the actually broken field is still flagged"
  );
});

test("#613: a `__proto__` entry in a rescued fragment cannot smuggle fields past data's own keys", () => {
  // The exact repro from #613: the whole block fails full-document YAML
  // parsing (the bad escape in `title`), so the rescue re-parses entry by
  // entry — and one entry is `__proto__:`. js-yaml hands that back as an OWN
  // key on the fragment, but `Object.assign(data, parsed)` writes through
  // `data`'s `[[Set]]`: since `data` has no own `__proto__`, the assignment
  // hits `Object.prototype`'s `__proto__` accessor and replaces data's
  // prototype instead of creating an own property. `id` and `sensitivity` are
  // never written anywhere else in this frontmatter, so a reader using dot
  // access (schema validation, `repairRequired`'s presence checks) picks up
  // the smuggled values through the prototype chain while every check that
  // enumerates own keys sees a clean frontmatter.
  const m = parse(
    `---\ntitle: "kaputt\\'hier"\ntype: lesson\nsummary: ok\ntopic_path: [a]\ntags: [t]\nscope: s\nrecall_when: [x]\ncreated: 2026-05-01\nupdated: 2026-05-01\n__proto__:\n  sensitivity: public\n  id: someone-elses-id\n---\nbody`,
    "/vault/memories/safe-name.md"
  );
  assert.notEqual(m.fm.id, "someone-elses-id", "a __proto__ entry must not smuggle an id nobody wrote");
  assert.notEqual(m.fm.sensitivity, "public", "a __proto__ entry must not smuggle a sensitivity nobody wrote");
  assert.equal(m.fm.id, "safe-name", "the id must fall back to the filename, exactly as a genuinely missing id would");
  assert.ok(
    m.damaged?.some((d) => d.field === "id"),
    "a smuggled-then-dropped id must still be flagged as repaired"
  );
});

test("#613: rescueFrontmatter never lets a `__proto__` entry change data's own prototype", () => {
  const boom = (): never => {
    throw new Error("forced into the rescue path");
  };
  const rescued = rescueFrontmatter(
    boom as unknown as Parameters<typeof rescueFrontmatter>[0],
    `---\ntitle: note\n__proto__:\n  sensitivity: public\n  id: someone-elses-id\n---\nbody\n`
  );
  assert.ok(rescued, "a delimited block is rescuable");
  assert.equal(Object.getPrototypeOf(rescued!.data), Object.prototype, "data's prototype must never change");
  assert.equal((rescued!.data as Record<string, unknown>).sensitivity, undefined, "no inherited sensitivity");
  assert.equal((rescued!.data as Record<string, unknown>).id, undefined, "no inherited id");
  assert.deepEqual(Object.keys(rescued!.data), ["title"], "the __proto__ entry must not appear as an own key either");
});

test("#613: `constructor` and `prototype` entries are ordinary own keys, not a pollution vector", () => {
  // Unlike `__proto__`, `constructor` and `prototype` are plain DATA
  // properties on Object.prototype (or absent entirely, for `prototype`), so
  // assigning them onto a plain object just shadows them as normal own
  // properties — enumerable and dot-accessible alike. No special handling
  // needed; this test pins that down so a future change cannot regress it.
  const boom = (): never => {
    throw new Error("forced into the rescue path");
  };
  const rescued = rescueFrontmatter(
    boom as unknown as Parameters<typeof rescueFrontmatter>[0],
    `---\nconstructor: not a function\nprototype: not a prototype\n---\nbody\n`
  );
  assert.ok(rescued);
  assert.deepEqual(Object.keys(rescued!.data).sort(), ["constructor", "prototype"]);
  assert.equal(rescued!.data.constructor, "not a function");
  assert.equal(rescued!.data.prototype, "not a prototype");
});

test("a key that starts with a dash is still a key, and no list ever leaks in as `0`/`1` entries", () => {
  // Guarding the split with "a line starting `- ` is a list item" must not
  // swallow a legitimate key whose name begins with a dash, and the array
  // guard in the assign is the belt to that braces: an Object.assign of a
  // list would write positional `"0"`, `"1"` keys into the frontmatter.
  const boom = (): never => {
    throw new Error("forced into the rescue path");
  };
  const rescued = rescueFrontmatter(
    boom as unknown as Parameters<typeof rescueFrontmatter>[0],
    `---\n-notakey: still a key\ntags:\n- "a: b"\n- c\n---\nbody\n`
  );
  assert.ok(rescued, "a delimited block is rescuable");
  assert.equal(rescued!.data["-notakey"], "still a key");
  assert.deepEqual(rescued!.data.tags, ["a: b", "c"]);
  assert.ok(!("0" in rescued!.data), `positional keys must never reach the data map: ${JSON.stringify(rescued!.data)}`);
});

test("#1720: an `updated` that is no date is taken from the file mtime; the note stays loaded", () => {
  const note = (updated: string) =>
    `---\nid: note\ntitle: T\ntype: lesson\nsummary: s\ntopic_path: [a]\ntags: [t]\nscope: s\nrecall_when: [x]\ncreated: 2026-05-01\nupdated: ${updated}\n---\nbody`;
  // mtime of `parse`: 2026-05-17; js-yaml would roll 2026-02-31 into 2026-03-03
  for (const bad of ["false", "[invalid]", "2026-02-31", "2026-02-31T10:00:00Z", "2026-13-01", "20260501"]) {
    const m = parse(note(bad));
    assert.equal(m.fm.updated, "2026-05-17", bad);
    assert.ok(
      m.damaged?.some((d) => d.field === "updated"),
      `${bad} is flagged`
    );
    assert.equal(m.fm.summary, "s", "the other fields stay as written");
  }
  for (const [good, day] of [
    ["2026-05-02", "2026-05-02"],
    ["2024-02-29", "2024-02-29"],
    ["2026-05-01T23:30:00-02:00", "2026-05-02"],
    ['"2026-05-02"', "2026-05-02"],
    ['"not a date"', "not a date"],
  ]) {
    const m = parse(note(good));
    assert.equal(m.fm.updated, day, `${good} keeps its value; a non-date string is left to the Recall formatter`);
    assert.equal(m.damaged, undefined, good);
  }
  assert.throws(() => parse(note("2026-05-01").replace("created: 2026-05-01", "created: false")), /created/);
});

// #1731: every YAML spelling of an impossible calendar day, in every date field the loader repairs.
// Each line replaces the field's own line; `{f}` is the field's key.
const IMPOSSIBLE_DATE_LINES = [
  "{f}: 2026-02-31",
  '"{f}": 2026-02-31',
  "'{f}': 2026-02-31",
  "{f} : 2026-02-31",
  "{f}: 2026-02-31 # written by hand",
  "{f}: 2026-04-31",
  "{f}: 2026-13-01",
  "{f}: 2100-02-29",
  "{f}: 0026-05-01",
  "{f}: 2026-02-31T10:00:00Z",
  "{f}: 2026-2-31 1:00:00",
  '"{f}" : 2026-2-31 1:00:00 # comment',
  "{f}: 2026-05-01T24:00:00Z",
  '{f}: "2026-02-31"',
  "{f}: '2026-02-30T10:00:00Z'",
  // #1737: a quoted early year outside the ISO format, which `Date.parse` maps into the 1900s.
  "{f}: '0099-3-1'",
  // #1737: a folded time line, explicit tags and an alias to an anchored timestamp.
  "{f}: 2026-02-31\n  12:30:00Z",
  "{f}: 2026-05-01\n  24:00:00Z",
  '{f}: !!timestamp "2026-02-31"',
  String.raw`{f}: !!timestamp "2026-02-\x33\x31"`,
  "{f}: !!timestamp '2026-02-30T10:00:00Z'",
  "{f}: !<tag:yaml.org,2002:timestamp> 2026-02-31",
  "{f}: !!timestamp >-\n  2026-02-31",
  "x_when: &when 2026-02-31\n{f}: *when",
  '{f}: &when !!timestamp "2026-02-31"',
];
const VALID_DATE_LINES: Array<[line: string, day: string]> = [
  ["{f}: 2024-02-29", "2024-02-29"],
  ["{f}: 2000-02-29", "2000-02-29"],
  ['"{f}" : 2026-05-02 # comment', "2026-05-02"],
  ["{f}: 2026-5-2 1:00:00", "2026-05-02"],
  ["{f}: 2026-05-01T23:30:00-02:00", "2026-05-02"],
  ["{f}: 1999-12-31", "1999-12-31"],
  ['{f}: "2026-05-02"', "2026-05-02"],
  // #1737: a quoted early year in the ISO format keeps its year; only YAML's unquoted reading moves it.
  ["{f}: '0099-03-01'", "0099-03-01"],
  ['{f}: "0026-05-01T10:00:00Z"', "0026-05-01T10:00:00Z"],
  ["{f}: 2026-05-01\n  23:30:00-02:00", "2026-05-02"],
  ['{f}: !!timestamp "2026-05-02"', "2026-05-02"],
  ["x_when: &when 2026-05-02\n{f}: *when", "2026-05-02"],
];
const datedNote = (field: string, line: string) =>
  [
    "---",
    "id: note",
    "title: T",
    "type: lesson",
    "summary: s",
    "topic_path: [a]",
    "tags: [t]",
    "scope: s",
    "recall_when: [x]",
    field === "created" ? line.replace("{f}", field) : "created: 2026-05-01",
    field === "updated" ? line.replace("{f}", field) : "updated: 2026-05-03",
    ...(field === "last_reviewed_at" ? [line.replace("{f}", field)] : []),
    "---",
    "body",
  ].join("\n");

test("valid date-only frontmatter needs just one YAML parse", (t) => {
  const { yaml } = (matter as unknown as { engines: { yaml: { parse: (input: string) => unknown } } }).engines;
  const parseYaml = t.mock.method(yaml, "parse");
  const raw = datedNote("last_reviewed_at", '"last_reviewed_at" : 2024-02-29 # leap day');
  const memory = parse(raw);
  assert.equal(memory.fm.last_reviewed_at, "2024-02-29");
  assert.equal(memory.damaged, undefined);
  assert.equal(parseYaml.mock.callCount(), 1);
});

for (const [field, fallback] of [
  ["updated", "2026-05-17"],
  ["created", "2026-05-17"],
  ["last_reviewed_at", undefined],
] as const) {
  for (const line of IMPOSSIBLE_DATE_LINES) {
    test(`#1731: an impossible \`${field}\` day never rolls over — ${line}`, () => {
      const m = parse(datedNote(field, line));
      assert.equal(m.fm[field], fallback, `${line}: falls back instead of rolling`);
      assert.ok(
        m.damaged?.some((d) => d.field === field),
        `${line}: the fallback is diagnosed, got ${JSON.stringify(m.damaged)}`
      );
      assert.equal(m.damaged?.length, 1, `${line}: no other field is touched`);
      assert.equal(m.fm.summary, "s");
      if (field !== "created") assert.equal(m.fm.created, "2026-05-01");
      if (field !== "updated") assert.equal(m.fm.updated, "2026-05-03");
    });
  }
  test(`#1731: a valid \`${field}\` keeps its day in every spelling and is not reported`, () => {
    for (const [line, day] of VALID_DATE_LINES) {
      const m = parse(datedNote(field, line));
      assert.equal(m.fm[field], day, `${line} keeps its day`);
      assert.equal(m.damaged, undefined, `${line} is not reported as damaged`);
    }
  });
}

test("#1731: the impossible-day check also runs when the block only loads through the rescue", () => {
  const raw = datedNote("updated", '"updated" : 2026-02-31 # c').replace("title: T", 'title: "it\\\'s"');
  const m = parse(raw);
  assert.equal(m.fm.updated, "2026-05-17");
  assert.deepEqual(m.damaged?.map((d) => d.field).sort(), ["title", "updated"]);
});

test("#1731: a second load of the same bytes reports the same repair (gray-matter caches by bytes)", () => {
  const raw = datedNote("updated", "updated: false").replace("id: note", "id: cached-note");
  const first = parse(raw, "/vault/a.md", Date.UTC(2026, 4, 17));
  const second = parse(raw, "/vault/b.md", Date.UTC(2026, 4, 18));
  assert.equal(first.fm.updated, "2026-05-17");
  assert.equal(second.fm.updated, "2026-05-18", "the first load's fallback must not leak into the second");
  assert.ok(second.damaged?.some((d) => d.field === "updated"));
});

test("#1731: a valid `valid_until` loads as written and is not reported", () => {
  const m = parse(datedNote("last_reviewed_at", "valid_until: 2026-05-20"));
  assert.equal(m.fm.valid_until, "2026-05-20");
  assert.equal(m.damaged, undefined);
});

test("#1731: an impossible `valid_until` keeps its rolled expiry and is reported", () => {
  // Owner decision pending in #1731: dropping the expiry would serve an expired note again, so the
  // value and its delivery stay exactly as before; only the diagnosis is new.
  const now = new Date("2026-11-25T12:00:00Z");
  for (const [line, loaded] of [
    ["valid_until: 2026-02-31", "2026-03-03"],
    ['valid_until: "2026-02-31"', "2026-02-31"],
    ["valid_until: !!timestamp '2026-02-31'", "2026-03-03"],
  ]) {
    const m = parse(datedNote("last_reviewed_at", line));
    assert.equal(m.fm.valid_until, loaded, `${line}: the value is unchanged`);
    assert.equal(pastValidUntil(m.fm, now), true, `${line}: still expired, so hooks keep withholding it`);
    assert.equal(computeStaleness(m.fm, now), "expired", line);
    assert.deepEqual(
      m.damaged?.map((d) => d.field),
      ["valid_until"],
      `${line}: the typo is reported, got ${JSON.stringify(m.damaged)}`
    );
  }
});
