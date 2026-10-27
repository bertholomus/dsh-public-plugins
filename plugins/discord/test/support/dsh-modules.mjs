/**
 * Where to find DSH's own packages for the tests that load lib/index.js
 * (schemastery, dsh-tools, dsh-llm, dsh-brand), and a resolve hook that
 * sends `@deepseek-ai/*` imports there, as DSH's loader does for a plugin.
 *
 * Looked for, in order: DSH_MODULES (a node_modules folder); this repo's
 * .e2e/dsh-<version>/node_modules (newest first, made by npm run
 * e2e:install); the same under DSH_E2E_DIR; the plugin suite's
 * ~/Projects/dsh-plugin-suite/.e2e/dsh-<version>/node_modules.
 *
 * @module test/support/dsh-modules
 */
import { existsSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The newest dsh-<version> runtime folders under an .e2e folder. */
function runtimesIn(base) {
    try {
        return readdirSync(base).filter((n) => /^dsh-\d/.test(n)).sort().reverse().map((n) => join(base, n, 'node_modules'));
    } catch {
        return [];
    }
}

/** A node_modules folder that has DSH's packages, or undefined. */
export function findDshModules() {
    const tries = [
        process.env.DSH_MODULES,
        ...runtimesIn(join(repoRoot, '.e2e')),
        ...(process.env.DSH_E2E_DIR ? runtimesIn(process.env.DSH_E2E_DIR) : []),
        ...runtimesIn(join(homedir(), 'Projects', 'dsh-plugin-suite', '.e2e')),
    ].filter(Boolean);
    return tries.find((dir) => existsSync(join(dir, '@deepseek-ai', 'dsh-tools', 'package.json')) && existsSync(join(dir, '@deepseek-ai', 'schemastery', 'package.json')));
}

/** Send `@deepseek-ai/*` imports to DSH's packages. Throws, in words, when there are none. */
export function useDshModules() {
    const modules = findDshModules();
    if (!modules) {
        throw new Error('DSH\'s packages were not found: run npm run e2e:install (it installs the DSH test builds into .e2e/), or set DSH_MODULES to a node_modules folder of a DSH install');
    }
    const hooks = `data:text/javascript,${encodeURIComponent(`
        let base;
        export async function initialize(data) { base = data.base; }
        export async function resolve(specifier, context, next) {
            if (specifier.startsWith('@deepseek-ai/')) return next(specifier, { ...context, parentURL: base });
            return next(specifier, context);
        }
    `)}`;
    register(hooks, { data: { base: pathToFileURL(join(dirname(modules), 'index.js')).href } });
    return modules;
}
