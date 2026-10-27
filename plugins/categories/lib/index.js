/**
 * dsh-plugin-categories — categories for DSH Desktop's session list.
 *
 * A category is a named set of DSH workspaces. DSH's session list shows a
 * header for each one, in the user's order, above the workspaces it holds,
 * and "Other workspaces" over the rest; the user makes, renames, moves and
 * deletes categories and files workspaces into them from the headers' ⋯
 * menus, by dragging, or on the Categories page (lib/client.js). The host
 * half (lib/categories.js) keeps them in the plugin's own store and keeps
 * DSH's workspace order in step. At its first start it brings over, once,
 * the categories the projects plugin kept before this plugin, and the
 * all-in-one mod's old sidebar projects.
 *
 * @module dsh-plugin-categories
 */
import z from '@deepseek-ai/schemastery';
import { CategoryManager, appendLog } from './categories.js';
import { checkConfig } from './config.js';
import { CategoriesRemote, SERVICE } from './remote.js';
import { dataPath } from './store.js';

export const name = 'categories';

/** Host services the plugin uses. */
export const inject = ['workspaceRegistry'];

/**
 * Settings. Each takes any value, so a wrong type in the profile never
 * stops the plugin: it counts as its default, the plugin's log warns once
 * at start, and the Categories page names it (config.js).
 */
export const Config = z.object({
    /** Master switch. Off: no headers, no chip; the page says so; the store is kept as it is. "no", "off", 0 count as off. */
    enabled: z.any().default(true),
    /** The categories and which workspaces each holds (a path under ~/.dsh is one under DSH_HOME). */
    storeFile: z.any().default('~/.dsh/categories/categories.json'),
    /** Action log, mode 600: ids and counts only. Empty turns it off. */
    logFile: z.any().default('~/.dsh/categories/categories.log'),
    /**
     * The projects plugin's store, read once at this plugin's first start to
     * bring over the categories it kept before this plugin. Never written.
     * Empty skips that move.
     */
    projectsStoreFile: z.any().default('~/.dsh/projects/projects.json'),
});

/** Each setting's default, as the schema gives it: what a wrong value counts as (config.js). */
export const DEFAULTS = Object.freeze(Config({}));

export function apply(ctx, raw) {
    const { config, problems } = checkConfig(raw, DEFAULTS);
    // Every warning goes to DSH's logger (kept in memory by DSH 0.2) and to the plugin's own log file, where it can be
    // read. Switched off by `enabled: false`, the plugin writes nothing, its log included; a wrong value that counts
    // as off (`enabled: "no"`) is still warned in its log, once.
    const quiet = !config.enabled && !problems.some((problem) => problem.key === 'enabled');
    let logFile = '';
    try { logFile = !quiet && config.logFile ? dataPath(config.logFile) : ''; } catch { /* no home to put it in: no log */ }
    const warn = (text) => {
        try { ctx.logger?.warn?.('%s', text); } catch { /* the log never fails the plugin */ }
        appendLog(logFile, `warn ${String(text).replace(/^categories: /, '')}`);
    };
    for (const problem of problems) warn(`categories: a setting is wrong: ${problem.text}`);
    if (!config.enabled) {
        // Switched off in its settings: the window's list answers "off" (no headers; the page says why), and nothing
        // in DSH or in the store changes.
        ctx.inject(['typertGateway'], (scope) => {
            scope.provide(SERVICE, new CategoriesRemote(scope, null, { problems, warn }));
        });
        ctx.logger?.info?.('categories: switched off in its settings');
        return;
    }
    const manager = new CategoryManager({ ctx, config, warn: (text) => warn(`categories: ${text}`) });
    // Switched off or reloaded: this manager stops, and the next start reads the store from its file.
    ctx.effect(() => () => manager.dispose(), 'categories.manager()');

    // The window's endpoints (remote.js), served by DSH's own gateway.
    // Optional: without them the window draws DSH's list as it is.
    ctx.inject(['typertGateway'], (scope) => {
        scope.provide(SERVICE, new CategoriesRemote(scope, manager, { problems, warn }));
    });

    manager.start().then(() => {
        ctx.logger?.info?.('categories: %d categor%s', Object.keys(manager.store.categories).length, Object.keys(manager.store.categories).length === 1 ? 'y' : 'ies');
    }, (error) => {
        warn(`categories: startup failed: ${String(error?.message ?? error).slice(0, 300)}`);
    });
}
