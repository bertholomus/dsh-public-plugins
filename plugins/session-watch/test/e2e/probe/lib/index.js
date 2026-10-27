/**
 * dsh-plugin-session-watch-probe — a stand-in user of Session Watch for its
 * real-DSH test (tests only; never installed). It injects the `sessionWatch`
 * service as Autopilot, Decisions and Agent Terminals do, records what the
 * watcher tells its listeners, and serves the service's calls to the test
 * as window endpoints (`/api/dsh-plugin-session-watch-probe/<method>`).
 *
 * @module dsh-plugin-session-watch-probe
 */
import { Remote, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';

export const name = 'session-watch-probe';
export const inject = [];

const NAMESPACE = 'dsh-plugin-session-watch-probe';
const SERVICE = 'dshPluginSessionWatchProbeRemote';

/** What a listener got, without the state objects (which the test reads from `row`). */
function brief(event) {
    const out = { type: event.type, at: Date.now() };
    for (const key of ['sessionId', 'change', 'status', 'turn', 'id']) if (event[key] !== undefined) out[key] = event[key];
    if (event.end) out.end = { kind: event.end.kind, turn: event.end.turn, ...(event.end.left ? { left: event.end.left } : {}) };
    if (event.type === 'state' && event.state) out.asking = event.state.asking?.question ?? null;
    if (event.delivery) out.delivery = event.delivery;
    if (event.ask) out.ask = { id: event.ask.id, source: event.ask.source, question: event.ask.question };
    if (event.answer !== undefined) out.answer = event.answer;
    if (event.outcome) out.outcome = event.outcome;
    if (event.external !== undefined) out.external = event.external;
    return out;
}

class ProbeRemote {
    constructor(probe) {
        this.probe = probe;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /** Whether the probe has the watcher now. */
    async ready() {
        return { ready: Boolean(this.probe.watch), events: this.probe.events.length };
    }

    /** What the watcher told its listeners, from index `since`. */
    async events(since) {
        const from = Number.isSafeInteger(since) ? since : 0;
        return { next: this.probe.events.length, items: this.probe.events.slice(from) };
    }

    /** `deliver(sessionId, text, { mode, from })`: the delivery as it is when the call returns. */
    async deliver(sessionId, text, mode, from) {
        const watch = this.probe.need();
        const options = { ...(mode ? { mode } : {}), ...(from ? { from } : {}) };
        const delivery = await watch.deliver(sessionId, text, Object.keys(options).length ? options : undefined);
        this.probe.deliveries.set(delivery.id, delivery);
        return delivery.toJSON();
    }

    /** `deliveryOf(id)`: a delivery's record as the watcher has it (an earlier run's too). */
    async deliveryOf(id) {
        return this.probe.need().deliveryOf(id) ?? null;
    }

    /** One delivery as it is now, and whether its `done` promise has resolved. */
    async delivery(id) {
        const delivery = this.probe.deliveries.get(id);
        if (!delivery) return null;
        return { ...delivery.toJSON(), settled: this.probe.settled.has(id) || delivery.state === 'delivered' || delivery.state === 'failed' };
    }

    /** `get(sessionId)`: the session's row, as the suite's pages and plugins read it. */
    async row(sessionId) {
        return this.probe.need().get(sessionId);
    }

    /** `fullState(sessionId)`: the whole state, with the reply text a saved value leaves out. */
    async full(sessionId) {
        const state = await this.probe.need().fullState(sessionId);
        return state ?? null;
    }

    /** The session's log as DSH reads it (`readLog`, through DSH's session controller): each event's type, seq and data. */
    async log(sessionId) {
        const read = await this.probe.need().readLog(sessionId);
        return read ? read.events.map((e) => ({ seq: e.seq, type: e.type, data: e.data })) : null;
    }

    /** `cutOffSessions({ withinMs })`. */
    async cutOff(withinMs) {
        return this.probe.need().cutOffSessions({ withinMs: Number.isFinite(withinMs) ? withinMs : 0 });
    }

    /** `projection(sessionId, key)`. */
    async projection(sessionId, key) {
        return this.probe.need().projection(sessionId, key) ?? null;
    }

    /** `raiseAsk(...)`, with an answer handler that records what it got. */
    async raise(id, sessionId, question) {
        const watch = this.probe.need();
        return watch.raiseAsk({ id, sessionId, source: 'probe', question, options: [{ id: 'yes', label: 'Yes' }], freeText: true, onAnswer: (answer, by) => { this.probe.answers.push({ id, answer, by }); return { told: true }; } });
    }

    /** `answerAsk(id, answer)`. */
    async answer(id, answer) {
        return this.probe.need().answerAsk(id, answer, 'test');
    }

    /** `asks()` and the answers the handler got. */
    async asks() {
        return { waiting: this.probe.need().asks(), answers: this.probe.answers };
    }

    /** `askOutcome(id, outcome)`. */
    async outcome(id, state) {
        return this.probe.need().askOutcome(id, { state, by: 'probe' });
    }

    /** `setExternal(sessionId, external)`. */
    async external(sessionId, status) {
        this.probe.need().setExternal(sessionId, status ? { status, label: 'Probe agent' } : null);
        return true;
    }
}

function markRemote(Class, names) {
    for (const method of names) {
        Remote(Class.prototype[method], {
            kind: 'method', name: method, static: false, private: false,
            addInitializer(init) { init.call(Object.create(Class.prototype)); },
        });
    }
}
markRemote(ProbeRemote, ['ready', 'events', 'deliver', 'deliveryOf', 'delivery', 'row', 'full', 'log', 'cutOff', 'projection', 'raise', 'answer', 'asks', 'outcome', 'external']);

export function apply(ctx) {
    const probe = {
        watch: undefined,
        events: [],
        deliveries: new Map(),
        settled: new Set(),
        answers: [],
        need() {
            if (!this.watch) throw new Error('Session Watch is not running');
            return this.watch;
        },
    };
    // As the suite's plugins do: the watcher is optional at the top, its work under its own scope.
    ctx.inject(['sessionWatch'], (scope) => {
        probe.watch = scope.sessionWatch;
        const off = probe.watch.on((event) => {
            probe.events.push(brief(event));
            if (event.type === 'delivery' && (event.delivery?.state === 'delivered' || event.delivery?.state === 'failed')) probe.settled.add(event.delivery.id);
        });
        return () => {
            off();
            probe.watch = undefined;
        };
    });
    ctx.inject(['typertGateway'], (scope) => {
        scope.provide(SERVICE, new ProbeRemote(probe));
    });
}
