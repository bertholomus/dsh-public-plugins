/**
 * The `coordinatorSession` session projection: what the DSH window needs to
 * draw a coordinating chat or a thread. It says whether a session
 * coordinates threads or is one, holds a coordinating chat's thread roster
 * and a thread's coordinating chat, and lists the cards each turn earned (a
 * thread started, a handback arrived). DSH folds it on the Host over every
 * committed event of every session and sends the value to the browser half
 * (lib/client.js), which never reads session logs itself.
 *
 * The fold reads only what these sessions already record: the user's
 * /coordinate and /coordinate off (DSH's `command/run` and `command/done`:
 * a chat coordinates from the command's success on, under its own session
 * id, and keeps its value when it stops, marked `off`), the chat's title,
 * the presentation meta of the plugin's tool results (tools.js), the
 * tagged messages the plugin sends (prompts.js), which DSH logs as an
 * agent's or a plugin's message (earlier versions sent them as the user's,
 * with a request id that marks them), the turns in which a thread changed files (DSH's
 * `workspace/changes` events; the window then reads the numbers from the
 * plugin), and how a thread's last turn ended (DSH's `turn/end`), so a
 * failed or stopped thread says so. A thread is known by its brief; the
 * notes threads send count only in a chat that coordinates, so the old
 * projects plugin's sessions stay plain chats. A session the store already
 * knows is seeded from the store the first time DSH folds it, so one whose
 * value DSH dropped shows its threads at once; replayed events older than
 * the seed then add cards but never overwrite the roster. A forked chat's
 * log starts with its source's events (DSH says how many): they give it
 * its title and turn numbers, never a role, so a fork of a coordinating
 * chat or of a thread is a plain chat of the user's until /coordinate there.
 *
 * DSH runs `apply` inside its event commit and parses persisted state
 * without catching, so `apply` and both parsers never throw.
 *
 * Value shape (`null` for sessions that neither coordinate nor are threads):
 *
 * { role: 'coordinator'|'thread', project: { id?, name }, coordinator?: sessionId,
 *   thread?: { id, title }, threads?: [{ id, session, title, resolved, created?, handback? }],
 *   cards?: [{ turn, seq, kind, thread?, status? }], off?: true, changes?: [{ turn, seq }],
 *   ending?: { state: 'failed'|'stopped', kind, turn, seq, at, message?, code?, cause?, hook?, times? },
 *   turnAt?: ms }
 *
 * `project` names the coordinating chat: its session id and its title (for
 * a thread, its coordinator's). Card kinds: start, send, update (tool
 * results), handback, idle, approval and question (the plugin's messages).
 * An idle card's status says when the thread's turn failed or stopped (from
 * the note's first line). `off` is set while a chat has stopped
 * coordinating. `changes` lists a thread's turns that changed files,
 * oldest first. `turnAt` is when a thread's latest turn
 * started (DSH's event time), so a running thread's card says how long it
 * has run. `ending` is a thread's last turn when it didn't finish: it
 * failed (DSH logged an error, a plugin blocked it, or the user signed out)
 * or it stopped (stopped, cut off by DSH closing, or at the output token
 * limit); a turn that finishes, or hands back a result before it ends,
 * clears it. `times` counts the same ending in a row, from 2 (a thread
 * retried that failed again).
 *
 * @module dsh-plugin-coordinator/projection
 */
import { TAGS, endingStateOf, readableError, handbackSummary, cardSummary } from './prompts.js';

/** The projection key; the browser half reads the same name. */
export const PROJECTION_KEY = 'coordinatorSession';
/** Bump when the state shape or fold changes; DSH then refolds from the log. */
export const STATE_VERSION = 7;
/** Most recent cards kept per session; older turns rarely scroll into view. */
export const MAX_CARDS = 60;
/** Threads kept in a roster: every open one, then the newest resolved ones. */
export const MAX_THREADS = 60;
/** A thread's turns with file changes kept in its value (the newest). */
export const MAX_CHANGES = 40;
/** Marks the presentation meta of project tool results. */
export const META_MARK = 'dshCoordinator';

const INITIAL = Object.freeze({ turn: 0, v: null });
/** Request ids of plugin prompts sent as the user's (earlier versions): `projects-<uuid>`, then `@<coordinator session>`. */
const RPC = /^projects-[^@]*(?:@(.+))?$/;
/** Source kinds of the plugin's messages now: an agent's (from the coordinator or a thread) or a plugin's. */
const AGENT_MESSAGE = 'agent-message';
const PLUGIN_MESSAGE = 'cordis-host-runner';
const BRIEF = /^\[Brief from the chat "(.*)" · you are thread (t\d+), "(.*)"\]$/;
const HANDBACK = /^\[Handback from thread (t\d+) · "(.*)" · status: ([a-z_]+)\]$/;
const IDLE = /^\[Thread idle without a handback: (t\d+) · "(.*)"\]$/;
const APPROVAL = /^\[Thread waiting for approval: (t\d+) · "(.*)"\]$/;
const QUESTION = /^\[Question from thread (t\d+) · "(.*)"\]$/;
/** The command a chat coordinates with (projects.js COMMAND), and what after it stops. */
const COMMAND = 'coordinate';
const STOP_WORDS = new Set(['off', 'stop']);
/** What a coordinating chat goes by before DSH has given it a title (prompts.js UNTITLED_CHAT). */
const UNTITLED = 'Untitled chat';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : undefined);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One roster entry as stored in the value, or null when it is not one. */
function threadEntry(raw) {
    if (!isObject(raw) || typeof raw.id !== 'string' || !/^t\d+$/.test(raw.id)) return null;
    const entry = { id: raw.id, session: str(raw.session, 120) ?? null, title: str(raw.title, 120) ?? raw.id, resolved: raw.resolved === true };
    if (typeof raw.created === 'string') entry.created = raw.created.slice(0, 40);
    if (isObject(raw.handback) && typeof raw.handback.status === 'string') {
        entry.handback = { status: raw.handback.status.slice(0, 20), summary: str(raw.handback.summary, 300) ?? '', at: str(raw.handback.at, 40) ?? null };
    }
    return entry;
}

const threadNumber = (entry) => Number(entry.id.slice(1));

/** Keep every open thread and the newest resolved ones, in thread order. */
function trimRoster(list) {
    const sorted = [...list].sort((a, b) => threadNumber(a) - threadNumber(b));
    if (sorted.length <= MAX_THREADS) return sorted;
    const open = sorted.filter((t) => !t.resolved);
    const resolved = sorted.filter((t) => t.resolved).slice(-Math.max(MAX_THREADS - open.length, 0));
    const keep = new Set([...open, ...resolved]);
    return sorted.filter((t) => keep.has(t));
}

/** Upsert roster entries by id; `replace` drops the ones not given. */
function mergeRoster(current, entries, replace) {
    const byId = new Map(replace ? [] : (current ?? []).map((t) => [t.id, t]));
    for (const entry of entries) byId.set(entry.id, { ...byId.get(entry.id), ...entry });
    return trimRoster([...byId.values()]);
}

/** A card for a turn, keeping the newest MAX_CARDS. */
function withCard(v, card) {
    const cards = [...(v.cards ?? []), card];
    return { ...v, cards: cards.length > MAX_CARDS ? cards.slice(-MAX_CARDS) : cards };
}

/**
 * A thread's value with when its latest turn started (the state's
 * `turnAt`); any other value as it is. A thread's first turn starts before
 * its brief says it is one, so the brief brings the time along.
 */
function withTurnAt(state, v) {
    return v?.role === 'thread' && Number.isFinite(state.turnAt) && v.turnAt !== state.turnAt ? { ...v, turnAt: state.turnAt } : v;
}

/** The visible value with role and project set, from what an event says. */
function identify(v, role, project, extra = {}) {
    const base = v ?? { role, project };
    const next = { ...base, ...extra };
    // A coordinator never turns into a thread or back; the first role seen holds.
    next.role = base.role ?? role;
    next.project = { ...base.project, ...project };
    return next;
}

/**
 * Text and sender of a message this plugin sent, or null. `sender` is the
 * session it came from, when known: the coordinator for a brief or a
 * coordinator's message, the thread for a handback.
 */
function messageOf(event) {
    const data = event?.data;
    const message = isObject(data?.message) ? data.message : data;
    if (!isObject(message) || !Array.isArray(message.content)) return null;
    const source = isObject(message.source) ? message.source : {};
    let sender;
    if (source.kind === AGENT_MESSAGE) {
        sender = str(source.senderSessionId, 120);
        if (!sender) return null;
    } else if (source.kind !== PLUGIN_MESSAGE) {
        if (source.kind !== undefined && source.kind !== 'user') return null;
        const rpc = RPC.exec(typeof source.rpcId === 'string' ? source.rpcId : '');
        // Only messages this plugin sent carry project meaning; a user typing a tag does not.
        if (!rpc) return null;
        sender = rpc[1];
    }
    let text = '';
    for (const block of message.content) if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    return text.startsWith('[') ? { text, sender } : null;
}

/** Fold one of the plugin's messages into the state, or return the same state. */
function applyMessage(state, event) {
    const message = messageOf(event);
    if (!message) return state;
    const { text, sender } = message;
    const newline = text.indexOf('\n');
    const head = newline < 0 ? text : text.slice(0, newline);
    const fresh = !(state.since > 0) || !(event.time < state.since);
    let m;
    if (text.startsWith(TAGS.brief) && (m = BRIEF.exec(head))) {
        const v = identify(state.v, 'thread', { name: m[1] }, {
            thread: { id: m[2], title: clip(m[3], 120) },
            ...(sender ? { coordinator: sender } : {}),
        });
        return { ...state, v: state.v?.role === 'coordinator' ? state.v : withTurnAt(state, v) };
    }
    if (text.startsWith(TAGS.coordinator)) {
        // A coordinator made again (the old one was deleted) writes from its new session.
        if (state.v?.role !== 'thread' || !sender || state.v.coordinator === sender) return state;
        return { ...state, v: { ...state.v, coordinator: sender } };
    }
    if (text.startsWith(TAGS.handback) && (m = HANDBACK.exec(head))) {
        if (state.v?.role !== 'coordinator') return state;
        let v = state.v;
        if (fresh) {
            const body = handbackSummary(text);
            const known = (v.threads ?? []).find((t) => t.id === m[1]);
            const handback = { status: m[3], summary: cardSummary(body, 300), at: Number.isFinite(event.time) ? new Date(event.time).toISOString() : null };
            v = { ...v, threads: mergeRoster(v.threads, [{ ...(known ?? { id: m[1], session: null, title: clip(m[2], 120), resolved: false }), handback }], false) };
        }
        return { ...state, v: withCard(v, { turn: state.turn, seq: event.seq, kind: 'handback', thread: m[1], status: m[3] }) };
    }
    for (const [tag, pattern, kind] of [[TAGS.idle, IDLE, 'idle'], [TAGS.approval, APPROVAL, 'approval'], [TAGS.question, QUESTION, 'question']]) {
        if (text.startsWith(tag) && (m = pattern.exec(head))) {
            if (state.v?.role !== 'coordinator') return state;
            // An idle note says first when the turn failed or stopped (prompts.js idleMessage).
            const ended = kind === 'idle' && newline >= 0 ? endingStateOf(text.slice(newline).trim()) : undefined;
            return { ...state, v: withCard(state.v, { turn: state.turn, seq: event.seq, kind, thread: m[1], ...(ended ? { status: ended } : {}) }) };
        }
    }
    return state;
}

/** Fold the presentation meta of one of the plugin's tool results, or return the same state. */
function applyToolMeta(state, event) {
    const meta = event?.data?.meta;
    if (!isObject(meta) || meta[META_MARK] !== 1) return state;
    const role = meta.role === 'thread' ? 'thread' : 'coordinator';
    if (state.v?.role && state.v.role !== role) return state;
    const project = isObject(meta.project) ? { ...(str(meta.project.id, 80) ? { id: meta.project.id } : {}), ...(str(meta.project.name, 120) ? { name: meta.project.name } : {}) } : {};
    let v = identify(state.v, role, project);
    if (typeof meta.coordinator === 'string') v.coordinator = meta.coordinator.slice(0, 120);
    if (role === 'thread' && isObject(meta.thread) && /^t\d+$/.test(String(meta.thread.id))) {
        v.thread = { id: meta.thread.id, title: str(meta.thread.title, 120) ?? meta.thread.id };
    }
    const fresh = !(state.since > 0) || !(event.time < state.since);
    if (role === 'coordinator' && Array.isArray(meta.threads) && fresh) {
        v.threads = mergeRoster(v.threads, meta.threads.map(threadEntry).filter(Boolean), meta.full === true);
    }
    const action = meta.action;
    if (isObject(action) && typeof action.kind === 'string') {
        const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : state.turn;
        v = withCard(v, {
            turn, seq: event.seq, kind: action.kind.slice(0, 20),
            ...(typeof action.thread === 'string' ? { thread: action.thread.slice(0, 12) } : {}),
            ...(typeof action.status === 'string' ? { status: action.status.slice(0, 20) } : {}),
        });
    }
    return { ...state, v: withTurnAt(state, v) };
}

/**
 * A thread's turn changed files (DSH announces each turn's changes, and a
 * turn again when they change): note the event, so the window knows to
 * read the thread's changes again.
 */
function applyChanges(state, event) {
    if (state.v?.role !== 'thread' || !Number.isSafeInteger(event?.seq)) return state;
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : state.turn;
    const list = (Array.isArray(state.v.changes) ? state.v.changes : []).filter((c) => c?.turn !== turn);
    list.push({ turn, seq: event.seq });
    return { ...state, v: { ...state.v, changes: list.slice(-MAX_CHANGES) } };
}

/**
 * How a turn ended, as the window shows a thread's last turn: null when it
 * finished, undefined for an ending this fold doesn't know (it keeps what
 * it had). DSH shows a sign-out as a failure, so this does too.
 */
function endingOf(reason, event, turn) {
    if (!isObject(reason) || typeof reason.kind !== 'string') return undefined;
    const base = { turn, seq: event.seq, at: Number.isFinite(event.time) ? new Date(event.time).toISOString() : null };
    switch (reason.kind) {
        case 'completed': return null;
        case 'error': {
            const error = isObject(reason.error) ? reason.error : {};
            const code = str(error.code, 60);
            return { ...base, state: 'failed', kind: 'error', message: readableError(error.message), ...(code ? { code } : {}) };
        }
        case 'blocked': return { ...base, state: 'failed', kind: 'blocked' };
        case 'aborted': {
            const cause = isObject(reason.reason) ? reason.reason : {};
            if (cause.kind === 'hook' && cause.reason === 'deepseek-account/signed-out') return { ...base, state: 'failed', kind: 'signed-out' };
            const kind = str(cause.kind, 20);
            const hook = cause.kind === 'hook' ? str(cause.reason, 120) : undefined;
            return { ...base, state: 'stopped', kind: 'aborted', ...(kind ? { cause: kind } : {}), ...(hook ? { hook } : {}) };
        }
        case 'interrupted': return { ...base, state: 'stopped', kind: 'interrupted' };
        case 'max-tokens': return { ...base, state: 'stopped', kind: 'max-tokens' };
        default: return undefined;
    }
}

/**
 * A thread's turn ended: keep how, when it didn't finish, so the window
 * shows the thread as failed or stopped until a later turn finishes. A
 * turn that handed back a result (not just progress) is told by its
 * handback instead.
 */
function applyTurnEnd(state, event) {
    if (state.v?.role !== 'thread') return state;
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : state.turn;
    const handedBack = (state.v.cards ?? []).some((c) => c?.kind === 'handback' && c.turn === turn && c.status !== 'progress');
    const ending = handedBack ? null : endingOf(event.data?.reason, event, turn);
    if (ending === undefined) return state;
    if (ending !== null) {
        // The same ending again (a retry that failed again, a resume stopped again): count it, so the window says so.
        const before = state.v.ending;
        const times = before?.state === ending.state && before.turn !== turn ? (Number.isSafeInteger(before.times) ? before.times : 1) + 1 : 1;
        return { ...state, v: { ...state.v, ending: times > 1 ? { ...ending, times } : ending } };
    }
    if (state.v.ending === undefined) return state;
    const { ending: _finished, ...v } = state.v;
    return { ...state, v };
}

/**
 * /coordinate or /coordinate off as DSH logs it: `command/run` names the
 * command (kept until its result), and `command/done` with success makes
 * the chat a coordinating one under its own session id, or marks it `off`.
 * A thread never coordinates, and a failed command changes nothing.
 */
function applyCommand(state, event) {
    const data = event?.data;
    if (event.type === 'command/run') {
        if (data?.name !== COMMAND || typeof data.commandId !== 'string') return state;
        const arg = typeof data.args === 'string' ? data.args.trim().toLowerCase() : '';
        return { ...state, command: { id: data.commandId.slice(0, 120), off: STOP_WORDS.has(arg) } };
    }
    if (!state.command || data?.commandId !== state.command.id) return state;
    const { command, ...rest } = state;
    if (data.kind !== 'success' || state.v?.role === 'thread') return rest;
    if (command.off) {
        if (state.v?.role !== 'coordinator' || state.v.off === true) return rest;
        return { ...rest, v: { ...state.v, off: true } };
    }
    if (typeof state.id !== 'string') return rest;
    const { off: _stopped, ...v } = identify(state.v, 'coordinator', { id: state.id, name: state.title ?? state.v?.project?.name ?? UNTITLED });
    return { ...rest, v };
}

/** The chat's title, which a coordinating chat goes by. */
function applyTitle(state, event) {
    const title = str(event?.data?.title, 120)?.trim();
    if (!title || title === state.title) return state;
    const v = state.v?.role === 'coordinator' ? { ...state.v, project: { ...state.v.project, name: title } } : state.v;
    return { ...state, title, v };
}

/** One event folded into the state; the same reference when the event says nothing about coordinating. */
export function applyEvent(state, event) {
    try {
        // A fork's inherited events are its source's: the chat it forked from coordinated or was a thread, not it.
        if (state.inherited > 0 && Number.isSafeInteger(event?.seq) && event.seq < state.inherited && event.type !== 'session/title' && event.type !== 'turn/start') return state;
        switch (event?.type) {
            case 'command/run':
            case 'command/done': return applyCommand(state, event);
            case 'session/title': return applyTitle(state, event);
            case 'turn/start': {
                const turn = event.data?.turn;
                let next = Number.isSafeInteger(turn) && turn !== state.turn ? { ...state, turn } : state;
                // When the turn started: a thread's card says how long it has run.
                if (Number.isFinite(event.time) && next.turnAt !== event.time) next = { ...next, turnAt: event.time };
                const v = withTurnAt(next, next.v);
                return v === next.v ? next : { ...next, v };
            }
            case 'user/message': return applyMessage(state, event);
            case 'tool/result': return applyToolMeta(state, event);
            case 'workspace/changes': return applyChanges(state, event);
            case 'turn/end': return applyTurnEnd(state, event);
            default: return state;
        }
    } catch {
        return state;
    }
}

/** Persisted or seeded state, made safe; never throws. */
export function parseState(value) {
    if (!isObject(value)) return INITIAL;
    const turn = Number.isSafeInteger(value.turn) && value.turn >= 0 ? value.turn : 0;
    const v = isObject(value.v) && (value.v.role === 'coordinator' || value.v.role === 'thread') && isObject(value.v.project) ? value.v : null;
    const command = isObject(value.command) && typeof value.command.id === 'string' ? { id: value.command.id.slice(0, 120), off: value.command.off === true } : undefined;
    return {
        turn, v,
        ...(Number.isFinite(value.since) && value.since > 0 ? { since: value.since } : {}),
        ...(Number.isFinite(value.turnAt) ? { turnAt: value.turnAt } : {}),
        // How many of a fork's first events are its source's.
        ...(Number.isSafeInteger(value.inherited) && value.inherited > 0 ? { inherited: value.inherited } : {}),
        // The session's own id and title, for a chat that starts coordinating; and the command it waits on the result of.
        ...(typeof value.id === 'string' ? { id: value.id.slice(0, 120) } : {}),
        ...(typeof value.title === 'string' ? { title: value.title.slice(0, 120) } : {}),
        ...(command ? { command } : {}),
    };
}

/**
 * The projection definition for DSH's `ctx.sessionProjections`.
 * @param {(sessionId: string) => object|null} seed - the store's view of a session it knows, or null.
 */
export function coordinatorSessionProjection(seed) {
    return {
        key: PROJECTION_KEY,
        stateVersion: STATE_VERSION,
        stateSchema: { parse: parseState },
        init(header, inheritedEventCount) {
            const id = typeof header?.id === 'string' && header.id !== '' ? header.id.slice(0, 120) : undefined;
            const inherited = Number.isSafeInteger(inheritedEventCount) && inheritedEventCount > 0 ? { inherited: inheritedEventCount } : {};
            let v = null;
            try { v = id ? seed(id) : null; } catch { v = null; }
            if (v) return { turn: 0, v, since: Date.now(), id, ...inherited };
            return id || inherited.inherited ? { ...INITIAL, ...(id ? { id } : {}), ...inherited } : INITIAL;
        },
        apply: applyEvent,
        wire: {
            viewSchema: { parse: (value) => (isObject(value) ? value : null) },
            view: (state) => state?.v ?? null,
        },
    };
}
