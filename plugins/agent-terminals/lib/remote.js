/**
 * Agent Terminals' endpoints for its page and the window's marks, served by
 * DSH's own gateway as `/api/dsh-plugin-agent-terminals/<method>`.
 * Parameters are plain names: the gateway reads them from the method
 * source. Every method answers in words a person can read; none throws a
 * raw error at the window.
 *
 * @module dsh-plugin-agent-terminals/remote
 */
import { Remote, RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { pageState, working } from './page.js';

export const NAMESPACE = 'dsh-plugin-agent-terminals';
export const SERVICE = 'dshPluginAgentTerminalsRemote';

export class AgentTerminalsRemote {
    constructor({ agents, journal, config, check, watch, terminals, detected, workspaces, started }) {
        this.agents = agents;
        this.journal = journal;
        this.config = config;
        this.check = check;
        this.watch = watch;
        this.terminals = terminals;
        this.detected = detected;
        this.workspaces = workspaces;
        this.started = started;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /** Run one endpoint: what it throws reaches the window as its message, in words. */
    async run(work) {
        try {
            return await work();
        } catch (error) {
            throw new RemoteError('agent-terminals/refused', String(error?.message ?? error).slice(0, 400), {});
        }
    }

    /** Refuse, in words, while Agent Terminals cannot act: what to do first. */
    off() {
        if (this.config.enabled === false) throw new Error('Agent Terminals is switched off in DSH\'s profile (enabled: false), so it starts and types nothing.');
        if (!working(this)) throw new Error('Agent Terminals is waiting for a setting to be fixed: see the top of its page.');
        if (!this.terminals()) throw new Error('This DSH has no terminals for plugins (its terminal controller is not running), so no agent can start.');
        if (!this.started()) throw new Error('Agent Terminals is still starting: try again in a moment.');
    }

    /** Everything the page shows. */
    async state() {
        return this.run(() => pageState(this));
    }

    /** What windows draw on session rows and use to open agents' terminal tabs. */
    async marks() {
        return this.run(async () => ({
            off: !working(this) || !this.terminals(),
            openTabs: this.config.openTabs !== false,
            agents: working(this) ? this.agents.marks() : [],
        }));
    }

    /** Start a new agent. */
    async start(input) {
        return this.run(async () => {
            this.off();
            return this.agents.launch(input);
        });
    }

    /** Start a stopped agent again: resuming its conversation, or anew with `fresh`. */
    async startAgain(key, fresh) {
        return this.run(async () => {
            this.off();
            return this.agents.startAgain(key, { fresh: fresh === true });
        });
    }

    /** Stop an agent (its terminal closes; its conversation stays). */
    async stop(key) {
        return this.run(async () => {
            this.off();
            return this.agents.stopAgent(key);
        });
    }

    /** Drop an agent from the list. */
    async forget(key) {
        return this.run(async () => {
            this.off();
            return this.agents.forget(key);
        });
    }

    /** Send a message: typed in when the agent is ready, then proven from its transcript. */
    async send(key, text) {
        return this.run(async () => {
            this.off();
            return this.agents.send(key, text);
        });
    }

    /** Take back a message not typed in yet. */
    async cancel(key, id) {
        return this.run(async () => {
            this.off();
            return this.agents.cancel(key, id);
        });
    }

    /** What an agent's terminal shows now, when it can be read. */
    async screen(key) {
        return this.run(async () => {
            const record = this.agents.need(key);
            const lines = this.agents.typist.screenLines(record.sessionId, record.terminalId);
            if (!lines) return { lines: null };
            while (lines.length && lines.at(-1).trim() === '') lines.pop();
            return { lines: lines.slice(-60) };
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
markRemote(AgentTerminalsRemote, ['state', 'marks', 'start', 'startAgain', 'stop', 'forget', 'send', 'cancel', 'screen']);
