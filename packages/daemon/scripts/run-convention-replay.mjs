// Dedicated opt-in runner: establish isolation before enabling the red fixture.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import "../../../scripts/test-env.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const child = spawn(process.execPath, ["--import", "tsx", "--import", "./scripts/test-env.mjs", "--test",
  "packages/daemon/__tests__/convention-replay.test.ts"], {
  cwd: root, env: { ...process.env, CONVENTION_REPLAY: "1" }, stdio: "inherit",
});
child.once("error", error => { console.error(error); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
