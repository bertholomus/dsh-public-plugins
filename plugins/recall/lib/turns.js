/**
 * One turn as Recall indexes it, whatever log it came from: the person's
 * words, the replies, and one line per tool call with its key argument,
 * each bounded so one runaway turn cannot swell the index.
 *
 * A turn being read is plain data (it is saved with the file's read state
 * between passes); `rowOf` gives the row the index stores.
 *
 * @module dsh-plugin-recall/turns
 */

/** How much of a turn Recall keeps, in characters. */
export const LIMITS = Object.freeze({
    prompt: 6000,
    /** Replies: the start, and the end (where an answer usually is). */
    replyHead: 3000,
    replyTail: 9000,
    tools: 4000,
    toolLines: 60,
    toolLine: 300,
    title: 200,
});

/** A turn just started. */
export function newTurn({ turn, seq = 0, time = 0, line = 0, model = '', provider = '' }) {
    return { turn, seq, time, end: 0, line, status: 'running', why: '', model, provider, prompt: '', head: '', tail: '', cut: false, tools: '', toolCount: 0 };
}

const clean = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();

/** Add the person's words (or a plugin's message to the agent). */
export function addPrompt(turn, text) {
    const words = clean(text);
    if (!words || turn.prompt.length >= LIMITS.prompt) return;
    const joined = turn.prompt ? `${turn.prompt}\n\n${words}` : words;
    turn.prompt = joined.length > LIMITS.prompt ? `${joined.slice(0, LIMITS.prompt - 1)}…` : joined;
}

/** Add reply text: the first LIMITS.replyHead characters, then a rolling LIMITS.replyTail. */
export function addReply(turn, text) {
    let words = clean(text);
    if (!words) return;
    if (turn.head.length < LIMITS.replyHead && turn.tail === '') {
        const joined = turn.head ? `${turn.head}\n\n${words}` : words;
        if (joined.length <= LIMITS.replyHead) {
            turn.head = joined;
            return;
        }
        turn.head = joined.slice(0, LIMITS.replyHead);
        words = joined.slice(LIMITS.replyHead);
    } else {
        words = `\n\n${words}`;
    }
    const tail = turn.tail + words;
    if (tail.length > LIMITS.replyTail) {
        turn.tail = tail.slice(tail.length - LIMITS.replyTail);
        turn.cut = true;
    } else {
        turn.tail = tail;
    }
}

/** The argument that says what a call did: the command, the path, the pattern, the address or the query. */
const KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'name', 'message'];

/** One call's line: its name and its key argument. */
export function toolLine(name, args) {
    let value = args;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { /* a plain string argument */ }
    }
    let key = '';
    if (typeof value === 'string') key = value;
    else if (value && typeof value === 'object') {
        for (const k of KEYS) {
            const v = value[k];
            if (typeof v === 'string' && v.trim()) { key = v; break; }
            if (Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === 'string')) { key = v.join(' '); break; }
        }
        if (!key) {
            const first = Object.values(value).find((v) => typeof v === 'string' && v.trim());
            if (first) key = first;
        }
    }
    const line = `${String(name || 'tool')}${key ? `: ${key.replace(/\s+/g, ' ').trim()}` : ''}`;
    return line.length > LIMITS.toolLine ? `${line.slice(0, LIMITS.toolLine - 1)}…` : line;
}

/** Add one tool call. */
export function addTool(turn, name, args) {
    turn.toolCount += 1;
    if (turn.toolCount > LIMITS.toolLines || turn.tools.length >= LIMITS.tools) return;
    const line = toolLine(name, args);
    const joined = turn.tools ? `${turn.tools}\n${line}` : line;
    turn.tools = joined.length > LIMITS.tools ? joined.slice(0, LIMITS.tools) : joined;
}

/** The reply as the index keeps it: its start, and its end when it was longer. */
export function replyOf(turn) {
    if (!turn.tail) return turn.head;
    return `${turn.head}${turn.cut ? '\n…\n' : ''}${turn.tail}`;
}

/** The row the index stores for a turn. */
export function rowOf(turn, { done = turn.status !== 'running' } = {}) {
    const more = turn.toolCount > LIMITS.toolLines ? `\n… and ${turn.toolCount - LIMITS.toolLines} more calls` : '';
    return {
        turn: turn.turn,
        seq: turn.seq,
        time: turn.time,
        end: turn.end,
        line: turn.line,
        status: done ? (turn.status === 'running' ? 'done' : turn.status) : 'running',
        why: done ? String(turn.why ?? '') : '',
        model: turn.model,
        provider: turn.provider,
        label: '',
        prompt: turn.prompt,
        reply: replyOf(turn),
        tools: `${turn.tools}${more}`,
    };
}

/** A title as the page shows it: one line, at most LIMITS.title characters. */
export function titleLine(text) {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim();
    return line.length > LIMITS.title ? `${line.slice(0, LIMITS.title - 1)}…` : line;
}
