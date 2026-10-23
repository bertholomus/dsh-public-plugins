/**
 * Proof's endpoints for its page and its flags, served by DSH's own gateway
 * as `/api/dsh-plugin-proof/<method>`. Parameters are plain names: the
 * gateway reads them from the method source. Every method answers in words
 * a person can read; none throws a raw error at the window.
 *
 * @module dsh-plugin-proof/remote
 */
import { Remote, RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { EXPORT_FORMATS, exportLedger } from './ledger.js';
import { ledgerState, pageState, sessionState, working } from './page.js';

export const NAMESPACE = 'dsh-plugin-proof';
export const SERVICE = 'dshPluginProofRemote';

export class ProofRemote {
    /**
     * @param {object} options
     * @param {object} options.config - Proof's live settings.
     * @param {object} options.check - its SettingsCheck.
     * @param {import('./verifier.js').Verifier} options.verifier
     * @param {import('./shared/journal.js').Journal} options.journal
     * @param {object} options.dsh - inspect and titleOf (lib/index.js).
     * @param {() => Promise<object[]>} options.rows - the sessions with claims.
     */
    constructor({ config, check, verifier, journal, dsh, rows }) {
        this.config = config;
        // Not `check`: that name is the endpoint below.
        this.settingsCheck = check;
        this.verifier = verifier;
        this.journal = journal;
        this.dsh = dsh;
        this.rows = rows;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /** What the page's readers get. */
    get parts() {
        return { config: this.config, check: this.settingsCheck, verifier: this.verifier, journal: this.journal, dsh: this.dsh, rows: this.rows };
    }

    /** Run one endpoint: what it throws reaches the window as its message, in words. */
    async run(work) {
        try {
            return await work();
        } catch (error) {
            throw new RemoteError('proof/refused', String(error?.message ?? error).slice(0, 300), {});
        }
    }

    /** Refuse, in words, while Proof does not work: what to do first. */
    off() {
        if (this.config.enabled === false) throw new Error('Proof is switched off in DSH\'s profile (enabled: false), so it reads no claims.');
        if (!working(this.parts)) throw new Error('Proof is waiting for a setting to be fixed: see the top of its page.');
    }

    static sessionId(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 200) throw new Error('Name the session.');
        return sessionId;
    }

    /** Everything the page shows. */
    async state() {
        return this.run(() => pageState(this.parts));
    }

    /** What one session's flags need: on or off, how checks run, and its checks. */
    async session(sessionId) {
        return this.run(async () => sessionState(this.parts, ProofRemote.sessionId(sessionId)));
    }

    /** One session's whole ledger: every claim, its evidence, its verdict and its check. */
    async ledger(sessionId) {
        return this.run(async () => {
            this.off();
            return ledgerState(this.parts, ProofRemote.sessionId(sessionId));
        });
    }

    /**
     * One session's ledger as a file to save: `{ name, type, text }`. With
     * `copy`, the window puts it on the clipboard instead, and logs that
     * with `copied` once it has (no file is saved, so none is logged here).
     */
    async exportLedger(sessionId, format, copy) {
        return this.run(async () => {
            this.off();
            if (!EXPORT_FORMATS.includes(format)) throw new Error('Export as Markdown, CSV or JSON.');
            const { session, claims } = await ledgerState(this.parts, ProofRemote.sessionId(sessionId));
            const file = exportLedger(session, claims, format);
            if (copy === true) return file;
            this.journal.add({
                kind: 'export',
                sessionId: session.id,
                text: `Ledger exported as ${format === 'md' ? 'Markdown' : format.toUpperCase()}`,
                why: `${claims.length} claim${claims.length === 1 ? '' : 's'}, as ${file.name}.`,
                state: 'done',
            });
            return file;
        });
    }

    /** The window put a ledger on the clipboard as Markdown (`claims`: how many it held): logged as a copy. */
    async copied(sessionId, claims) {
        return this.run(async () => {
            this.off();
            const id = ProofRemote.sessionId(sessionId);
            const n = Number.isSafeInteger(claims) && claims >= 0 ? claims : undefined;
            this.journal.add({
                kind: 'export',
                sessionId: id,
                text: 'Ledger copied as Markdown',
                why: n === undefined ? 'Onto the clipboard.' : `${n} claim${n === 1 ? '' : 's'}, onto the clipboard.`,
                state: 'done',
            });
            return { ok: true };
        });
    }

    /** Check one claim in a fresh read-only thread. */
    async check(sessionId, claimId) {
        return this.run(async () => {
            this.off();
            if (typeof claimId !== 'string' || claimId === '' || claimId.length > 60) throw new Error('Name the claim to check.');
            return this.verifier.request(ProofRemote.sessionId(sessionId), claimId, { by: 'you' });
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
markRemote(ProofRemote, ['state', 'session', 'ledger', 'exportLedger', 'copied', 'check']);
