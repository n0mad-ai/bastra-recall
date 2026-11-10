import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';

/** A closed health port is not a process lifetime boundary. */
export async function waitForFixtureChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'close');
}
