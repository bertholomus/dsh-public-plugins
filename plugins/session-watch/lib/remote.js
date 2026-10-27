/**
 * The watcher's endpoints for the suite's windows, served by DSH's own
 * gateway as `/api/dsh-plugin-session-watch/<method>`.
 *
 * - `wait(since, timeoutMs)`: one request a window keeps open; it answers
 *   when any suite plugin's channel moves (or after `timeoutMs`), so each
 *   plugin's window reads its own state only when something changed.
 * - `sessions()`: every session with its state word, for the suite's pages.
 * - `deliveries(sessionId, limit)`: what it put into sessions and what
 *   became of each, newest first, from its journal.
 * - `status()`: that the watcher runs, and a setting of its that is wrong.
 *
 * Parameters are plain names: the gateway reads them from the method source.
 *
 * @module dsh-plugin-session-watch/remote
 */
import { Remote, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';

/** Wire namespace: the window calls `/api/dsh-plugin-session-watch/<method>`. */
export const NAMESPACE = 'dsh-plugin-session-watch';
/** Cordis service key the gateway finds the service by. */
export const SERVICE = 'dshPluginSessionWatchRemote';

/** Longest a window's open request waits. */
export const MAX_WAIT_MS = 25000;

export class SessionWatchRemote {
    /**
     * @param {import('./watch.js').SessionWatch} watch
     * @param {import('./shared/hub.js').Hub} hub
     */
    constructor(watch, hub) {
        this.watch = watch;
        this.hub = hub;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /**
     * Answer when a channel moves past `since`, or after `timeoutMs` (at most
     * 25 s). DSH aborts `signal` when the window goes away, which ends the wait.
     */
    async wait(since, timeoutMs, signal) {
        const ms = Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, 0), MAX_WAIT_MS) : MAX_WAIT_MS;
        return this.hub.wait(since, ms, signal);
    }

    /** Every session DSH lists, with the watcher's state and its state word. */
    async sessions() {
        return { items: await this.watch.list() };
    }

    /** What it put into sessions and what became of each, newest first (at most 200; one session's when `sessionId` is given). */
    async deliveries(sessionId, limit) {
        const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
        return { items: this.watch.deliveries({ ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}), limit: n }) };
    }

    /** That the watcher runs (the suite's pages ask when their own plugin does not answer), and a wrong setting, if any. */
    async status() {
        const problem = this.watch.settings?.problem;
        return { running: true, ...(problem ? { problem } : {}) };
    }
}

/** Mark methods the way the `@Remote` decorator does in DSH's TypeScript: DSH's gateway serves only marked methods. */
function markRemote(Class, names) {
    for (const name of names) {
        Remote(Class.prototype[name], {
            kind: 'method', name, static: false, private: false,
            addInitializer(init) { init.call(Object.create(Class.prototype)); },
        });
    }
}
markRemote(SessionWatchRemote, ['wait', 'sessions', 'deliveries', 'status']);
