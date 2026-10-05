import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export interface PanelGit {
  branch: string | null; staged: number; changed: number; untracked: number; conflicts: number;
  ahead: number | null; behind: number | null; known: boolean;
  sha?: string;
}
export function parseGitStatus(raw: string): PanelGit {
  const git: PanelGit = { branch: null, staged: 0, changed: 0, untracked: 0, conflicts: 0, ahead: null, behind: null, known: true };
  let originalRenamePath = false;
  for (const row of raw.split('\0')) {
    if (originalRenamePath) { originalRenamePath = false; continue; }
    if (row.startsWith('# branch.oid ') && /^[a-f0-9]+$/.test(row.slice(13).trim())) git.sha = row.slice(13).trim();
    else if (row.startsWith('# branch.head ')) git.branch = row.slice(14).trim();
    else if (row.startsWith('# branch.ab ')) {
      const m = /^# branch.ab \+(\d+) -(\d+)$/.exec(row.trim());
      if (m) { git.ahead = Number(m[1]); git.behind = Number(m[2]); }
    } else if (row.startsWith('1 ') || row.startsWith('2 ')) {
      if (row[2] !== '.') git.staged++;
      if (row[3] !== '.') git.changed++;
      if (row.startsWith('2 ')) originalRenamePath = true;
    } else if (row.startsWith('? ')) git.untracked++;
    else if (row.startsWith('u ')) git.conflicts++;
  }
  return git;
}

/** Read-only, one argv-based git process per five seconds, no fetch/network. */
export class PanelGitReader {
  private cwd = ''; private at = 0; private value: PanelGit | null = null;
  async read(cwd: string | null | undefined, now = Date.now()): Promise<PanelGit | null> {
    if (!cwd) return null;
    if (cwd === this.cwd && now - this.at >= 0 && now - this.at < 5000) return this.value;
    this.cwd = cwd; this.at = now;
    try {
      const { stdout } = await exec('git', ['-C', cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'],
        { encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
      this.value = parseGitStatus(stdout);
    } catch {
      this.value = { branch: null, staged: 0, changed: 0, untracked: 0, conflicts: 0, ahead: null, behind: null, known: false };
    }
    return this.value;
  }
}
