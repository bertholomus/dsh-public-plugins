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

/** What a change answers while the plugin is switched off in its settings. */
export const OFF_TEXT = 'Categories are switched off in the plugin\'s settings: set enabled: true in its row of the profile\'s cordis.patch.yml to switch them on.';

export class CategoriesRemote {
    /**
     * @param {object} ctx - the plugin's context (the binding reads it).
     * @param {object|null} manager - the CategoryManager, or null while the plugin is switched off in its settings.
     * @param {{ problems?: Array<{key: string, text: string}>, warn?: (text: string) => void }} [options]
     *   problems: the settings that were wrong (config.js), for the page to name; warn: the plugin's log (index.js).
     */
    constructor(ctx, manager, { problems = [], warn = () => {} } = {}) {
        this.ctx = ctx;
        this.manager = manager;
        this.problems = problems;
        this.warn = warn;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /**
     * A refusal the user can act on as it is; anything else in words, and
     * logged, so no call ever fails without saying why.
     */
    failure(error) {
        if (error instanceof CategoryError) return new RemoteError('categories/refused', error.message, {});
        const message = String(error?.message ?? error).slice(0, 300);
        try { this.warn(`categories: a call failed: ${message}`); } catch { /* the log never fails a call */ }
        return new RemoteError('categories/failed', `Categories could not do that: ${message}`, {});
    }

    /** The plugin's manager, or the refusal a change gets while it is switched off. */
    running() {
        if (!this.manager) throw new RemoteError('categories/off', OFF_TEXT, {});
        return this.manager;
    }

    /**
     * Every category in its order, with the workspaces it holds in DSH's
     * order: `{categories: [{id, name, source, importedFrom?, imported?, workspaces: [{id, path, title}]}], problems, store}`.
     * `imported` marks one this plugin's import of the old sidebar made;
     * `problems` names the settings that were wrong (each counts as its
     * default); `store` says what is wrong with the store, in words (a save
     * that failed, a file that couldn't be used), else null.
     * Switched off in its settings: `{categories: [], off: true, problems, store: null}`.
     */
    async list() {
        try {
            if (!this.manager) return { categories: [], off: true, problems: this.problems, store: null };
            // A workspace DSH added since (it lists a new one first) goes back among those in none.
            this.manager.syncWorkspaceOrder().catch(() => {});
            return { categories: this.manager.listCategories(), problems: this.problems, store: this.manager.storeNote() };
        } catch (error) {
            throw this.failure(error);
        }
    }

    /** What a change answers: the categories as they are now, and the store's note (list). */
    answer(extra = {}) {
        return { ...extra, categories: this.manager.listCategories(), store: this.manager.storeNote() };
    }

    /**
     * A new category, last in the list.
     * @param name - its name.
     * @param workspace - optional: a DSH workspace id it holds from the start.
     * @returns {category: the new id, categories}.
     */
    async createCategory(name, workspace) {
        try {
            const id = await this.running().createCategory(name, typeof workspace === 'string' && workspace !== '' ? workspace : undefined);
            return this.answer({ category: id });
        } catch (error) {
            throw error instanceof RemoteError ? error : this.failure(error);
        }
    }

    /** Rename a category. @returns {categories}. */
    async renameCategory(category, name) {
        try {
            this.running().renameCategory(category, name);
            return this.answer();
        } catch (error) {
            throw error instanceof RemoteError ? error : this.failure(error);
        }
    }

    /** Delete a category; its workspaces go to Other workspaces. @returns {categories}. */
    async removeCategory(category) {
        try {
            await this.running().removeCategory(category);
            return this.answer();
        } catch (error) {
            throw error instanceof RemoteError ? error : this.failure(error);
        }
    }

    /** Move a category before another one, or (before empty) to the end. @returns {categories}. */
    async moveCategory(category, before) {
        try {
            await this.running().moveCategory(category, typeof before === 'string' ? before : null);
            return this.answer();
        } catch (error) {
            throw error instanceof RemoteError ? error : this.failure(error);
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
            await this.running().fileWorkspace(workspace, typeof category === 'string' && category !== '' ? category : null, typeof before === 'string' ? before : null);
            return this.answer();
        } catch (error) {
            throw error instanceof RemoteError ? error : this.failure(error);
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
