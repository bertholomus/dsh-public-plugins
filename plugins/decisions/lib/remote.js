/**
 * Decisions' endpoints for its page, served by DSH's own gateway as
 * `/api/dsh-plugin-decisions/<method>`. Parameters are plain names: the
 * gateway reads them from the method source. Every method answers in
 * words a person can read; none throws a raw error at the window.
 *
 * @module dsh-plugin-decisions/remote
 */
import { Remote, RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { pageState, working } from './page.js';

export const NAMESPACE = 'dsh-plugin-decisions';
export const SERVICE = 'dshPluginDecisionsRemote';

export class DecisionsRemote {
    constructor({ inbox, journal, config, check, mirror, watch, notifications }) {
        this.inbox = inbox;
        this.journal = journal;
        this.config = config;
        this.check = check;
        this.mirror = mirror;
        this.watch = watch;
        this.notifications = notifications;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /** Run one endpoint: what it throws reaches the window as its message, in words. */
    async run(work) {
        try {
            return await work();
        } catch (error) {
            throw new RemoteError('decisions/refused', String(error?.message ?? error).slice(0, 300), {});
        }
    }

    /** Refuse, in words, while Decisions does not work: what to do first. */
    off() {
        if (this.config.enabled === false) throw new Error('Decisions is switched off in DSH\'s profile (enabled: false), so it answers nothing. Answer in the session instead.');
        if (!working(this)) throw new Error('Decisions is waiting for a setting to be fixed: see the top of its page.');
    }

    /** Everything the page shows. */
    async state() {
        return this.run(() => pageState(this));
    }

    /** The panel icon's count: what waits, and how much of it holds a running turn. */
    async badge() {
        return this.run(async () => (working(this) ? this.inbox.badge() : { waiting: 0, urgent: 0, off: true }));
    }

    /** Answer one card; `answer`'s shape depends on the card (see Inbox.answer). */
    async answer(id, answer) {
        return this.run(async () => {
            this.off();
            return this.inbox.answer(id, answer);
        });
    }

    /** Hide a card here (the session itself still waits, if it does). */
    async dismiss(id) {
        return this.run(async () => {
            this.off();
            if (typeof id !== 'string' || id === '') throw new Error('Name what to dismiss.');
            return this.inbox.dismiss(id);
        });
    }

    /** Bring a dismissed card back. */
    async undismiss(id) {
        return this.run(async () => {
            this.off();
            if (typeof id !== 'string' || id === '') throw new Error('Name what to bring back.');
            return this.inbox.undismiss(id);
        });
    }

    /**
     * Note in What happened that the webhook address was set or removed on
     * Decisions' settings page. The address itself never comes here: DSH's
     * key store holds it.
     */
    async addressChanged(change) {
        return this.run(async () => {
            if (change !== 'set' && change !== 'removed') throw new Error('Say whether the webhook address was set or removed.');
            const key = typeof this.config.mirrorUrlEnv === 'string' && this.config.mirrorUrlEnv ? this.config.mirrorUrlEnv : 'DECISIONS_WEBHOOK_URL';
            this.journal.add({
                kind: 'settings',
                text: change === 'set' ? 'Webhook address set' : 'Webhook address removed',
                why: change === 'set' ? `Kept in DSH's key store under ${key}, never in the settings file.` : `Removed from DSH's key store (${key}).`,
                state: 'done',
            });
            return { ok: true };
        });
    }

    /** Send a test message through the mirror. */
    async testMirror() {
        return this.run(async () => {
            this.off();
            const result = await this.mirror.test();
            if (!result.ok) throw new Error(`Not sent: ${String(result.reason).replace(/\.$/, '')}.`);
            return { ok: true, place: result.place || this.mirror.place };
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
markRemote(DecisionsRemote, ['state', 'badge', 'answer', 'dismiss', 'undismiss', 'addressChanged', 'testMirror']);
