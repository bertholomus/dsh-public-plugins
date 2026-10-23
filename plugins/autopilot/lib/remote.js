/**
 * Autopilot's endpoints for its page, served by DSH's own gateway as
 * `/api/dsh-plugin-autopilot/<method>`. Parameters are plain names: the
 * gateway reads them from the method source. Every method answers in
 * words a person can read; none throws a raw error at the window.
 *
 * @module dsh-plugin-autopilot/remote
 */
import { Remote, RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { pageState } from './page.js';
import { RULES } from './pilot.js';

export const NAMESPACE = 'dsh-plugin-autopilot';
export const SERVICE = 'dshPluginAutopilotRemote';

export class AutopilotRemote {
    constructor({ pilot, watch, journal, config, check }) {
        this.pilot = pilot;
        this.watch = watch;
        this.journal = journal;
        this.config = config;
        this.check = check;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /** Run one endpoint: what it throws reaches the window as its message, in words. */
    async run(work) {
        try {
            return await work();
        } catch (error) {
            throw new RemoteError('autopilot/refused', String(error?.message ?? error).slice(0, 300), {});
        }
    }

    /** Refuse a change while a setting is wrong, or while the profile switches Autopilot off: the page says which. */
    ready() {
        const problem = this.check?.problem;
        if (problem) throw new Error(`Not changed: Autopilot is waiting for a setting to be fixed (${problem.text}).`);
        if (this.config.enabled === false) throw new Error('Not changed: Autopilot is switched off in DSH\'s profile (enabled: false), so it watches nothing.');
    }

    /** Everything the page shows. */
    async state() {
        return this.run(() => pageState(this));
    }

    /** The panel icon's count: questions Autopilot waits on, and whether it is off. */
    async badge() {
        return this.run(async () => ({
            asks: (this.watch.asks?.() ?? []).filter((ask) => ask.source === 'Autopilot').length,
            paused: this.pilot.data.paused === true || this.config.enabled === false || this.check?.ok === false,
        }));
    }

    /** The kill switch. */
    async setPaused(paused) {
        return this.run(async () => {
            this.ready();
            if (typeof paused !== 'boolean') throw new Error('Say true to switch Autopilot off, false to switch it on.');
            this.pilot.setPaused(paused);
            return { paused: this.pilot.data.paused };
        });
    }

    /** One session's rule; null goes back to the default. */
    async setRule(sessionId, rule) {
        return this.run(async () => {
            this.ready();
            if (typeof sessionId !== 'string' || sessionId === '') throw new Error('Name the session.');
            if (rule !== null && !RULES.includes(rule)) throw new Error('The rule must be Auto, Ask first or Off.');
            this.pilot.setRule(sessionId, rule ?? undefined);
            return { rule: this.pilot.ruleOf(sessionId) };
        });
    }

    /** The rule for sessions without their own. */
    async setDefaultRule(rule) {
        return this.run(async () => {
            this.ready();
            if (!RULES.includes(rule)) throw new Error('The rule must be Auto, Ask first or Off.');
            this.pilot.setDefaultRule(rule);
            return { rule: this.pilot.defaultRule() };
        });
    }

    /** Answer one of Autopilot's questions: 'go', 'skip', or the person's own words. */
    async answer(id, answer) {
        return this.run(async () => {
            this.ready();
            if (typeof id !== 'string') throw new Error('Name the question.');
            if (typeof answer !== 'string' || answer.trim() === '') throw new Error('The answer is empty.');
            const result = await this.watch.answerAsk(id, answer.trim(), 'you');
            if (!result.ok) throw new Error(result.error);
            return { ok: true };
        });
    }

    /** Try a session again now, past a back-off or a give-up. */
    async retry(sessionId) {
        return this.run(async () => {
            this.ready();
            if (typeof sessionId !== 'string' || sessionId === '') throw new Error('Name the session.');
            const result = await this.pilot.retry(sessionId);
            return { action: result.action, ...(result.why ? { why: result.why } : {}) };
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
markRemote(AutopilotRemote, ['state', 'badge', 'setPaused', 'setRule', 'setDefaultRule', 'answer', 'retry']);
