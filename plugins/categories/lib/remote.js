/**
 * The plugin's endpoints for its browser half. DSH's own panels reach the
 * Host through Remote namespaces its gateway serves on the window's
 * connection (`/api/<namespace>/<method>`, the same carrier in the desktop
 * app and in a browser). This module adds one more,
 * `dsh-plugin-categories`, so the session list's headers and ⋯ menus and
 * the Categories page list the categories and change them.
 *
 * The gateway finds a Remote service by its `typertRemote` binding and the
 * method markers on its prototype; DSH's own services get both from
 * TypeScript decorators, applied here by hand. Parameters are plain names,
 * since the gateway reads them from the method source.
 *
 * @module dsh-plugin-categories/remote
 */
import { Remote, RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { CategoryError } from './categories.js';

/** Wire namespace: the client calls `/api/dsh-plugin-categories/<method>`. */
export const NAMESPACE = 'dsh-plugin-categories';
/** Cordis service key the gateway looks the service up by. */
export const SERVICE = 'dshPluginCategoriesRemote';

/** A refusal the user can act on, as a Remote failure the window shows. */
function failure(error) {
    if (error instanceof CategoryError) return new RemoteError('categories/refused', error.message, {});
    return error;
}

export class CategoriesRemote {
    /**
     * @param {object} ctx - the plugin's context (the binding reads it).
     * @param {object} manager - the CategoryManager.
     */
    constructor(ctx, manager) {
        this.ctx = ctx;
        this.manager = manager;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /**
     * Every category in its order, with the workspaces it holds in DSH's
     * order: `{categories: [{id, name, source, importedFrom?, workspaces: [{id, path, title}]}]}`.
     * `source` is 'import' for one the old sidebar's import made.
     */
    async list() {
        try {
            // A workspace DSH added since (it lists a new one first) goes back among those in none.
            this.manager.syncWorkspaceOrder().catch(() => {});
            return { categories: this.manager.listCategories() };
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * A new category, last in the list.
     * @param name - its name.
     * @param workspace - optional: a DSH workspace id it holds from the start.
     * @returns {category: the new id, categories}.
     */
    async createCategory(name, workspace) {
        try {
            const id = await this.manager.createCategory(name, typeof workspace === 'string' && workspace !== '' ? workspace : undefined);
            return { category: id, categories: this.manager.listCategories() };
        } catch (error) {
            throw failure(error);
        }
    }

    /** Rename a category. @returns {categories}. */
    async renameCategory(category, name) {
        try {
            this.manager.renameCategory(category, name);
            return { categories: this.manager.listCategories() };
        } catch (error) {
            throw failure(error);
        }
    }

    /** Delete a category; its workspaces go to Other workspaces. @returns {categories}. */
    async removeCategory(category) {
        try {
            await this.manager.removeCategory(category);
            return { categories: this.manager.listCategories() };
        } catch (error) {
            throw failure(error);
        }
    }

    /** Move a category before another one, or (before empty) to the end. @returns {categories}. */
    async moveCategory(category, before) {
        try {
            await this.manager.moveCategory(category, typeof before === 'string' ? before : null);
            return { categories: this.manager.listCategories() };
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * Put a DSH workspace in a category (empty for none), before another of
     * its workspaces or (before empty) after the last.
     * @returns {categories}.
     */
    async fileWorkspace(workspace, category, before) {
        try {
            if (typeof workspace !== 'string' || workspace === '') throw new CategoryError('workspace is required');
            await this.manager.fileWorkspace(workspace, typeof category === 'string' && category !== '' ? category : null, typeof before === 'string' ? before : null);
            return { categories: this.manager.listCategories() };
        } catch (error) {
            throw failure(error);
        }
    }
}

/** Mark methods the way the `@Remote` decorator does in DSH's TypeScript. */
function markRemote(Class, names) {
    for (const name of names) {
        Remote(Class.prototype[name], {
            kind: 'method', name, static: false, private: false,
            addInitializer(init) { init.call(Object.create(Class.prototype)); },
        });
    }
}
markRemote(CategoriesRemote, ['list', 'createCategory', 'renameCategory', 'removeCategory', 'moveCategory', 'fileWorkspace']);
