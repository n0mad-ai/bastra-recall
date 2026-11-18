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
  const source = strip(await read("views/inline-scan.js")) + strip(await read("views/markdown.js"));
  const byId = new Map([["known-id", { title: "Known memory" }]]);
  return runInNewContext(`${source}\nmarkdown`, { h, vault: () => ({ byId }) });
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
