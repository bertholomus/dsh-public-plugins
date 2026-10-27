/**
 * Lets a test that imports DSH's own packages (`@deepseek-ai/*`, and what
 * they import) run without a `node_modules` in this repository: a bare
 * import that does not resolve from the test's own folders resolves from
 * the DSH install in `DSH_PACKAGES` (a folder whose `node_modules` holds a
 * DSH, such as `.e2e/dsh-0.2.1-rc.1`). Those are DSH's real packages, not
 * stand-ins, so the test runs against that DSH build.
 *
 *   DSH_PACKAGES=.e2e/dsh-0.2.1-rc.1 node --import ./test/helpers/dsh-packages.mjs plugins/coordinator/test/smoke.mjs
 *
 * @module test/helpers/dsh-packages
 */
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.DSH_PACKAGES;
if (root) {
    // Node looks for a bare import in `node_modules` beside its parent: a parent inside the DSH folder finds DSH's.
    const parentURL = pathToFileURL(resolve(root, 'package.json')).href;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            try {
                return nextResolve(specifier, context);
            } catch (error) {
                const bare = !/^(node:|file:|data:|\.|\/)/.test(specifier);
                if (!bare || error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
                return nextResolve(specifier, { ...context, parentURL });
            }
        },
    });
}
