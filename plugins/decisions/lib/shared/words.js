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

/*
 * Code spans (`parser.py`, ``a`b``) keep their words whole while a line is
 * read: no mark inside one is dropped (`__init__.py`, `a**b`), and no dot
 * or question mark inside one ends a sentence. Each span stands in as one
 * placeholder until the words are given back.
 */

/** A placeholder's ends: control characters a reply never holds (a text that has them is read without placeholders). */
const HOLD_OPEN = '\u0001';
const HOLD_CLOSE = '\u0002';
/** One held code span in a text: its number. */
export const HELD_SPAN = /\u0001(\d+)\u0002/;

/** A code span on one line: a run of backticks, its words, and a run of the same length (Markdown's rule). */
const CODE_SPAN = /(?<!`)(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g;

/** A marker line written in code (`DECISION NEEDED: …`) is read as the line it is. */
const MARKED_CODE = (inner) => /^[\s*_]*DECISION NEEDED\b/i.test(inner) || /^[\s*_]*BLOCKED\b/.test(inner);

/**
 * The text with each code span held as a placeholder: `{ text, spans }`,
 * where `spans[i]` is `{ written, words }` (the span as written, and its
 * words without the backticks).
 */
export function holdCode(text) {
    const value = String(text ?? '');
    const spans = [];
    if (value.includes(HOLD_OPEN) || value.includes(HOLD_CLOSE)) return { text: value, spans };
    const held = value.replace(CODE_SPAN, (written, ticks, inner) => {
        if (MARKED_CODE(inner)) return inner;
        // A space at both ends is Markdown's padding, not part of the words.
        const words = /^ [\s\S]*[^ ][\s\S]* $/.test(inner) ? inner.slice(1, -1) : inner;
        spans.push({ written, words });
        return `${HOLD_OPEN}${spans.length - 1}${HOLD_CLOSE}`;
    });
    return { text: held, spans };
}

/** A held text with its code spans given back: their words (the default), or as written (`written: true`). */
export function unholdCode(text, spans, { written = false } = {}) {
    if (!spans?.length) return String(text ?? '');
    return String(text ?? '').replace(new RegExp(HELD_SPAN.source, 'g'), (whole, n) => {
        const span = spans[Number(n)];
        return span ? (written ? span.written : span.words) : whole;
    });
}

/**
 * The bold, italic and stray code marks dropped from a text whose code
 * spans are held: `**a**` and `*a*` (inside a word too, as Markdown reads
 * them), `__a__` and `_a_` (not inside a word: `my__var` stays), what is
 * left of a `**` or `__` unless it sits inside a word (`a**b`), and a lone
 * backtick.
 */
export function dropMarks(text) {
    return String(text ?? '')
        .replace(/\*\*(?=[^\s*])((?:(?!\*\*).)*?[^\s*])\*\*/g, '$1')
        .replace(/(?<![\p{L}\p{N}])__(?=[^\s_])((?:(?!__).)*?[^\s_])__(?![\p{L}\p{N}])/gu, '$1')
        .replace(/(?<![\p{L}\p{N}])(?:\*\*|__)|(?:\*\*|__)(?![\p{L}\p{N}])/gu, '')
        .replace(/`+/g, '')
        .replace(/(^|\s)[*_](?=\S)/g, '$1')
        .replace(/(?<=\S)[*_](?=\s|$|[.,:;!?)])/g, '');
}

/**
 * A line as a person reads it: the bold and code marks a model puts around
 * words (`**DECISION NEEDED:**`, `*Monday*`, `\`main\``) dropped. Marks
 * inside a word (`file_name`, `my__var`) and everything inside a code span
 * (`__init__.py`, `a**b`) stay.
 */
export function plainLine(line) {
    const { text, spans } = holdCode(String(line));
    return unholdCode(dropMarks(text), spans);
}

/** A fence's line: up to three spaces, then three or more backticks or tildes (an opening one may name a language). */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The text with each closed fenced code block (```…``` or ~~~…~~~) blanked
 * out, line for line: what a reply shows as code (a DECISION NEEDED line
 * quoted from a rules file, a prompt's "Continue?") is not what it asks. A
 * fence that is never closed is read as text.
 */
export function unfenced(text) {
    const lines = String(text ?? '').split('\n');
    let open;
    for (let i = 0; i < lines.length; i += 1) {
        const fence = FENCE.exec(lines[i]);
        if (!fence) continue;
        if (open === undefined) {
            // A backtick fence's language holds no backtick: "```a```" on one line is code inside a line, not a fence.
            if (fence[1][0] === '`' && fence[2].includes('`')) continue;
            open = { at: i, mark: fence[1] };
        } else if (fence[1][0] === open.mark[0] && fence[1].length >= open.mark.length && fence[2].trim() === '') {
            for (let j = open.at; j <= i; j += 1) lines[j] = '';
            open = undefined;
        }
    }
    return lines.join('\n');
}

/** A text's lines with their marks dropped and their code spans held, and how to give a part of them back in words. */
function heldLines(text) {
    const { text: held, spans } = holdCode(text);
    return { lines: held.split('\n').map(dropMarks), words: (part) => unholdCode(part, spans) };
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
 * one, nor is one inside a fenced code block (a rule quoted as an example).
 * DECISION NEEDED is read in any case; BLOCKED only in capitals.
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
    // Code spans are held while the line is read, so `__init__.py` or a `--flag` in one stays whole; a fenced
    // code block is shown, not said, so a marker in one is none.
    const { lines, words } = heldLines(unfenced(text));
    const tail = tailStart(lines);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const rest = afterMarker(lines[i], 'DECISION NEEDED', { anyCase: true, inline: i >= tail });
        if (rest === undefined) continue;
        const [asked, picked] = splitRecommendation(trimMarks(rest));
        const question = words(trimMarks(asked)).trim();
        if (!question) continue;
        // Some write the recommendation on the next line.
        const next = picked ? undefined : lines.slice(i + 1).find((line) => line.trim() !== '');
        const recommendation = words(pickWords(picked ?? (next ? RECOMMEND_LINE.exec(next)?.[1] : ''))).trim();
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
    const { lines: [last = ''], words } = heldLines(lines.at(-1) ?? '');
    const before = lines.slice(0, -1).join('\n').trim();
    const own = RECOMMEND_LINE.exec(last);
    if (own) {
        const recommendation = words(pickWords(own[1])).trim();
        return before && recommendation ? { question: before, recommendation } : undefined;
    }
    const [asked, picked] = splitRecommendation(trimMarks(last));
    const recommendation = words(pickWords(picked ?? '')).trim();
    const question = [before, words(trimMarks(asked)).trim()].filter(Boolean).join('\n');
    return recommendation && question ? { question, recommendation } : undefined;
}

/** The text of the last BLOCKED marker in a text, or undefined. */
export function blockedIn(text) {
    if (typeof text !== 'string' || !/BLOCKED/.test(text)) return undefined;
    const { lines, words } = heldLines(unfenced(text));
    const tail = tailStart(lines);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const rest = words(trimMarks(afterMarker(lines[i], 'BLOCKED', { anyCase: false, inline: i >= tail }))).trim();
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
export function askIn(reply) {
    if (typeof reply !== 'string') return undefined;
    // A fenced code block is shown, not asked: read as blank lines.
    const text = unfenced(reply);
    if (text.trim() === '') return undefined;
    const decision = decisionIn(text);
    if (decision) return { kind: 'decision', question: cutAsk(decision.question), ...(decision.recommendation ? { recommendation: cutAsk(decision.recommendation) } : {}) };
    const blocked = blockedIn(text);
    if (blocked) return { kind: 'blocked', question: cutAsk(blocked) };
    if (!asksSomeone(text)) return undefined;
    // Code spans are held while the lines are read: a dot or a question mark inside one ends nothing.
    const { text: held, spans } = holdCode(text.trim());
    const lines = held.split('\n').map((line) => line.replace(/^[\s>*_`#-]+|[\s*_`]+$/g, '').trim()).filter(Boolean);
    const tail = lines.slice(-6);
    // The last sentence with a question mark; else the last line that asks for the person's word
    // ("It needs your decision on the port."), not a closing line such as "Reply here and I'll pass it on.".
    const asking = [...tail].reverse().find((line) => line.includes('?'));
    let question;
    if (asking) {
        question = lastQuestion(asking);
    } else {
        const pleading = [...tail].reverse().find((line) => [...ASKS, ...OFFERS].some((pattern) => pattern.test(line)));
        question = pleading ?? tail.at(-1) ?? '';
    }
    // The question as the reply wrote it, code spans and all.
    question = unholdCode(question, spans, { written: true });
    // "Let me know if you want the docs too." offers more without waiting on an answer.
    const soft = !asksForAnswer(text);
    return question ? { kind: 'question', question: cutAsk(question), ...(soft ? { soft: true } : {}) } : undefined;
}

/**
 * Where one sentence of a line ends and the next begins: a full stop, ! or
 * ?, any closing quote, bracket or mark, then a space before a capital, an
 * opening quote, bracket or mark, or a code span. So the dot in a file name
 * (`parser.py`), a version (2.0.0), an address (staging.example.com), a
 * number (2.5) or "e.g. with" ends nothing.
 */
const SENTENCE_BREAK = /(?<=[.!?。！？]["'”’)\]*_]*)\s+(?=[\p{Lu}\p{Lt}"'“‘(\[*_\u0001])/u;

/** Words that end in a dot without ending a sentence: "e.g. Postgres", "Dr. Lee". */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|cf|approx|incl|resp|fig|mr|mrs|ms|dr|prof)\.["'”’)\]*_]*$/i;

/** A question that leans on the one before it ("Or should I wait?", "If so, …?"): read with that one. */
const LEANS_BACK = /^["'“‘(\[*_]*(?:or|and|if (?:so|not)|otherwise|else|also)\b/i;

/**
 * The last sentence of a line that asks (it has a question mark), up to its
 * last question mark; with the question before it when it leans on that one
 * ("Should I fix it now? Or wait for the review?").
 */
function lastQuestion(line) {
    const parts = [];
    for (const part of line.split(SENTENCE_BREAK)) {
        if (parts.length && ABBREVIATION.test(parts.at(-1))) parts[parts.length - 1] += ` ${part}`;
        else parts.push(part);
    }
    const last = parts.findLastIndex((part) => part.includes('?'));
    if (last < 0) return line.trim();
    let first = last;
    while (first > 0 && LEANS_BACK.test(parts[first]) && parts[first - 1].includes('?')) first -= 1;
    const asking = parts.slice(first, last + 1).join(' ');
    const end = /\?["'”’)\]*_]*(?!.*\?)/.exec(asking);
    return (end ? asking.slice(0, end.index + end[0].length) : asking).trim();
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
    const lines = tailOf(unfenced(text));
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
    const tail = tailOf(unfenced(text)).slice(-6).join('\n');
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

/** "45 seconds", "90 seconds", "2 minutes 30 seconds", "10 minutes", "2 hours", "3 days": never rounded up past what it says. */
export function spanWords(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 120) return `${s} second${s === 1 ? '' : 's'}`;
    if (s < 600 && s % 60 !== 0) {
        const whole = Math.floor(s / 60);
        const rest = s % 60;
        return `${whole} minute${whole === 1 ? '' : 's'} ${rest} second${rest === 1 ? '' : 's'}`;
    }
    const m = Math.round(s / 60);
    if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
    // Hours and minutes up to ten hours, so 90 minutes never reads as 2 hours.
    if (m < 600 && m % 60 !== 0) {
        const whole = Math.floor(m / 60);
        const rest = m % 60;
        return `${whole} hour${whole === 1 ? '' : 's'} ${rest} minute${rest === 1 ? '' : 's'}`;
    }
    const h = Math.round(m / 60);
    if (h < 36) return `${h} hour${h === 1 ? '' : 's'}`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'}`;
}

/** "1 open todo", "3 open todos". */
export function count(n, one, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
}
