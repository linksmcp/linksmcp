import { loadConfig } from './config.js';
import { Door } from './door.js';
import { createLogger } from './log.js';
import { ensureHome, resolvePaths } from './paths.js';
import { Store } from './store.js';

/** Opens the data directory, config and store, and returns the shared Door. */
export function openDoor(env: NodeJS.ProcessEnv = process.env): Door {
  const paths = resolvePaths(env);
  ensureHome(paths);
  const config = loadConfig(paths.config, env);
  const store = new Store(paths.db);
  return new Door({ store, paths, config: () => config, env, log: createLogger() });
}
