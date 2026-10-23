/**
 * Recall's endpoints for its page, its mark on a turn and the tool's card,
 * served by DSH's own gateway as `/api/dsh-plugin-recall/<method>`.
 * Parameters are plain names: the gateway reads them from the method
 * source. Every method answers in words a person can read; none throws a
 * raw error at the window.
 *
 * @module dsh-plugin-recall/remote
 */
import { Remote, RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { cleanQuery, pageState, refusalOf } from './page.js';

export const NAMESPACE = 'dsh-plugin-recall';
export const SERVICE = 'dshPluginRecallRemote';

export class RecallRemote {
    /**
     * @param {object} options
     * @param {object} options.config - Recall's live settings.
     * @param {object} options.check - its SettingsCheck.
     * @param {import('./thread.js').IndexThread} options.thread
     * @param {import('./shared/journal.js').Journal} options.journal
     * @param {() => { left: object[] }} options.sources - the folders searched now.
     * @param {() => object | undefined} options.lastStatus - the last status the index sent.
     * @param {{ rebuild: () => void, restart: () => void }} options.actions - logged in index.js.
     */
    constructor({ config, check, thread, journal, sources, lastStatus, actions }) {
        this.config = config;
        this.settingsCheck = check;
        this.thread = thread;
        this.journal = journal;
        this.sources = sources;
        this.lastStatus = lastStatus;
        this.actions = actions;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /** Run one endpoint: what it throws reaches the window as its message, in words. */
    async run(work) {
        try {
            return await work();
        } catch (error) {
            throw new RemoteError('recall/refused', String(error?.message ?? error).slice(0, 400), {});
        }
    }

    /** Refuse, in words, while Recall cannot search: what to do first. */
    refuse() {
        const no = refusalOf({ config: this.config, check: this.settingsCheck, thread: this.thread });
        if (no) throw new Error(no);
    }

    /** Everything the page shows: settings, the index's state, the folders, what happened. */
    async state() {
        return this.run(() => pageState({
            config: this.config,
            check: this.settingsCheck,
            thread: this.thread,
            status: () => this.thread.call('status', {}, { timeoutMs: 5000 }),
            lastStatus: this.lastStatus(),
            sources: this.sources(),
            journal: this.journal,
        }));
    }

    /** Search: `{ text, kind, folder, model, since, until, sort, limit, offset, prefix, file }`. */
    async search(query) {
        return this.run(async () => {
            this.refuse();
            return this.thread.call('search', cleanQuery(query));
        });
    }

    /** One turn (or note section) in full, by its result id ("12.4"). */
    async turn(id) {
        return this.run(async () => {
            this.refuse();
            if (typeof id !== 'string' || !/^\d{1,12}\.\d{1,9}$/.test(id)) throw new Error('Name a result by its id, such as 12.4.');
            return this.thread.call('turn', { id });
        });
    }

    /** What the filters can choose from: folders, models and kinds, with counts. */
    async facets() {
        return this.run(async () => {
            this.refuse();
            return this.thread.call('facets');
        });
    }

    /** Walk every folder again now, for new, changed and deleted files. */
    async rescan() {
        return this.run(async () => {
            this.refuse();
            return this.thread.call('rescan');
        });
    }

    /** Read every file again; searches keep working meanwhile. */
    async rebuild() {
        return this.run(async () => {
            this.refuse();
            const status = await this.thread.call('rebuild');
            this.actions.rebuild();
            return status;
        });
    }

    /** Start the index thread again after it stopped for good. */
    async restart() {
        return this.run(async () => {
            if (this.config.enabled === false) throw new Error('Recall is switched off in DSH\'s profile (enabled: false).');
            if (this.thread.state === 'running' || this.thread.state === 'starting') return { state: this.thread.state };
            this.actions.restart();
            return { state: this.thread.state };
        });
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
markRemote(RecallRemote, ['state', 'search', 'turn', 'facets', 'rescan', 'rebuild', 'restart']);
