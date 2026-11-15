/**
 * file-size-check (PreToolUse-Hook) — die Datei-Größen-Konvention wird
 * deterministisch gemessen statt erinnert. Runner:
 * tsx --test __tests__/file-size-check.test.ts
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thresholdsFor, formatSizeNote, fileSizeNote } from "../src/file-size-check.js";

afterEach(() => {
  delete process.env.BASTRA_SIZE_CHECK;
  delete process.env.BASTRA_SIZE_GUIDE;
  delete process.env.BASTRA_SIZE_CRITICAL;
});

test("thresholds: code files 500/800, test files 700/1000, non-code exempt", () => {
  assert.deepEqual(thresholdsFor("/x/app.js"), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/view.tsx"), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/__tests__/foo.test.ts"), { guide: 700, critical: 1000 });
  assert.equal(thresholdsFor("/x/README.md"), null);
  assert.equal(thresholdsFor("/x/package-lock.json"), null);
});

test("env override moves the guide value (onboarding hook), tests stay fixed", () => {
  process.env.BASTRA_SIZE_GUIDE = "300";
  assert.deepEqual(thresholdsFor("/x/app.js"), { guide: 300, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/a.test.ts"), { guide: 700, critical: 1000 });
});

test("note fires from ~90% of guide, escalates past critical, silent below", () => {
  const t = { guide: 500, critical: 800 };
  assert.equal(formatSizeNote("/x/app.js", 200, t), null);
  assert.equal(formatSizeNote("/x/app.js", 449, t), null);
  const nearNote = formatSizeNote("/x/app.js", 460, t);
  assert.ok(nearNote?.includes('level="guide"') && nearNote.includes('lines="460"'));
  const critNote = formatSizeNote("/x/app.js", 950, t);
  assert.ok(critNote);
  assert.ok(critNote.includes('level="critical"') && critNote.includes("review whether coherent responsibilities"));
  assert.ok(critNote.includes("not a growth ban"));
  assert.ok(nearNote?.includes("review modularization"));
});

test("throwaway contexts are exempt, ordinary source of the same shape is not (#280)", () => {
  // Directory segments…
  assert.equal(thresholdsFor("/x/sandbox/anims.js"), null);
  assert.equal(thresholdsFor("/x/webui/lab/anims.js"), null);
  assert.equal(thresholdsFor("/x/experiments/orbit/view.tsx"), null);
  assert.equal(thresholdsFor("/x/scratch/foo.py"), null);
  assert.equal(thresholdsFor("/x/prototypes/foo.rs"), null);
  assert.equal(thresholdsFor("/x/sandbox/foo.test.ts"), null, "sandbox beats the test-file branch");
  assert.equal(thresholdsFor("\\x\\sandbox\\anims.js"), null, "windows separators normalize");
  // …and the reported basename case.
  assert.equal(thresholdsFor("/x/webui/mindspace-lab-anims.js"), null);
  assert.equal(thresholdsFor("/x/scratch-pad.js"), null);

  // The regression that counts: whole-segment / delimiter-bounded matching, so
  // ordinary code with those letters inside a word keeps the convention.
  assert.deepEqual(thresholdsFor("/x/collaboration/view.tsx"), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/labels/view.tsx"), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/collab-view.ts"), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/foo-labels.ts"), { guide: 500, critical: 800 });
  assert.deepEqual(
    thresholdsFor("/x/prototype-utils.ts"),
    { guide: 500, critical: 800 },
    "Object.prototype is production code"
  );
});

test("throwaway directories count only BELOW the project anchor, never above it", () => {
  // A checkout that merely LIVES under ~/labs must keep the convention — the
  // ancestor segment is none of the project's business.
  const cwd = "/users/x/labs/myapp";
  assert.deepEqual(thresholdsFor(`${cwd}/src/view.tsx`, {}, cwd), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor(`${cwd}/packages/daemon/src/http.ts`, {}, cwd), { guide: 500, critical: 800 });
  assert.deepEqual(
    thresholdsFor("/users/x/scratch/myapp/src/view.tsx", {}, "/users/x/scratch/myapp/"),
    { guide: 500, critical: 800 },
    "a trailing slash on the anchor changes nothing"
  );
  // Project-INTERNAL throwaway dirs stay exempt, and so does the reported case.
  assert.equal(thresholdsFor(`${cwd}/labs/anims.js`, {}, cwd), null);
  assert.equal(thresholdsFor(`${cwd}/webui/sandbox/anims.js`, {}, cwd), null);
  assert.equal(thresholdsFor(`${cwd}/packages/daemon/webui/mindspace-lab-anims.js`, {}, cwd), null);
  // Anchor that does not contain the file → no anchor at all, old behaviour.
  assert.equal(thresholdsFor(`${cwd}/src/view.tsx`, {}, "/users/x/other"), null);
  assert.equal(thresholdsFor(`${cwd}/src/view.tsx`), null);
});

test("size.exemptPaths from cli-settings silences extra paths, nothing else", () => {
  const settings = { exemptPaths: ["webui/mindspace", "  ", "PACKAGES/Daemon/Demo"] };
  assert.equal(thresholdsFor("/x/webui/mindspace/orbit.js", settings), null);
  assert.equal(thresholdsFor("/x/packages/daemon/demo/app.js", settings), null, "match is case-insensitive");
  assert.deepEqual(thresholdsFor("/x/webui/js/app.js", settings), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/webui/js/app.js", { exemptPaths: [] }), { guide: 500, critical: 800 });
});

test("exempt paths stay silent end-to-end while the same file elsewhere warns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-exempt-"));
  try {
    const body = Array.from({ length: 1299 }, (_, i) => `const value${i} = ${i};`).join("\n");
    const lab = join(dir, "mindspace-lab-anims.js");
    const sandboxDir = join(dir, "sandbox");
    const plain = join(dir, "anims.js");
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(lab, body, "utf8");
    await writeFile(join(sandboxDir, "anims.js"), body, "utf8");
    await writeFile(plain, body, "utf8");

    // Every call carries the tmp settingsPath — without it the test would read
    // the developer's real ~/.bastra/cli-settings.json and fail on any machine
    // with a raised size.critical or a wide size.exemptPaths. The file does not
    // exist yet at this point, which is exactly the built-in 500/800 default.
    const settingsPath = join(dir, "cli-settings.json");
    assert.equal(await fileSizeNote(lab, settingsPath), null, "the reported 1299-line sandbox file must stay silent");
    assert.equal(await fileSizeNote(join(sandboxDir, "anims.js"), settingsPath), null, "sandbox/ segment stays silent");
    const note = await fileSizeNote(plain, settingsPath);
    assert.ok(note?.includes('level="critical"'), "identical file outside a sandbox still warns");

    // The anchor reaches the hook entry point: with sandbox/ AS the project
    // root it is an ancestor, not a project-internal throwaway directory.
    const anchored = await fileSizeNote(join(sandboxDir, "anims.js"), settingsPath, sandboxDir);
    assert.ok(anchored?.includes('level="critical"'), "the project root itself is never a sandbox segment");

    await writeFile(settingsPath, JSON.stringify({ size: { exemptPaths: [dir] } }), "utf8");
    assert.equal(await fileSizeNote(plain, settingsPath), null, "settings exemption reaches the hook entry point");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("fileSizeNote measures real files; new files and kill-switch stay silent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-"));
  try {
    // Every call passes an explicit settingsPath: without one, readSizeSettings
    // falls back to the developer's real ~/.bastra/cli-settings.json, and a
    // size.critical raised past 900 — or, since #280, any size.exemptPaths
    // entry that happens to be a substring of the tmp path — turns this red on
    // one machine and green on the next.
    const settingsPath = join(dir, "cli-settings.json");
    const big = join(dir, "big.js");
    await writeFile(big, Array.from({ length: 900 }, (_, i) => `// line ${i}`).join("\n"), "utf8");
    const note = await fileSizeNote(big, settingsPath);
    assert.equal(note, null, "900 comment-only lines do not contribute code");
    await writeFile(big, Array.from({ length: 900 }, (_, i) => `const value${i} = ${i};`).join("\n"), "utf8");
    assert.ok((await fileSizeNote(big, settingsPath))?.includes('level="critical"'), "900 code lines must warn");

    assert.equal(await fileSizeNote(join(dir, "does-not-exist.js"), settingsPath), null, "new file → silent");

    process.env.BASTRA_SIZE_CHECK = "off";
    assert.equal(await fileSizeNote(big, settingsPath), null, "kill-switch silences the check");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("fileSizeNote excludes comments and blank source lines but preserves literal data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-lexical-"));
  const cases: { name: string; ext: string; source: string; lines: number; atStart?: boolean }[] = [
    { name: "empty source", ext: "ts", source: "\n \t\n", lines: 0 },
    {
      name: "JavaScript shebang is comment trivia only at the file start",
      ext: "mjs",
      source: "#!/usr/bin/env node\n// ignored\nconst end = 1;",
      lines: 1,
      atStart: true,
    },
    { name: "line and block comments", ext: "ts", source: "// ignored\n/* ignored\n still ignored */\n", lines: 0 },
    {
      name: "mixed comments and code",
      ext: "js",
      source: "/* before */ const x = 1; // after\n/* only */\n/* before\n */ const y = 2;",
      lines: 2,
    },
    {
      name: "CRLF and final newline",
      ext: "mjs",
      source: "const x = 1;\r\n// ignored\r\n\r\nconst y = 2;\r\n",
      lines: 2,
    },
    {
      name: "escaped quotes and URL markers",
      ext: "cjs",
      source: String.raw`const url = "https://example.org/*";
const text = 'it\'s /* data */';
// ignored
const end = 1;`,
      lines: 3,
    },
    {
      name: "regex character classes and escapes",
      ext: "ts",
      source: String.raw`const markers = /[/*]/;
const url = /https?:\/\/[^/*]+/;
// ignored
const quotient = 8 / 2; /* ignored */`,
      lines: 3,
    },
    {
      name: "regex after keyword",
      ext: "js",
      source: "function match() {\nreturn /[/*]/.test('x');\n}\n/* ignored */",
      lines: 3,
    },
    {
      name: "template data excluding blank lines",
      ext: "js",
      source: "const text = `\n// literal\n \t\n/* literal */\n`;\n// ignored",
      lines: 4,
    },
    {
      name: "template interpolation retains source around comments",
      ext: "ts",
      source: "const text = `\n${ /* retained */\n1 }\n`;",
      lines: 4,
    },
    {
      name: "nested templates cannot turn literal comment openers into comments",
      ext: "js",
      source: "const a = `${x ? `/* a` : ''}`;\nconst b = 1;\nconst c = 2;\n/* ignored */",
      lines: 3,
    },
    {
      name: "shell quoting with regex and nested template quotes",
      ext: "ts",
      source: "const quote = s => `'${s.replace(/'/g, `'\\\\''`)}'`;\n// ignored\n/* ignored */\nconst end = 1;",
      lines: 2,
    },
    {
      name: "nested interpolation braces and comment-only expression lines",
      ext: "ts",
      source: "const x = `${\n/* ignored */\nJSON.stringify({ a: `nested ${value}` })\n}`;\n// ignored\nconst end = 1;",
      lines: 4,
    },
    {
      name: "regex statement with quote after closing block",
      ext: "js",
      source: "function f() {}\n/'/.test(s);\n// ignored\nconst end = 1;",
      lines: 3,
    },
    {
      name: "TSX type arguments stay in JavaScript",
      ext: "tsx",
      source:
        "const [a] = useState<string>('');\n// ignored\n/* ignored */\nfunction f() {/* ignored */}\nconst end = 1;",
      lines: 3,
    },
    {
      name: "JSX less-than comparison stays in JavaScript",
      ext: "jsx",
      source: "const a = b <c;\n// ignored\nconst end = 1;",
      lines: 2,
    },
    {
      name: "Swift failed raw prefix does not hide following source",
      ext: "swift",
      source: '################\n// ignored\nlet raw = ###"/* literal */"###\n/* ignored */\nlet end = 1',
      lines: 3,
    },
    {
      name: "Python comments and quoted hash",
      ext: "py",
      source: "# ignored\nx = '# /* data */' # ignored\ny = 'https://example.org'\n",
      lines: 2,
    },
    {
      name: "Python triple quoted data and docstrings",
      ext: "py",
      source: '"""\n# literal\n\n"""\n# ignored\nx = 1',
      lines: 4,
    },
    {
      name: "Python single triple quotes",
      ext: "py",
      source: "x = '''\n// literal\n/* literal */\n'''\n# ignored",
      lines: 4,
    },
    { name: "Go raw strings", ext: "go", source: "var text = `\n// literal\n\n/* literal */\n`\n// ignored", lines: 4 },
    {
      name: "Rust raw string and lifetimes",
      ext: "rs",
      source: 'let text = r##"\n/* literal */\n"# still literal\n"##;\nfn use_ref<\'a>(x: &\'a str) {}\n// ignored',
      lines: 5,
    },
    {
      name: "nested Rust block comments",
      ext: "rs",
      source: "/* outer\n/* inner */\nstill outer */\nlet x = 1;",
      lines: 1,
    },
    {
      name: "Swift multiline and raw strings",
      ext: "swift",
      source: 'let text = """\n// literal\n"""\nlet raw = #"/* literal */"#\n// ignored',
      lines: 4,
    },
    {
      name: "nested Swift block comments",
      ext: "swift",
      source: "/* outer\n/* inner */\nstill outer */\nlet x = 1",
      lines: 1,
    },
    {
      name: "CSS URLs and block comments",
      ext: "css",
      source:
        '/* ignored\nstill ignored */\na { background: url(https://example.org/a); }\nb::after { content: "/* literal */"; }',
      lines: 2,
    },
    {
      name: "SCSS line comments",
      ext: "scss",
      source: '// ignored\na { content: "https://example.org"; } // ignored\n/* ignored */',
      lines: 1,
    },
    {
      name: "JSX comments and raw text",
      ext: "jsx",
      source:
        "const view = <div>\n{/* ignored\nstill ignored */}\nhttps://example.org\n/* literal text\nit's text\n</div>;\n// ignored",
      lines: 5,
    },
    {
      name: "TSX attribute strings and expressions",
      ext: "tsx",
      source: 'const view = <div title="/* literal */" value={\n// ignored\nvalue\n}>text</div>;\n// ignored',
      lines: 3,
    },
    {
      name: "Svelte control directives return to markup",
      ext: "svelte",
      source: "{#if ok}\n<!-- ignored -->\n<p>text</p>\n{:else}\n<p>other</p>\n{/if}\n<!-- ignored -->",
      lines: 5,
    },
    {
      name: "nested JSX returns to the surrounding expression",
      ext: "tsx",
      source: "const view = <div>{\nitems.map(x => <span>{x}</span>)\n// ignored\n}</div>;\n// ignored",
      lines: 3,
    },
    {
      name: "Vue single braces preserve literal JSX-looking text",
      ext: "vue",
      source: "<p>\n{/* literal text */}\n</p>",
      lines: 3,
    },
    {
      name: "Vue multiline single braces stay literal",
      ext: "vue",
      source: "<p>\n{/* literal\ntext */}\n</p>",
      lines: 4,
    },
    {
      name: "Vue double braces enter an expression",
      ext: "vue",
      source: "<p>\n{{\n// ignored\nvalue\n}}\n</p>",
      lines: 5,
    },
    ...["vue", "svelte"].map((ext) => ({
      name: `${ext} markup, script and style`,
      ext,
      source:
        '<div>\nhttps://example.org /* literal\n<!-- ignored\nstill ignored -->\n</div>\n<script>\n// ignored\nconst x = "/* literal */";\n</script>\n<style>\n/* ignored\nstill ignored */\na { background: url(https://example.org); }\n</style>',
      lines: 9,
    })),
  ];
  try {
    const settingsPath = join(dir, "cli-settings.json");
    // Keep the public hook entry point observable even for tiny snippets,
    // without exporting an implementation detail or changing configuration.
    const prefix = "0;\n".repeat(450);
    for (const { name, ext, source, lines, atStart } of cases) {
      const path = join(dir, `source.${ext}`);
      await writeFile(path, atStart ? source + "\n" + prefix : prefix + source, "utf8");
      const note = await fileSizeNote(path, settingsPath);
      assert.equal(note?.match(/ lines="(\d+)"/)?.[1], String(450 + lines), name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
