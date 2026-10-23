/**
 * Stand-ins for the DSH packages Canon's host half imports, so its tests
 * can load lib/index.js, lib/remote.js and lib/tools.js without DSH: each
 * `@deepseek-ai/<name>` resolves to `<name>.mjs` here. Register before the
 * first import of a Canon file that needs them.
 */
import { registerHooks } from 'node:module';

const STUBS = new Set(['schemastery', 'dsh-home-paths', 'dsh-llm', 'dsh-typert-protocol', 'dsh-tools']);

registerHooks({
    resolve(specifier, context, nextResolve) {
        const name = /^@deepseek-ai\/([\w-]+)$/.exec(specifier)?.[1];
        if (name && STUBS.has(name)) return { url: new URL(`./${name}.mjs`, import.meta.url).href, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
