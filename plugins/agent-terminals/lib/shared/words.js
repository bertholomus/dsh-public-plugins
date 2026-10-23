/**
 * The suite's words for sessions, one set on every surface (DESIGN.md §9):
 * what state a session is in, whether its last reply asks a person
 * something, and times in plain words.
 *
 * @module suite/shared/words
 */

/**
 * A model or provider error in plain words: DSH passes on the provider's
 * answer as it came (`400: {"error":{"message":"…"}}`), and a person needs
 * its message, not its JSON.
 * @param {unknown} text
 */
export function plainError(text) {
    const raw = String(text ?? '').trim();
    const json = /^(?:(\d{3})\s*:?\s*)?(\{[\s\S]*\})$/.exec(raw);
    if (json) {
        try {
            const body = JSON.parse(json[2]);
            const message = body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : undefined);
            if (typeof message === 'string' && message.trim() !== '') return json[1] ? `${json[1]}: ${message.trim()}` : message.trim();
        } catch {}
    }
    return raw;
}

/** Whether a turn end means DSH stopped under a running turn (a restart, a crash, a reload). */
export function cutOff(end) {
    return Boolean(end) && (end.kind === 'interrupted' || (end.kind === 'aborted' && end.cause === 'disposed'));
}

/**
 * One word (or short phrase) for a session's state.
 * @param {{ status?: string, blank?: boolean, external?: { status: string }, state?: object | null }} row
 */
export function stateWord(row) {
    if (!row) return 'unknown';
    if (row.external?.status) return row.external.status;
    const state = row.state ?? {};
    if (row.status === 'running') return state.approvals?.length ? 'waiting for approval' : state.asking ? 'waiting for your answer' : 'running';
    if (state.open) return 'cut off';
    const end = state.end;
    if (!end) return row.blank ? 'new' : 'idle';
    if (cutOff(end)) return 'cut off';
    if (end.kind === 'error') return 'failed';
    if (end.kind === 'aborted') return 'stopped';
    if (end.kind === 'blocked') return 'blocked';
    if (end.kind === 'max-tokens') return 'cut short';
    return 'idle';
}

/**
 * A line as a person reads it: the bold and code marks a model puts around
 * words (`**DECISION NEEDED:**`, `*Monday*`, `\`main\``) dropped. Marks
 * inside a word (`file_name`) stay.
 */
export function plainLine(line) {
    return String(line)
        .replace(/\*\*|__|`+/g, '')
        .replace(/(^|\s)[*_](?=\S)/g, '$1')
        .replace(/(?<=\S)[*_](?=\s|$|[.,:;!?)])/g, '');
}

/*
 * The suite's markers, as models write them:
 *   DECISION NEEDED: <question> — recommend: <pick>
 *   BLOCKED: <what is missing>
 * A marker counts at the start of any line (after a quote mark, a bullet,
 * a list number or a heading mark; bold and code marks are dropped first),
 * and, in the reply's last lines, also after the end of a sentence:
 * "…without valid credentials. BLOCKED: working staging credentials." A
 * marker inside a sentence ("the request was BLOCKED: by policy") is not
 * one. DECISION NEEDED is read in any case; BLOCKED only in capitals.
 */

/** How many of a reply's last non-empty lines may carry a marker after a sentence's end. */
const MARKER_TAIL = 6;

/** What may start a line before a marker: quote marks, a bullet, a list number, a heading mark. */
const LEAD = String.raw`[\s>*_\`#-]*(?:\d{1,3}[.)]\s+)?`;

/** The end of a sentence before an inline marker: a full stop, ! or ?, any closing quote or bracket, then a space. */
const SENTENCE_END = String.raw`[.!?。！？]["'”’)\]]*\s+`;

/** The words after the last marker in a line, or undefined when the line has none. */
function afterMarker(line, marker, { anyCase, inline }) {
    const pattern = new RegExp(`(?:^${LEAD}${inline ? `|${SENTENCE_END}` : ''})${marker}\\s*[:：]\\s*`, anyCase ? 'gi' : 'g');
    let rest;
    for (const match of line.matchAll(pattern)) rest = line.slice(match.index + match[0].length);
    return rest;
}

/** Where a reply's last lines (the ones that may carry an inline marker) begin. */
function tailStart(lines) {
    let left = MARKER_TAIL;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].trim() !== '') left -= 1;
        if (left === 0) return i;
    }
    return 0;
}

/** Text with the marks a model leaves at its ends dropped. */
const trimMarks = (text) => String(text ?? '').replace(/^[\s*_`]+|[\s*_`]+$/g, '');

/** A recommendation as a card shows it: no closing full stop. */
const pickWords = (text) => trimMarks(text).replace(/(?<![.])\.$/, '').trim();

/** A recommendation after the question: "— recommend: …" (a dash, "--" or a hyphen), or a sentence "Recommend: …" / "I recommend …". */
function splitRecommendation(rest) {
    const dashed = /^(.+?)\s*(?:—|–|--|-)\s*recommend(?:ation|ed)?\s*[:：]\s*(.+)$/i.exec(rest);
    if (dashed) return [dashed[1], dashed[2]];
    const sentence = /^(.+?[.?!])\s+(?:recommend(?:ation|ed)?\s*[:：]|my recommendation(?: is)?\s*[:：]?|I(?:['’]d| would)? recommend\b\s*[:：]?)\s*(.+)$/i.exec(rest);
    if (sentence) return [sentence[1], sentence[2]];
    return [rest, undefined];
}

/** A recommendation on the line after a decision line: `Recommend: <pick>`. */
const RECOMMEND_LINE = /^[\s>*_`-]*recommend(?:ation|ed)?\s*[:：]\s*(.+?)\s*$/i;

/** The question and recommendation of the last decision line in a text, or undefined. */
export function decisionIn(text) {
    if (typeof text !== 'string' || !/DECISION NEEDED/i.test(text)) return undefined;
    const lines = text.split('\n').map(plainLine);
    const tail = tailStart(lines);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const rest = afterMarker(lines[i], 'DECISION NEEDED', { anyCase: true, inline: i >= tail });
        if (rest === undefined) continue;
        const [asked, picked] = splitRecommendation(trimMarks(rest));
        const question = trimMarks(asked);
        if (!question) continue;
        // Some write the recommendation on the next line.
        const next = picked ? undefined : lines.slice(i + 1).find((line) => line.trim() !== '');
        const recommendation = pickWords(picked ?? (next ? RECOMMEND_LINE.exec(next)?.[1] : ''));
        return { question, ...(recommendation ? { recommendation } : {}) };
    }
    return undefined;
}

/**
 * A recommendation said at the end of free text (a thread's handback, say),
 * split from what is asked: "Which port? Recommendation: 8080 — it is
 * free." gives the question "Which port?" and the recommendation "8080 —
 * it is free". Only the last line is read, where a handback puts what it
 * needs; undefined when it recommends nothing.
 */
export function recommendationIn(text) {
    if (typeof text !== 'string' || !/recommend/i.test(text)) return undefined;
    const lines = text.trim().split('\n');
    const last = plainLine(lines.at(-1) ?? '');
    const before = lines.slice(0, -1).join('\n').trim();
    const own = RECOMMEND_LINE.exec(last);
    if (own) {
        const recommendation = pickWords(own[1]);
        return before && recommendation ? { question: before, recommendation } : undefined;
    }
    const [asked, picked] = splitRecommendation(trimMarks(last));
    const recommendation = pickWords(picked ?? '');
    const question = [before, trimMarks(asked)].filter(Boolean).join('\n');
    return recommendation && question ? { question, recommendation } : undefined;
}

/** The text of the last BLOCKED marker in a text, or undefined. */
export function blockedIn(text) {
    if (typeof text !== 'string' || !/BLOCKED/.test(text)) return undefined;
    const lines = text.split('\n').map(plainLine);
    const tail = tailStart(lines);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const rest = trimMarks(afterMarker(lines[i], 'BLOCKED', { anyCase: false, inline: i >= tail }));
        if (rest) return rest;
    }
    return undefined;
}

/** Longest question an `askIn` result keeps. */
const ASK_MAX = 400;

const cutAsk = (text) => {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > ASK_MAX ? `${flat.slice(0, ASK_MAX - 1)}…` : flat;
};

/**
 * What a reply's end asks a person, if anything: a decision line (with its
 * recommendation), a BLOCKED line, or a plain question (the last sentence
 * that asks). A decision line wins over a BLOCKED line, which wins over a
 * plain question.
 * @returns {{ kind: 'decision', question: string, recommendation?: string } | { kind: 'blocked', question: string } | { kind: 'question', question: string } | undefined}
 */
export function askIn(text) {
    if (typeof text !== 'string' || text.trim() === '') return undefined;
    const decision = decisionIn(text);
    if (decision) return { kind: 'decision', question: cutAsk(decision.question), ...(decision.recommendation ? { recommendation: cutAsk(decision.recommendation) } : {}) };
    const blocked = blockedIn(text);
    if (blocked) return { kind: 'blocked', question: cutAsk(blocked) };
    if (!asksSomeone(text)) return undefined;
    const lines = text.trim().split('\n').map((line) => line.replace(/^[\s>*_`#-]+|[\s*_`]+$/g, '').trim()).filter(Boolean);
    const tail = lines.slice(-6);
    // The last sentence with a question mark; else the last line that asks for the person's word
    // ("It needs your decision on the port."), not a closing line such as "Reply here and I'll pass it on.".
    const asking = [...tail].reverse().find((line) => line.includes('?'));
    let question;
    if (asking) {
        const sentences = asking.match(/[^.!?]*\?/g);
        question = sentences ? sentences.at(-1).trim() : asking;
    } else {
        const pleading = [...tail].reverse().find((line) => [...ASKS, ...OFFERS].some((pattern) => pattern.test(line)));
        question = pleading ?? tail.at(-1) ?? '';
    }
    // "Let me know if you want the docs too." offers more without waiting on an answer.
    const soft = !asksForAnswer(text);
    return question ? { kind: 'question', question: cutAsk(question), ...(soft ? { soft: true } : {}) } : undefined;
}

/** Asks that wait on a person's answer. */
const ASKS = [
    /\bDECISION NEEDED\b/i,
    /(?:^[\s>*_`#-]*(?:\d{1,3}[.)]\s+)?|[.!?。！？]["'”’)\]]*\s+)BLOCKED\s*[:：]/m,
    /\b(?:waiting|wait) (?:for|on) (?:your|you)\b/i,
    /\b(?:your call|your decision|need your|needs your|please confirm|can you confirm|could you confirm)\b/i,
    /\b(?:should I|shall I|do you want|would you like|which (?:one|option) (?:do|would) you)\b/i,
];

/** Offers that leave the next step to the person without waiting on them. */
const OFFERS = [
    /\b(?:let me know|if you(?:'d| would)? (?:like|want|prefer)|happy to|feel free)\b/i,
];

/** The last few lines of a reply, where an agent asks. */
const tailOf = (text) => text.trim().split('\n').map((line) => line.trim()).filter(Boolean);

/**
 * Whether a reply's end waits on a person's answer: a decision line, a
 * BLOCKED line, a question at the end, or a plain request for their word
 * (not an offer such as "Let me know if you want more").
 */
export function asksForAnswer(text) {
    if (typeof text !== 'string' || text.trim() === '') return false;
    const lines = tailOf(text);
    if (/\?\s*[*_`)\]]*\s*$/.test(lines.at(-1) ?? '')) return true;
    const tail = lines.slice(-6).join('\n');
    return ASKS.some((pattern) => pattern.test(tail));
}

/**
 * Whether a reply's end asks a person for something: a decision line, a
 * BLOCKED line, a question at the end, a plain request for their word, or
 * an offer that leaves the next step to them ("Let me know if…"). Read
 * from the last few lines only, where an agent asks.
 */
export function asksSomeone(text) {
    if (asksForAnswer(text)) return true;
    if (typeof text !== 'string' || text.trim() === '') return false;
    const tail = tailOf(text).slice(-6).join('\n');
    return OFFERS.some((pattern) => pattern.test(tail));
}

/** "9:41 PM" today, "yesterday 9:41 PM", or "Oct 3, 9:41 PM", in this machine's zone. */
export function timeWords(at, now = Date.now()) {
    if (!Number.isFinite(at) || at <= 0) return 'an unknown time';
    const when = new Date(at);
    const clock = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const day = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const today = new Date(now);
    if (day(when) === day(today)) return clock;
    const yesterday = new Date(now - 86400000);
    if (day(when) === day(yesterday)) return `yesterday ${clock}`;
    return `${when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${clock}`;
}

/** "45 seconds", "10 minutes", "2 hours", "3 days". */
export function spanWords(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
    const m = Math.round(s / 60);
    if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} hour${h === 1 ? '' : 's'}`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'}`;
}

/** "1 open todo", "3 open todos". */
export function count(n, one, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
}
