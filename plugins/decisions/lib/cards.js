/**
 * What Decisions lists, as pure functions over what the suite already
 * knows: the watcher's rows (each session's state, with the ask at the end
 * of its last reply), DSH's question-box projection, the coordinator's
 * thread roster, and the questions suite plugins raise. No DSH imports, so
 * the rules are tested without DSH.
 *
 * A card is one thing waiting on a person:
 *
 *     { id, kind, sessionId, title, question, recommendation?, detail?,
 *       at, running, answer, ... }
 *
 * `kind` is what it is (KINDS); `answer` is how Decisions answers it:
 * 'approval' (Allow once or Reject), 'questions' (the question box's
 * choices), 'text' (words sent into the session), 'ask' (a suite plugin's
 * own options), or 'open' (only the session itself can answer it).
 *
 * @module dsh-plugin-decisions/cards
 */
import { clip, isRecord } from './shared/safe.js';
import { HELD_SPAN, cutOff, dropMarks, holdCode, recommendationIn, unfenced, unholdCode } from './shared/words.js';

/** Every kind of card, most urgent first: approvals and questions hold a running turn. */
export const KINDS = Object.freeze(['approval', 'question', 'ask', 'decision', 'blocked', 'thread', 'reply']);

/** A card's kind in a word or two, as the page and notifications say it. */
export const KIND_WORDS = Object.freeze({
    approval: 'Approval',
    question: 'Question',
    ask: 'Asks you',
    decision: 'Decision',
    blocked: 'Blocked',
    thread: 'Thread',
    reply: 'Asked you',
});

/** The sessions Decisions reads: a subagent's asks go to its parent, not to the person. */
export const readable = (row) => isRecord(row) && typeof row.sessionId === 'string' && !row.parentSessionId && row.origin !== 'subagent';

/** Turn ends after which the reply's ask stands. */
const ASK_ENDS = new Set(['completed', 'blocked', 'aborted', 'max-tokens']);

const titleOf = (row) => (typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : 'Untitled session');

/**
 * Markdown links as their words: "[Port pick](.dsh-thread/t1)" reads "Port
 * pick" on a card. An address may hold one level of brackets
 * (`…/Cache_(computing)`) and a title (`[notes](a.md "Notes")`).
 */
export const plainLinks = (text) => String(text ?? '').replace(/\[([^\]\n]{1,300})\]\((?:[^()\s]|\([^()\s]{0,200}\)){0,1000}(?:\s+"[^"\n]{0,200}")?\)/g, '$1');

/**
 * A reply's line as a card shows it: links as their words, without
 * Markdown's marks; a code span's words stay whole (`__init__.py`, `a**b`).
 */
export const plainLine = (line) => {
    const { text, spans } = holdCode(plainLinks(line));
    return unholdCode(dropMarks(text).replace(/^\s*>+\s?/, '').replace(/^\s*#{1,6}\s+/, ''), spans).replace(/\s+/g, ' ').trim();
};

/** Text of several lines as a card shows it: each line by `plainLine`, a code fence's own line left out, one blank line at most. */
export const plainText = (text) => String(text ?? '').replace(/\r/g, '').split('\n')
    .map((line) => (/^\s*(?:```|~~~)[\w+.-]*\s*$/.test(line) ? '' : plainLine(line)))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * A handback's question as `recommendationIn` split it from its pick, in
 * plain words: its lines before the last by `plainText` (the last line's
 * question already is), each read once, so `__init__.py` stays whole.
 */
function plainSplit(summary, question) {
    const before = summary.trim().split('\n').slice(0, -1).join('\n').trim();
    if (!before) return question;
    if (!question.startsWith(before)) return plainText(question);
    return [plainText(before), question.slice(before.length).trim()].filter(Boolean).join('\n');
}

/**
 * Words to find a question by in its reply: a line as a card shows it, in
 * lower case and without any mark, so a question already read into plain
 * words ("__init__.py") is found in its line however the line marked it;
 * `at[i]` is where its i-th character sits in `plainLine(line)`.
 */
function findable(line) {
    const plain = plainLine(line);
    let text = '';
    const at = [];
    for (let i = 0; i < plain.length; i += 1) {
        if (plain[i] === '*' || plain[i] === '_' || plain[i] === '`') continue;
        for (const unit of plain[i].toLowerCase()) {
            text += unit;
            at.push(i);
        }
    }
    return { text, at };
}

/** The most of a reply a card carries from before its question. */
const CONTEXT_LINES = 4;
const CONTEXT_MAX = 400;

/**
 * The line of a reply that holds its question: the last one with the
 * question's start (a long question is found by its first words), and where
 * in that line (as plain text) the question starts. Undefined when not found.
 */
function questionLine(lines, question) {
    const wanted = findable(question).text.replace(/…$/, '');
    if (wanted.length < 4) return undefined;
    for (const size of [60, 24]) {
        const probe = wanted.slice(0, size);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const line = findable(lines[i]);
            const index = line.text.indexOf(probe);
            if (index >= 0) return { at: i, from: line.at[index] };
        }
    }
    return undefined;
}

/**
 * The lines of a reply just before its question: what the question is
 * about ("1. tidy … 2. sweep … Which one do you prefer?"). Up to four lines
 * or 400 characters, in their order, as plain text; empty when the question
 * opens the reply or is not found in it.
 * @param {string} text - the reply.
 * @param {string} question - the question the card shows.
 */
export function contextOf(text, question) {
    if (typeof text !== 'string' || typeof question !== 'string') return '';
    const lines = text.replace(/\r/g, '').split('\n');
    // The question is looked for where it was asked, outside fenced code; the lines before it keep a block's code.
    const found = questionLine(unfenced(lines.join('\n')).split('\n'), question);
    if (!found) return '';
    const { at, from } = found;
    const out = [];
    let size = 0;
    // What the question's own line says before it ("Here are three: A, B, C."), without a marker.
    const own = plainLine(lines[at]);
    const lead = own.slice(0, Math.min(from, own.length)).replace(/(?:DECISION NEEDED|BLOCKED)\s*[:：]?\s*$/i, '').trim();
    if (lead) { out.push(lead); size += lead.length; }
    for (let i = at - 1; i >= 0 && out.length < CONTEXT_LINES; i -= 1) {
        if (/^\s*(?:```|~~~)/.test(lines[i])) continue;
        const line = plainLine(lines[i]);
        if (!line) continue;
        if (size + line.length > CONTEXT_MAX) {
            // A long line is cut at a word, and only when nothing was kept yet.
            if (out.length === 0) out.unshift(`…${line.slice(line.length - CONTEXT_MAX + 1).replace(/^\S*\s/, '')}`);
            break;
        }
        out.unshift(line);
        size += line.length;
    }
    return out.join('\n');
}

/** A bold span (`**a**`, or `__a__` not inside a word) or a held code span (lib/shared/words.js). */
const SPAN = new RegExp(String.raw`\*\*(?=[^\s*])((?:(?!\*\*).)*?[^\s*])\*\*|(?<![\p{L}\p{N}])__(?=[^\s_])((?:(?!__).)*?[^\s_])__(?![\p{L}\p{N}])|${HELD_SPAN.source}`, 'gu');

/**
 * Markdown's marks dropped, with where each bold or code span is in what is
 * left: [start, end) pairs. A code span's words stay whole (`__init__.py`).
 */
function unmark(text) {
    const { text: held, spans: codes } = holdCode(text);
    const words = (part) => unholdCode(dropMarks(part), codes);
    let flat = '';
    const spans = [];
    let last = 0;
    for (const m of held.matchAll(SPAN)) {
        flat += words(held.slice(last, m.index));
        const inner = m[3] !== undefined ? (codes[Number(m[3])]?.words ?? '') : words(m[1] ?? m[2]);
        spans.push([flat.length, flat.length + inner.length]);
        flat += inner;
        last = m.index + m[0].length;
    }
    return { flat: flat + words(held.slice(last)), spans };
}

/**
 * Where a pick starts: "Recommend …", "I'd recommend …", "Recommendation: …",
 * "My recommendation is …", "Recommended: …" at a sentence's or a line's
 * start; "… but I would recommend …" and "… — recommend …" inside one.
 */
const PICK_LEAD = new RegExp([
    String.raw`(?:^|[.!?;]["'”’)\]]*\s+|\n)[ \t>]*(?:[-*]\s+|\d{1,2}[.)]\s+)?(?:(?:(?:I|we)(?:['’]d|\s+would)?\s+)?recommend\b(?:\s*[:：])?|recommended\s*[:：]|(?:my\s+|our\s+)?recommendation(?:\s+is\b|\s*[:：]))`,
    String.raw`\b(?:I|we)(?:['’]d|\s+would)?(?:\s+(?:still|strongly|really))?\s+recommend\b(?:\s*[:：])?`,
    String.raw`\s(?:—|–|--)\s*recommend(?:ation|ed)?\b(?:\s*[:：])?`,
].join('|'), 'gi');

/** "I recommend that you …", "recommend against …": advice, not a pick. */
const NOT_A_PICK = /^(?:that|you|we|against|not|it|this|these|those|doing|to|a\s+few|some|one\s+of|either)\b/i;

/** "9090 (recommended)", "9090 (the thread's recommendation)". */
const PICK_MARKED = /(?:^|[\n.;:!?,]\s*)(?:[-*]\s+|\d{1,2}[.)]\s+)?([^\n.;:!?(),]{1,120}?)\s*\((?:recommended|my\s+recommendation|(?:the\s+)?thread['’]s\s+recommendation|recommendation)\)/i;

/** A sentence's end: a full stop, ! or ? before a space (not the dot in "v2.0" or "notes.md"), a semicolon, a line's end. */
const PICK_END = /[.!?。！？](?=["'”’)\]]*(?:\s|$))|[;\n]/;

/** Where the pick's own words end and its reason or a contrast begins: " because …", ", which …", ": it …", " — …", " (…". */
const PICK_BREAK = /\s+(?:because|since|as\s+(?:it|they|this|that|its|their|the\s+(?:former|latter))|so\s+that|given\s+that|due\s+to|whereas|while|though|although|rather\s+than|instead\s+of)\b|,\s*(?:as|because|since|which|whereas|while|but|though|although|so|given|and\s+(?:it|this|that)|it|this|that)\b|:\s|\s+[—–]\s*|\s+--?\s+|\s*\(/i;

/** The longest pick a card shows; a longer one is cut at a word, with "…". */
const PICK_MAX = 160;

const pickTidy = (words) => words.replace(/\s+/g, ' ').replace(/[\s,:;—–-]+$/, '').trim().replace(/^(?:or|and|either|to)\s+/i, '');

/**
 * A pick stated as a sentence anywhere in a handback or a reply's end, when
 * no "Recommendation:" closes it, in the pick's own words: "Recommend 9090
 * for the status page." gives "9090 for the status page"; "I would
 * recommend **release/v2** because …" gives "release/v2" (a bold or code
 * span the pick starts with, when the reason follows it); "Recommendation:
 * 9090, as it is unused." gives "9090" (its reason left out); a dot inside
 * a word ("v2.0") does not end it, and a long one is cut at a word, with
 * "…". "**9090 (thread's recommendation)**" gives "9090". Undefined when
 * nothing is recommended.
 */
export function pickIn(text) {
    // A fenced code block is shown, not said: a "recommend:" quoted in one is no pick.
    const { flat, spans } = unmark(plainLinks(unfenced(text)));
    for (const lead of flat.matchAll(PICK_LEAD)) {
        const start = lead.index + lead[0].length;
        const from = start + /^\s*/.exec(flat.slice(start))[0].length;
        const rest = flat.slice(from);
        // "I recommend that you …" is advice; "My recommendation is to keep both" is a pick.
        if (!rest || (/recommend\s*$/i.test(lead[0]) && NOT_A_PICK.test(rest))) continue;
        const span = spans.find(([a]) => a === from);
        if (span) {
            const after = flat.slice(span[1]);
            if (/^\s*$/.test(after) || /^[,:;)]/.test(after) || PICK_END.exec(after)?.index === 0 || PICK_BREAK.exec(after)?.index === 0) {
                const words = pickTidy(flat.slice(span[0], span[1]));
                if (words) return clip(words, PICK_MAX);
            }
        }
        const end = PICK_END.exec(rest);
        let words = end ? rest.slice(0, end.index) : rest;
        const cut = PICK_BREAK.exec(words);
        if (cut && cut.index > 0) words = words.slice(0, cut.index);
        words = pickTidy(words);
        if (words) return clip(words, PICK_MAX);
    }
    const marked = PICK_MARKED.exec(flat);
    const words = marked ? pickTidy(marked[1]) : '';
    return words ? clip(words, PICK_MAX) : undefined;
}

/** A decision line's pick after a dash without its colon: "Send it? — recommend sending it after the review". */
const DASHED_PICK = /^(.+?)\s+(?:—|–|--)\s*(?:(?:I|we)(?:['’]d|\s+would)?\s+)?recommend(?:ed)?\b\s*[:：]?\s*(?!(?:that|you|against|not)\b)(\S.*)$/i;

/**
 * Split a decision line's question from a pick written "— recommend X"
 * (the suite's form, without its colon), or undefined.
 */
export function dashedPick(question) {
    const found = DASHED_PICK.exec(String(question ?? ''));
    if (!found) return undefined;
    const pick = found[2].replace(/^[\s*_`]+|[\s*_`]+$/g, '').replace(/(?<![.])\.$/, '').trim();
    const asked = found[1].trim();
    return pick && asked ? { question: asked, recommendation: clip(pick, 300) } : undefined;
}

/**
 * The raw lines of a reply up to its question's line (marks kept, for a pick's bold or code span), or ''. A fenced
 * code block's lines are left out (blank) before the reply is cut, so a block the cut starts inside is still one.
 */
export function linesToQuestion(text, question) {
    if (typeof text !== 'string' || typeof question !== 'string') return '';
    const lines = unfenced(text.replace(/\r/g, '')).split('\n');
    const found = questionLine(lines, question);
    return found ? lines.slice(Math.max(0, found.at - CONTEXT_LINES * 2), found.at + 1).join('\n') : '';
}

/**
 * The card for what a session's last reply asks: a DECISION NEEDED line, a
 * BLOCKED line, or (with `replies`) a plain question. None while the
 * session runs, when anything was written in since the turn ended (the
 * person answered, or a plugin's note moved it on), or when the turn ended
 * longer than `windowMs` ago.
 * @param {object} row - a watcher row (`sessionWatch.list()`).
 * @param {{ replies?: boolean, windowMs?: number, now?: number, reply?: { text: string, turn: number } }} [options] -
 *   `reply`: the session's last reply and its turn, from the watcher's full state (`sessionWatch.stateOf`): a row
 *   leaves the text out.
 */
export function replyCard(row, { replies = true, windowMs = 0, now = Date.now(), reply } = {}) {
    const state = row?.state;
    const ask = state?.ask;
    const end = state?.end;
    if (!readable(row) || !isRecord(ask) || !isRecord(end) || state.open || row.status === 'running') return undefined;
    if (ask.turn !== end.turn || !ASK_ENDS.has(end.kind) || cutOff(end)) return undefined;
    const endAt = Number(end.at) || 0;
    if (Math.max(Number(state.inAt) || 0, Number(state.userAt) || 0) > endAt) return undefined;
    if (windowMs > 0 && endAt > 0 && now - endAt > windowMs) return undefined;
    const kind = ask.kind === 'decision' ? 'decision' : ask.kind === 'blocked' ? 'blocked' : 'reply';
    // An offer ("Let me know if you want the docs too") waits on nobody: Autopilot still leaves the session alone.
    if (kind === 'reply' && (!replies || ask.soft === true)) return undefined;
    // "DECISION NEEDED: Send it? — recommend sending it after the review" (no colon) still splits off its pick.
    const dashed = kind === 'decision' && !ask.recommendation ? dashedPick(plainLinks(ask.question)) : undefined;
    // A plain question comes as the reply wrote it ("Should I fix `parser.py` first?"): shown in plain words, like
    // its lines (a marker's words already are).
    const question = dashed?.question ?? (kind === 'reply' ? plainLine(ask.question) : plainLinks(ask.question));
    // The reply's lines before its question ("1. tidy 2. sweep … Which one do you prefer?"), so the card can be answered in place.
    const said = reply ?? (typeof state.text === 'string' ? { text: state.text, turn: state.textTurn } : undefined);
    const text = said?.turn === ask.turn ? said.text : undefined;
    const context = contextOf(text, ask.question);
    // A plain question after "I'd recommend **9090** for the page." gets the pick too, with its own answer: read
    // from the reply's own lines, so a bold or code span is still known.
    const pick = ask.recommendation ? plainLinks(ask.recommendation)
        : dashed ? dashed.recommendation
            : kind === 'reply' ? pickIn(linesToQuestion(text, ask.question) || `${context}\n${question}`) : undefined;
    return {
        id: `${kind}:${row.sessionId}:${end.turn}`,
        kind,
        sessionId: row.sessionId,
        title: titleOf(row),
        ...(row.cwd ? { cwd: row.cwd } : {}),
        // A BLOCKED line's words are what the session waits for ("valid staging credentials"): said as such.
        ...(kind === 'blocked' ? { head: 'Blocked on:' } : {}),
        question,
        ...(context ? { context } : {}),
        ...(pick ? { recommendation: pick } : {}),
        turn: end.turn,
        at: endAt,
        running: false,
        answer: 'text',
    };
}

/** One question-box question, made safe for the window. */
export function questionOf(item) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.question !== 'string') return undefined;
    const options = Array.isArray(item.options)
        ? item.options.filter((o) => isRecord(o) && typeof o.label === 'string' && o.label !== '').slice(0, 20)
            .map((o) => ({ label: o.label.slice(0, 200), ...(typeof o.description === 'string' && o.description ? { description: clip(o.description, 300) } : {}) }))
        : [];
    return {
        id: item.id.slice(0, 120),
        question: item.question.slice(0, 1000),
        ...(typeof item.header === 'string' && item.header ? { header: clip(item.header, 80) } : {}),
        ...(typeof item.detail === 'string' && item.detail ? { detail: item.detail.slice(0, 4000) } : {}),
        options,
        multiSelect: item.multiSelect === true || item.multi_select === true,
        ...(isRecord(item.intent) && typeof item.intent.kind === 'string' ? { intent: item.intent.kind } : {}),
    };
}

/** The question-box calls in a session's `userQuestions` value (DSH's live state or its saved view). */
export function activeQuestions(value) {
    const view = isRecord(value?.questions) && Array.isArray(value.questions.active) ? value.questions : value;
    return Array.isArray(view?.active) ? view.active.filter((q) => isRecord(q) && typeof q.callId === 'string' && Array.isArray(q.questions)) : [];
}

/**
 * Cards for a session's question-box calls that DSH keeps answerable: a
 * call whose wait ran out ("continued") is answered through DSH's question
 * service; one still in its first wait that Decisions does not hold is
 * answered in its session.
 * @param {object} row
 * @param {{ value: any } | undefined} projection - `sessionWatch.projection(id, 'userQuestions')`.
 */
export function questionCards(row, projection) {
    if (!readable(row) || !projection) return [];
    const cards = [];
    for (const call of activeQuestions(projection.value)) {
        const questions = call.questions.map(questionOf).filter(Boolean);
        if (questions.length === 0) continue;
        const continued = call.state === 'continued';
        cards.push({
            id: `question:${row.sessionId}:${call.callId}`,
            kind: 'question',
            sessionId: row.sessionId,
            title: titleOf(row),
            callId: call.callId,
            questions,
            question: questions[0].question,
            ...(questions.length > 1 ? { more: questions.length - 1 } : {}),
            at: 0,
            running: row.status === 'running',
            answer: continued ? 'questions' : 'open',
            ...(continued ? { late: true } : {}),
        });
    }
    return cards;
}

/** The coordinator's view of a session (`coordinatorSession`), from its live state or its saved view. */
export function coordinatorView(value) {
    if (!isRecord(value)) return undefined;
    if (typeof value.role === 'string') return value;
    return isRecord(value.v) && typeof value.v.role === 'string' ? value.v : undefined;
}

/** Handback statuses that wait on a person. */
const WAITING = new Set(['needs_decision', 'blocked']);

/** A coordinator thread's card id: one per thread turn, whether its reply or its handback (or both) say what it needs. */
export const threadCardId = (sessionId, turn) => `thread:${sessionId}:${turn}`;

/**
 * A coordinator thread's own reply card (`replyCard` on the thread's row)
 * as the thread's card: under the id its handback's card takes for the same
 * turn (`threadCards`), so the two are one card from the first sight.
 * `handedBack` when the thread's own log shows it handed back in that turn
 * waiting on the person (the coordinator announces such a handback itself).
 * @param {object} card - the reply's card.
 * @param {object} view - the thread's `coordinatorSession` view (role 'thread').
 * @param {{ sessionId: string, title: string } | undefined} chat - its coordinating chat.
 */
export function ownThreadCard(card, view, chat) {
    const handback = (Array.isArray(view?.cards) ? view.cards : []).filter((c) => isRecord(c) && c.kind === 'handback' && c.turn === card.turn).at(-1);
    return {
        ...card,
        id: threadCardId(card.sessionId, card.turn),
        kind: 'thread',
        // What the reply is, for the answer's first line: a DECISION NEEDED line, a BLOCKED line or a question.
        ask: card.kind,
        status: card.kind === 'blocked' || handback?.status === 'blocked' ? 'blocked' : 'needs_decision',
        ...(chat ? { via: chat } : {}),
        ...(handback && WAITING.has(handback.status) ? { handedBack: true } : {}),
    };
}

/**
 * Cards for a coordinating chat's threads that handed back needing a
 * decision (or blocked) and have heard nothing since: no message to the
 * thread after the handback, the thread not running, not resolved.
 * @param {object} row - the coordinating chat's watcher row.
 * @param {{ value: any } | undefined} projection - `sessionWatch.projection(id, 'coordinatorSession')`.
 * @param {Map<string, object>} rowsById - every watcher row, for the threads' own sessions.
 * @param {(sessionId: string) => object | undefined} [viewOf] - a thread's own `coordinatorSession` view (role
 *   'thread'), which lists the turn it handed back in.
 */
export function threadCards(row, projection, rowsById, viewOf) {
    const view = coordinatorView(projection?.value);
    if (!readable(row) || view?.role !== 'coordinator' || view.off) return [];
    const cards = [];
    for (const thread of Array.isArray(view.threads) ? view.threads : []) {
        if (!isRecord(thread) || thread.resolved || typeof thread.session !== 'string' || !isRecord(thread.handback)) continue;
        if (!WAITING.has(thread.handback.status)) continue;
        // The newest card about the thread must be its handback: a later send means the chat already answered it.
        const about = (Array.isArray(view.cards) ? view.cards : []).filter((card) => isRecord(card) && card.thread === thread.id);
        if (about.length && about.at(-1).kind !== 'handback') continue;
        const own = rowsById?.get(thread.session);
        if (own?.status === 'running') continue;
        const at = Date.parse(thread.handback.at) || 0;
        if (own?.state && at > 0 && Math.max(Number(own.state.inAt) || 0, Number(own.state.userAt) || 0) > at) continue;
        const summary = plainLinks(thread.handback.summary).trim();
        // "… Recommendation: 8080 — it matches the docs." goes under Recommended, with its own answer button,
        // and so does a pick said anywhere in it ("Recommend 9090 for the status page. …").
        const split = recommendationIn(summary);
        const pick = split ? undefined : pickIn(summary);
        // Shown in plain words, as a reply's card is ("Use `9090`, not **8080**?" reads "Use 9090, not 8080?").
        const question = split ? plainSplit(summary, split.question) : plainText(summary);
        const blocked = thread.handback.status === 'blocked';
        // One id per thread turn, the same as the thread's own reply's card (lib/inbox.js): a handback the chat takes
        // late updates the card the thread's reply made, never a second one. The turn is the one the thread's own
        // log says it handed back in, else its last; before either is known (its session not listed), the
        // handback's time.
        let mark;
        try {
            const marks = viewOf?.(thread.session)?.cards;
            mark = (Array.isArray(marks) ? marks : []).filter((c) => isRecord(c) && c.kind === 'handback' && Number.isSafeInteger(c.turn)).at(-1);
        } catch { /* the thread's last turn stands in */ }
        // The thread handed back again since (its chat has not taken that one yet): this handback is not its last word.
        if (mark && typeof mark.status === 'string' && mark.status !== thread.handback.status) continue;
        const handedIn = mark?.turn;
        const ended = Number.isSafeInteger(own?.state?.end?.turn) ? own.state.end.turn : undefined;
        // The thread had a turn since it handed back (an answer reached it before its chat took the handback): answered.
        if (handedIn !== undefined && ended !== undefined && ended > handedIn) continue;
        const turn = handedIn ?? ended;
        const legacy = `thread:${thread.session}:${at || thread.id}`;
        cards.push({
            id: turn !== undefined ? threadCardId(thread.session, turn) : legacy,
            ...(turn !== undefined ? { legacy, turn } : {}),
            handback: true,
            kind: 'thread',
            sessionId: thread.session,
            title: clip(String(thread.title ?? 'Thread'), 120) || 'Thread',
            via: { sessionId: row.sessionId, title: titleOf(row) },
            status: thread.handback.status,
            // A summary that asks nothing is headed by what the thread waits for, so it reads as a request.
            ...(question && !question.includes('?') ? { head: blocked ? 'The thread is blocked:' : 'The thread needs your decision:' } : {}),
            question: question || (blocked ? 'The thread is blocked.' : 'The thread needs a decision.'),
            ...(split ? { recommendation: split.recommendation } : pick ? { recommendation: pick } : {}),
            at,
            running: false,
            answer: 'text',
        });
    }
    return cards;
}

/**
 * The thread sessions a coordinating chat runs, each with the chat: so a
 * card from inside a thread (an approval, a question) can say whose thread
 * it is.
 * @returns {Array<{ session: string, chat: { sessionId: string, title: string } }>}
 */
export function threadsOf(row, projection) {
    const view = coordinatorView(projection?.value);
    if (!readable(row) || view?.role !== 'coordinator') return [];
    return (Array.isArray(view.threads) ? view.threads : [])
        .filter((thread) => isRecord(thread) && typeof thread.session === 'string')
        .map((thread) => ({ session: thread.session, chat: { sessionId: row.sessionId, title: titleOf(row) } }));
}

/**
 * Every thread's latest handback in a coordinating chat, whether it still
 * waits or not: what the chat's relay of a handback can be about. Decisions
 * keeps them (lib/inbox.js), so the chat's relay of a handback that asked
 * the person is never a card of its own, before or after the answer.
 * @returns {Array<{ thread: string, chat: string, at: number, asks: boolean }>}
 */
export function handbacksOf(row, projection) {
    const view = coordinatorView(projection?.value);
    if (!readable(row) || view?.role !== 'coordinator' || view.off) return [];
    const out = [];
    for (const thread of Array.isArray(view.threads) ? view.threads : []) {
        if (!isRecord(thread) || typeof thread.session !== 'string' || !isRecord(thread.handback)) continue;
        const at = Date.parse(thread.handback.at) || 0;
        if (at > 0) out.push({ thread: thread.session, chat: row.sessionId, at, asks: WAITING.has(thread.handback.status) });
    }
    return out;
}

/** A card for a question a suite plugin raised through the watcher (Autopilot's Ask first, an agent in a terminal). */
export function askCard(ask, rowsById) {
    if (!isRecord(ask) || typeof ask.id !== 'string' || typeof ask.question !== 'string') return undefined;
    const row = typeof ask.sessionId === 'string' ? rowsById?.get(ask.sessionId) : undefined;
    const options = Array.isArray(ask.options) ? ask.options.filter((o) => isRecord(o) && typeof o.id === 'string' && typeof o.label === 'string').slice(0, 6) : [];
    return {
        id: `ask:${ask.id}`,
        kind: 'ask',
        askId: ask.id,
        ...(typeof ask.sessionId === 'string' ? { sessionId: ask.sessionId } : {}),
        title: typeof ask.title === 'string' && ask.title ? ask.title : row ? titleOf(row) : '',
        source: typeof ask.source === 'string' ? ask.source : 'A plugin',
        question: ask.question,
        ...(typeof ask.recommendation === 'string' && ask.recommendation ? { recommendation: ask.recommendation } : {}),
        ...(typeof ask.why === 'string' && ask.why ? { detail: ask.why } : {}),
        options,
        freeText: ask.freeText === true,
        at: Number(ask.at) || 0,
        running: row?.status === 'running',
        // A question with no answers to pick and no words to write is answered in the session; the plugin says how.
        answer: options.length || ask.freeText === true ? 'ask' : 'session',
        ...(typeof ask.answerHint === 'string' && ask.answerHint ? { hint: clip(ask.answerHint, 200) } : {}),
    };
}

/** Whether a card holds a running turn: an approval or a question box the turn waits on, held here or not. */
export const holdsTurn = (card) => card?.answer === 'approval' || ((card?.kind === 'question' || card?.kind === 'approval') && (card.live === true || card.running === true));

/** Cards in the order the page lists them: what holds a running turn first, then oldest first. */
export function byUrgency(a, b) {
    const live = (card) => (holdsTurn(card) ? 0 : 1);
    return live(a) - live(b) || (a.at || Infinity) - (b.at || Infinity) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.id.localeCompare(b.id);
}

const LEADS = {
    decision: 'your DECISION NEEDED line',
    blocked: 'your BLOCKED line',
    reply: 'your question',
};

/**
 * The message an answer puts into the session: a tagged first line that
 * says what it answers, then the person's words as they wrote them.
 * @param {object} card
 * @param {{ text?: string, recommended?: boolean }} answer
 */
export function answerMessage(card, { text, recommended } = {}) {
    const lead = card.kind === 'thread' ? (card.handback || !LEADS[card.ask] ? 'your handback' : LEADS[card.ask]) : LEADS[card.kind] ?? 'your question';
    const what = clip(String(card.question ?? ''), 300);
    if (recommended) {
        return `[Decisions] The person answered ${lead} (“${what}”): go with your recommendation${card.recommendation ? ` (${clip(card.recommendation, 300)})` : ''}.`;
    }
    return `[Decisions] The person answered ${lead} (“${what}”):\n\n${String(text ?? '').trim()}`;
}

/** Longest typed answer Decisions sends. */
export const ANSWER_MAX = 8000;

/**
 * Check a question-box answer against its questions and give it in DSH's
 * shape (`{ answers: [{ id, selected, custom? }] }`). A question with no
 * choice and no words is skipped, as DSH's own card skips it.
 * @throws {Error} in words, when the answer does not fit the questions.
 */
export function checkAnswers(questions, answers) {
    if (!Array.isArray(answers)) throw new Error('Send one answer for each question.');
    const given = new Map();
    for (const item of answers) {
        if (!isRecord(item) || typeof item.id !== 'string') throw new Error('Each answer names its question.');
        if (given.has(item.id)) throw new Error('Each question takes one answer.');
        given.set(item.id, item);
    }
    const out = [];
    for (const question of questions) {
        const item = given.get(question.id);
        if (!item) throw new Error(`Answer “${clip(question.question, 80)}”, or skip it.`);
        given.delete(question.id);
        const selected = Array.isArray(item.selected) ? item.selected.filter((s) => typeof s === 'string') : [];
        const labels = new Set((question.options ?? []).map((o) => o.label));
        for (const label of selected) if (!labels.has(label)) throw new Error(`“${clip(label, 60)}” is not one of the choices.`);
        if (!question.multiSelect && selected.length > 1) throw new Error(`Pick one choice for “${clip(question.question, 80)}”.`);
        const custom = typeof item.custom === 'string' && item.custom.trim() ? item.custom.trim().slice(0, ANSWER_MAX) : undefined;
        out.push({ id: question.id, selected, ...(custom ? { custom } : {}) });
    }
    if (given.size > 0) throw new Error('An answer names a question that was not asked.');
    return { answers: out };
}

/** A question-box answer in a few words, for the history ("staging", "skipped"). */
export function answerWords(answers) {
    const parts = (answers ?? []).map((a) => [...(a.selected ?? []), ...(a.custom ? [a.custom] : [])].join(', ') || 'skipped');
    return clip(parts.join('; '), 200);
}

/** The heading a notification or a mirrored message gives a card. */
export function headline(card) {
    const where = card.title ? `“${clip(card.title, 80)}”` : 'a session';
    switch (card.kind) {
        case 'approval': return `${where} waits for your approval`;
        case 'question': return `${where} asks you a question`;
        case 'decision': return `${where} needs a decision`;
        case 'blocked': return `${where} is blocked`;
        case 'thread': return `Thread ${where} ${card.status === 'blocked' ? 'is blocked' : 'needs a decision'}`;
        case 'ask': return `${card.source ?? 'A plugin'} asks about ${where}`;
        default: return `${where} asked you something`;
    }
}

/**
 * What a card is, without its session's title, for a history row (which
 * links the session beside it): "Needs a decision", "Blocked".
 */
export function lead(card) {
    switch (card.kind) {
        case 'approval': return 'Waiting for your approval';
        case 'question': return 'Asked you a question';
        case 'decision': return 'Needs a decision';
        case 'blocked': return 'Blocked';
        case 'thread': return card.status === 'blocked' ? 'The thread is blocked' : 'The thread needs a decision';
        case 'ask': return `${card.source ?? 'A plugin'} asked you`;
        default: return 'Asked you something';
    }
}

/** Cut text to `max` characters, keeping its lines. */
export function cutLines(text, max) {
    const value = String(text ?? '').trim();
    return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** The plain text a mirror sends for a card. */
export function mirrorText(card) {
    const lines = [headline(card)];
    if (card.context) lines.push(cutLines(card.context, CONTEXT_MAX));
    lines.push(clip(`${card.head ? `${card.head} ` : ''}${String(card.question ?? '')}`, 900));
    if (card.recommendation) lines.push(`Recommended: ${clip(card.recommendation, 300)}`);
    if (card.via?.title) lines.push(card.kind === 'thread' ? `In “${clip(card.via.title, 80)}”.` : `In a thread of “${clip(card.via.title, 80)}”.`);
    lines.push('Answer it in DSH: Decisions.');
    return lines.join('\n');
}
