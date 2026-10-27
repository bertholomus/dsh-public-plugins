/**
 * A stand-in for the DSH services the router drives (agents, presets,
 * titles, workspaces, the model route, the title model), for unit tests.
 * Agents record what they were handed (followups, steers, cancels) and let
 * a test play their turns: claimed, a Discord send or not, the turn about to
 * stop (with the router's own listeners), an error, idle. The real wiring is
 * proven against real DSH in test/e2e.
 *
 * @module test/support/fake-host
 */
import { randomUUID } from 'node:crypto';

/** DSH's helpers, faked: plain objects with the same fields. */
export const host = {
    brandString: (s) => s,
    createUserMessage: (m) => ({ id: randomUUID(), role: 'user', ...m }),
    BlockAssembler: class {
        constructor() {
            this.text = '';
            this.finish = undefined;
        }
        push(chunk) {
            if (chunk.type === 'text') this.text += chunk.text;
            if (chunk.type === 'error') this.finish = { kind: 'error', error: { message: chunk.message } };
        }
        blocks() {
            return this.text ? [{ type: 'text', text: this.text }] : [];
        }
    },
};

/**
 * An agent's scoped context: on() for listeners, emit/serial/waterfall for the test.
 * As in cordis, listeners run in the order they were added, and `{ prepend: true }`
 * (or `true`) puts one in front; a waterfall listener that does not call next() ends the chain.
 */
function agentContext() {
    const listeners = new Map();
    const registered = [];
    return {
        listeners,
        // DSH's tool registry as an agent's own scope sees it: a tool registered here is this agent's only.
        tools: {
            registered,
            register(definition) {
                if (registered.some((t) => t.name === definition.name)) throw new Error(`a tool named ${definition.name} is already registered in this scope`);
                registered.push(definition);
                return () => {
                    const at = registered.indexOf(definition);
                    if (at >= 0) registered.splice(at, 1);
                };
            },
        },
        on(name, fn, options) {
            if (!listeners.has(name)) listeners.set(name, []);
            const prepend = typeof options === 'object' ? options?.prepend === true : options === true;
            listeners.get(name)[prepend ? 'unshift' : 'push'](fn);
            // As in cordis: the way to take the listener off again.
            return () => {
                const list = listeners.get(name) ?? [];
                const at = list.indexOf(fn);
                if (at >= 0) list.splice(at, 1);
            };
        },
        emit(name, payload) {
            for (const fn of listeners.get(name) ?? []) fn(payload);
        },
        async serial(name, payload) {
            for (const fn of listeners.get(name) ?? []) await fn(payload);
        },
        async waterfall(name, payload, base) {
            const fns = listeners.get(name) ?? [];
            // The end of the chain: a value, or (as DSH's own waterfalls take it) a function that gives one.
            const run = (i) => (i >= fns.length ? Promise.resolve(typeof base === 'function' ? base() : base) : fns[i](payload, () => run(i + 1)));
            return run(0);
        },
    };
}

export class FakeAgent {
    constructor(sessionId) {
        this.id = sessionId;
        this.ctx = agentContext();
        // The session's history as DSH's deriveMessages() gives it: the messages taken up and the agent's answers.
        this.messages = [];
        this.session = { id: sessionId, deriveMessages: () => [...this.messages] };
        this.status = 'idle';
        this.followups = [];
        this.steers = [];
        this.cancels = [];
        this.turn = 0;
        this.disposed = false;
    }
    followup(message) {
        if (this.disposed) throw new Error('the agent was disposed');
        this.followups.push(message);
    }
    steer(message) {
        this.steers.push(message);
    }
    cancel(cause, options) {
        this.cancels.push({ cause, options });
    }
    setStatus(status) {
        this.status = status;
        this.ctx.emit('agent/status', { agent: this, status });
    }
    /**
     * Play one turn over the newest followup.
     * @param {object} play
     * @param {() => Promise<void>} [play.send] - what the model does in its first step (a tool call, say).
     * @param {() => Promise<void>} [play.afterNudge] - what it does after a reminder.
     * @param {string} [play.text] - its last words.
     * @param {unknown} [play.error] - the turn fails with this.
     */
    async playTurn({ send, afterNudge, text = 'Here is my answer.', error } = {}) {
        this.turn += 1;
        const turn = this.turn;
        this.setStatus('running');
        const message = this.followups.at(-1);
        if (message) this.messages.push(message);
        this.ctx.emit('agent/inbox/claimed', { agent: this, message, turn });
        if (error !== undefined) {
            this.ctx.emit('agent/error', { agent: this, turn, step: 1, error });
            this.setStatus('idle');
            return;
        }
        if (send) await send();
        this.messages.push({ id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }] });
        const before = this.steers.length;
        await this.ctx.serial('agent/turn-stopping', { agent: this, turn });
        if (this.steers.length > before) {
            this.messages.push(...this.steers.slice(before));
            if (afterNudge) await afterNudge();
            await this.ctx.serial('agent/turn-stopping', { agent: this, turn });
        }
        this.setStatus('idle');
    }
}

/**
 * The DSH services the router injects.
 * @param {object} [options]
 * @param {string[]} [options.permissionPresets] - preset names that exist.
 * @param {string} [options.title] - what the title model answers.
 * @param {(agentCtx: object) => void} [options.hostListeners] - DSH's own listeners, put on each
 *   agent before the plugin's setup runs (as DSH's boot-time listeners are there before any plugin's).
 * @param {() => Promise<void>} [options.createGate] - awaited before a session is made.
 */
export function fakeCtx({ permissionPresets = ['read-only', 'workspace-write', 'danger-full-access'], title = 'Fix the login redirect loop', hostListeners, createGate } = {}) {
    const agents = new Map();
    const created = [];
    const resumed = [];
    const renames = [];
    const presetSets = [];
    const open = new Map();
    const logs = [];
    const ctx = {
        logger: {
            info: (...a) => logs.push(['info', ...a]),
            warn: (...a) => logs.push(['warn', ...a]),
            debug: () => {},
        },
        agents: {
            async create({ sessionId, meta, agentOptions, setup }) {
                if (createGate) await createGate(); // a session that takes its time to start (DSH can stop meanwhile)
                const agent = new FakeAgent(sessionId);
                agent.meta = meta;
                agent.options = agentOptions;
                hostListeners?.(agent.ctx);
                await setup(agent.ctx, agent);
                agents.set(sessionId, agent);
                created.push(agent);
                return { agent, dispose: async () => { agent.disposed = true; } };
            },
            async resume({ resumeSessionId, setup }) {
                if (!agents.has(resumeSessionId) && !ctx.agents.knownOnDisk.has(resumeSessionId)) throw new Error(`session ${resumeSessionId} not found`);
                const agent = new FakeAgent(resumeSessionId);
                hostListeners?.(agent.ctx);
                await setup(agent.ctx, agent);
                agents.set(resumeSessionId, agent);
                resumed.push(agent);
                return { agent, dispose: async () => { agent.disposed = true; } };
            },
            get: (id) => open.get(id),
            knownOnDisk: new Set(),
        },
        agentPresets: {
            resolve: async (name) => ({ id: name }),
            acquireScope: async () => ({ [Symbol.asyncDispose]: async () => {} }),
            mount: async () => {},
        },
        permissionPresets: {
            resolve(name) {
                if (!permissionPresets.includes(name)) throw new Error(`there is no permission preset named "${name}"`);
                return { id: name };
            },
            set: (session, name) => presetSets.push({ sessionId: session.id, name }),
        },
        sessionTitle: { rename: (session, t) => renames.push({ sessionId: session.id, title: t }) },
        workspaceRegistry: { create: async (path) => ({ path, attachSession: async () => {} }) },
        agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
        llm: {
            stream: async function* () {
                if (title instanceof Error) throw title;
                yield { type: 'text', text: title };
            },
        },
    };
    return { ctx, agents, created, resumed, renames, presetSets, open, logs };
}
