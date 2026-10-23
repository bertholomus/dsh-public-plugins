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
import { CategoryManager } from './categories.js';
import { CategoriesRemote, SERVICE } from './remote.js';

export const name = 'categories';

/** Host services the plugin uses. */
export const inject = ['workspaceRegistry'];

export const Config = z.object({
    /** Master switch. */
    enabled: z.boolean().default(true),
    /** The categories and which workspaces each holds. */
    storeFile: z.string().default('~/.dsh/categories/categories.json'),
    /** Action log, mode 600: ids and counts only. Empty turns it off. */
    logFile: z.string().default('~/.dsh/categories/categories.log'),
    /**
     * The projects plugin's store, read once at this plugin's first start to
     * bring over the categories it kept before this plugin. Never written.
     * Empty skips that move.
     */
    projectsStoreFile: z.string().default('~/.dsh/projects/projects.json'),
});

export function apply(ctx, config) {
    if (!config.enabled) return;
    const manager = new CategoryManager({ ctx, config });
    // Switched off or reloaded: this manager stops, and the next start reads the store from its file.
    ctx.effect(() => () => manager.dispose(), 'categories.manager()');

    // The window's endpoints (remote.js), served by DSH's own gateway.
    // Optional: without them the window draws DSH's list as it is.
    ctx.inject(['typertGateway'], (scope) => {
        scope.provide(SERVICE, new CategoriesRemote(scope, manager));
    });

    manager.start().then(() => {
        ctx.logger?.info?.('categories: %d categor%s', Object.keys(manager.store.categories).length, Object.keys(manager.store.categories).length === 1 ? 'y' : 'ies');
    }, (error) => {
        ctx.logger?.warn?.('categories: startup failed: %s', error?.message ?? error);
    });
}
