import { writeSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { sep } from "node:path";

// Keep the transport's actual 300 ms timer. Deliver the kill switch on entry
// to the spool write, so the race does not depend on filesystem latency.
const setTimeout = globalThis.setTimeout;
let killSwitch;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === Number(process.env.BASTRA_HOOK_TIMEOUT_MS) + 50) {
    killSwitch = () => callback(...args);
    return setTimeout(() => {}, delay);
  }
  return setTimeout(callback, delay, ...args);
};

const mkdir = fs.mkdir;
fs.mkdir = async (path, ...args) => {
  if (killSwitch && String(path).endsWith(`${sep}rulebook-failures`)) {
    const fire = killSwitch;
    killSwitch = undefined;
    writeSync(2, "kill-switch during failure spool\n");
    fire();
  }
  return mkdir(path, ...args);
};
syncBuiltinESMExports();
