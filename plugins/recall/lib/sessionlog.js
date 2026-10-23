/**
 * A DSH session log, read into turns: one row per turn with the person's
 * words, the replies, and the tool calls with their key arguments.
 *
 * The log is JSON lines: a header (`{"type":"session", id, cwd, …}`), then
 * events (`{"type", "seq", "time", "data"}`). A turn runs from
 * `turn/start` to `turn/end`. What the person wrote is a `user/message`
 * whose source is theirs (or a plugin's or a schedule's); messages DSH
 * injects as context (instructions, runtime and time context, job notices)
 * are left out, or every session would match their words. Lines of other
 * types (the system prompt, request headers, tool output) are skipped from
 * their first bytes, without parsing them.
 *
 * The reader is incremental: `state` holds where it is (the header, the
 * open turn), so the next pass can go on from the next line.
 *
 * A forked session's log starts with its parent's events up to a
 * `session/end-seed` marker; those turns are the parent's, and are skipped.
 *
 * A turn's end keeps DSH's reason: `completed`, `aborted` (who stopped it:
 * `user`, `parent`, `disposed` or a `hook`), `error` (with its message),
 * `max-tokens`, `blocked`, or `interrupted` (DSH closes a turn so when it
 * opens a session again after a crash; Recall does the same when a turn
 * starts while one is open).
 *
 * @module dsh-plugin-recall/sessionlog
 */
import { addPrompt, addReply, addTool, newTurn, rowOf, titleLine } from './turns.js';

/** The event types Recall reads; every other line is skipped unparsed. */
const WANTED = new Set(['session', 'session/title', 'session/end-seed', 'turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'request/context']);

/** Who injects context into a session (not the person's words). */
export const CONTEXT_KINDS = new Set(['agent-instructions', 'runtime-context', 'time-context', 'tool-jobs', 'system-prompt', 'skill-catalog', 'compaction']);
/** Context forms that are material, not a message: a file's instructions, a catalog, a snapshot, a one-line notice. */
export const CONTEXT_FORMS = new Set(['instructions', 'catalog', 'snapshot', 'notice']);

/** A line's type, read from its first bytes: DSH writes `{"type":"…"` first. */
export function typeOf(line) {
    if (!line.startsWith('{"type":"')) return undefined;
    const end = line.indexOf('"', 9);
    return end > 9 && end < 80 ? line.slice(9, end) : undefined;
}

/** The text blocks of a message's content. */
export function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((b) => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/** Whether a user message is the person's (or an agent's, a plugin's, a schedule's) and not injected context. */
export function isPrompt(message) {
    if (!message || typeof message !== 'object') return false;
    if (message.role !== undefined && message.role !== 'user') return false;
    const source = message.source ?? {};
    if (CONTEXT_KINDS.has(source.kind) || CONTEXT_FORMS.has(source.form)) return false;
    return true;
}

/** Why a turn ended early, in DSH's own words: who or what stopped it, or the error's message; '' otherwise. */
export function whyOf(reason) {
    const words = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (reason?.kind === 'aborted') {
        const cause = reason.reason && typeof reason.reason === 'object' ? reason.reason : {};
        const kind = typeof cause.kind === 'string' ? cause.kind.slice(0, 20) : '';
        const text = typeof cause.reason === 'string' ? cause.reason : typeof cause.reason?.message === 'string' ? cause.reason.message : '';
        return text ? words(`${kind}: ${text}`) : kind;
    }
    if (reason?.kind === 'error') {
        const e = reason.error && typeof reason.error === 'object' ? reason.error : {};
        return words(typeof e.message === 'string' && e.message.trim() ? e.message : typeof e.code === 'string' ? e.code : '');
    }
    return '';
}

/** A reader's state before the first line. */
export function newSessionState() {
    return { v: 1, header: undefined, title: '', model: '', provider: '', pastSeed: true, open: undefined, pending: '', turns: 0, count: 0, first: '', last: 0, bad: 0 };
}

export class SessionLog {
    /** @param {object} [state] - from an earlier pass (`newSessionState()` for a new file). */
    constructor(state) {
        this.state = state && state.v === 1 ? state : newSessionState();
        /** Rows ended in this pass, by turn. */
        this.ended = new Map();
        this.touched = false;
    }

    /** Read one line of the log. Lines that are not JSON are counted and skipped. */
    line(text) {
        const type = typeOf(text);
        if (type === undefined || !WANTED.has(type)) return;
        let event;
        try {
            event = JSON.parse(text);
        } catch {
            this.state.bad += 1;
            return;
        }
        if (!event || typeof event !== 'object') return;
        const s = this.state;
        const data = event.data && typeof event.data === 'object' ? event.data : {};
        if (Number.isFinite(event.time) && event.time > s.last) s.last = event.time;
        switch (type) {
            case 'session':
                s.header = {
                    id: typeof event.id === 'string' ? event.id : '',
                    cwd: typeof event.cwd === 'string' ? event.cwd : '',
                    created: Number.isFinite(event.createdAt) ? event.createdAt : 0,
                    seeded: event.isSeeded === true,
                    depth: Number.isInteger(event.delegationDepth) ? event.delegationDepth : 0,
                };
                if (s.header.created > s.last) s.last = s.header.created;
                if (s.header.seeded) s.pastSeed = false;
                this.touched = true;
                return;
            case 'session/end-seed':
                // The parent's events end here; this session's own begin.
                s.pastSeed = true;
                s.open = undefined;
                s.pending = '';
                return;
            case 'session/title':
                if (typeof data.title === 'string' && data.title.trim()) {
                    s.title = titleLine(data.title);
                    this.touched = true;
                }
                return;
            case 'request/context':
                if (typeof data.model === 'string' && data.model) {
                    s.model = data.model;
                    s.provider = typeof data.provider === 'string' ? data.provider : '';
                    if (s.open && s.pastSeed) {
                        s.open.model = s.model;
                        s.open.provider = s.provider;
                    }
                }
                return;
            default:
                break;
        }
        if (!s.pastSeed) return;
        switch (type) {
            case 'turn/start': {
                if (s.open) this.close('interrupted', 0);
                const n = Number.isSafeInteger(data.turn) && data.turn > 0 ? data.turn : s.turns + 1;
                s.open = newTurn({ turn: n, seq: Number.isSafeInteger(event.seq) ? event.seq : 0, time: Number.isFinite(event.time) ? event.time : 0, model: s.model, provider: s.provider });
                if (s.pending) {
                    addPrompt(s.open, s.pending);
                    s.pending = '';
                }
                return;
            }
            case 'user/message': {
                if (!isPrompt(data)) return;
                const words = textOf(data.content);
                if (!words.trim()) return;
                if (s.open) addPrompt(s.open, words);
                else if (s.pending.length < 6000) s.pending = s.pending ? `${s.pending}\n\n${words}`.slice(0, 6000) : words.slice(0, 6000);
                if (!s.first) s.first = titleLine(words.split('\n').find((l) => l.trim()) ?? '');
                return;
            }
            case 'assistant/message': {
                const message = data.message;
                if (!s.open || !message || typeof message !== 'object') return;
                addReply(s.open, textOf(message.content));
                const model = message.source?.model;
                if (typeof model === 'string' && model) {
                    s.open.model = model;
                    if (typeof message.source?.provider === 'string') s.open.provider = message.source.provider;
                }
                return;
            }
            case 'tool/call':
                if (s.open && typeof data.name === 'string') addTool(s.open, data.name, data.arguments);
                return;
            case 'turn/end': {
                if (!s.open) return;
                if (Number.isSafeInteger(data.turn) && data.turn !== s.open.turn) return;
                const reason = data.reason && typeof data.reason === 'object' ? data.reason : {};
                this.close(typeof reason.kind === 'string' && reason.kind ? reason.kind.slice(0, 40) : 'completed', Number.isFinite(event.time) ? event.time : 0, whyOf(reason));
                return;
            }
            default:
        }
    }

    /** End the open turn: how (DSH's reason) and why (who stopped it, or the error). */
    close(status, at, why = '') {
        const s = this.state;
        const open = s.open;
        if (!open) return;
        open.status = status;
        open.why = why;
        open.end = at;
        this.ended.set(open.turn, rowOf(open, { done: true }));
        s.turns = Math.max(s.turns, open.turn);
        s.count += 1;
        s.open = undefined;
    }

    /**
     * The rows this pass changed, the open turn included (as still running,
     * so what was asked is found before the turn ends), and the session's
     * facts. Clears what it gives.
     */
    take() {
        const rows = [...this.ended.values()];
        this.ended.clear();
        const open = this.state.open;
        if (open) rows.push(rowOf(open, { done: false }));
        const s = this.state;
        const header = s.header ?? { id: '', cwd: '', created: 0, seeded: false, depth: 0 };
        const meta = {
            session: header.id,
            title: s.title || s.first,
            folder: header.cwd,
            model: s.model,
            created: header.created,
            updated: s.last,
            turns: s.count + (open ? 1 : 0),
            subagent: header.depth > 0,
        };
        this.touched = false;
        return { rows, meta };
    }
}
