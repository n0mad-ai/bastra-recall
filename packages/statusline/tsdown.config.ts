import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/codex-statusline.ts", "src/recall-panel.ts", "src/claude-panel-feed.ts"],
    format: "esm",
    target: "node18",
    platform: "node",
    clean: true,
    minify: true,
    nodeProtocol: true,
    // The Deno hook embeds the Claude statusline bundle with npm resolution disabled.
    deps: { alwaysBundle: ["@bastra-recall/core/runtime-settings"] },
  },
  {
    entry: ["src/browser.ts"],
    format: "esm",
    target: "es2022",
    platform: "browser",
    clean: false,
    minify: true,
    dts: true,
    deps: { neverBundle: [/^node:/] },
  },
]);
