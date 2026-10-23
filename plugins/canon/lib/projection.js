/**
 * The `canonRecall` session projection: which turn of a session Canon
 * last added notes to, and which notes. DSH folds it over every committed
 * event, keeps it with the session and streams it to the window, where
 * the card after that turn reads it (lib/client.js). The model never sees
 * it. It also knows the session's current turn, for a capture's source.
 *
 * DSH runs `apply` inside its event commit and parses saved state without
 * catching, so neither throws, and an event that changes nothing gives
 * back the same state. The view (on every row of DSH's session list) is
 * small: the count and the last recall.
 *
 * State: `{ v: 1, turn, recall: { count, last: { turn, at, notes: [{ path, title }] } | null } }`
 *
 * @module dsh-plugin-canon/projection
 */
import { KIND } from './recall.js';

export const KEY = 'canonRecall';
export const STATE_VERSION = 1;
const MAX_NOTES = 10;

const NO_RECALL = Object.freeze({ count: 0, last: null });
export const INITIAL = Object.freeze({ v: 1, turn: 0, recall: NO_RECALL });

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

/** The notes a Canon message cites, as kept. */
function notesOf(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((n) => isRecord(n) && typeof n.path === 'string' && n.path).slice(0, MAX_NOTES).map((n) => ({ path: str(n.path, 400), title: str(n.title, 200) }));
}

/** Fold one committed event. */
export function applyEvent(state, event) {
    try {
        const s = isRecord(state) && state.v === 1 && isRecord(state.recall) ? state : INITIAL;
        if (!isRecord(event) || typeof event.type !== 'string') return s;
        const data = isRecord(event.data) ? event.data : {};
        if (event.type === 'turn/start') {
            const turn = Number.isSafeInteger(data.turn) ? data.turn : s.turn + 1;
            return turn === s.turn ? s : { ...s, turn };
        }
        if (event.type === 'user/message' && data.source?.kind === KIND) {
            const notes = notesOf(data.source.notes);
            if (notes.length === 0) return s;
            const turn = Number.isSafeInteger(data.source.turn) ? data.source.turn : s.turn;
            return { ...s, recall: { count: s.recall.count + 1, last: { turn, at: Number.isFinite(event.time) ? event.time : 0, notes } } };
        }
        return s;
    } catch {
        return isRecord(state) ? state : INITIAL;
    }
}

/** A saved state, made safe (an older or broken one starts over). */
export function parseState(value) {
    try {
        if (!isRecord(value) || value.v !== 1) return INITIAL;
        return { v: 1, turn: Number.isSafeInteger(value.turn) ? value.turn : 0, recall: parseView(value.recall) };
    } catch {
        return INITIAL;
    }
}

/** The window's view: the count and the last recall (the same object while they stay the same). */
export function viewOf(state) {
    return isRecord(state) && isRecord(state.recall) ? state.recall : NO_RECALL;
}

export function parseView(value) {
    if (!isRecord(value)) return NO_RECALL;
    const last = isRecord(value.last) && Number.isSafeInteger(value.last.turn)
        ? { turn: value.last.turn, at: Number.isFinite(value.last.at) ? value.last.at : 0, notes: notesOf(value.last.notes) } : null;
    return { count: Number.isSafeInteger(value.count) && value.count >= 0 ? value.count : last ? 1 : 0, last: last && last.notes.length ? last : null };
}

/** The projection for DSH's `ctx.sessionProjections.register`. */
export function canonProjection() {
    return {
        key: KEY,
        stateVersion: STATE_VERSION,
        stateSchema: { parse: parseState },
        init: () => INITIAL,
        apply: applyEvent,
        wire: {
            viewSchema: { parse: parseView },
            view: viewOf,
        },
    };
}

/** Fold a whole log (a test's, or a cold session's). */
export function foldAll(events) {
    let state = INITIAL;
    for (const event of events ?? []) state = applyEvent(state, event);
    return state;
}
