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
 *   Nothing here ever reports a message as sent without that. Every
 *   delivery and what became of it goes into a private journal
 *   (`deliveries.jsonl`), so one on its way when DSH stops (a quit, a
 *   crash, a reload, the watcher switched off) is followed again at the
 *   next start, against the session's log; `deliveryOf(id)` and
 *   `deliveries()` read it.
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
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { KEY, applyEvent, foldAll, inboxOf, line, parseState, readIn, viewOf, waitingOf } from './fold.js';
import { cutOff, stateWord } from './shared/words.js';
import { JsonStore } from './shared/files.js';
import { Journal } from './shared/journal.js';
import { errorText, isRecord, later } from './shared/safe.js';

export { stateWord };

/** Other projections the suite reads (DSH's question box, the coordinator's threads), kept from DSH's list for sessions that are not loaded. */
export const SHARED_KEYS = Object.freeze(['userQuestions', 'coordinatorSession']);

/** At most this many cut-off sessions are kept to fold from their logs at the next start (the newest). */
const UNSAVED_MAX = 50;

/** How a watcher event is named for listeners. */
export const EVENTS = Object.freeze(['turn-start', 'turn-end', 'status', 'state', 'agent', 'delivery', 'ask', 'external']);

/** What can become of an answer, once its asker knows (`askOutcome`). */
export const OUTCOMES = new Set(['delivered', 'not proven', 'not delivered', 'typed in']);

/** Deliveries the journal keeps (in memory, and on a rewrite of its file past JOURNAL_BYTES). */
const JOURNAL_KEEP = 1000;
const JOURNAL_BYTES = 1_000_000;
/** A message an earlier run left in a queue is followed at least this long after the start, whatever its wait left. */
const RESTORED_MIN_MS = 60000;
/** The fields a delivery's record carries besides id, sessionId, state and at. */
const RECORD_KEYS = ['queuedAt', 'deliveredAt', 'failedAt', 'turn', 'reason', 'mode', 'waiting', 'from', 'preview', 'restored'];

/** What waits in a live agent's queue (next-turn, then next-step), as DSH's inbox has it. Never throws. */
export function queuedIn(agent) {
    try {
        const inbox = agent?.inbox;
        if (!inbox) return [];
        const turn = inbox.nextTurn;
        const step = inbox.nextStep;
        if (Array.isArray(turn) || Array.isArray(step)) return [...(Array.isArray(turn) ? turn : []), ...(Array.isArray(step) ? step : [])];
        return Array.isArray(inbox) ? [...inbox] : [];
    } catch {
        return [];
    }
}

/** One message's way into a session, for `deliver`. */
class Delivery {
    constructor(id, sessionId, text, now = Date.now, { mode = 'queue', from, at } = {}) {
        this.id = id;
        this.sessionId = sessionId;
        this.text = text;
        this.now = now;
        /** 'pending' → 'queued' → 'delivered', or 'failed'. */
        this.state = 'pending';
        this.at = Number.isFinite(at) ? at : now();
        /** How it went in: 'queue' (its own turn) or 'steer' (the next step). */
        this.mode = mode === 'steer' ? 'steer' : 'queue';
        if (from) this.from = from;
        const preview = line(typeof text === 'string' ? text : '', 120);
        if (preview) this.preview = preview;
        this.listeners = new Set();
        let resolve;
        this.done = new Promise((r) => { resolve = r; });
        this.resolveDone = resolve;
    }

    /** One an earlier run (or this watcher before it was switched off) left on its way, from its journal entry. */
    static restore(entry, now) {
        const delivery = new Delivery(entry.delivery, entry.sessionId, '', now, { mode: entry.mode, from: entry.from, at: entry.at });
        delivery.state = entry.state === 'queued' ? 'queued' : 'pending';
        for (const key of ['queuedAt', 'waiting', 'preview']) if (entry[key] !== undefined) delivery[key] = entry[key];
        delivery.restored = true;
        return delivery;
    }

    /** Whether it is settled: delivered or failed. */
    get final() {
        return this.state === 'delivered' || this.state === 'failed';
    }

    /** Move forward; never back. */
    advance(state, details = {}) {
        const order = { pending: 0, queued: 1, delivered: 2, failed: 3 };
        if (this.final) return false;
        if (order[state] <= order[this.state]) return false;
        this.state = state;
        Object.assign(this, details);
        this[`${state}At`] = this.now();
        for (const listener of [...this.listeners]) {
            try { listener(this); } catch { /* a listener never stops a delivery */ }
        }
        if (this.final) this.resolveDone(this);
        return true;
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    toJSON() {
        const out = { id: this.id, sessionId: this.sessionId, state: this.state, at: this.at };
        for (const key of RECORD_KEYS) if (this[key] !== undefined) out[key] = this[key];
        return out;
    }
}

/** A delivery's record from its journal entry, as `toJSON` gives a live one. */
function recordOf(entry) {
    const out = { id: entry.delivery, sessionId: entry.sessionId, state: entry.state, at: entry.at };
    for (const key of RECORD_KEYS) if (entry[key] !== undefined) out[key] = entry[key];
    return out;
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
     * @param {(logger: object, label: string, ms: number, fn: Function) => any} [options.after] - a timer (tests use their own).
     * @param {(timer: any) => void} [options.cancel] - stops a timer `after` gave.
     * @param {() => number} [options.now] - the clock (tests use their own).
     */
    constructor({ ctx, config, logger, makeMessage, hub, dir, after = later, cancel = clearTimeout, now = Date.now }) {
        this.ctx = ctx;
        this.config = config;
        this.logger = logger;
        this.makeMessage = makeMessage;
        this.hub = hub;
        this.after = after;
        this.cancel = cancel;
        this.now = now;
        this.listeners = new Set();
        /** Timers still to run; a closed watcher stops them all. */
        this.timers = new Set();
        /** The question-box call each loaded session waits on, so a change is told once. */
        this.askingSeen = new Map();
        /** DSH's last session list and when it was read, so a burst of window reads asks DSH once. */
        this.listed = { at: 0, items: undefined };
        /** Cold sessions' saved states and list fields, from the last `list()`. */
        this.cold = new Map();
        /** Titles and folders of sessions seen. */
        this.rows = new Map();
        /** SHARED_KEYS values from DSH's last list, by session. */
        this.saved = new Map();
        /** Deliveries on their way (not yet delivered or failed), by message id. */
        this.onTheWay = new Map();
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
                // Sessions a stop cut off that have not ended a turn since: DSH's saved values for them are from before the stop.
                unsaved: isRecord(value?.unsaved) ? Object.fromEntries(Object.entries(value.unsaved).filter(([, v]) => isRecord(v))) : {},
            }),
        });
        /** What the last process left running: the candidates for "cut off by a stop". */
        this.leftRunning = { ...this.running.data.sessions };
        /** Sessions whose rows are folded from their logs at the start: those, and earlier stops' that have not ended a turn since. */
        this.toFold = Object.fromEntries(Object.entries({ ...this.running.data.unsaved, ...this.running.data.sessions })
            .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, UNSAVED_MAX));
        this.running.data.unsaved = { ...this.toFold };
        this.running.data.sessions = {};
        this.running.change();
        this.startedAt = this.now();
        /** Every message it put into a session and what became of it, kept on disk: the record a restart keeps. */
        this.journal = new Journal(join(dir, 'deliveries.jsonl'), { keep: JOURNAL_KEEP, maxBytes: JOURNAL_BYTES, logger, now });
        // The journal names entries by time and a count kept per process: count on from the last run's, so no two share a name.
        let seq = 0;
        for (const entry of this.journal.entries) {
            const n = parseInt(/-([0-9a-z]+)$/.exec(String(entry.id))?.[1] ?? '0', 36);
            if (Number.isSafeInteger(n) && n > seq) seq = n;
        }
        this.journal.seq = Math.max(this.journal.seq, seq);
        if (seq > 0) {
            try { chmodSync(this.journal.file, 0o600); } catch { /* written 600 when it is next written */ }
        }
        /** Journal entry ids by delivery id. */
        this.entryOf = new Map();
        for (const entry of this.journal.entries) {
            if (typeof entry.delivery !== 'string' || typeof entry.sessionId !== 'string') continue;
            this.entryOf.set(entry.delivery, entry.id);
            // On its way when the last run stopped (or this watcher was switched off): followed again from here.
            if (entry.state === 'pending' || entry.state === 'queued') {
                const delivery = Delivery.restore(entry, this.now);
                this.onTheWay.set(delivery.id, delivery);
                delivery.onChange((d) => this.journalSet(d));
            }
        }
        /** Settles the deliveries an earlier run left on their way, against their sessions' logs (after this start's own work). */
        this.restoring = new Promise((resolve) => setImmediate(resolve)).then(() => this.restore())
            .catch((error) => this.logger?.warn?.(`session-watch: could not follow the messages an earlier run left on their way: ${errorText(error)}`));
    }

    /** A timer the watcher stops when it closes; one that comes due after that does nothing. */
    later(label, ms, fn) {
        let timer;
        const run = () => {
            this.timers.delete(timer);
            if (!this.closed) fn();
        };
        timer = this.after(this.logger, label, ms, run);
        this.timers.add(timer);
        return timer;
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
        // What the last run left running reads as its log has it from now on (the windows are told when it is read).
        void this.readLeftRunning();
        return listed.map((item) => this.rowOf(item.sessionId));
    }

    /**
     * The sessions a stop cut off, folded from their logs once per start:
     * those the last run left running, and those an earlier stop cut off
     * that have not ended a turn since. DSH's saved values for them are from
     * before the stop (a quit or a crash saves nothing more), so until then a
     * cut-off session would read as it did before its turn ("new", even).
     * Loaded sessions keep their live state. Windows are told when it is done.
     * @returns {Promise<void>}
     */
    readLeftRunning() {
        if (!this.leftRead) {
            this.leftRead = (async () => {
                let changed = false;
                for (const sessionId of Object.keys(this.toFold)) {
                    if (this.sessionOf(sessionId) || this.cold.get(sessionId)?.full) continue;
                    const read = await this.readLog(sessionId);
                    if (!read) {
                        // Gone from DSH (deleted): let it go.
                        if (this.listed.items && !this.rows.has(sessionId)) {
                            delete this.running.data.unsaved[sessionId];
                            this.running.change();
                        }
                        continue;
                    }
                    if (this.sessionOf(sessionId)) continue;
                    this.cold.set(sessionId, { state: read.state, full: true, queued: waitingList(read.events) });
                    changed = true;
                }
                if (changed) {
                    this.logger?.info?.(`session-watch: read the logs of the sessions a stop cut off (${Object.keys(this.toFold).length})`);
                    this.hub?.bump('sessions');
                }
            })().catch((error) => this.logger?.warn?.(`session-watch: could not read the sessions a stop cut off: ${errorText(error)}`));
        }
        return this.leftRead;
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
        this.cold.set(sessionId, { state: read.state, full: true, queued: waitingList(read.events) });
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
                this.askingSeen.delete(sessionId);
                this.running.data.sessions[sessionId] = { turn: event.data?.turn, at: event.time ?? this.now() };
                this.running.change();
                this.emit({ type: 'turn-start', sessionId, turn: event.data?.turn });
                return;
            case 'turn/end': {
                this.askingSeen.delete(sessionId);
                delete this.running.data.sessions[sessionId];
                // A turn ended: DSH saves the session's values with it again.
                delete this.running.data.unsaved[sessionId];
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
            case 'tool/call':
            case 'tool/result': {
                // A question in DSH's question box starts with its tool call and ends with its result: told once each.
                const state = this.stateOf(sessionId);
                const asking = state?.asking ? (state.asking.call ?? `at ${state.asking.at}`) : undefined;
                if (asking === this.askingSeen.get(sessionId)) return;
                if (asking === undefined) this.askingSeen.delete(sessionId);
                else this.askingSeen.set(sessionId, asking);
                this.emit({ type: 'state', sessionId, change: event.type, state });
                return;
            }
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
        if (this.onTheWay.size === 0) return;
        if (event.type === 'agent/inbox/spliced') {
            for (const message of Array.isArray(event.data?.inserted) ? event.data.inserted : []) {
                const delivery = this.onTheWay.get(message?.id);
                if (delivery && delivery.sessionId === sessionId && delivery.advance('queued', { seq: event.seq })) {
                    this.emit({ type: 'delivery', sessionId, delivery: delivery.toJSON() });
                }
            }
            return;
        }
        if (event.type === 'user/message') {
            const delivery = this.onTheWay.get(event.data?.id);
            if (delivery && delivery.sessionId === sessionId) {
                const turn = this.stateOf(sessionId)?.turn;
                this.settle(delivery, 'delivered', { turn, seq: event.seq });
            }
        }
    }

    /**
     * Settle a delivery (delivered or failed): out of the map, logged, told
     * to listeners, and kept in the journal. Never throws.
     */
    settle(delivery, state, details) {
        if (!delivery.advance(state, details)) return false;
        this.onTheWay.delete(delivery.id);
        const again = delivery.restored ? ' (followed again after a stop)' : '';
        if (state === 'delivered') this.logger?.info?.(`session-watch: the message ${delivery.id} to ${delivery.sessionId} was read into turn ${delivery.turn}${again}`);
        else this.logger?.warn?.(`session-watch: a message to ${delivery.sessionId} was not delivered${again}: ${delivery.reason}`);
        this.emit({ type: 'delivery', sessionId: delivery.sessionId, delivery: delivery.toJSON() });
        return true;
    }

    /** DSH let a queued message go without reading it (installed by index.js on `agent/inbox/discarded`). */
    onDiscarded(agent, message) {
        const delivery = this.onTheWay.get(message?.id);
        // The watcher's own taking back (`expire`) says why itself.
        if (!delivery || delivery.withdrawing) return;
        this.settle(delivery, 'failed', { reason: 'the session let the message go without reading it' });
    }

    /** Keep a delivery in the journal, and each change to it. Never throws. */
    record(delivery) {
        try {
            const { id, at, ...fields } = delivery.toJSON();
            const entry = this.journal.add({ delivery: id, ...fields });
            this.entryOf.set(id, entry.id);
            // One time for it everywhere: the journal's.
            delivery.at = entry.at;
            delivery.onChange((d) => this.journalSet(d));
        } catch (error) {
            this.logger?.warn?.(`session-watch: could not keep a record of the message ${delivery.id}: ${errorText(error)}`);
        }
    }

    journalSet(delivery) {
        const entryId = this.entryOf.get(delivery.id);
        if (!entryId) return;
        try {
            const { id, sessionId, at, ...patch } = delivery.toJSON();
            this.journal.set(entryId, patch);
        } catch (error) {
            this.logger?.warn?.(`session-watch: could not keep a record of the message ${delivery.id}: ${errorText(error)}`);
        }
    }

    /**
     * One delivery's record, by its id: live while it is on its way, else
     * from the journal (this run's and earlier runs', the newest 1000).
     * Undefined for an id it does not know. Never throws.
     * @param {string} id
     */
    deliveryOf(id) {
        if (typeof id !== 'string') return undefined;
        const live = this.onTheWay.get(id);
        if (live) return live.toJSON();
        const entry = this.journal.get(this.entryOf.get(id));
        return entry ? recordOf(entry) : undefined;
    }

    /**
     * What it put into sessions and what became of each, newest first (the
     * journal's newest 1000). Never throws.
     * @param {{ sessionId?: string, limit?: number }} [options]
     */
    deliveries({ sessionId, limit = 50 } = {}) {
        const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), JOURNAL_KEEP) : 50;
        return this.journal.list({ ...(typeof sessionId === 'string' ? { sessionId } : {}), limit: n })
            .filter((entry) => typeof entry.delivery === 'string')
            .map((entry) => this.onTheWay.get(entry.delivery)?.toJSON() ?? recordOf(entry));
    }

    /** The delivery timeout in ms. */
    timeoutMs() {
        return Math.max(1000, (this.config.deliveryTimeoutSeconds ?? 600) * 1000);
    }

    /**
     * Put a message into a session, loading it first when it is cold.
     * Resolves to the delivery as soon as it is queued or has failed; its
     * `done` promise resolves once the session read it into a turn (or it
     * failed). `mode: 'steer'` puts it into a running turn's next step.
     *
     * A session that is not running but whose queue already holds messages
     * (a stop left them there: DSH reads one queued message per turn, and
     * nothing woke the session since) gets the message in its next step: the
     * turn it starts reads it with the oldest message waiting for a turn, it
     * first (anything a stop left for a next step comes ahead of both, in that
     * same turn). So a note about the stop is read before what was queued
     * for a turn before the stop, never after it, and never waits behind it.
     * @param {string} sessionId
     * @param {string} text
     * @param {{ mode?: 'queue' | 'steer', from?: string }} [options] - `from`: who sends it, kept with its record.
     * @returns {Promise<Delivery>}
     */
    async deliver(sessionId, text, { mode = 'queue', from } = {}) {
        const sender = typeof from === 'string' && from.trim() ? from.trim().slice(0, 60) : undefined;
        let message;
        try {
            message = this.makeMessage(text);
        } catch (error) {
            const failed = new Delivery(`failed-${this.now().toString(36)}`, sessionId, text, this.now, { mode, from: sender });
            failed.advance('failed', { reason: `the message could not be made: ${errorText(error)}` });
            this.record(failed);
            this.logger?.warn?.(`session-watch: a message to ${sessionId} was not delivered: ${failed.reason}`);
            return failed;
        }
        const delivery = new Delivery(message.id, sessionId, text, this.now, { mode, from: sender });
        this.onTheWay.set(message.id, delivery);
        let agent;
        try {
            agent = await this.resolveAgent(sessionId);
        } catch (error) {
            this.onTheWay.delete(message.id);
            delivery.advance('failed', { reason: `the session could not be opened: ${errorText(error)}` });
            this.record(delivery);
            this.logger?.warn?.(`session-watch: a message to ${sessionId} was not delivered: ${delivery.reason}`);
            return delivery;
        }
        const running = agent.status === 'running';
        const waiting = running ? 0 : queuedIn(agent).length;
        const steered = typeof agent.steer === 'function' && ((mode === 'steer' && running) || waiting > 0);
        delivery.mode = steered ? 'steer' : 'queue';
        if (waiting > 0) delivery.waiting = waiting;
        this.record(delivery);
        try {
            if (steered) agent.steer(message);
            else agent.followup(message);
        } catch (error) {
            this.onTheWay.delete(message.id);
            delivery.advance('failed', { reason: `DSH refused the message: ${errorText(error)}` });
            this.logger?.warn?.(`session-watch: a message to ${sessionId} was not delivered: ${delivery.reason}`);
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
        const timeoutMs = this.timeoutMs();
        const where = waiting > 0 ? `its next turn, ahead of the ${waiting === 1 ? 'message' : `${waiting} messages`} a stop left in its queue` : steered ? 'its running turn' : 'its queue';
        this.logger?.info?.(`session-watch: a message ${delivery.id} went into ${sessionId} (${where}${sender ? `, from ${sender}` : ''}); a turn has ${spanOf(Math.round(timeoutMs / 1000))} to read it`);
        this.later('session-watch: delivery timeout', timeoutMs, () => this.expire(delivery, timeoutMs));
        return delivery;
    }

    /**
     * No turn read a delivery within the timeout. A message still waiting in
     * the session's queue is taken back out of it (DSH's own inbox removal,
     * which the session's log records), so a message reported as not
     * delivered is never read later. One a turn took from the queue a moment
     * ago is left for its turn to prove. Never throws.
     * @param {Delivery} delivery
     * @param {number} timeoutMs
     */
    expire(delivery, timeoutMs) {
        if (delivery.final || this.closed) return;
        const seconds = Math.round(timeoutMs / 1000);
        const fail = (reason) => this.settle(delivery, 'failed', { reason });
        const inbox = this.agentOf(delivery.sessionId)?.inbox;
        let removed;
        if (typeof inbox?.remove === 'function') {
            delivery.withdrawing = true;
            try {
                removed = inbox.remove(delivery.id) === true;
            } catch (error) {
                this.logger?.warn?.(`session-watch: could not take a message back from ${delivery.sessionId}: ${errorText(error)}`);
            } finally {
                delivery.withdrawing = false;
            }
        }
        if (removed === true) {
            fail(`no turn read it within ${spanOf(seconds)}, so Session Watch took it back out of the session's queue`);
            return;
        }
        if (removed === false && delivery.state === 'queued') {
            // Not in the queue any more: a turn has just taken it, and its own log proves it. A last look a minute on.
            this.lastLook(delivery);
            return;
        }
        fail(delivery.state === 'queued'
            ? `no turn read it within ${spanOf(seconds)}; it is still in the session's queue, which the session reads when it runs again`
            : 'the session\'s log never showed it');
    }

    /** A turn took the message from the queue: its log shows it read within a minute, or it is reported. */
    lastLook(delivery) {
        this.later('session-watch: delivery last look', 60000, () => {
            if (delivery.final) return;
            this.settle(delivery, 'failed', { reason: 'a turn took it from the session\'s queue, but the session\'s log never showed it read' });
        });
    }

    /**
     * The deliveries an earlier run left on their way (DSH quit, crashed or
     * reloaded, or the watcher was switched off), each settled against its
     * session's log: read into a turn (delivered, naming it), still in the
     * queue (followed for the time its wait has left, at least a minute
     * more), or gone from it unread (not delivered, saying how). Listeners
     * hear each one. Never throws.
     */
    async restore() {
        const open = [...this.onTheWay.values()].filter((d) => d.restored && !d.final);
        if (open.length === 0 || this.closed) return;
        this.logger?.info?.(`session-watch: following ${open.length === 1 ? 'a message' : `${open.length} messages`} an earlier run left on ${open.length === 1 ? 'its' : 'their'} way`);
        for (const delivery of open) {
            if (this.closed) return;
            try {
                await this.settleRestored(delivery);
            } catch (error) {
                this.logger?.warn?.(`session-watch: could not follow the message ${delivery.id} to ${delivery.sessionId}: ${errorText(error)}`);
            }
        }
        this.hub?.bump('sessions');
    }

    async settleRestored(delivery) {
        if (delivery.final) return;
        const { sessionId, id } = delivery;
        const live = () => queuedIn(this.agentOf(sessionId)).some((m) => m?.id === id);
        let events;
        try {
            const read = await this.ctx.sessionController.inspect(sessionId, AbortSignal.timeout(30000));
            events = Array.isArray(read?.events) ? read.events : [];
        } catch (error) {
            if (delivery.final || this.closed) return;
            if (live()) return this.follow(delivery);
            this.settle(delivery, 'failed', { reason: `after DSH stopped, its session's log could not be read (${errorText(error)})` });
            return;
        }
        // A turn may have read it while the log was read: then its own event settled it.
        if (delivery.final || this.closed) return;
        const seen = readIn(events, id);
        if (seen) {
            this.settle(delivery, 'delivered', { ...(seen.turn !== undefined ? { turn: seen.turn } : {}), ...(seen.seq !== undefined ? { seq: seen.seq } : {}) });
            return;
        }
        const inbox = inboxOf(events);
        if (live() || [...inbox['next-turn'], ...inbox['next-step']].some((m) => m.id === id)) {
            delivery.advance('queued');
            this.emit({ type: 'delivery', sessionId, delivery: delivery.toJSON() });
            this.follow(delivery);
            return;
        }
        // Loaded and running: a turn may have just taken it, and the log on disk may lag; its own event proves it.
        if (this.agentOf(sessionId)) {
            this.lastLook(delivery);
            return;
        }
        const gone = inbox.gone.get(id)?.how;
        this.settle(delivery, 'failed', {
            reason: gone === 'claimed' ? 'a turn took it from the session\'s queue, but DSH stopped before that turn read it'
                : gone === 'canceled' ? 'it was taken out of the session\'s queue unread when DSH stopped'
                    : 'DSH stopped before it reached the session\'s queue',
        });
    }

    /** Keep following a message an earlier run left in a queue, for the time its wait has left (at least a minute). */
    follow(delivery) {
        const timeoutMs = this.timeoutMs();
        const left = Math.max(RESTORED_MIN_MS, (delivery.queuedAt ?? delivery.at) + timeoutMs - this.now());
        this.logger?.info?.(`session-watch: the message ${delivery.id} to ${delivery.sessionId} still waits in its queue; followed for ${spanOf(Math.round(left / 1000))} more`);
        this.later('session-watch: delivery timeout', left, () => this.expire(delivery, timeoutMs));
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
        await this.readLeftRunning();
        // What an earlier run left on its way is settled first, so what still waits in a queue is known.
        await this.restoring;
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
            const folded = this.cold.get(sessionId);
            let state = this.sessionOf(sessionId) ? this.stateOf(sessionId) : folded?.full ? folded.state : undefined;
            if (!state || state.open) {
                const read = await this.readLog(sessionId, signal);
                if (!read) continue;
                state = read.state;
                // Not loaded: its row reads as its log has it from now on, not as DSH's saved value from before the stop.
                if (!this.sessionOf(sessionId)) this.cold.set(sessionId, { state, full: true, queued: waitingList(read.events) });
            }
            if (!state?.end || !cutOff(state.end)) continue;
            if (state.open) continue;
            // A person or another plugin wrote to it after the cut: it is not waiting to carry on.
            if ((state.inAt ?? 0) > state.end.at) continue;
            const at = state.end.at || this.leftRunning[sessionId]?.at || 0;
            if (withinMs > 0 && at > 0 && now - at > withinMs) continue;
            const queued = this.waitingIn(sessionId);
            found.push({ sessionId, title: row.title || state.title || '', ...(row.cwd ? { cwd: row.cwd } : {}), end: state.end, state: viewOf(state), ...(queued.length ? { queued } : {}) });
        }
        return found;
    }

    /**
     * What waits in a session's queue now, oldest first: live from its agent
     * when it is loaded, else as its log had it when the watcher last read
     * it. A message the watcher put in names its sender (`from`) when one
     * was given. Never throws.
     * @param {string} sessionId
     * @returns {Array<{ id: string, at?: number, kind?: string, preview?: string, from?: string }>}
     */
    waitingIn(sessionId) {
        const agent = this.agentOf(sessionId);
        const items = agent ? queuedIn(agent).filter((m) => isRecord(m) && typeof m.id === 'string').map((m) => waitingOf(m)) : this.cold.get(sessionId)?.queued ?? [];
        return items.map((item) => {
            const from = this.deliveryOf(item.id)?.from;
            return from ? { ...item, from } : { ...item };
        });
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

    /**
     * Stop: write what is pending and stop every timer, so a watcher switched
     * off never takes a message back or reports one later. A delivery still on
     * its way stays in the journal, and the next start follows it again.
     */
    close() {
        this.closed = true;
        for (const timer of this.timers) {
            try { this.cancel(timer); } catch { /* a timer that already ran */ }
        }
        this.timers.clear();
        this.running.close();
        this.listeners.clear();
    }
}

/** What waits in a queue a log describes, oldest first: DSH's next-turn list, then its next-step list. */
function waitingList(events) {
    const lists = inboxOf(events);
    return [...lists['next-turn'], ...lists['next-step']];
}

/** A wait in words: "45 seconds", "10 minutes". */
function spanOf(seconds) {
    if (seconds % 60 === 0 && seconds >= 120) return `${seconds / 60} minutes`;
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/** A question as windows and other plugins see it: no handler. */
export function publicAsk(item) {
    const { onAnswer, ...rest } = item;
    return rest;
}
