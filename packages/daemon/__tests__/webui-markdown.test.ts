// The UI's mini Markdown renderer (markdown() and inline(), shared by the memory browser's reader,
// the task reports and the agent window): a fixed corpus rendered with the fake DOM and frozen as an
// HTML string, so moving or reshaping the renderer cannot change what any reader shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Node_, h } from "./webui-report-dom.js";

const read = (path: string) => readFile(new URL(`../webui/app/js/${path}`, import.meta.url), "utf8");

async function renderer(): Promise<(md: string, onLink: (id: string) => void) => Node_[]> {
  const strip = (src: string) => src.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");
  const source = ["views/inline-scan.js", "views/code-lines.js", "views/markdown.js"].map(read);
  const joined = (await Promise.all(source)).map(strip).join("\n");
  const byId = new Map([["known-id", { title: "Known memory" }]]);
  return runInNewContext(`${joined}\nmarkdown`, { h, vault: () => ({ byId }) });
}

/** A node as HTML: tag, attributes in a fixed order, class, text. */
function html(n: Node_): string {
  if (n.nodeType === 3) return n.textContent;
  const tag = n.tagName.toLowerCase();
  const attrs = Object.entries(n.attrs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  const cls = n.className ? ` class="${n.className}"` : "";
  const on = Object.keys(n.listeners).length ? ` on="${Object.keys(n.listeners).sort().join(",")}"` : "";
  return `<${tag}${cls}${attrs}${on}>${n.own}${n.children.map(html).join("")}</${tag}>`;
}

const CORPUS = [
  "# Heading one",
  "###### Heading six with `code`",
  "#not a heading",
  "",
  "Paragraph with **bold**, *em*, `code`, a [link](https://example.org/a) and https://example.org/b.",
  "Snake_case and 2*3*4 stay text; *an em * too.",
  "Links: [[known-id]] [[known-id|own label]] [[missing-id]].",
  "",
  "- item one",
  "  - nested item",
  "* star item",
  "1. ordered item",
  "",
  "after a blank line",
  "---",
  "",
  "---",
  "  * * *  ",
  "",
  "```",
  "# no heading in code",
  "- no item",
  "```",
  "> quote stays a paragraph",
  "<!-- hidden note -->Visible",
  "| a | b |",
  "|---|---|",
  "Ship it? [? Yes | No]",
  "Literal \\[? Yes | No]",
  "",
  "```",
  "open fence to the end",
].join("\n");

const FROZEN = [
  "<h3>Heading one</h3>",
  "<h3>Heading six with <code>code</code></h3>",
  "<p>#not a heading</p>",
  '<p>Paragraph with <strong>bold</strong>, <em>em</em>, <code>code</code>, a <a href="https://example.org/a" rel="noopener" target="_blank">link</a> and <a href="https://example.org/b." rel="noopener" target="_blank">https://example.org/b.</a></p>',
  "<p>Snake_case and 2*3*4 stay text; <em>an em </em> too.</p>",
  '<p>Links: <span class="mb-wl" role="link" tabindex="0" title="known-id" on="click,keydown">Known memory</span> <span class="mb-wl" role="link" tabindex="0" title="known-id" on="click,keydown">own label</span> <span class="mb-wl is-dead" title="missing-id">missing-id</span>.</p>',
  "<ul><li>item one</li><li>nested item</li><li>star item</li><li>ordered item</li></ul>",
  "<p>after a blank line</p>",
  "<p>---</p>",
  "<hr></hr>",
  "<ul><li>* *</li></ul>",
  "<pre># no heading in code\n- no item</pre>",
  "<p>> quote stays a paragraph</p>",
  "<p>Visible</p>",
  "<p>| a | b |</p>",
  "<p>|---|---|</p>",
  "<p>Ship it? [? Yes | No]</p>",
  "<p>Literal \\[? Yes | No]</p>",
  "<pre>open fence to the end</pre>",
];

test("markdown(): a fixed corpus renders to the same nodes (characterisation)", async () => {
  const markdown = await renderer();
  const followed: string[] = [];
  const nodes = markdown(CORPUS, (id) => followed.push(id));
  assert.deepEqual(Array.from(nodes, html), FROZEN);
  const link = nodes[5].children[1];
  await link.click();
  for (const fn of link.listeners.keydown ?? []) fn({ key: "Enter" });
  for (const fn of link.listeners.keydown ?? []) fn({ key: "x" });
  assert.deepEqual(followed, ["known-id", "known-id"], "a known wiki link follows on click and Enter");
});

// #1665/#1662: code as code-lines.js finds it. Indented code (four spaces or a tab, after a blank line,
// outside a list) and a fence at any indentation become a pre; a line right under a paragraph and a
// list's indented continuation stay text.
const CODE = [
  "    code at the start",
  "Text right under it.",
  "",
  "    const a = 1; // **not bold**",
  "\tif (a) [[known-id]]",
  "",
  "      kept indentation",
  "",
  "",
  "Lazy paragraph",
  "    continuation stays text",
  "",
  "- item",
  "",
  "    continuation of the item stays text",
  "  - nested",
  "",
  "Back at column 0.",
  "",
  "    Ship it? [? Yes | No]",
  "",
  "- step",
  "  ```",
  "  fenced in a list",
  "    keeps what is deeper",
  "  ```",
  "Out of the list.",
  "",
  "    ```",
  "    an indented fence after a blank line is code",
  "    ```",
  "   ```",
  "three spaces open a fence",
  "```",
].join("\n");

const FROZEN_CODE = [
  "<pre>code at the start</pre>",
  "<p>Text right under it.</p>",
  "<pre>const a = 1; // **not bold**\nif (a) [[known-id]]\n\n  kept indentation</pre>",
  "<p>Lazy paragraph</p>",
  "<p>    continuation stays text</p>",
  "<ul><li>item</li></ul>",
  "<p>    continuation of the item stays text</p>",
  "<ul><li>nested</li></ul>",
  "<p>Back at column 0.</p>",
  "<pre>Ship it? [? Yes | No]</pre>",
  "<ul><li>step</li></ul>",
  "<pre>fenced in a list\n  keeps what is deeper</pre>",
  "<p>Out of the list.</p>",
  "<pre>```\nan indented fence after a blank line is code\n```</pre>",
  "<pre>three spaces open a fence</pre>",
];

test("markdown() #1665/#1662: indented code and indented fences render as code, list text stays text", async () => {
  const markdown = await renderer();
  assert.deepEqual(
    Array.from(
      markdown(CODE, () => {}),
      html
    ),
    FROZEN_CODE
  );
});

// Realistic reports and memories without indented code, each frozen as the renderer before #1665 showed
// it (base 5980c618): nested lists with four spaces, continuation paragraphs under list items, lazy
// lines, column-0 fences and tables render exactly as before.
const UNCHANGED: [string, string[]][] = [
  [
    [
      "## Ergebnis",
      "",
      "Alle Tests grün, zwei Punkte offen.",
      "",
      "- Build: **ok** (`npm run build`)",
      "- Tests: 412 bestanden",
      "    - davon 3 übersprungen (Netz)",
      "    - 1 langsam: `webui-markdown.test.ts`",
      "- Lint: sauber",
      "",
      "## Offene Punkte",
      "",
      "1. Die Migration läuft nur einmal.",
      "",
      "    Sie prüft vorher, ob die Spalte schon existiert.",
      "",
      "2. Der Daemon braucht einen Neustart. [? Jetzt | Später]",
      "",
      "| Schritt | Dauer |",
      "|---|---|",
      "| Build | 12 s |",
      "| Tests | 3 min |",
      "",
      "Details: https://example.org/run/42",
    ].join("\n"),
    [
      "<h3>Ergebnis</h3>",
      "<p>Alle Tests grün, zwei Punkte offen.</p>",
      "<ul><li>Build: <strong>ok</strong> (<code>npm run build</code>)</li><li>Tests: 412 bestanden</li><li>davon 3 übersprungen (Netz)</li><li>1 langsam: <code>webui-markdown.test.ts</code></li><li>Lint: sauber</li></ul>",
      "<h3>Offene Punkte</h3>",
      "<ul><li>Die Migration läuft nur einmal.</li></ul>",
      "<p>    Sie prüft vorher, ob die Spalte schon existiert.</p>",
      "<ul><li>Der Daemon braucht einen Neustart. [? Jetzt | Später]</li></ul>",
      "<p>| Schritt | Dauer |</p>",
      "<p>|---|---|</p>",
      "<p>| Build | 12 s |</p>",
      "<p>| Tests | 3 min |</p>",
      '<p>Details: <a href="https://example.org/run/42" rel="noopener" target="_blank">https://example.org/run/42</a></p>',
    ],
  ],
  [
    [
      "### Change",
      "",
      "```ts",
      "const x = 1;",
      "| not | a table |",
      "|---|---|",
      "```",
      "",
      "* star list",
      "* second",
      "",
      "Text after the list.",
      "Second line of the same paragraph",
      "    lazy continuation, not code",
      "",
      "<!-- auto-related -->",
      "- [[some-memory]] link",
      "  - nested two",
      "      - nested three",
      "",
      "        deep continuation of nested three",
      "",
      "Done.",
    ].join("\n"),
    [
      "<h3>Change</h3>",
      "<pre>const x = 1;\n| not | a table |\n|---|---|</pre>",
      "<ul><li>star list</li><li>second</li></ul>",
      "<p>Text after the list.</p>",
      "<p>Second line of the same paragraph</p>",
      "<p>    lazy continuation, not code</p>",
      '<ul><li><span class="mb-wl is-dead" title="some-memory">some-memory</span> link</li><li>nested two</li><li>nested three</li></ul>',
      "<p>        deep continuation of nested three</p>",
      "<p>Done.</p>",
    ],
  ],
  [
    [
      "**Regel:** Immer zuerst prüfen.",
      "",
      "**Warum:** Am 31.10. lief es schief.",
      "",
      "**Anwenden:**",
      "- Schritt eins",
      "- Schritt zwei",
      "",
      "  Erläuterung zu Schritt zwei, eingerückt.",
      "",
      "Fertig.",
    ].join("\n"),
    [
      "<p><strong>Regel:</strong> Immer zuerst prüfen.</p>",
      "<p><strong>Warum:</strong> Am 31.10. lief es schief.</p>",
      "<p><strong>Anwenden:</strong></p>",
      "<ul><li>Schritt eins</li><li>Schritt zwei</li></ul>",
      "<p>  Erläuterung zu Schritt zwei, eingerückt.</p>",
      "<p>Fertig.</p>",
    ],
  ],
];

test("markdown() #1665: realistic reports and memories without indented code render as before", async () => {
  const markdown = await renderer();
  for (const [md, before] of UNCHANGED)
    assert.deepEqual(
      Array.from(
        markdown(md, () => {}),
        html
      ),
      before,
      md
    );
});
