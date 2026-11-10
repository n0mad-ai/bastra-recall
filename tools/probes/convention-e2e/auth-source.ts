import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';

/** Copy only the explicitly supplied isolated probe credential. */
export async function copyAuthSource(source: string, destination: string): Promise<void> {
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw Error('Auth source must be a regular file.');
    await writeFile(destination, await handle.readFile(), { flag: 'wx', mode: 0o600 });
  } finally { await handle.close(); }
}
