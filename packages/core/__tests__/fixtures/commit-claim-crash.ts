/** One isolated child, deliberately stopped at a publication gate by its test. */
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { acquireCommitClaim } from '../../src/save-commit.js';
const lock = process.argv[2]!;
if (process.argv[3] === 'before-link') {
  const link = fs.link;
  fs.link = (async (...args: Parameters<typeof fs.link>) => {
    if (args[1] === lock) {
      process.send?.({ checkpoint: 'prepared' });
      await new Promise<void>(() => {});
    }
    return link(...args);
  }) as typeof fs.link;
  syncBuiltinESMExports();
}
const alive = setInterval(() => {}, 1000);
try {
  await acquireCommitClaim(lock, 'fixture', lock);
  process.send?.({ checkpoint: 'held' });
} catch (error) {
  clearInterval(alive);
  throw error;
}
