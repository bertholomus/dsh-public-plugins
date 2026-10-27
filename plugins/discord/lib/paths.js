/**
 * Where the plugin keeps its files. A path that starts with `~/.dsh/` means
 * DSH's own data folder: `$DSH_HOME` when DSH runs with one (a test home, a
 * second instance), else `~/.dsh`. Any other `~/` path is the user's home.
 *
 * @module dsh-plugin-discord/paths
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {string} path - a configured path.
 * @param {NodeJS.ProcessEnv} [env] - the environment (tests pass their own).
 * @returns {string} an absolute path.
 */
export function resolvePath(path, env = process.env) {
    const value = String(path ?? '');
    if (value === '~/.dsh' || value.startsWith('~/.dsh/')) {
        const home = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh');
        return join(home, value.slice('~/.dsh'.length));
    }
    if (value === '~' || value.startsWith('~/')) return join(homedir(), value.slice(1));
    return value;
}
