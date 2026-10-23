/**
 * Coding-agent transcripts (JSON lines), read into turns like DSH's own
 * sessions. A turn starts at each message the person wrote; the replies and
 * tool calls after it, up to the next one, are its own.
 *
 * Three line shapes are read, as coding agents write them:
 *
 * - message lines: `{ type: "user" | "assistant", message: { role, content, model? }, cwd?, sessionId?, timestamp? }`,
 *   the content a string or blocks (`text`, `tool_use` with `name` and `input`, `tool_result`, …);
 * - payload lines: `{ type: "response_item", payload: { type: "message", role, content } }`, tool calls as
 *   `payload.type` `function_call` / `custom_tool_call` / `local_shell_call`, with `session_meta` and
 *   `turn_context` lines giving the folder, the session id and the model;
 * - plain lines: `{ role, content }`.
 *
 * A user message with no text of its own (only tool results) does not start
 * a turn, nor does one that is a single block of injected context
 * (`<tag>…</tag>`). Any other line is skipped. Lines too long to be a
 * person's message (tool output) are skipped from their first bytes.
 *
 * @module dsh-plugin-recall/transcripts
 */
import { textOf } from './sessionlog.js';
import { addPrompt, addReply, addTool, newTurn, rowOf, titleLine } from './turns.js';

/** Past this, a line is tool output or an attachment, not a message to read. */
const LONG_LINE = 256 * 1024;

/** A transcript reader's state before the first line. */
export function newTranscriptState() {
    return { v: 1, session: '', cwd: '', title: '', model: '', open: undefined, count: 0, first: '', last: 0, bad: 0 };
}

/** A message that is one injected block of context (`<environment>…</environment>`), not the person's words. */
const INJECTED = /^<([A-Za-z][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/;

const timeOf = (value) => {
    if (Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
    if (typeof value !== 'string') return 0;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
};

/** The person's words in a user message: text blocks only (never tool results), and not injected context. */
function promptText(content) {
    const text = textOf(content).trim();
    if (!text || INJECTED.test(text)) return '';
    return text;
}

export class TranscriptLog {
    /** @param {object} [state] - from an earlier pass. */
    constructor(state) {
        this.state = state && state.v === 1 ? state : newTranscriptState();
        this.ended = [];
    }

    /** Read one line; `lineNo` is its line number in the file (from 1). */
    line(text, lineNo = 0) {
        if (!text || text.charCodeAt(0) !== 123) return;
        if (text.length > LONG_LINE) {
            const head = text.slice(0, 400);
            if (!/"(?:user|assistant)"/.test(head) || /tool_result|function_call_output|"toolUseResult"/.test(head)) return;
        }
        let o;
        try {
            o = JSON.parse(text);
        } catch {
            this.state.bad += 1;
            return;
        }
        if (!o || typeof o !== 'object' || Array.isArray(o)) return;
        const s = this.state;
        const at = timeOf(o.timestamp ?? o.time);
        if (at > s.last) s.last = at;
        if (typeof o.cwd === 'string' && o.cwd) s.cwd = o.cwd;
        const sid = o.sessionId ?? o.session_id;
        if (typeof sid === 'string' && sid && !s.session) s.session = sid.slice(0, 200);

        if (o.type === 'summary' && typeof o.summary === 'string') {
            s.title = titleLine(o.summary);
            return;
        }
        if (o.type === 'session_meta' || o.type === 'turn_context') {
            const p = o.payload ?? {};
            if (typeof p.cwd === 'string' && p.cwd) s.cwd = p.cwd;
            if (typeof p.id === 'string' && p.id && !s.session) s.session = p.id.slice(0, 200);
            if (typeof p.model === 'string' && p.model) {
                s.model = p.model;
                if (s.open) s.open.model = p.model;
            }
            const t = timeOf(p.timestamp);
            if (t > s.last) s.last = t;
            return;
        }
        if (o.type === 'response_item' && o.payload && typeof o.payload === 'object') {
            const p = o.payload;
            if (p.type === 'message') this.message(p.role, p.content, { at, lineNo });
            else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
                if (s.open) addTool(s.open, p.name, p.arguments ?? p.input);
            } else if (p.type === 'local_shell_call') {
                if (s.open) addTool(s.open, 'shell', p.action ?? {});
            }
            return;
        }
        if ((o.type === 'user' || o.type === 'assistant') && o.message && typeof o.message === 'object') {
            if (o.isMeta === true || o.isSidechain === true) return;
            this.message(o.message.role ?? o.type, o.message.content, { at, lineNo, model: o.message.model });
            return;
        }
        if ((o.role === 'user' || o.role === 'assistant') && o.content !== undefined) {
            this.message(o.role, o.content, { at, lineNo, model: o.model });
        }
    }

    /** One message: a person's message starts a turn; an assistant's adds its text and calls to the open one. */
    message(role, content, { at, lineNo, model }) {
        const s = this.state;
        if (role === 'user') {
            const words = promptText(content);
            if (!words) return;
            if (s.open) this.close();
            // A message with no time of its own takes the latest time before it in the file (the indexer gives
            // one with none at all the file's modified time).
            s.open = newTurn({ turn: s.count + 1, time: at || s.last, line: lineNo, model: s.model });
            addPrompt(s.open, words);
            if (!s.first) s.first = titleLine(words.split('\n').find((l) => l.trim()) ?? '');
            return;
        }
        if (role !== 'assistant' || !s.open) return;
        if (typeof model === 'string' && model && !model.startsWith('<')) {
            s.model = model;
            s.open.model = model;
        }
        addReply(s.open, textOf(content));
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block && block.type === 'tool_use' && typeof block.name === 'string') addTool(s.open, block.name, block.input);
            }
        }
        if (at > s.open.end) s.open.end = at;
    }

    close() {
        const s = this.state;
        if (!s.open) return;
        s.open.status = 'completed';
        this.ended.push(rowOf(s.open, { done: true }));
        s.count += 1;
        s.open = undefined;
    }

    /** The rows this pass changed (the open turn included) and the transcript's facts. Clears what it gives. */
    take() {
        const rows = this.ended.splice(0);
        const s = this.state;
        if (s.open) rows.push(rowOf(s.open, { done: false }));
        return {
            rows,
            meta: { session: s.session, title: s.title || s.first, folder: s.cwd, model: s.model, created: 0, updated: s.last, turns: s.count + (s.open ? 1 : 0), subagent: false },
        };
    }
}
