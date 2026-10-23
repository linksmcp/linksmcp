import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';

export interface Paths {
  home: string;
  auth: string;
  db: string;
  config: string;
}

/** Resolves the data directory: LINKSMCP_HOME, or ~/.linksmcp. */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = resolve(env.LINKSMCP_HOME && env.LINKSMCP_HOME.trim() ? env.LINKSMCP_HOME : join(homedir(), '.linksmcp'));
  return {
    home,
    auth: join(home, 'auth.json'),
    db: join(home, 'linksmcp.db'),
    config: join(home, 'config.json'),
  };
}

export function ensureHome(paths: Paths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(paths.home, 0o700);
  } catch {
    // not ours to change (for example a mounted volume); the files inside are still 0600
  }
}
