/**
 * #1039 split powerline.ts into collaborators (theme, layout, segment
 * dispatch). The split is behaviour-neutral, so the exact ANSI output of
 * PowerlineRenderer is pinned here: themes, colour depths, styles, charsets,
 * padding, two lines and auto-wrap at several widths, with and without
 * colour. The expected strings were generated from main before the split.
 *
 * Only segments that render from the hook data alone are used (no git,
 * transcript, tmux, clock or bastra state), so the output is deterministic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PowerlineRenderer } from "../../packages/statusline/src/powerline.ts";
import { DEFAULT_CONFIG } from "../../packages/statusline/src/config/defaults.ts";

const HOOK_DATA = {
  session_id: "0123abcd-4567-89ef-0123-456789abcdef",
  cwd: "/tmp/powerline-snapshot/project-dir",
  workspace: { current_dir: "/tmp/powerline-snapshot/project-dir" },
  model: { id: "claude-opus-4-1", display_name: "Opus 4.1" },
  version: "2.1.78",
  agent: { name: "reviewer" },
  thinking: { enabled: true },
  effort: { level: "high" },
  context_window: {
    context_window_size: 200000,
    current_usage: {
      input_tokens: 90000,
      cache_creation_input_tokens: 10000,
      cache_read_input_tokens: 40000,
    },
  },
};

const LINE_MAIN = {
  segments: {
    directory: { enabled: true, style: "basename" },
    model: { enabled: true },
    sessionId: { enabled: true, showIdLabel: true },
    version: { enabled: true },
    context: { enabled: true, displayStyle: "text" },
  },
};

const LINE_EXTRA = {
  segments: {
    env: { enabled: true, variable: "POWERLINE_SNAPSHOT_ENV", prefix: "env" },
    agent: { enabled: true, showLabel: true },
    thinking: { enabled: true, showEnabled: true, showEffort: true },
  },
};

const CUSTOM_COLORS = {
  directory: { bg: "#112233", fg: "#ffeedd", bold: true },
  model: { bg: "#334455", fg: "#ddccbb" },
  sessionId: { fg: "#abcdef" },
  context: { bg: "#202020", fg: "#1f1f1f" },
};

// columns = terminal width + the 45 columns getTerminalWidth reserves.
const CASES = {
  "dark powerline truecolor": {},
  "dark powerline ansi256": { colorCompatibility: "ansi256" },
  "dark powerline ansi": { colorCompatibility: "ansi" },
  "light powerline truecolor": { theme: "light" },
  "nord powerline ansi256": { theme: "nord", colorCompatibility: "ansi256" },
  "gruvbox capsule truecolor": { theme: "gruvbox", style: "capsule" },
  "tokyo-night capsule ansi": {
    theme: "tokyo-night",
    style: "capsule",
    colorCompatibility: "ansi",
  },
  "rose-pine minimal truecolor": { theme: "rose-pine", style: "minimal" },
  "custom powerline truecolor": { theme: "custom", custom: CUSTOM_COLORS },
  "custom capsule ansi256": {
    theme: "custom",
    style: "capsule",
    colorCompatibility: "ansi256",
    custom: CUSTOM_COLORS,
  },
  "unknown theme falls back to dark": { theme: "no-such-theme" },
  "text charset": { charset: "text" },
  "text charset capsule": { charset: "text", style: "capsule" },
  "padding 0": { padding: 0 },
  "padding 2 capsule": { padding: 2, style: "capsule" },
  "no colour (NO_COLOR)": { colorCompatibility: "auto", env: { NO_COLOR: "1" } },
  "no colour capsule (NO_COLOR)": {
    colorCompatibility: "auto",
    style: "capsule",
    env: { NO_COLOR: "1" },
  },
  "auto colour FORCE_COLOR=2": {
    colorCompatibility: "auto",
    env: { FORCE_COLOR: "2" },
  },
  "auto colour FORCE_COLOR=1 capsule": {
    colorCompatibility: "auto",
    style: "capsule",
    env: { FORCE_COLOR: "1" },
  },
  "autoWrap width 200": { autoWrap: true, columns: "245" },
  "autoWrap width 60": { autoWrap: true, columns: "105" },
  "autoWrap width 30": { autoWrap: true, columns: "75" },
  "autoWrap width 1": { autoWrap: true, columns: "10" },
  "autoWrap width 40 capsule": { autoWrap: true, columns: "85", style: "capsule" },
  "autoWrap width 40 capsule padding 0": {
    autoWrap: true,
    columns: "85",
    style: "capsule",
    padding: 0,
  },
  "autoWrap width 40 no colour": {
    autoWrap: true,
    columns: "85",
    colorCompatibility: "auto",
    env: { NO_COLOR: "1" },
  },
  "autoWrap width 40 light minimal": {
    autoWrap: true,
    columns: "85",
    theme: "light",
    style: "minimal",
  },
};

function buildConfig(c) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.theme = c.theme ?? "dark";
  config.display.style = c.style ?? "powerline";
  config.display.charset = c.charset ?? "unicode";
  config.display.colorCompatibility = c.colorCompatibility ?? "truecolor";
  config.display.padding = c.padding ?? 1;
  config.display.autoWrap = c.autoWrap ?? false;
  config.display.lines = [
    structuredClone(LINE_MAIN),
    structuredClone(LINE_EXTRA),
  ];
  if (c.custom) config.colors = { ...(config.colors ?? {}), custom: c.custom };
  return config;
}

const ENV_KEYS = [
  "NO_COLOR",
  "FORCE_COLOR",
  "COLUMNS",
  "POWERLINE_SNAPSHOT_ENV",
  "TERM",
  "COLORTERM",
  "CI",
];

async function render(c) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.POWERLINE_SNAPSHOT_ENV = "staging";
  if (c.columns) process.env.COLUMNS = c.columns;
  Object.assign(process.env, c.env ?? {});
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await new PowerlineRenderer(buildConfig(c)).generateStatusline(
      structuredClone(HOOK_DATA),
    );
  } finally {
    console.warn = warn;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const EXPECTED = {
  "dark powerline truecolor":
    "\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255m project-dir \u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;139;69;19m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m ✱ Opus 4.1 \u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;45;45;45m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;32;32;32m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m ◈ v2.1.78 \u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;58;58;74m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m ⚙ env: staging \u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;45;45;61m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m ◇ agent: reviewer \u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;42;42;74m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m ✦ On · high \u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "dark powerline ansi256":
    "\u001b[0m\u001b[48;5;136m\u001b[38;5;231m project-dir \u001b[0m\u001b[48;5;237m\u001b[38;5;136m\u001b[48;5;237m\u001b[38;5;231m ✱ Opus 4.1 \u001b[0m\u001b[48;5;235m\u001b[38;5;237m\u001b[48;5;235m\u001b[38;5;51m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[48;5;238m\u001b[38;5;235m\u001b[48;5;238m\u001b[38;5;183m ◈ v2.1.78 \u001b[0m\u001b[48;5;124m\u001b[38;5;238m\u001b[48;5;124m\u001b[38;5;217m ◔ 140.000 (16%) \u001b[0m\u001b[38;5;124m\u001b[0m\n\u001b[0m\u001b[48;5;237m\u001b[38;5;182m ⚙ env: staging \u001b[0m\u001b[48;5;60m\u001b[38;5;237m\u001b[48;5;60m\u001b[38;5;146m ◇ agent: reviewer \u001b[0m\u001b[48;5;59m\u001b[38;5;60m\u001b[48;5;59m\u001b[38;5;183m ✦ On · high \u001b[0m\u001b[38;5;59m\u001b[0m",
  "dark powerline ansi":
    "\u001b[0m\u001b[37m project-dir \u001b[0m\u001b[0m\u001b[37m ✱ Opus 4.1 \u001b[0m\u001b[0m\u001b[37m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[0m\u001b[34m ◈ v2.1.78 \u001b[0m\u001b[0m\u001b[31m ◔ 140.000 (16%) \u001b[0m\u001b[0m\n\u001b[0m\u001b[37m ⚙ env: staging \u001b[0m\u001b[0m\u001b[34m ◇ agent: reviewer \u001b[0m\u001b[0m\u001b[37m ✦ On · high \u001b[0m\u001b[0m",
  "light powerline truecolor":
    "\u001b[0m\u001b[48;2;255;107;71m\u001b[38;2;255;255;255m project-dir \u001b[0m\u001b[48;2;135;206;235m\u001b[38;2;255;107;71m\u001b[48;2;135;206;235m\u001b[38;2;0;0;0m ✱ Opus 4.1 \u001b[0m\u001b[48;2;218;112;214m\u001b[38;2;135;206;235m\u001b[48;2;218;112;214m\u001b[38;2;255;255;255m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[48;2;139;125;216m\u001b[38;2;218;112;214m\u001b[48;2;139;125;216m\u001b[38;2;255;255;255m ◈ v2.1.78 \u001b[0m\u001b[48;2;220;38;38m\u001b[38;2;139;125;216m\u001b[48;2;220;38;38m\u001b[38;2;255;255;255m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;220;38;38m\u001b[0m\n\u001b[0m\u001b[48;2;212;93;191m\u001b[38;2;255;255;255m ⚙ env: staging \u001b[0m\u001b[48;2;124;58;237m\u001b[38;2;212;93;191m\u001b[48;2;124;58;237m\u001b[38;2;255;255;255m ◇ agent: reviewer \u001b[0m\u001b[48;2;124;58;237m\u001b[38;2;124;58;237m\u001b[48;2;124;58;237m\u001b[38;2;255;255;255m ✦ On · high \u001b[0m\u001b[38;2;124;58;237m\u001b[0m",
  "nord powerline ansi256":
    "\u001b[0m\u001b[48;5;109m\u001b[38;5;253m project-dir \u001b[0m\u001b[48;5;242m\u001b[38;5;109m\u001b[48;5;242m\u001b[38;5;146m ✱ Opus 4.1 \u001b[0m\u001b[48;5;237m\u001b[38;5;242m\u001b[48;5;237m\u001b[38;5;109m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[48;5;109m\u001b[38;5;237m\u001b[48;5;109m\u001b[38;5;109m ◈ v2.1.78 \u001b[0m\u001b[48;5;174m\u001b[38;5;109m\u001b[48;5;174m\u001b[38;5;231m ◔ 140.000 (16%) \u001b[0m\u001b[38;5;174m\u001b[0m\n\u001b[0m\u001b[48;5;239m\u001b[38;5;181m ⚙ env: staging \u001b[0m\u001b[48;5;242m\u001b[38;5;239m\u001b[48;5;242m\u001b[38;5;181m ◇ agent: reviewer \u001b[0m\u001b[48;5;239m\u001b[38;5;242m\u001b[48;5;239m\u001b[38;5;181m ✦ On · high \u001b[0m\u001b[38;5;239m\u001b[0m",
  "gruvbox capsule truecolor":
    "\u001b[0m\u001b[38;2;80;73;69m\u001b[0m\u001b[48;2;80;73;69m\u001b[38;2;235;219;178m project-dir \u001b[0m\u001b[38;2;80;73;69m\u001b[0m \u001b[38;2;102;92;84m\u001b[0m\u001b[48;2;102;92;84m\u001b[38;2;131;165;152m ✱ Opus 4.1 \u001b[0m\u001b[38;2;102;92;84m\u001b[0m \u001b[38;2;40;40;40m\u001b[0m\u001b[48;2;40;40;40m\u001b[38;2;142;192;124m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[38;2;40;40;40m\u001b[0m \u001b[38;2;80;73;69m\u001b[0m\u001b[48;2;80;73;69m\u001b[38;2;142;192;124m ◈ v2.1.78 \u001b[0m\u001b[38;2;80;73;69m\u001b[0m \u001b[38;2;204;36;29m\u001b[0m\u001b[48;2;204;36;29m\u001b[38;2;235;219;178m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;204;36;29m\u001b[0m\n\u001b[0m\u001b[38;2;60;56;54m\u001b[0m\u001b[48;2;60;56;54m\u001b[38;2;211;134;155m ⚙ env: staging \u001b[0m\u001b[38;2;60;56;54m\u001b[0m \u001b[38;2;80;73;69m\u001b[0m\u001b[48;2;80;73;69m\u001b[38;2;211;134;155m ◇ agent: reviewer \u001b[0m\u001b[38;2;80;73;69m\u001b[0m \u001b[38;2;60;48;70m\u001b[0m\u001b[48;2;60;48;70m\u001b[38;2;211;134;155m ✦ On · high \u001b[0m\u001b[38;2;60;48;70m\u001b[0m",
  "tokyo-night capsule ansi":
    "\u001b[0m\u001b[0m\u001b[34m project-dir \u001b[0m\u001b[0m \u001b[0m\u001b[37m ✱ Opus 4.1 \u001b[0m\u001b[0m \u001b[0m\u001b[34m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[0m \u001b[0m\u001b[34m ◈ v2.1.78 \u001b[0m\u001b[0m \u001b[0m\u001b[90m ◔ 140.000 (16%) \u001b[0m\u001b[0m\n\u001b[0m\u001b[0m\u001b[37m ⚙ env: staging \u001b[0m\u001b[0m \u001b[0m\u001b[34m ◇ agent: reviewer \u001b[0m\u001b[0m \u001b[0m\u001b[34m ✦ On · high \u001b[0m\u001b[0m",
  "rose-pine minimal truecolor":
    "\u001b[0m\u001b[48;2;38;35;58m\u001b[38;2;196;167;231m project-dir \u001b[0m\u001b[48;2;25;23;36m\u001b[38;2;38;35;58m\u001b[48;2;25;23;36m\u001b[38;2;235;188;186m ✱ Opus 4.1 \u001b[0m\u001b[48;2;38;35;58m\u001b[38;2;25;23;36m\u001b[48;2;38;35;58m\u001b[38;2;246;193;119m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[48;2;42;39;63m\u001b[38;2;38;35;58m\u001b[48;2;42;39;63m\u001b[38;2;196;167;231m ◈ v2.1.78 \u001b[0m\u001b[48;2;235;111;146m\u001b[38;2;42;39;63m\u001b[48;2;235;111;146m\u001b[38;2;25;23;36m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;235;111;146m\u001b[0m\n\u001b[0m\u001b[48;2;33;32;46m\u001b[38;2;235;111;146m ⚙ env: staging \u001b[0m\u001b[48;2;42;39;63m\u001b[38;2;33;32;46m\u001b[48;2;42;39;63m\u001b[38;2;196;167;231m ◇ agent: reviewer \u001b[0m\u001b[48;2;38;34;58m\u001b[38;2;42;39;63m\u001b[48;2;38;34;58m\u001b[38;2;196;167;231m ✦ On · high \u001b[0m\u001b[38;2;38;34;58m\u001b[0m",
  "custom powerline truecolor":
    "\u001b[0m\u001b[48;2;17;34;51m\u001b[38;2;255;238;221m\u001b[1m project-dir \u001b[22m\u001b[0m\u001b[48;2;51;68;85m\u001b[38;2;17;34;51m\u001b[48;2;51;68;85m\u001b[38;2;221;204;187m ✱ Opus 4.1 \u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;51;68;85m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;32;32;32m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m ◈ v2.1.78 \u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;58;58;74m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m ⚙ env: staging \u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;45;45;61m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m ◇ agent: reviewer \u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;42;42;74m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m ✦ On · high \u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "custom capsule ansi256":
    "\u001b[0m\u001b[38;5;23m\u001b[0m\u001b[48;5;23m\u001b[38;5;230m\u001b[1m project-dir \u001b[22m\u001b[0m\u001b[38;5;23m\u001b[0m \u001b[38;5;60m\u001b[0m\u001b[48;5;60m\u001b[38;5;188m ✱ Opus 4.1 \u001b[0m\u001b[38;5;60m\u001b[0m \u001b[38;5;235m\u001b[0m\u001b[48;5;235m\u001b[38;5;51m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[38;5;235m\u001b[0m \u001b[38;5;238m\u001b[0m\u001b[48;5;238m\u001b[38;5;183m ◈ v2.1.78 \u001b[0m\u001b[38;5;238m\u001b[0m \u001b[38;5;124m\u001b[0m\u001b[48;5;124m\u001b[38;5;217m ◔ 140.000 (16%) \u001b[0m\u001b[38;5;124m\u001b[0m\n\u001b[0m\u001b[38;5;237m\u001b[0m\u001b[48;5;237m\u001b[38;5;182m ⚙ env: staging \u001b[0m\u001b[38;5;237m\u001b[0m \u001b[38;5;60m\u001b[0m\u001b[48;5;60m\u001b[38;5;146m ◇ agent: reviewer \u001b[0m\u001b[38;5;60m\u001b[0m \u001b[38;5;59m\u001b[0m\u001b[48;5;59m\u001b[38;5;183m ✦ On · high \u001b[0m\u001b[38;5;59m\u001b[0m",
  "unknown theme falls back to dark":
    "\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255m project-dir \u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;139;69;19m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m ✱ Opus 4.1 \u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;45;45;45m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;32;32;32m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m ◈ v2.1.78 \u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;58;58;74m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m ⚙ env: staging \u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;45;45;61m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m ◇ agent: reviewer \u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;42;42;74m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m ✦ On · high \u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "text charset":
    "\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255m project-dir \u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;139;69;19m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m M Opus 4.1 \u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;45;45;45m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m # 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;32;32;32m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m V v2.1.78 \u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;58;58;74m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m C 140.000 (16%) \u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m $ env: staging \u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;45;45;61m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m & agent: reviewer \u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;42;42;74m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m T On · high \u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "text charset capsule":
    "\u001b[0m\u001b[38;2;139;69;19m\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255m project-dir \u001b[0m\u001b[38;2;139;69;19m\u001b[0m \u001b[38;2;45;45;45m\u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m M Opus 4.1 \u001b[0m\u001b[38;2;45;45;45m\u001b[0m \u001b[38;2;32;32;32m\u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m # 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[38;2;32;32;32m\u001b[0m \u001b[38;2;58;58;74m\u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m V v2.1.78 \u001b[0m\u001b[38;2;58;58;74m\u001b[0m \u001b[38;2;153;27;27m\u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m C 140.000 (16%) \u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[38;2;45;45;61m\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m $ env: staging \u001b[0m\u001b[38;2;45;45;61m\u001b[0m \u001b[38;2;42;42;74m\u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m & agent: reviewer \u001b[0m\u001b[38;2;42;42;74m\u001b[0m \u001b[38;2;42;42;58m\u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m T On · high \u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "padding 0":
    "\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255mproject-dir\u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;139;69;19m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m✱ Opus 4.1\u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;45;45;45m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m⌗ 0123abcd-4567-89ef-0123-456789abcdef\u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;32;32;32m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m◈ v2.1.78\u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;58;58;74m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m◔ 140.000 (16%)\u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m⚙ env: staging\u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;45;45;61m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m◇ agent: reviewer\u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;42;42;74m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m✦ On · high\u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "padding 2 capsule":
    "\u001b[0m\u001b[38;2;139;69;19m\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255m  project-dir  \u001b[0m\u001b[38;2;139;69;19m\u001b[0m \u001b[38;2;45;45;45m\u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m  ✱ Opus 4.1  \u001b[0m\u001b[38;2;45;45;45m\u001b[0m \u001b[38;2;32;32;32m\u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m  ⌗ 0123abcd-4567-89ef-0123-456789abcdef  \u001b[0m\u001b[38;2;32;32;32m\u001b[0m \u001b[38;2;58;58;74m\u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m  ◈ v2.1.78  \u001b[0m\u001b[38;2;58;58;74m\u001b[0m \u001b[38;2;153;27;27m\u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m  ◔ 140.000 (16%)  \u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[38;2;45;45;61m\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m  ⚙ env: staging  \u001b[0m\u001b[38;2;45;45;61m\u001b[0m \u001b[38;2;42;42;74m\u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m  ◇ agent: reviewer  \u001b[0m\u001b[38;2;42;42;74m\u001b[0m \u001b[38;2;42;42;58m\u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m  ✦ On · high  \u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "no colour (NO_COLOR)":
    " project-dir  ✱ Opus 4.1  ⌗ 0123abcd-4567-89ef-0123-456789abcdef  ◈ v2.1.78  ◔ 140.000 (16%) \n ⚙ env: staging  ◇ agent: reviewer  ✦ On · high ",
  "no colour capsule (NO_COLOR)":
    " project-dir   ✱ Opus 4.1   ⌗ 0123abcd-4567-89ef-0123-456789abcdef   ◈ v2.1.78   ◔ 140.000 (16%) \n ⚙ env: staging   ◇ agent: reviewer   ✦ On · high ",
  "auto colour FORCE_COLOR=2":
    "\u001b[0m\u001b[48;5;136m\u001b[38;5;231m project-dir \u001b[0m\u001b[48;5;237m\u001b[38;5;136m\u001b[48;5;237m\u001b[38;5;231m ✱ Opus 4.1 \u001b[0m\u001b[48;5;235m\u001b[38;5;237m\u001b[48;5;235m\u001b[38;5;51m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[48;5;238m\u001b[38;5;235m\u001b[48;5;238m\u001b[38;5;183m ◈ v2.1.78 \u001b[0m\u001b[48;5;124m\u001b[38;5;238m\u001b[48;5;124m\u001b[38;5;217m ◔ 140.000 (16%) \u001b[0m\u001b[38;5;124m\u001b[0m\n\u001b[0m\u001b[48;5;237m\u001b[38;5;182m ⚙ env: staging \u001b[0m\u001b[48;5;60m\u001b[38;5;237m\u001b[48;5;60m\u001b[38;5;146m ◇ agent: reviewer \u001b[0m\u001b[48;5;59m\u001b[38;5;60m\u001b[48;5;59m\u001b[38;5;183m ✦ On · high \u001b[0m\u001b[38;5;59m\u001b[0m",
  "auto colour FORCE_COLOR=1 capsule":
    "\u001b[0m\u001b[0m\u001b[37m project-dir \u001b[0m\u001b[0m \u001b[0m\u001b[37m ✱ Opus 4.1 \u001b[0m\u001b[0m \u001b[0m\u001b[37m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[0m \u001b[0m\u001b[34m ◈ v2.1.78 \u001b[0m\u001b[0m \u001b[0m\u001b[31m ◔ 140.000 (16%) \u001b[0m\u001b[0m\n\u001b[0m\u001b[0m\u001b[37m ⚙ env: staging \u001b[0m\u001b[0m \u001b[0m\u001b[34m ◇ agent: reviewer \u001b[0m\u001b[0m \u001b[0m\u001b[37m ✦ On · high \u001b[0m\u001b[0m",
  "autoWrap width 200":
    "\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255m project-dir \u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;139;69;19m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m ✱ Opus 4.1 \u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;45;45;45m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;32;32;32m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m ◈ v2.1.78 \u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;58;58;74m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m ⚙ env: staging \u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;45;45;61m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m ◇ agent: reviewer \u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;42;42;74m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m ✦ On · high \u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "autoWrap width 60":
    "\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255m project-dir \u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;139;69;19m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m ✱ Opus 4.1 \u001b[0m\u001b[38;2;45;45;45m\u001b[0m\n\u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;32;32;32m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m ◈ v2.1.78 \u001b[0m\u001b[38;2;58;58;74m\u001b[0m\n\u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m ⚙ env: staging \u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;45;45;61m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m ◇ agent: reviewer \u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;42;42;74m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m ✦ On · high \u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "autoWrap width 30":
    "\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255m project-dir \u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;139;69;19m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m ✱ Opus 4.1 \u001b[0m\u001b[38;2;45;45;45m\u001b[0m\n\u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[38;2;32;32;32m\u001b[0m\n\u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m ◈ v2.1.78 \u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;58;58;74m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m ⚙ env: staging \u001b[0m\u001b[38;2;45;45;61m\u001b[0m\n\u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m ◇ agent: reviewer \u001b[0m\u001b[38;2;42;42;74m\u001b[0m\n\u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m ✦ On · high \u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "autoWrap width 1":
    "\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255m project-dir \u001b[0m\u001b[38;2;139;69;19m\u001b[0m\n\u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m ✱ Opus 4.1 \u001b[0m\u001b[38;2;45;45;45m\u001b[0m\n\u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[38;2;32;32;32m\u001b[0m\n\u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m ◈ v2.1.78 \u001b[0m\u001b[38;2;58;58;74m\u001b[0m\n\u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m ⚙ env: staging \u001b[0m\u001b[38;2;45;45;61m\u001b[0m\n\u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m ◇ agent: reviewer \u001b[0m\u001b[38;2;42;42;74m\u001b[0m\n\u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m ✦ On · high \u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "autoWrap width 40 capsule":
    "\u001b[0m\u001b[38;2;139;69;19m\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255m project-dir \u001b[0m\u001b[38;2;139;69;19m\u001b[0m \u001b[38;2;45;45;45m\u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m ✱ Opus 4.1 \u001b[0m\u001b[38;2;45;45;45m\u001b[0m\n\u001b[0m\u001b[38;2;32;32;32m\u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[38;2;32;32;32m\u001b[0m\n\u001b[0m\u001b[38;2;58;58;74m\u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m ◈ v2.1.78 \u001b[0m\u001b[38;2;58;58;74m\u001b[0m \u001b[38;2;153;27;27m\u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[38;2;45;45;61m\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m ⚙ env: staging \u001b[0m\u001b[38;2;45;45;61m\u001b[0m \u001b[38;2;42;42;74m\u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m ◇ agent: reviewer \u001b[0m\u001b[38;2;42;42;74m\u001b[0m\n\u001b[0m\u001b[38;2;42;42;58m\u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m ✦ On · high \u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "autoWrap width 40 capsule padding 0":
    "\u001b[0m\u001b[38;2;139;69;19m\u001b[0m\u001b[48;2;139;69;19m\u001b[38;2;255;255;255mproject-dir\u001b[0m\u001b[38;2;139;69;19m\u001b[0m \u001b[38;2;45;45;45m\u001b[0m\u001b[48;2;45;45;45m\u001b[38;2;255;255;255m✱ Opus 4.1\u001b[0m\u001b[38;2;45;45;45m\u001b[0m\n\u001b[0m\u001b[38;2;32;32;32m\u001b[0m\u001b[48;2;32;32;32m\u001b[38;2;0;255;255m⌗ 0123abcd-4567-89ef-0123-456789abcdef\u001b[0m\u001b[38;2;32;32;32m\u001b[0m\n\u001b[0m\u001b[38;2;58;58;74m\u001b[0m\u001b[48;2;58;58;74m\u001b[38;2;184;184;208m◈ v2.1.78\u001b[0m\u001b[38;2;58;58;74m\u001b[0m \u001b[38;2;153;27;27m\u001b[0m\u001b[48;2;153;27;27m\u001b[38;2;252;165;165m◔ 140.000 (16%)\u001b[0m\u001b[38;2;153;27;27m\u001b[0m\n\u001b[0m\u001b[38;2;45;45;61m\u001b[0m\u001b[48;2;45;45;61m\u001b[38;2;208;160;208m⚙ env: staging\u001b[0m\u001b[38;2;45;45;61m\u001b[0m \u001b[38;2;42;42;74m\u001b[0m\u001b[48;2;42;42;74m\u001b[38;2;176;168;224m◇ agent: reviewer\u001b[0m\u001b[38;2;42;42;74m\u001b[0m\n\u001b[0m\u001b[38;2;42;42;58m\u001b[0m\u001b[48;2;42;42;58m\u001b[38;2;199;146;234m✦ On · high\u001b[0m\u001b[38;2;42;42;58m\u001b[0m",
  "autoWrap width 40 no colour":
    " project-dir  ✱ Opus 4.1 \n ⌗ 0123abcd-4567-89ef-0123-456789abcdef \n ◈ v2.1.78  ◔ 140.000 (16%) \n ⚙ env: staging  ◇ agent: reviewer \n ✦ On · high ",
  "autoWrap width 40 light minimal":
    "\u001b[0m\u001b[48;2;255;107;71m\u001b[38;2;255;255;255m project-dir \u001b[0m\u001b[48;2;135;206;235m\u001b[38;2;255;107;71m\u001b[48;2;135;206;235m\u001b[38;2;0;0;0m ✱ Opus 4.1 \u001b[0m\u001b[38;2;135;206;235m\u001b[0m\n\u001b[0m\u001b[48;2;218;112;214m\u001b[38;2;255;255;255m ⌗ 0123abcd-4567-89ef-0123-456789abcdef \u001b[0m\u001b[38;2;218;112;214m\u001b[0m\n\u001b[0m\u001b[48;2;139;125;216m\u001b[38;2;255;255;255m ◈ v2.1.78 \u001b[0m\u001b[48;2;220;38;38m\u001b[38;2;139;125;216m\u001b[48;2;220;38;38m\u001b[38;2;255;255;255m ◔ 140.000 (16%) \u001b[0m\u001b[38;2;220;38;38m\u001b[0m\n\u001b[0m\u001b[48;2;212;93;191m\u001b[38;2;255;255;255m ⚙ env: staging \u001b[0m\u001b[48;2;124;58;237m\u001b[38;2;212;93;191m\u001b[48;2;124;58;237m\u001b[38;2;255;255;255m ◇ agent: reviewer \u001b[0m\u001b[38;2;124;58;237m\u001b[0m\n\u001b[0m\u001b[48;2;124;58;237m\u001b[38;2;255;255;255m ✦ On · high \u001b[0m\u001b[38;2;124;58;237m\u001b[0m",
};

// The context segment formats its token count with the process locale
// (`totalTokens.toLocaleString()`), and EXPECTED was generated under de_DE.
// The locale is fixed at process start, so re-format that one number the way
// this process does: "140.000" on de_DE, "140,000" on the en_US CI runners.
const TOKENS_DE = "140.000";
const TOKENS_HERE = (140000).toLocaleString();

for (const [name, c] of Object.entries(CASES)) {
  test(`powerline output is unchanged: ${name}`, async () => {
    assert.equal(
      await render(c),
      EXPECTED[name].replaceAll(TOKENS_DE, TOKENS_HERE),
    );
  });
}

