/**
 * The session watcher's view of one session, folded from its events.
 *
 * DSH drives every registered projection over every committed session
 * event, keeps the result per session, saves it with the session, and
 * hands it back for sessions that are not loaded (`sessionController.list`
 * hints). This fold is the one place the suite reads a session's turns,
 * todos, goal and pending approvals from, so Autopilot, Decisions and
 * Agent Terminals never read logs of their own.
 *
 * The fold is pure: it never throws, never reads the clock, and returns
 * the same object when an event changes nothing.
 *
 * `ask` is what the newest reply text asks a person (a DECISION NEEDED
 * line, a BLOCKED line or a plain question), with the turn it came in; it
 * stays in the view, so Decisions finds asks in sessions that are not
 * loaded without reading their logs.
 *
 * `approvals` (tools waiting for approval) and `asking` (a question waiting
 * in DSH's question box) belong to the open turn: a turn's start and end
 * clear them, since nothing waits on a turn that is over. A turn that DSH
 * cut off under one keeps what it left in `end.left`, so a note after the
 * restart can say the tool did not run, or the question was not answered.
 * A graceful stop cancels them first (`approval/decided` "cancelled", the
 * question box's call ending in an error), so the turn keeps what a stop
 * cancelled in `cancelled` until it ends.
 *
 * @module dsh-plugin-session-watch/fold
 */
import { askIn, cutOff, plainError } from './shared/words.js';

export { cutOff };

/** The projection's key in DSH (one name for the whole Host). */
export const KEY = 'sessionWatch';
/** Bump when the state's shape changes: DSH then drops saved states of the old shape and folds again. */
export const STATE_VERSION = 4;

/** DSH's question box, as a tool. */
export const ASK_TOOL = 'ask_user_question';

/** Longest final reply text the state keeps (for "DECISION NEEDED" lines and the like). */
export const TEXT_MAX = 1500;
/** Longest objective, todo line, reason or error kept. */
const LINE_MAX = 240;

const INITIAL = Object.freeze({ turn: 0, open: false, tools: 0, at: 0 });

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = (value) => Number.isFinite(value) && value >= 0;

/** Flatten and cut a line of text. */
export function line(text, max = LINE_MAX) {
    if (typeof text !== 'string') return '';
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The text blocks of a message, joined. */
export function textOf(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('');
}

/** A todo list in counts, and the item to work on next. */
export function todoSummary(todos) {
    if (!Array.isArray(todos)) return undefined;
    let open = 0;
    let active = 0;
    let done = 0;
    let next = '';
    let firstPending = '';
    for (const item of todos) {
        if (!isRecord(item)) continue;
        if (item.status === 'completed') done += 1;
        else if (item.status === 'in_progress') {
            open += 1;
            active += 1;
            if (!next) next = line(item.content, 160);
        } else {
            open += 1;
            if (!firstPending) firstPending = line(item.content, 160);
        }
    }
    const total = open + done;
    if (total === 0) return { open: 0, active: 0, done: 0, total: 0 };
    return { open, active, done, total, ...(next || firstPending ? { next: next || firstPending } : {}) };
}

/** A turn end, as the watcher keeps it. */
export function endOf(data, time) {
    const reason = isRecord(data?.reason) ? data.reason : {};
    const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown';
    const out = { turn: Number.isSafeInteger(data?.turn) ? data.turn : 0, kind, at: isTime(time) ? time : 0 };
    if (kind === 'aborted' && isRecord(reason.reason) && typeof reason.reason.kind === 'string') out.cause = reason.reason.kind;
    if (kind === 'error' && isRecord(reason.error)) {
        if (typeof reason.error.code === 'string') out.code = line(reason.error.code, 60);
        const message = line(plainError(reason.error.message), LINE_MAX);
        if (message) out.error = message;
    }
    return out;
}

/** A question-box call as the watcher keeps it: its call id, its first question and how many more. */
export function askingOf(data, time) {
    let args = data?.arguments;
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch {
            args = undefined;
        }
    }
    const questions = Array.isArray(args?.questions) ? args.questions.filter((q) => isRecord(q) && typeof q.question === 'string' && q.question.trim()) : [];
    return {
        ...(typeof data?.callId === 'string' ? { call: data.callId } : {}),
        ...(questions.length ? { question: line(questions[0].question) } : {}),
        ...(questions.length > 1 ? { more: questions.length - 1 } : {}),
        at: isTime(time) ? time : 0,
    };
}

/** What a turn left waiting when it ended: the newest approval, else the question box's question, else what the stop cancelled. */
function leftOf(state) {
    const approval = state.approvals?.at(-1);
    if (approval) {
        return {
            kind: 'approval',
            ...(approval.tool ? { tool: approval.tool } : {}),
            ...(approval.reason ? { reason: approval.reason } : {}),
            ...(state.approvals.length > 1 ? { more: state.approvals.length - 1 } : {}),
        };
    }
    if (state.asking) return questionLeft(state.asking);
    return state.cancelled;
}

const questionLeft = (asking) => ({ kind: 'question', ...(asking.question ? { question: asking.question } : {}), ...(asking.more ? { more: asking.more } : {}) });

/** The goal as the watcher keeps it, from a `goal/change` payload. */
export function goalOf(change, previous) {
    if (!isRecord(change)) return previous;
    if (change.operation === 'clear') return undefined;
    const goal = change.goal;
    if (!isRecord(goal) || typeof goal.id !== 'string') return previous;
    const out = {
        id: goal.id,
        rev: Number.isSafeInteger(goal.revision) ? goal.revision : 0,
        phase: typeof goal.phase === 'string' ? goal.phase : 'active',
        objective: line(goal.objective, LINE_MAX),
        rounds: Number.isSafeInteger(change.roundsStarted) ? change.roundsStarted : 0,
        max: Number.isSafeInteger(goal.maxGoalRounds) ? goal.maxGoalRounds : 0,
    };
    if (isRecord(goal.blockedReason)) out.blocked = line(goal.blockedReason.message, LINE_MAX);
    if (previous && previous.id === out.id && previous.rounds > out.rounds) out.rounds = previous.rounds;
    return out;
}

/** Shallow-compare two plain values made of records, arrays and scalars. */
function same(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, i) => same(item, b[i]));
    }
    if (!isRecord(a) || !isRecord(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => same(a[key], b[key]));
}

/** Copy `state` with `patch`, or give `state` back when the patch changes nothing. */
function patched(state, patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
        if (!same(state[key], value)) {
            changed = true;
            break;
        }
    }
    if (!changed) return state;
    const next = { ...state };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
    }
    return next;
}

/** One event's effect on the state. */
function step(state, event) {
    const data = event.data;
    const at = isTime(event.time) ? event.time : state.at;
    switch (event.type) {
        case 'turn/start':
            return patched(state, {
                turn: Number.isSafeInteger(data?.turn) ? data.turn : state.turn + 1,
                open: true,
                startedAt: at,
                steps: 0,
                approvals: undefined,
                asking: undefined,
                cancelled: undefined,
                at,
            });
        case 'turn/end': {
            const end = endOf(data, at);
            const left = cutOff(end) ? leftOf(state) : undefined;
            if (left) end.left = left;
            return patched(state, {
                open: false,
                end,
                approvals: undefined,
                asking: undefined,
                cancelled: undefined,
                errors: end.kind === 'error' ? (state.errors ?? 0) + 1 : end.kind === 'completed' ? undefined : state.errors,
                at,
            });
        }
        case 'user/message': {
            const kind = typeof data?.source?.kind === 'string' ? data.source.kind : 'unknown';
            // Who sent another session's message (a coordinator relaying a thread, say), so a reply to it can be told apart.
            const from = kind === 'agent-message' && typeof data.source.senderSessionId === 'string' ? data.source.senderSessionId.slice(0, 128) : undefined;
            const patch = { inAt: at, inKind: kind, inFrom: from, at };
            if (kind === 'user') patch.userAt = at;
            if (kind === 'goal' && state.goal && data.source.goalId === state.goal.id && Number.isSafeInteger(data.source.round) && data.source.round > state.goal.rounds) {
                patch.goal = { ...state.goal, rounds: data.source.round };
            }
            return patched(state, patch);
        }
        case 'assistant/message': {
            const text = textOf(data?.message);
            if (!text.trim()) return state;
            const textTurn = Number.isSafeInteger(data?.turn) ? data.turn : state.turn;
            const ask = askIn(text);
            return patched(state, {
                text: text.length > TEXT_MAX ? `…${text.slice(text.length - TEXT_MAX + 1)}` : text,
                textTurn,
                ask: ask ? { ...ask, turn: textTurn } : undefined,
                at,
            });
        }
        case 'tool/call': {
            const patch = { tools: state.tools + 1, steps: (state.steps ?? 0) + 1, at };
            if (data?.name === ASK_TOOL) patch.asking = askingOf(data, at);
            return patched(state, patch);
        }
        case 'tool/result': {
            // The question box's result: the person answered (or it timed out), so nothing waits on it now. An error
            // is a stop cancelling it (or the box going away): kept, in case the turn turns out to be cut off.
            if (!state.asking) return state;
            const id = data?.message?.toolCallId;
            if (state.asking.call && id !== state.asking.call) return state;
            const failed = data?.error !== undefined || data?.message?.isError === true;
            return patched(state, { asking: undefined, ...(failed ? { cancelled: questionLeft(state.asking) } : {}), at });
        }
        case 'todo/write':
            return patched(state, { todos: todoSummary(data?.todos), at });
        case 'goal/change':
            return patched(state, { goal: goalOf(data, state.goal), at });
        case 'approval/asked': {
            if (typeof data?.id !== 'string') return state;
            const asked = (state.approvals ?? []).filter((item) => item.id !== data.id);
            asked.push({
                id: data.id,
                tool: line(data.toolName, 80),
                ...(typeof data.callId === 'string' ? { call: data.callId } : {}),
                ...(typeof data.reason === 'string' && data.reason.trim() ? { reason: line(data.reason) } : {}),
                at,
            });
            return patched(state, { approvals: asked.slice(-20), at });
        }
        case 'approval/decided': {
            const decided = state.approvals?.find((item) => item.id === data?.id);
            if (!decided) return state;
            const left = state.approvals.filter((item) => item.id !== data.id);
            // A stop cancels a waiting approval before the turn ends: kept, in case the turn turns out to be cut off.
            const cancelled = data.outcome === 'cancelled'
                ? { kind: 'approval', ...(decided.tool ? { tool: decided.tool } : {}), ...(decided.reason ? { reason: decided.reason } : {}) } : undefined;
            return patched(state, { approvals: left.length ? left : undefined, ...(cancelled ? { cancelled } : {}), at });
        }
        case 'session/title':
            return patched(state, { title: line(data?.title, 120) || undefined });
        default:
            return state;
    }
}

/**
 * Fold one committed event into a session's state. Never throws: an event
 * it cannot read leaves the state as it was.
 * @param {object} state
 * @param {{ type: string, time?: number, data?: any }} event
 */
export function applyEvent(state, event) {
    try {
        if (!isRecord(state)) state = INITIAL;
        if (!isRecord(event) || typeof event.type !== 'string') return state;
        return step(state, event);
    } catch {
        return state;
    }
}

/** A saved state made safe; never throws. */
export function parseState(value) {
    if (!isRecord(value)) return INITIAL;
    const out = {
        turn: Number.isSafeInteger(value.turn) && value.turn >= 0 ? value.turn : 0,
        open: value.open === true,
        tools: Number.isSafeInteger(value.tools) && value.tools >= 0 ? value.tools : 0,
        at: isTime(value.at) ? value.at : 0,
    };
    for (const key of ['startedAt', 'userAt', 'inAt']) if (isTime(value[key])) out[key] = value[key];
    for (const key of ['steps', 'errors', 'textTurn']) if (Number.isSafeInteger(value[key]) && value[key] >= 0) out[key] = value[key];
    if (typeof value.inKind === 'string') out.inKind = value.inKind.slice(0, 40);
    if (typeof value.inFrom === 'string') out.inFrom = value.inFrom.slice(0, 128);
    if (typeof value.title === 'string') out.title = value.title.slice(0, 120);
    if (typeof value.text === 'string') out.text = value.text.slice(-TEXT_MAX);
    if (isRecord(value.end) && typeof value.end.kind === 'string') out.end = { ...value.end };
    if (isRecord(value.todos)) out.todos = { ...value.todos };
    if (isRecord(value.goal) && typeof value.goal.id === 'string') out.goal = { ...value.goal };
    if (isRecord(value.ask) && ['decision', 'blocked', 'question'].includes(value.ask.kind) && typeof value.ask.question === 'string') {
        out.ask = {
            kind: value.ask.kind,
            question: value.ask.question.slice(0, 400),
            ...(typeof value.ask.recommendation === 'string' ? { recommendation: value.ask.recommendation.slice(0, 400) } : {}),
            ...(value.ask.soft === true ? { soft: true } : {}),
            turn: Number.isSafeInteger(value.ask.turn) ? value.ask.turn : 0,
        };
    }
    if (Array.isArray(value.approvals)) {
        const approvals = value.approvals.filter((item) => isRecord(item) && typeof item.id === 'string').slice(-20);
        if (approvals.length) out.approvals = approvals;
    }
    if (isRecord(value.cancelled) && ['approval', 'question'].includes(value.cancelled.kind)) out.cancelled = { ...value.cancelled };
    if (isRecord(value.asking)) {
        out.asking = {
            ...(typeof value.asking.call === 'string' ? { call: value.asking.call } : {}),
            ...(typeof value.asking.question === 'string' ? { question: value.asking.question.slice(0, LINE_MAX) } : {}),
            ...(Number.isSafeInteger(value.asking.more) && value.asking.more > 0 ? { more: value.asking.more } : {}),
            at: isTime(value.asking.at) ? value.asking.at : 0,
        };
    }
    return out;
}

/**
 * What a window and a cold session's list row get: the state without the
 * reply text, which only the host reads.
 */
export function viewOf(state) {
    if (!isRecord(state)) return null;
    const { text, ...rest } = state;
    return rest;
}

/** The projection definition for DSH's `ctx.sessionProjections.register`. */
export function sessionWatchProjection() {
    return {
        key: KEY,
        stateVersion: STATE_VERSION,
        stateSchema: { parse: parseState },
        init: () => INITIAL,
        apply: applyEvent,
        wire: {
            viewSchema: { parse: (value) => (isRecord(value) ? value : null) },
            view: viewOf,
        },
    };
}

/** Fold a list of events from the start (for tests, and for a log read whole). */
export function foldAll(events) {
    let state = INITIAL;
    for (const event of events ?? []) state = applyEvent(state, event);
    return state;
}

/** Longest preview of a waiting message the watcher keeps. */
const PREVIEW_MAX = 120;

/**
 * What waits in a session's queue, folded from its log as DSH folds its
 * own inbox (`agent/inbox/spliced`: a target list, a start, a count
 * removed and the messages inserted): `{ 'next-turn': [...], 'next-step':
 * [...], gone }`, each waiting one `{ id, at, kind, preview }`, oldest
 * first, and `gone` the ids taken out of it and how. DSH reads one
 * next-turn message per turn, with every next-step message. Never throws:
 * a splice it cannot place leaves the lists as they were.
 * @param {object[]} events
 */
export function inboxOf(events) {
    const lists = { 'next-turn': [], 'next-step': [] };
    /** Messages taken out of the queue, by id: 'claimed' by a turn (which then reads them), or 'canceled' (let go unread). */
    const gone = new Map();
    for (const event of Array.isArray(events) ? events : []) {
        if (event?.type !== 'agent/inbox/spliced' || !isRecord(event.data)) continue;
        const { target, start, removedCount = 0, inserted, outcome } = event.data;
        const list = target === 'next-turn' || target === 'next-step' ? lists[target] : undefined;
        if (!list || !Number.isSafeInteger(start) || start < 0 || start > list.length || !Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > list.length) continue;
        const added = (Array.isArray(inserted) ? inserted : []).filter((m) => isRecord(m) && typeof m.id === 'string').map((m) => waitingOf(m, event.time));
        for (const removed of list.splice(start, removedCount, ...added)) gone.set(removed.id, { how: outcome === 'canceled' ? 'canceled' : 'claimed', ...(isTime(event.time) ? { at: event.time } : {}) });
        for (const item of added) gone.delete(item.id);
    }
    return { ...lists, gone };
}

/** One waiting message as the watcher shows it: its id, when it went in, who it is from (DSH's source kind) and its first words. */
export function waitingOf(message, time) {
    const kind = typeof message?.source?.kind === 'string' ? message.source.kind.slice(0, 40) : undefined;
    const preview = line(textOf(message), PREVIEW_MAX);
    return { id: message.id, ...(isTime(time) ? { at: time } : {}), ...(kind ? { kind } : {}), ...(preview ? { preview } : {}) };
}

/**
 * Where a message sits in a log: the index of its `user/message`, and the
 * turn that read it (the last `turn/start` before it with no `turn/end`
 * between). Undefined when no turn read it.
 * @param {object[]} events
 * @param {string} id
 * @returns {{ index: number, turn?: number, seq?: number } | undefined}
 */
export function readIn(events, id) {
    if (!Array.isArray(events)) return undefined;
    const index = events.findIndex((e) => e?.type === 'user/message' && e.data?.id === id);
    if (index < 0) return undefined;
    let turn;
    for (let i = index - 1; i >= 0; i -= 1) {
        const type = events[i]?.type;
        if (type === 'turn/end') break;
        if (type === 'turn/start') {
            turn = Number.isSafeInteger(events[i].data?.turn) ? events[i].data.turn : undefined;
            break;
        }
    }
    return { index, ...(turn !== undefined ? { turn } : {}), ...(Number.isSafeInteger(events[index].seq) ? { seq: events[index].seq } : {}) };
}

export { INITIAL };
