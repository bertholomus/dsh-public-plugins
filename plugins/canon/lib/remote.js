/**
 * Canon's endpoints for its page and its card after a turn, served by
 * DSH's own gateway as `/api/dsh-plugin-canon/<method>`. Parameters are
 * plain names: the gateway reads them from the method source. Every method
 * answers in words a person can read; none throws a raw error at the
 * window.
 *
 * Promote is here and only here: a person presses it on Canon's page. No
 * tool, model or timer can reach it.
 *
 * @module dsh-plugin-canon/remote
 */
import { Remote, RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { sessionFolder } from './config.js';
import { pageState, sessionState, working } from './page.js';

export const NAMESPACE = 'dsh-plugin-canon';
export const SERVICE = 'dshPluginCanonRemote';

export class CanonRemote {
    /**
     * @param {object} parts - what the page reads (page.js), and Canon's actions:
     *   `setSession(sessionId, on)`, `promote(path)`, `discard(path)`, `preview(text, folder)`, `refresh()`.
     */
    constructor(parts) {
        this.parts = parts;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /** Run one endpoint: what it throws reaches the window as its message, in words. */
    async run(work) {
        try {
            return await work();
        } catch (error) {
            throw new RemoteError('canon/refused', String(error?.message ?? error).slice(0, 400), {});
        }
    }

    /** Refuse, in words, while Canon does not work: what to do first. */
    off() {
        if (this.parts.config.enabled === false) throw new Error('Canon is switched off in DSH\'s profile (enabled: false), so it reads no vault.');
        if (!working(this.parts)) throw new Error('Canon is waiting for a setting to be fixed: see the top of its page.');
    }

    static sessionId(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 200) throw new Error('Name the session.');
        return sessionId;
    }

    /** Everything the page shows. */
    async state() {
        return this.run(() => pageState(this.parts));
    }

    /** What one session's card needs: whether Canon adds notes there. */
    async session(sessionId) {
        return this.run(async () => sessionState(this.parts, CanonRemote.sessionId(sessionId)));
    }

    /** Turn adding notes on or off for one session. */
    async setSession(sessionId, on) {
        return this.run(async () => {
            this.off();
            if (typeof on !== 'boolean') throw new Error('Say on or off.');
            return this.parts.setSession(CanonRemote.sessionId(sessionId), on);
        });
    }

    /**
     * What a prompt would get: the notes, why each, and the exact block, for
     * a session in `folder` (a full path, or one starting with ~/, as a
     * turn's session has it; empty for a session with no folder).
     */
    async search(text, folder) {
        return this.run(async () => {
            this.off();
            if (typeof text !== 'string' || text.trim() === '') throw new Error('Type a prompt to try.');
            if (text.length > 8000) throw new Error('Try a shorter prompt (at most 8,000 characters).');
            const where = sessionFolder(folder, this.parts.home);
            if (where === undefined) {
                const said = typeof folder === 'string' ? ` (it is “${folder.trim().slice(0, 120)}”)` : '';
                throw new Error(`The session folder must be a full path, such as /Users/you/Projects/app, or start with ~/, such as ~/Projects/app${said}. Leave it empty for a session with no folder.`);
            }
            return this.parts.preview(text, where);
        });
    }

    /** Promote a draft to an active note (a person pressed Promote). */
    async promote(path) {
        return this.run(async () => {
            this.off();
            if (typeof path !== 'string' || path === '') throw new Error('Name the draft to promote.');
            return this.parts.promote(path);
        });
    }

    /** Discard a draft to the vault's trash (a person pressed Discard). */
    async discard(path) {
        return this.run(async () => {
            this.off();
            if (typeof path !== 'string' || path === '') throw new Error('Name the draft to discard.');
            return this.parts.discard(path);
        });
    }

    /** Read the vault again now. */
    async refresh() {
        return this.run(async () => {
            this.off();
            return this.parts.refresh();
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
markRemote(CanonRemote, ['state', 'session', 'setSession', 'search', 'promote', 'discard', 'refresh']);
