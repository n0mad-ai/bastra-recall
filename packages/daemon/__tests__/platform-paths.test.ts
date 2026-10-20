import { test } from "node:test";
import assert from "node:assert/strict";
import { hostPaths, bastraDataDir } from "../src/platform-paths.js";
import { detectSurfaces, surfaceTraces, expandUserPath } from "../src/cli/wizard.js";
import { ADAPTERS } from "../src/cli/registry.js";

test("macOS host paths retain the pre-Windows layout", () => {
  assert.deepEqual(hostPaths({ platform: "darwin", home: "/Users/person", env: {} }), {
    dataDir: "/Users/person/.bastra",
    claudeDesktopDir: "/Users/person/Library/Application Support/Claude",
    claudeDesktopConfig: "/Users/person/Library/Application Support/Claude/claude_desktop_config.json",
    claudeCodeConfig: "/Users/person/.claude.json",
    claudeCodeSettings: "/Users/person/.claude/settings.json",
    cursorDir: "/Users/person/.cursor",
    cursorConfig: "/Users/person/.cursor/mcp.json",
    codexDir: "/Users/person/.codex",
    codexConfig: "/Users/person/.codex/config.toml",
    codexHooks: "/Users/person/.codex/hooks.json",
  });
});

test("Windows paths use relocated AppData and native separators, preserving dotfile client conventions", () => {
  assert.deepEqual(hostPaths({ platform: "win32", home: "C:\\Users\\A Person", env: {
    APPDATA: "D:\\Roaming Data", LOCALAPPDATA: "D:\\Local Data",
  } }), {
    dataDir: "D:\\Local Data\\Bastra",
    claudeDesktopDir: "D:\\Roaming Data\\Claude",
    claudeDesktopConfig: "D:\\Roaming Data\\Claude\\claude_desktop_config.json",
    claudeCodeConfig: "C:\\Users\\A Person\\.claude.json",
    claudeCodeSettings: "C:\\Users\\A Person\\.claude\\settings.json",
    cursorDir: "C:\\Users\\A Person\\.cursor",
    cursorConfig: "C:\\Users\\A Person\\.cursor\\mcp.json",
    codexDir: "C:\\Users\\A Person\\.codex",
    codexConfig: "C:\\Users\\A Person\\.codex\\config.toml",
    codexHooks: "C:\\Users\\A Person\\.codex\\hooks.json",
  });
});

test("Windows AppData fallback and Codex override", () => {
  const opts = { platform: "win32" as const, home: "C:\\Users\\person", env: {} };
  assert.equal(hostPaths(opts).claudeDesktopDir, "C:\\Users\\person\\AppData\\Roaming\\Claude");
  assert.equal(bastraDataDir(opts.home, opts), "C:\\Users\\person\\AppData\\Local\\Bastra");
  const custom = hostPaths({ ...opts, env: { CODEX_HOME: "D:\\Codex" } });
  assert.equal(custom.codexConfig, "D:\\Codex\\config.toml");
  assert.equal(custom.codexHooks, "D:\\Codex\\hooks.json");
});

test("Linux keeps XDG Claude Desktop and existing Bastra data location", () => {
  const paths = hostPaths({ platform: "linux", home: "/home/person", env: { XDG_CONFIG_HOME: "/config" } });
  assert.equal(paths.claudeDesktopDir, "/config/Claude");
  assert.equal(paths.dataDir, "/home/person/.bastra");
});

test("Windows detection covers exactly installed adapters and never probes macOS application paths", () => {
  const opts = { platform: "win32" as const, env: { APPDATA: "R:\\Profile" } };
  const traces = surfaceTraces({ ...opts, home: "C:\\Users\\person" });
  assert.deepEqual(Object.keys(traces).sort(), Object.keys(ADAPTERS).sort());
  const seen: string[] = [];
  const detected = detectSurfaces("C:\\Users\\person", { ...opts, exists: (path) => {
    seen.push(path);
    return new Set(["R:\\Profile\\Claude", "C:\\Users\\person\\.claude", "C:\\Users\\person\\.codex", "C:\\Users\\person\\.cursor"]).has(path);
  } });
  assert.ok(Object.values(detected).every(Boolean));
  assert.ok(seen.every(path => !path.includes("/Applications") && !path.includes("Library")));
  assert.deepEqual(detectSurfaces("C:\\Users\\person", { ...opts, exists: () => false }), {
    "claude-code": false, codex: false, "claude-desktop": false, cursor: false,
  });
});

test("macOS preserves application detection for Claude, Cursor and ChatGPT/Codex", () => {
  const detected = detectSurfaces("/Users/person", { platform: "darwin", env: {}, exists: path => path.startsWith("/Applications/") });
  assert.deepEqual(detected, { "claude-code": false, codex: true, "claude-desktop": true, cursor: true });
});

test("host data consumers follow LocalAppData while macOS paths remain unchanged", async () => {
  const { settingsFilePath } = await import("../src/settings-file.js");
  const { blockedUpdatePath } = await import("../src/update-blocked.js");
  const { manifestPath } = await import("../src/cli/update-preflight.js");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const previous = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = "D:\\Bastra State";
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    // node:path on this test host remains POSIX; normalize only separators in
    // consumer assertions. Production Windows uses win32 for both operations.
    const normalize = (path: string) => path.replace(/\\/g, "/");
    assert.equal(normalize(settingsFilePath()), "D:/Bastra State/Bastra/cli-settings.json");
    assert.equal(normalize(blockedUpdatePath()), "D:/Bastra State/Bastra/update-blocked.json");
    assert.ok(normalize(manifestPath()).startsWith("D:/Bastra State/Bastra/"));
    Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
    assert.equal(blockedUpdatePath("/Users/person"), "/Users/person/.bastra/update-blocked.json");
    assert.ok(manifestPath("/Users/person").startsWith("/Users/person/.bastra/"));
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
});


test("Windows custom vault input expands either tilde separator and preserves drive paths", () => {
  assert.equal(expandUserPath("~\\Vault", "C:\\Users\\person", "win32"), "C:\\Users\\person\\Vault");
  assert.equal(expandUserPath("~/Vault", "C:\\Users\\person", "win32"), "C:\\Users\\person\\Vault");
  assert.equal(expandUserPath("D:\\My Vault", "C:\\Users\\person", "win32"), "D:\\My Vault");
});
