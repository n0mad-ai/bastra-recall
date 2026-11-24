// Daniel's decision C on switching areas: the agent window appears in full first, then the stage slides
// to its place; it never shows through the half-faded window. Measured in a browser on the stylesheet
// below; here the stylesheet is the proof that the stage waits exactly as long as the window fades.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const css = (await readFile(new URL("../webui/app/css/panels.css", import.meta.url), "utf8")).replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);
const rule = (selector: string, from = 0) => {
  const at = css.indexOf(`${selector} {`, from);
  assert.ok(at >= 0, `${selector} is in panels.css`);
  return css.slice(at, css.indexOf("}", at));
};
const seconds = (s: string) => Number(s.replace("s", ""));
const fade = seconds(/opacity ([\d.]+s)/.exec(rule(".agent"))![1]);

test("decision C: the stage slides only after the agent window has faded in or out", () => {
  const [, duration, delay] = /left ([\d.]+s) var\(--ease-knob\) ([\d.]+s)/.exec(rule(".stage"))!;
  assert.equal(seconds(delay), fade);
  assert.ok(seconds(duration) > 0);
});

test("decision C: opening, the stage stays hidden while the window fades in over its old place", () => {
  assert.match(rule(".app.is-beside-agent .stage"), new RegExp(`animation: stage-after-agent ${fade}s step-end`));
  assert.match(rule("@keyframes stage-after-agent"), /from,\s*to\s*{\s*visibility: hidden;/);
});

test("decision C: with reduced motion the stage does not slide, and closing it still waits for the window", () => {
  const reduce = css.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.ok(reduce >= 0);
  assert.match(rule(".stage", reduce), new RegExp(`left 0s ${fade}s`));
  const opening = rule(".app.is-beside-agent .stage", reduce);
  assert.doesNotMatch(opening, /left/);
  assert.match(opening, /animation: none/);
});

test("decision C: reversing before the stage clears the agent keeps it hidden for the closing fade", async () => {
  const source = (await readFile(new URL("../webui/app/js/stage.js", import.meta.url), "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace(/^export /gm, "");
  const animations: unknown[] = [];
  let stageLeft = 100;
  const stage = {
    getBoundingClientRect: () => ({ left: stageLeft }),
    animate: (frames: unknown, duration: number) => animations.push([frames, duration]),
  };
  const { mountStage, keepClearOfClosingAgent } = runInNewContext(
    `${source}\n({ mountStage, keepClearOfClosingAgent });`,
    { h: () => stage }
  );
  mountStage({ append() {} });
  const agent = {
    getBoundingClientRect: () => ({ right: 456 }),
    getAnimations: () => [
      { transitionProperty: "transform" },
      { transitionProperty: "opacity", effect: { getComputedTiming: () => ({ endTime: 183 }) } },
    ],
  };

  keepClearOfClosingAgent(agent);
  assert.deepEqual(JSON.parse(JSON.stringify(animations)), [
    [[{ visibility: "hidden" }, { visibility: "hidden" }], 183],
  ]);

  stageLeft = 472;
  keepClearOfClosingAgent(agent);
  assert.equal(animations.length, 1, "closing after the stage has cleared the agent does not hide it");
});
