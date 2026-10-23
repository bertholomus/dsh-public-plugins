/**
 * The plugin's endpoints for its browser half. DSH's own panels reach the
 * Host through Remote namespaces its gateway serves on the window's
 * connection (`/api/<namespace>/<method>`, the same carrier in the desktop
 * app and in a browser). This module adds one more, `dsh-plugin-coordinator`,
 * so a chat starts or stops coordinating from its header (coordinate), the
 * Thread settings dialog in lib/client.js reads and changes a coordinating
 * chat's thread model, effort and pause the way its thread_settings tool
 * does, through the same manager methods, and its access settings (the
 * user's tools, the thread permission), which only it does, a failed or
 * stopped thread runs again from its card (Retry, Resume), a thread's
 * Changes tab reads its diffs (changes), a coordinating chat is archived
 * with its threads or brought back (archive, restore), and the window hears
 * what the user hasn't seen yet (news, seeNews).
 *
 * The gateway finds a Remote service by its `typertRemote` binding and the
 * method markers on its prototype; DSH's own services get both from
 * TypeScript decorators, applied here by hand. Parameters are plain names,
 * since the gateway reads them from the method source.
 *
 * @module dsh-plugin-coordinator/remote
 */
import { Remote, RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { ProjectError } from './projects.js';

/** Wire namespace: the client calls `/api/dsh-plugin-coordinator/<method>`. */
export const NAMESPACE = 'dsh-plugin-coordinator';
/** Cordis service key the gateway looks the service up by. */
export const SERVICE = 'dshPluginCoordinatorRemote';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A plugin error the user can act on, as a Remote failure the dialog shows. */
function failure(error) {
    if (error instanceof ProjectError) return new RemoteError('coordinator/refused', error.message, {});
    return error;
}

export class ProjectsRemote {
    /**
     * @param {object} ctx - the plugin's context (the binding reads it).
     * @param {object} manager - the ProjectManager.
     */
    constructor(ctx, manager) {
        this.ctx = ctx;
        this.manager = manager;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /**
     * A coordinating chat's thread settings and threads, as the dialog shows them.
     * @param target - the chat's session id, or the id of one of its threads.
     */
    async describe(target) {
        try {
            return await this.manager.describeProject(this.manager.projectFor(target));
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * Every coordinating chat with its thread settings and access settings
     * and their sources, with the user's tools (guardedTools) and the
     * permissions DSH offers.
     */
    async list() {
        try {
            return { ...this.lists(), guarded: this.manager.guards().map(([name]) => name), permissions: this.manager.permissionCatalog() };
        } catch (error) {
            throw failure(error);
        }
    }

    /** What every change answers with: the coordinating chats as they are now. */
    lists() {
        return { projects: this.manager.listProjects() };
    }

    /**
     * Every coordinating chat and thread the plugin knows, by session id,
     * for the session list while DSH has no value of the plugin's
     * projection for one (a session from before an update, not opened since).
     */
    async sessions() {
        try {
            return { sessions: this.manager.knownSessions() };
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * What the user hasn't seen yet, per coordinating chat: threads that
     * handed back, finished, wait on the user's approval, or failed or
     * stopped (the chat row's mark and the window's notice).
     * @returns {news: [{project, name, coordinator, seq, seen, unread}]}
     */
    async news() {
        try {
            return { news: this.manager.listNews() };
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * The user opened a coordinating chat: its news up to `seq` is seen.
     * @param target - the chat's session id, or the id of one of its threads.
     * @param seq - the newest news the window showed them; omitted, all of it.
     * @returns as news.
     */
    async seeNews(target, seq) {
        try {
            this.manager.seeNews(this.manager.projectFor(target), Number.isInteger(seq) ? seq : undefined);
            return { news: this.manager.listNews() };
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * Start or stop coordinating in a chat: its header's Coordinate button,
     * or Stop coordinating in its Threads menu. It runs as /coordinate (or
     * /coordinate off) in that chat, so DSH shows it there.
     * @param target - the chat's session id.
     * @param on - true to start, false to stop.
     * @returns {coordinating, session, text: the line DSH shows under the command, projects}.
     */
    async coordinate(target, on) {
        try {
            const done = await this.manager.coordinateFromWindow(typeof target === 'string' ? target : '', on !== false);
            return { ...done, ...this.lists() };
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * Archive a coordinating chat with its threads: what runs in them stops,
     * and DSH archives each one. Nothing is deleted.
     * @param project - the chat's session id, or the id of one of its threads.
     * @returns {archived: how many sessions DSH archived now, projects}.
     */
    async archive(project) {
        try {
            const done = await this.manager.archiveProject(this.manager.projectFor(project));
            return { archived: done.archived, ...this.lists() };
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * Bring an archived coordinating chat back with its threads.
     * @param project - as for archive.
     * @returns {restored: how many sessions DSH unarchived now, projects}.
     */
    async restore(project) {
        try {
            const done = await this.manager.restoreProject(this.manager.projectFor(project));
            return { restored: done.restored, ...this.lists() };
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * A thread's own changes for its Changes tab: each file with lines added
     * and deleted and each edit's hunks, the project's other threads that
     * changed the same files, and the turns DSH's Review can still show.
     * @param target - the thread's session id, or its chat's with `thread`.
     * @param thread - the thread's id (t3), when target isn't its session.
     */
    async changes(target, thread) {
        try {
            return await this.manager.threadDiffs(target, typeof thread === 'string' ? thread : undefined);
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * Run a thread again after its last turn failed (Retry) or stopped (Resume).
     * @param target - as for describe.
     * @param thread - the thread's id (t3).
     * @returns the project as describe returns it.
     */
    async continueThread(target, thread) {
        try {
            if (typeof thread !== 'string' || thread === '') throw new ProjectError('thread is required');
            return await this.manager.continueThread(this.manager.projectFor(target), thread);
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * Change a coordinating chat's thread settings, or one thread's model,
     * effort or permission, or rename, stop, resolve or reopen a thread.
     * Values are strings; null goes back to the default. `paused` is a
     * boolean. Access settings change only here (and in the plugin's
     * defaults): yourTools "asked" or "always", a permission DSH offers or
     * "default".
     * @param target - as for describe.
     * @param changes - {threadModel?, threadEffort?, paused?, yourTools?, threadPermission?}
     *   or {thread, model?, effort?, permission?}, or from a thread row's ⋯ {thread, title?, resolved?, stop?}.
     * @returns the project as describe returns it, with `notes` from the change.
     */
    async update(target, changes) {
        try {
            if (!isObject(changes)) throw new ProjectError('changes must be an object');
            return await this.manager.changeFromWindow(this.manager.projectFor(target), changes);
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
markRemote(ProjectsRemote, [
    'describe', 'list', 'sessions', 'news', 'seeNews', 'update', 'continueThread', 'changes', 'coordinate', 'archive', 'restore',
]);
