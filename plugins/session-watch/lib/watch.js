/**
 * The session watcher: one listener on DSH's session and agent events for
 * the whole suite, and the services built on it.
 *
 * - `list()` and `get(id)`: every session's state (lib/fold.js), its title,
 *   folder and whether its agent is running, idle or not loaded ("cold").
 *   Loaded sessions read DSH's projection registry; the rest read the
 *   values DSH saved with them.
 * - `on(listener)`: turn starts and ends, status changes and state changes,
 *   after DSH's projection has taken the event.
 * - `deliver(id, text)`: a message into a session, with proof. It resolves
 *   once the session's own log shows the message: queued in its inbox
 *   (`agent/inbox/spliced`) and then read into a turn (`user/message`).
 *   Nothing here ever reports a message as sent without that.
 * - `cutOffSessions()`: sessions whose last turn DSH cut off when it
 *   stopped (a restart, a crash, a reload), found from the watcher's own
 *   record of running turns and DSH's saved values, and checked against
 *   the session's log.
 * - `asks`: questions waiting on a person, raised by any suite plugin
 *   (Autopilot's "ask first" rule, an agent in a terminal) and answered in
 *   Decisions or on the raising plugin's page. `askOutcome` says later what
 *   became of an answer (typed into a terminal, then proven or not).
 * - `projection(id, key)`: another projection's value for a session (DSH's
 *   question box, the coordinator's threads), live or as DSH saved it.
 *
 * @module dsh-plugin-session-watch/watch
 */
import { join } from 'node:path';
import { KEY, applyEvent, foldAll, parseState, viewOf } from './fold.js';
import { cutOff, stateWord } from './shared/words.js';
import { JsonStore } from './shared/files.js';
import { errorText, isRecord, later } from './shared/safe.js';

export { stateWord };

/** Other projections the suite reads (DSH's question box, the coordinator's threads), kept from DSH's list for sessions that are not loaded. */
export const SHARED_KEYS = Object.freeze(['userQuestions', 'coordinatorSession']);

/** How a watcher event is named for listeners. */
export const EVENTS = Object.freeze(['turn-start', 'turn-end', 'status', 'state', 'agent', 'delivery', 'ask', 'external']);

/** What can become of an answer, once its asker knows (`askOutcome`). */
export const OUTCOMES = new Set(['delivered', 'not proven', 'not delivered', 'typed in']);

/** One message's way into a session, for `deliver`. */
class Delivery {
    constructor(id, sessionId, text, now = Date.now) {
        this.id = id;
        this.sessionId = sessionId;
        this.text = text;
        this.now = now;
        /** 'pending' → 'queued' → 'delivered', or 'failed'. */
        this.state = 'pending';
        this.at = now();
        this.listeners = new Set();
        let resolve;
        this.done = new Promise((r) => { resolve = r; });
        this.resolveDone = resolve;
    }

    /** Move forward; never back. */
    advance(state, details = {}) {
        const order = { pending: 0, queued: 1, delivered: 2, failed: 3 };
        if (this.state === 'delivered' || this.state === 'failed') return false;
        if (order[state] <= order[this.state]) return false;
        this.state = state;
        Object.assign(this, details);
        this[`${state}At`] = this.now();
        for (const listener of [...this.listeners]) {
            try { listener(this); } catch { /* a listener never stops a delivery */ }
        }
        if (state === 'delivered' || state === 'failed') this.resolveDone(this);
        return true;
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    toJSON() {
        const out = { id: this.id, sessionId: this.sessionId, state: this.state, at: this.at };
        for (const key of ['queuedAt', 'deliveredAt', 'failedAt', 'turn', 'reason']) if (this[key] !== undefined) out[key] = this[key];
        return out;
    }
}

export class SessionWatch {
    /**
     * @param {object} options
     * @param {object} options.ctx - the plugin's context: `sessions`, `agents`, `sessionController`, `sessionProjections`, `goals` (each optional but `sessionController`).
     * @param {object} options.config - the plugin's config.
     * @param {{ info: Function, warn: Function }} options.logger
     * @param {(text: string) => { id: string }} options.makeMessage - builds a user message with a stable id.
     * @param {import('./shared/hub.js').Hub} [options.hub]
     * @param {string} options.dir - the watcher's own folder.
     * @param {(logger: object, label: string, ms: number, fn: Function) => void} [options.after] - a timer (tests use their own).
     * @param {() => number} [options.now] - the clock (tests use their own).
     */
    constructor({ ctx, config, logger, makeMessage, hub, dir, after = later, now = Date.now }) {
        this.ctx = ctx;
        this.config = config;
        this.logger = logger;
        this.makeMessage = makeMessage;
        this.hub = hub;
        this.after = after;
        this.now = now;
        this.listeners = new Set();
        /** DSH's last session list and when it was read, so a burst of window reads asks DSH once. */
        this.listed = { at: 0, items: undefined };
        /** Cold sessions' saved states and list fields, from the last `list()`. */
        this.cold = new Map();
        /** Titles and folders of sessions seen. */
        this.rows = new Map();
        /** SHARED_KEYS values from DSH's last list, by session. */
        this.saved = new Map();
        /** Deliveries by message id. */
        this.deliveries = new Map();
        /** Questions waiting on a person, by id. */
        this.asksById = new Map();
        /** External agents' states (Agent Terminals), by session id. */
        this.externals = new Map();
        /** Sessions this process saw running, kept on disk so the next start knows what a stop cut off. */
        this.running = new JsonStore(join(dir, 'running.json'), {
            logger,
            delayMs: 150,
            parse: (value) => ({
                version: 1,
                sessions: isRecord(value?.sessions) ? Object.fromEntries(Object.entries(value.sessions).filter(([, v]) => isRecord(v))) : {},
            }),
        });
        /** What the last process left running: the candidates for "cut off by a stop". */
        this.leftRunning = { ...this.running.data.sessions };
        this.running.data.sessions = {};
        this.running.change();
        this.startedAt = this.now();
    }

    // ── Reading ────────────────────────────────────────────────────────

    /** The loaded Session object for an id, or undefined. */
    sessionOf(sessionId) {
        try { return this.ctx.sessions?.get?.(sessionId); } catch { return undefined; }
    }

    /** The live Agent for an id, or undefined. */
    agentOf(sessionId) {
        try { return this.ctx.agents?.get?.(sessionId); } catch { return undefined; }
    }

    /** 'running', 'idle' or 'cold' (not loaded). */
    statusOf(sessionId) {
        const agent = this.agentOf(sessionId);
        if (!agent) return 'cold';
        return agent.status === 'running' ? 'running' : 'idle';
    }

    /** A session's watcher state: live from DSH's registry when loaded, else the saved one. */
    stateOf(sessionId) {
        const session = this.sessionOf(sessionId);
        if (session) {
            try {
                const state = this.ctx.sessionProjections?.stateOf?.(session, KEY);
                if (state) return state;
            } catch (error) {
                this.logger?.warn?.(`session-watch: could not read ${sessionId}: ${errorText(error)}`);
            }
        }
        return this.cold.get(sessionId)?.state;
    }

    /**
     * Another projection's value for a session: live from DSH's registry
     * while the session is loaded (`live: true`; the projection's state),
     * else what DSH's last list carried for it (its view, for SHARED_KEYS).
     * Undefined when DSH has neither. Never throws.
     * @param {string} sessionId
     * @param {string} key
     * @returns {{ live: boolean, value: any } | undefined}
     */
    projection(sessionId, key) {
        const session = this.sessionOf(sessionId);
        if (session) {
            try {
                const state = this.ctx.sessionProjections?.stateOf?.(session, key);
                if (state !== undefined) return { live: true, value: state };
            } catch { /* a projection DSH does not have */ }
        }
        const saved = this.saved.get(sessionId);
        return saved && Object.hasOwn(saved, key) ? { live: false, value: saved[key] } : undefined;
    }

    /** A session's title: DSH's own, else the last one its log named. */
    titleOf(sessionId) {
        return this.rows.get(sessionId)?.title || this.stateOf(sessionId)?.title || '';
    }

    /** One row for a session, as `list()` gives them. */
    rowOf(sessionId) {
        const fields = this.rows.get(sessionId) ?? {};
        const state = this.stateOf(sessionId);
        const row = {
            sessionId,
            title: fields.title || state?.title || '',
            ...(fields.cwd ? { cwd: fields.cwd } : {}),
            ...(fields.parentSessionId ? { parentSessionId: fields.parentSessionId } : {}),
            ...(fields.origin ? { origin: fields.origin } : {}),
            updatedAt: Math.max(fields.updatedAt ?? 0, state?.at ?? 0),
            blank: fields.blank === true,
            status: this.statusOf(sessionId),
            state: state ? viewOf(state) : null,
        };
        const external = this.externals.get(sessionId);
        if (external) row.external = { ...external };
        row.word = stateWord(row);
        return row;
    }

    /**
     * Every session DSH lists, newest first, with the watcher's state. Never
     * throws: when DSH's list cannot be read, the sessions seen so far.
     * Loaded sessions' states are always live; DSH's list itself is read
     * again when older than `maxAgeMs`.
     * @param {AbortSignal} [signal]
     * @param {{ maxAgeMs?: number }} [options]
     */
    async list(signal, { maxAgeMs = 1500 } = {}) {
        let items;
        if (this.listed.items && this.now() - this.listed.at < maxAgeMs) {
            items = this.listed.items;
            return items.map((item) => this.rowOf(item.sessionId));
        }
        try {
            const result = await this.ctx.sessionController.list({}, signal ?? AbortSignal.timeout(20000));
            items = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
        } catch (error) {
            this.logger?.warn?.(`session-watch: DSH's session list could not be read: ${errorText(error)}`);
            return [...this.rows.keys()].map((id) => this.rowOf(id)).sort((a, b) => b.updatedAt - a.updatedAt);
        }
        for (const item of items) {
            if (!isRecord(item) || typeof item.sessionId !== 'string') continue;
            const values = item.projections?.values ?? {};
            const title = typeof values.title === 'string' ? values.title : typeof values.title?.title === 'string' ? values.title.title : '';
            this.rows.set(item.sessionId, {
                title,
                cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
                parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : undefined,
                origin: typeof item.origin === 'string' ? item.origin : isRecord(item.origin) && typeof item.origin.kind === 'string' ? item.origin.kind : undefined,
                updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
                blank: item.blank === true,
            });
            const shared = {};
            for (const key of SHARED_KEYS) if (Object.hasOwn(values, key)) shared[key] = values[key];
            this.saved.set(item.sessionId, shared);
            // A state folded from the whole log is newer than DSH's saved value until the session moves again.
            const known = this.cold.get(item.sessionId);
            if (isRecord(values[KEY]) && !(known?.full && (known.state?.at ?? 0) >= (values[KEY].at ?? 0))) this.cold.set(item.sessionId, { state: parseState(values[KEY]) });
        }
        const listed = items.filter((item) => typeof item?.sessionId === 'string');
        this.listed = { at: this.now(), items: listed };
        return listed.map((item) => this.rowOf(item.sessionId));
    }

    /** One session's row, reading DSH's list when the watcher has not seen it yet. */
    async get(sessionId) {
        if (!this.rows.has(sessionId) && !this.sessionOf(sessionId)) await this.list(undefined, { maxAgeMs: 0 });
        return this.rowOf(sessionId);
    }

    /**
     * A session's full log, folded: for a session whose saved state is
     * missing or may be behind. Reads the log without loading the agent.
     * @returns {Promise<{ state: object, events: object[] } | undefined>}
     */
    async readLog(sessionId, signal) {
        try {
            const read = await this.ctx.sessionController.inspect(sessionId, signal ?? AbortSignal.timeout(30000));
            const events = Array.isArray(read?.events) ? read.events : [];
            return { state: foldAll(events), events };
        } catch (error) {
            this.logger?.warn?.(`session-watch: could not read the log of ${sessionId}: ${errorText(error)}`);
            return undefined;
        }
    }

    /**
     * A session's whole watcher state, with the reply text a saved value
     * leaves out: live when loaded, else folded from its log.
     */
    async fullState(sessionId, signal) {
        if (this.sessionOf(sessionId)) return this.stateOf(sessionId);
        const read = await this.readLog(sessionId, signal);
        if (!read) return this.stateOf(sessionId);
        this.cold.set(sessionId, { state: read.state, full: true });
        return read.state;
    }

    /** The live agent for a session, loading it when it is cold. Throws with DSH's reason. */
    async resolveAgent(sessionId) {
        const found = await this.ctx.sessionController.resolveAgent(sessionId);
        const agent = found?.agent ?? found;
        if (!agent || typeof agent.followup !== 'function') throw new Error('DSH has no agent for it');
        return agent;
    }

    // ── Events ─────────────────────────────────────────────────────────

    /**
     * Listen to the watcher. A listener gets `{ type, sessionId, ... }`;
     * what it throws is logged and dropped.
     * @returns {() => void} stop listening.
     */
    on(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event) {
        for (const listener of [...this.listeners]) {
            try {
                const result = listener(event);
                if (result && typeof result.then === 'function') result.then(undefined, (error) => this.logger?.warn?.(`session-watch: a listener failed on ${event.type}: ${errorText(error)}`));
            } catch (error) {
                this.logger?.warn?.(`session-watch: a listener failed on ${event.type}: ${errorText(error)}`);
            }
        }
        this.hub?.bump('sessions');
    }

    /** DSH committed an event to a session (installed by index.js on `session/event`). */
    onSessionEvent(session, event) {
        const sessionId = session?.id;
        if (typeof sessionId !== 'string' || !isRecord(event)) return;
        // A session DSH's last list did not have: the next list() reads DSH's list again.
        if (!this.rows.has(sessionId)) this.listed.at = 0;
        this.trackDelivery(sessionId, event);
        switch (event.type) {
            case 'turn/start':
                this.running.data.sessions[sessionId] = { turn: event.data?.turn, at: event.time ?? this.now() };
                this.running.change();
                this.emit({ type: 'turn-start', sessionId, turn: event.data?.turn });
                return;
            case 'turn/end': {
                delete this.running.data.sessions[sessionId];
                this.running.change();
                const state = this.stateOf(sessionId) ?? applyEvent(undefined, event);
                this.emit({ type: 'turn-end', sessionId, end: state.end, state });
                return;
            }
            case 'todo/write':
            case 'goal/change':
            case 'approval/asked':
            case 'approval/decided':
            case 'session/title':
            case 'user/message':
                this.emit({ type: 'state', sessionId, change: event.type, state: this.stateOf(sessionId) });
                return;
            default:
        }
    }

    /** An agent was created or let go (installed by index.js). */
    onAgent(agent, change) {
        if (typeof agent?.id !== 'string') return;
        if (change === 'disposed' && this.running.data.sessions[agent.id]) {
            // A running turn whose agent is let go is cut off; DSH logs that as the turn's end.
            this.running.change();
        }
        this.emit({ type: 'agent', sessionId: agent.id, change });
    }

    /** An agent went running or idle (installed by index.js). */
    onStatus(agent, status) {
        if (typeof agent?.id !== 'string') return;
        this.emit({ type: 'status', sessionId: agent.id, status });
    }

    // ── Delivery ───────────────────────────────────────────────────────

    /** Follow a delivery through the session's log. */
    trackDelivery(sessionId, event) {
        if (this.deliveries.size === 0) return;
        if (event.type === 'agent/inbox/spliced') {
            for (const message of Array.isArray(event.data?.inserted) ? event.data.inserted : []) {
                const delivery = this.deliveries.get(message?.id);
                if (delivery && delivery.sessionId === sessionId) {
                    delivery.advance('queued', { seq: event.seq });
                    this.emit({ type: 'delivery', sessionId, delivery: delivery.toJSON() });
                }
            }
            return;
        }
        if (event.type === 'user/message') {
            const delivery = this.deliveries.get(event.data?.id);
            if (delivery && delivery.sessionId === sessionId) {
                const turn = this.stateOf(sessionId)?.turn;
                delivery.advance('delivered', { turn, seq: event.seq });
                this.deliveries.delete(delivery.id);
                this.emit({ type: 'delivery', sessionId, delivery: delivery.toJSON() });
            }
        }
    }

    /** DSH let a queued message go without reading it (installed by index.js on `agent/inbox/discarded`). */
    onDiscarded(agent, message) {
        const delivery = this.deliveries.get(message?.id);
        if (!delivery) return;
        delivery.advance('failed', { reason: 'the session let the message go without reading it' });
        this.deliveries.delete(delivery.id);
        this.emit({ type: 'delivery', sessionId: delivery.sessionId, delivery: delivery.toJSON() });
    }

    /**
     * Put a message into a session, loading it first when it is cold.
     * Resolves to the delivery as soon as it is queued or has failed; its
     * `done` promise resolves once the session read it into a turn (or it
     * failed). `mode: 'steer'` puts it into a running turn's next step.
     * @param {string} sessionId
     * @param {string} text
     * @param {{ mode?: 'queue' | 'steer' }} [options]
     * @returns {Promise<Delivery>}
     */
    async deliver(sessionId, text, { mode = 'queue' } = {}) {
        let message;
        try {
            message = this.makeMessage(text);
        } catch (error) {
            const failed = new Delivery(`failed-${this.now().toString(36)}`, sessionId, text, this.now);
            failed.advance('failed', { reason: `the message could not be made: ${errorText(error)}` });
            return failed;
        }
        const delivery = new Delivery(message.id, sessionId, text, this.now);
        this.deliveries.set(message.id, delivery);
        let agent;
        try {
            agent = await this.resolveAgent(sessionId);
        } catch (error) {
            this.deliveries.delete(message.id);
            delivery.advance('failed', { reason: `the session could not be opened: ${errorText(error)}` });
            return delivery;
        }
        try {
            if (mode === 'steer' && agent.status === 'running') agent.steer(message);
            else agent.followup(message);
        } catch (error) {
            this.deliveries.delete(message.id);
            delivery.advance('failed', { reason: `DSH refused the message: ${errorText(error)}` });
            return delivery;
        }
        // The inbox change is committed before followup/steer returns; flush it so a stop now keeps it.
        try {
            const sessions = this.ctx.sessions;
            if (typeof sessions?.flush === 'function' && agent.session) await sessions.flush(agent.session);
        } catch (error) {
            this.logger?.warn?.(`session-watch: could not save ${sessionId} after a message: ${errorText(error)}`);
        }
        // A session that read the message at once already resolved it; one that never shows it is reported, not assumed.
        const timeoutMs = Math.max(1000, (this.config.deliveryTimeoutSeconds ?? 600) * 1000);
        this.after(this.logger, 'session-watch: delivery timeout', timeoutMs, () => {
            if (delivery.state === 'delivered' || delivery.state === 'failed') return;
            this.deliveries.delete(delivery.id);
            delivery.advance('failed', { reason: delivery.state === 'queued' ? 'it waited in the session\'s queue and no turn read it' : 'the session\'s log never showed it' });
            this.emit({ type: 'delivery', sessionId, delivery: delivery.toJSON() });
        });
        return delivery;
    }

    // ── Cut off by a stop ──────────────────────────────────────────────

    /**
     * Sessions whose last turn DSH cut off when it stopped, checked against
     * each session's log. Sub-sessions (a subagent's) are left to their parent.
     * @param {{ withinMs: number, signal?: AbortSignal }} options
     * @returns {Promise<Array<{ sessionId: string, title: string, end: object, state: object, cwd?: string }>>}
     */
    async cutOffSessions({ withinMs, signal }) {
        const rows = await this.list(signal, { maxAgeMs: 0 });
        const now = this.now();
        const candidates = new Set(Object.keys(this.leftRunning));
        for (const row of rows) {
            const state = this.cold.get(row.sessionId)?.state ?? row.state;
            if (!state) continue;
            if (state.open || cutOff(state.end)) candidates.add(row.sessionId);
        }
        const found = [];
        for (const sessionId of candidates) {
            const row = this.rowOf(sessionId);
            if (row.parentSessionId) continue;
            if (this.statusOf(sessionId) === 'running') continue;
            let state = this.sessionOf(sessionId) ? this.stateOf(sessionId) : undefined;
            if (!state || state.open) {
                const read = await this.readLog(sessionId, signal);
                if (!read) continue;
                state = read.state;
            }
            if (!state?.end || !cutOff(state.end)) continue;
            if (state.open) continue;
            // A person or another plugin wrote to it after the cut: it is not waiting to carry on.
            if ((state.inAt ?? 0) > state.end.at) continue;
            const at = state.end.at || this.leftRunning[sessionId]?.at || 0;
            if (withinMs > 0 && at > 0 && now - at > withinMs) continue;
            found.push({ sessionId, title: row.title || state.title || '', ...(row.cwd ? { cwd: row.cwd } : {}), end: state.end, state: viewOf(state) });
        }
        return found;
    }

    // ── Questions waiting on a person ──────────────────────────────────

    /**
     * Raise a question for a person. Decisions shows it; the raising plugin
     * may show it too. `onAnswer` gets the chosen option id or the person's
     * own words; what it throws is logged.
     * @param {{ id: string, sessionId?: string, source: string, question: string, recommendation?: string, options?: Array<{ id: string, label: string }>, freeText?: boolean, at?: number, onAnswer?: Function }} ask
     *   `at`: when it was first asked, for a question raised again after a restart.
     */
    raiseAsk(ask) {
        if (!isRecord(ask) || typeof ask.id !== 'string' || typeof ask.question !== 'string') throw new Error('an ask needs an id and a question');
        const existing = this.asksById.get(ask.id);
        // A question asked before a restart keeps the time it was first asked (never a time still to come).
        const first = Number.isFinite(ask.at) && ask.at > 0 && ask.at <= this.now() ? ask.at : undefined;
        const item = { ...ask, at: existing?.at ?? first ?? this.now() };
        this.asksById.set(ask.id, item);
        this.emit({ type: 'ask', change: existing ? 'updated' : 'raised', ask: publicAsk(item) });
        this.hub?.bump('asks');
        return publicAsk(item);
    }

    /** Answer a question: run its handler, then drop it. */
    async answerAsk(id, answer, by = 'you') {
        const item = this.asksById.get(id);
        if (!item) return { ok: false, error: 'This question is no longer waiting.' };
        this.asksById.delete(id);
        this.emit({ type: 'ask', change: 'answered', ask: publicAsk(item), answer });
        this.hub?.bump('asks');
        try {
            const result = await item.onAnswer?.(answer, by);
            return { ok: true, ...(isRecord(result) ? result : {}) };
        } catch (error) {
            // The asking plugin refused the answer for now (it is switched off, say): the question stays.
            if (error?.refused === true && !this.asksById.has(id)) {
                this.asksById.set(id, item);
                this.emit({ type: 'ask', change: 'kept', ask: publicAsk(item) });
                this.hub?.bump('asks');
            } else {
                this.logger?.warn?.(`session-watch: the answer to ${id} failed: ${errorText(error)}`);
            }
            return { ok: false, error: errorText(error), ...(error?.refused === true ? { refused: true } : {}) };
        }
    }

    /** Drop a question nobody needs to answer any more. */
    dropAsk(id) {
        const item = this.asksById.get(id);
        if (!item) return false;
        this.asksById.delete(id);
        this.emit({ type: 'ask', change: 'dropped', ask: publicAsk(item) });
        this.hub?.bump('asks');
        return true;
    }

    /**
     * Say what became of an answer once its asker knows: an answer typed
     * into a coding agent's terminal is delivered only when the agent's own
     * transcript shows it. Decisions turns its "answered" into what this says.
     * @param {string} id - the question's id.
     * @param {{ state: 'delivered' | 'not proven' | 'not delivered' | 'typed in', text?: string, by?: string, sessionId?: string }} outcome
     * @returns {boolean} whether it was told.
     */
    askOutcome(id, outcome) {
        if (typeof id !== 'string' || !isRecord(outcome) || !OUTCOMES.has(outcome.state)) return false;
        this.emit({
            type: 'ask',
            change: 'outcome',
            id,
            ...(typeof outcome.sessionId === 'string' ? { sessionId: outcome.sessionId } : {}),
            outcome: {
                state: outcome.state,
                ...(typeof outcome.text === 'string' && outcome.text ? { text: outcome.text.slice(0, 600) } : {}),
                ...(typeof outcome.by === 'string' && outcome.by ? { by: outcome.by.slice(0, 80) } : {}),
                at: this.now(),
            },
        });
        return true;
    }

    /** The questions waiting, oldest first. */
    asks() {
        return [...this.asksById.values()].sort((a, b) => a.at - b.at).map(publicAsk);
    }

    // ── External agents ────────────────────────────────────────────────

    /**
     * Set or clear the state of an agent that runs outside DSH's own loop
     * (a coding agent in a terminal), shown with its session.
     * @param {string} sessionId
     * @param {{ status: 'working' | 'idle' | 'waiting on you' | 'stopped', label?: string, detail?: string } | null} external
     */
    setExternal(sessionId, external) {
        if (external === null) this.externals.delete(sessionId);
        else this.externals.set(sessionId, { ...external, at: this.now() });
        this.emit({ type: 'external', sessionId, external });
    }

    /** Stop: write what is pending, answer open window requests. */
    close() {
        this.running.close();
        this.listeners.clear();
    }
}

/** A question as windows and other plugins see it: no handler. */
export function publicAsk(item) {
    const { onAnswer, ...rest } = item;
    return rest;
}
