/**
 * A module resolve hook for the plugin's unit tests: DSH's own packages
 * (`@deepseek-ai/*`, the plugin's peers) come from the newest DSH test
 * runtime under the repository's `.e2e/` when nothing else provides them,
 * so the tests run in a plain checkout with `.e2e` linked in, as the
 * real-DSH tests do. Registered by smoke.mjs.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.e2e');
const runtime = (() => {
    try {
        return readdirSync(base).filter((name) => /^dsh-\d/.test(name)).sort()
            .map((name) => join(base, name, 'node_modules'))
            .filter((dir) => existsSync(join(dir, '@deepseek-ai'))).at(-1);
    } catch {
        return undefined;
    }
})();

export async function resolve(specifier, context, next) {
    try {
        return await next(specifier, context);
    } catch (error) {
        if (!runtime || !specifier.startsWith('@deepseek-ai/')) throw error;
        return next(specifier, { ...context, parentURL: pathToFileURL(join(runtime, 'peers.mjs')).href });
    }
}
