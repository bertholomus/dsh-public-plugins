/**
 * Reading a coding agent's own transcript: what it was told, what it did,
 * and what it answered. Two kinds of file are read, named by how they are
 * written, never by who writes them:
 *
 * - `messages`: one JSON line per message (`type` user or assistant, with a
 *   `message` whose `content` is text or a list of text, tool_use and
 *   tool_result parts);
 * - `events`: one JSON line per event (`type` session_meta, response_item,
 *   event_msg, with a `payload`).
 *
 * Every line becomes zero or more plain entries; the fold turns entries
 * into what the agent is doing now. Nothing here throws on a line it does
 * not know: it is skipped.
 *
 * @module dsh-plugin-agent-terminals/transcripts
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { askIn } from './shared/words.js';

/** @typedef {{ kind: 'user' | 'reply' | 'call' | 'result' | 'start' | 'end' | 'meta' | 'approval', at: number, text?: string, final?: boolean, callId?: string, tool?: string, summary?: string, id?: string, cwd?: string }} Entry */

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const timeOf = (value, fallback) => {
    const at = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
    return Number.isFinite(at) ? at : fallback;
};

/** Context a CLI puts into the conversation as a user message (`<environment_context>…</environment_context>`): not the person's words. */
const WRAPPED = /^\s*<([a-z][\w-]*)>[\s\S]*<\/\1>\s*$/i;
/** Local command echoes some CLIs log as user messages. */
const COMMAND_ECHO = /^\s*<(?:command|local-command)-[\w-]+>/i;

const textOf = (content, types) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((part) => isRecord(part) && types.includes(part.type) && typeof part.text === 'string').map((part) => part.text).join('\n');
};

/** A tool call's input in a few words (the command it runs, a file it touches). */
export function callSummary(input) {
    let value = input;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return value.slice(0, 160);
        }
    }
    if (!isRecord(value)) return '';
    const command = value.command ?? value.cmd;
    if (Array.isArray(command)) {
        const last = command.at(-1);
        return String(command.length >= 3 && /^-\w*c$/.test(String(command[1])) ? last : command.join(' ')).slice(0, 160);
    }
    if (typeof command === 'string') return command.slice(0, 160);
    for (const key of ['file_path', 'path', 'url', 'pattern', 'query', 'description']) {
        if (typeof value[key] === 'string') return value[key].slice(0, 160);
    }
    return '';
}

/**
 * The entries in one transcript line.
 * @param {'messages' | 'events'} format
 * @param {unknown} line - the parsed JSON line.
 * @param {number} [fallbackAt] - when the line has no time of its own.
 * @returns {Entry[]}
 */
export function entriesOf(format, line, fallbackAt = 0) {
    if (!isRecord(line)) return [];
    try {
        return format === 'events' ? eventEntries(line, fallbackAt) : messageEntries(line, fallbackAt);
    } catch {
        return [];
    }
}

function messageEntries(line, fallbackAt) {
    const at = timeOf(line.timestamp, fallbackAt);
    if (line.isMeta === true || line.isSidechain === true) return [];
    const message = line.message;
    if (!isRecord(message)) return [];
    const out = [];
    if (line.type === 'user') {
        if (typeof message.content === 'string') {
            if (!COMMAND_ECHO.test(message.content) && !WRAPPED.test(message.content)) out.push({ kind: 'user', at, text: message.content });
            return out;
        }
        if (!Array.isArray(message.content)) return out;
        for (const part of message.content) {
            if (!isRecord(part)) continue;
            if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') out.push({ kind: 'result', at, callId: part.tool_use_id });
        }
        const text = textOf(message.content, ['text']);
        if (text.trim() && !COMMAND_ECHO.test(text) && !WRAPPED.test(text)) out.push({ kind: 'user', at, text });
        return out;
    }
    if (line.type === 'assistant') {
        const parts = Array.isArray(message.content) ? message.content : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [];
        let calls = 0;
        for (const part of parts) {
            if (!isRecord(part) || part.type !== 'tool_use' || typeof part.id !== 'string') continue;
            calls += 1;
            out.push({ kind: 'call', at, callId: part.id, tool: String(part.name ?? 'a tool'), summary: callSummary(part.input) });
        }
        const text = textOf(parts, ['text']);
        if (text.trim()) out.push({ kind: 'reply', at, text, final: calls === 0 && message.stop_reason === 'end_turn' });
        return out;
    }
    return out;
}

function eventEntries(line, fallbackAt) {
    const at = timeOf(line.timestamp, fallbackAt);
    const payload = line.payload;
    if (!isRecord(payload)) return [];
    if (line.type === 'session_meta') {
        return [{ kind: 'meta', at, ...(typeof payload.id === 'string' ? { id: payload.id } : {}), ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}) }];
    }
    if (line.type === 'response_item') {
        switch (payload.type) {
            case 'message': {
                if (payload.role === 'user') {
                    const text = textOf(payload.content, ['input_text', 'text']);
                    return text.trim() && !WRAPPED.test(text) ? [{ kind: 'user', at, text }] : [];
                }
                if (payload.role === 'assistant') {
                    const text = textOf(payload.content, ['output_text', 'text']);
                    return text.trim() ? [{ kind: 'reply', at, text, final: false }] : [];
                }
                return [];
            }
            case 'function_call':
            case 'custom_tool_call':
            case 'local_shell_call': {
                const callId = payload.call_id ?? payload.id;
                return typeof callId === 'string' ? [{ kind: 'call', at, callId, tool: String(payload.name ?? 'shell'), summary: callSummary(payload.arguments ?? payload.input ?? payload.action) }] : [];
            }
            case 'function_call_output':
            case 'custom_tool_call_output':
            case 'local_shell_call_output':
                return typeof payload.call_id === 'string' ? [{ kind: 'result', at, callId: payload.call_id }] : [];
            default:
                return [];
        }
    }
    if (line.type === 'event_msg') {
        switch (payload.type) {
            case 'task_started':
                return [{ kind: 'start', at }];
            case 'task_complete':
                return [{ kind: 'end', at, final: true, ...(typeof payload.last_agent_message === 'string' ? { text: payload.last_agent_message } : {}) }];
            case 'turn_aborted':
                return [{ kind: 'end', at, final: false }];
            case 'exec_approval_request':
            case 'apply_patch_approval_request':
                return [{ kind: 'approval', at, ...(typeof payload.call_id === 'string' ? { callId: payload.call_id } : {}), summary: callSummary(payload.command ? { command: payload.command } : payload) }];
            default:
                return [];
        }
    }
    return [];
}

// ── The fold ────────────────────────────────────────────────────────────

/**
 * What a transcript says so far. Plain data, so it can be saved.
 * `activeAt` and `last` are the time and kind of its last entry that was
 * work (not meta); `cut` is a job its program ended in the middle of
 * (see closeOver).
 * @typedef {{ turns: number, lastAt: number, activeAt?: number, last?: string, user?: { at: number, text: string }, reply?: { at: number, text: string, final: boolean }, calls: Record<string, { at: number, tool: string, summary: string }>, approval?: { at: number, summary: string, callId?: string }, ended: boolean, cut?: { at: number, text: string }, id?: string, cwd?: string, users: Array<{ at: number, text: string }> }} Fold
 */

/** Messages kept for proof: the last few the agent was told. */
const KEEP_USERS = 12;

export function emptyFold() {
    return { turns: 0, lastAt: 0, calls: {}, ended: false, users: [] };
}

/**
 * Fold one entry in. Returns a new object when something changed.
 * @param {Fold} fold
 * @param {Entry} entry
 * @returns {Fold}
 */
export function foldEntry(fold, entry) {
    const next = { ...fold, calls: { ...fold.calls }, lastAt: Math.max(fold.lastAt, entry.at || 0) };
    if (entry.kind !== 'meta') {
        next.activeAt = Math.max(fold.activeAt ?? 0, entry.at || 0);
        next.last = entry.kind;
        // New work after a job was cut off: that job is history now.
        if (fold.cut && entry.kind !== 'end') next.cut = undefined;
    }
    switch (entry.kind) {
        case 'meta':
            if (entry.id) next.id = entry.id;
            if (entry.cwd) next.cwd = entry.cwd;
            return next;
        case 'user': {
            // The same words twice within a moment are one message logged two ways.
            const last = fold.users.at(-1);
            if (last && last.text === entry.text && Math.abs(entry.at - last.at) < 3000) return next;
            next.turns += 1;
            next.user = { at: entry.at, text: entry.text };
            next.users = [...fold.users, { at: entry.at, text: entry.text }].slice(-KEEP_USERS);
            next.reply = undefined;
            next.ended = false;
            next.approval = undefined;
            return next;
        }
        case 'start':
            next.ended = false;
            return next;
        case 'call':
            next.calls[entry.callId] = { at: entry.at, tool: entry.tool ?? 'a tool', summary: entry.summary ?? '' };
            next.ended = false;
            return next;
        case 'result':
            delete next.calls[entry.callId];
            if (next.approval && (!next.approval.callId || next.approval.callId === entry.callId)) next.approval = undefined;
            return next;
        case 'approval':
            next.approval = { at: entry.at, summary: entry.summary ?? '', ...(entry.callId ? { callId: entry.callId } : {}) };
            return next;
        case 'reply': {
            // A reply after another one in the same step is the same answer, said in parts.
            const same = fold.reply && !fold.reply.final && entry.at - fold.reply.at < 2000;
            next.reply = { at: entry.at, text: same ? `${fold.reply.text}\n${entry.text}` : entry.text, final: entry.final === true };
            if (entry.final) {
                next.ended = true;
                next.calls = {};
            }
            return next;
        }
        case 'end':
            next.ended = true;
            next.calls = {};
            next.approval = undefined;
            if (entry.text && !(fold.reply && fold.reply.text.trim() === entry.text.trim())) next.reply = { at: entry.at, text: entry.text, final: true };
            else if (next.reply) next.reply = { ...next.reply, final: true };
            return next;
        default:
            return fold;
    }
}

/** Kinds of entry after which a job is still going: its answer has not come. */
const MID_JOB = new Set(['user', 'start', 'call', 'result', 'approval']);

/**
 * Close what a transcript left open when its program ended: a DSH restart
 * or a stop ends the process, so its tool calls and its approval prompt are
 * gone, and a job it was in the middle of is over (`cut`, with its words),
 * so the agent reads idle in its resumed conversation instead of working for
 * ever. Entries at or after `before` belong to the program running now and
 * stay as they are. Returns the same object when nothing was open.
 * @param {Fold} fold
 * @param {number} [before] - when the program started again (Infinity: everything read so far is from before).
 * @returns {Fold}
 */
export function closeOver(fold, before = Infinity) {
    if (!fold) return fold;
    const old = (at) => !(at >= before);
    const calls = Object.fromEntries(Object.entries(fold.calls).filter(([, call]) => !old(call.at)));
    const dropped = Object.keys(calls).length !== Object.keys(fold.calls).length;
    const approval = fold.approval && old(fold.approval.at) ? undefined : fold.approval;
    const midJob = fold.turns > 0 && !fold.ended && MID_JOB.has(fold.last) && old(fold.activeAt ?? fold.lastAt);
    if (!dropped && approval === fold.approval && !midJob) return fold;
    const next = { ...fold, calls, approval };
    if (midJob) {
        next.ended = true;
        next.cut = { at: fold.activeAt ?? fold.lastAt, text: fold.user?.text ?? '' };
    }
    return next;
}

/**
 * What the agent is doing, from its transcript and its terminal.
 * @param {Fold | undefined} fold
 * @param {{ now: number, settleMs?: number, askAfterMs?: number, exited?: boolean, transcript?: boolean }} options
 * @returns {{ status: 'starting' | 'working' | 'idle' | 'waiting on you' | 'stopped' | 'running', detail?: string, ask?: object, call?: object }}
 */
export function statusOf(fold, { now, settleMs = 4000, askAfterMs = 20000, exited = false, transcript = true }) {
    if (exited) return { status: 'stopped' };
    if (!transcript) return { status: 'running' };
    if (!fold || (fold.turns === 0 && !fold.reply)) return { status: 'starting' };
    if (fold.approval) {
        return { status: 'waiting on you', detail: `It asks to run ${fold.approval.summary ? `“${fold.approval.summary}”` : 'a command'}: answer in its terminal.`, call: { ...fold.approval, approval: true } };
    }
    const pending = Object.entries(fold.calls).sort((a, b) => a[1].at - b[1].at);
    if (pending.length) {
        const [callId, call] = pending[0];
        if (now - call.at >= askAfterMs) {
            // Said in steps (then whole minutes), so the line does not change, and go out again, every few seconds.
            const waited = now - call.at < 60000 ? `${Math.round(askAfterMs / 1000)} s or more` : `${Math.floor((now - call.at) / 60000)} min`;
            return { status: 'waiting on you', detail: `${call.tool}${call.summary ? ` “${call.summary}”` : ''} has waited ${waited} for its result: it may be asking you in its terminal.`, call: { callId, ...call } };
        }
        return { status: 'working', detail: `Running ${call.tool}${call.summary ? `: ${call.summary}` : ''}` };
    }
    const reply = fold.reply;
    // Its last job was cut off when its program ended, and nothing came after: idle, and why.
    if (fold.cut && !(reply && reply.at > fold.cut.at)) {
        return { status: 'idle', detail: `Its job ${fold.cut.text ? `“${oneLine(fold.cut.text, 80)}” ` : ''}was cut off when its program ended (a DSH restart, or a stop). Send it a message to carry on.`, cut: true };
    }
    const settled = reply && (reply.final || fold.ended || now - Math.max(reply.at, fold.lastAt) >= settleMs);
    if (!reply || !settled) return { status: 'working', ...(fold.user ? { detail: `On: ${oneLine(fold.user.text, 80)}` } : {}) };
    const ask = askIn(reply.text);
    if (ask && ask.soft !== true) return { status: 'waiting on you', detail: oneLine(ask.question, 160), ask };
    return { status: 'idle', detail: oneLine(reply.text, 120) };
}

export const oneLine = (text, max) => {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// ── Proof ───────────────────────────────────────────────────────────────

const squeeze = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Whether the agent was told this message at or after `since`: its own
 * transcript holds a user message with the same words (the first 160
 * characters, spaces squeezed, so a CLI that trims or wraps still counts).
 */
export function provenIn(fold, text, since) {
    const want = squeeze(text).slice(0, 160);
    if (!want) return undefined;
    return (fold?.users ?? []).find((user) => user.at >= since - 2000 && squeeze(user.text).includes(want));
}

// ── Reading a file as it grows ──────────────────────────────────────────

/**
 * New whole lines of a file since the last read, by byte offset. A file
 * that shrank (rewritten) is read again from the start.
 */
export class Tail {
    constructor(path, { maxBytes = 4 * 1024 * 1024 } = {}) {
        this.path = path;
        this.offset = 0;
        this.rest = '';
        this.maxBytes = maxBytes;
    }

    /** @returns {{ lines: string[], reset: boolean }} */
    read() {
        let fd;
        try {
            fd = openSync(this.path, 'r');
        } catch {
            return { lines: [], reset: false };
        }
        try {
            const size = fstatSync(fd).size;
            let reset = false;
            if (size < this.offset) {
                this.offset = 0;
                this.rest = '';
                reset = true;
            }
            // A transcript far bigger than what matters now: read only its end.
            if (this.offset === 0 && size > this.maxBytes) {
                this.offset = size - this.maxBytes;
                // Cut inside a line: drop that part. Cut right after a line break: keep the whole line.
                const before = Buffer.alloc(1);
                readSync(fd, before, 0, 1, this.offset - 1);
                this.skipFirst = before[0] !== 0x0a;
            }
            if (size === this.offset) return { lines: [], reset };
            const buffer = Buffer.alloc(size - this.offset);
            const read = readSync(fd, buffer, 0, buffer.length, this.offset);
            this.offset += read;
            const text = this.rest + buffer.subarray(0, read).toString('utf8');
            const lines = text.split('\n');
            this.rest = lines.pop() ?? '';
            if (this.skipFirst && lines.length > 0) {
                lines.shift();
                this.skipFirst = false;
            }
            return { lines: lines.filter((line) => line.trim() !== ''), reset };
        } finally {
            closeSync(fd);
        }
    }
}

/**
 * Parse lines into entries, skipping what is not JSON.
 * @param {'messages' | 'events'} format
 * @param {string[]} lines
 */
export function parseLines(format, lines, fallbackAt = Date.now()) {
    const out = [];
    for (const line of lines) {
        let value;
        try {
            value = JSON.parse(line);
        } catch {
            continue;
        }
        out.push(...entriesOf(format, value, fallbackAt));
    }
    return out;
}
