/**
 * The `proofClaims` session projection: each session's claims ledger. DSH
 * folds it on the Host over every committed event of every session, keeps
 * it with the session and streams it to the window, where the turn's flag
 * reads it (lib/client.js); the model never sees it.
 *
 * Over a turn it gathers the evidence: one small item per tool result
 * (evidence.js `itemOf`). When the turn finishes, the claims in its last
 * reply (claims.js) are judged against that evidence: `backed` (quiet),
 * `unbacked` (flagged: nothing in the turn shows it) or `contradicted`
 * (flagged: the turn's own run says otherwise). A turn that ran no tools
 * may lean on the turn before it, unless the person asked for new work in
 * between: "all tests pass" after "thanks, summarize" is backed by the
 * test run one turn back, "renamed it" after "rename it" is not.
 *
 * DSH runs `apply` inside its event commit and parses saved state without
 * catching, so `apply` and the parser never throw, and an event that
 * changes nothing returns the same state object.
 *
 * DSH keeps the state with the session and puts every projection's view on
 * each row of its session list, so the view is small: the count and the
 * flagged claims only (a backed claim is quiet). Proof's page reads whole
 * ledgers from the host (index.js keeps them).
 *
 * State (`v` is the version of this shape):
 *
 *   { v: 1,
 *     turn: { n, seq, at, items: Item[], calls: { [callId]: { name, args } }, text, textSeq, work, ask } | null,
 *     prev: { n, items: Item[], ask } | null,
 *     claims: Claim[],
 *     check?: true,
 *     first?: number }
 *
 *   Claim: { id: "<turn>:<n>", turn, seq, at, kind, subject?, target?, text, part, verdict, evidence: string[], why, from? }
 *
 * `ask` is the person's message that started the turn (clipped): a bare
 * "Done" after "add the flag" needs a change to back it.
 *
 * `check` marks one of Proof's own check threads (its first message, from
 * Proof, starts with CHECK_LINE): its replies are verdicts on another
 * session's claim, so none of its turns is judged. `first` is that first
 * turn's number: the window says what the thread checks under it.
 *
 * @module dsh-plugin-proof/projection
 */
import { claimsIn } from './claims.js';
import { asksForWork, itemOf, judge, looksOnly, quotedBy } from './evidence.js';

/** The projection key; the browser half reads the same name. */
export const KEY = 'proofClaims';
export const STATE_VERSION = 1;

const MAX_CLAIMS = 60;
/** Flagged claims the window gets per session. */
const MAX_VIEW = 20;
const MAX_ITEMS = 60;
const MAX_CALLS = 40;
const KEEP_HEAD = 4000;
const KEEP_TAIL = 12000;
const MAX_ASK = 600;

export const INITIAL = Object.freeze({ v: 1, turn: null, prev: null, claims: [] });

/** How Proof's check threads start (lib/verifier.js writes it): such a session has no claims of its own. */
export const CHECK_LINE = 'Proof check.';

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, n = 400) => (typeof v === 'string' ? v.slice(0, n) : '');

/** A tool result's text parts, the start and the end of a long one (runners print their summary last). */
export function textOfContent(content) {
    const parts = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
    const text = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
    return text.length > KEEP_HEAD + KEEP_TAIL ? `${text.slice(0, KEEP_HEAD)}\n…\n${text.slice(-KEEP_TAIL)}` : text;
}

/** An assistant message's reply text (not its reasoning or tool calls). */
function replyText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n').trim();
}

/** Message sources that are not a request: context DSH or a plugin adds before a turn. */
const CONTEXT_SOURCES = new Set(['runtime-context', 'agent-instructions', 'dsh-plugin-canon', 'request-context']);

/** Keep the first few items and the latest ones: the order and the last runs are what the judging reads. */
function capItems(items) {
    return items.length > MAX_ITEMS ? [...items.slice(0, 10), ...items.slice(items.length - (MAX_ITEMS - 10))] : items;
}

function turnOf(state) {
    return state.turn ?? { n: 0, seq: 0, at: 0, items: [], calls: {}, text: '', textSeq: 0, work: false, ask: '' };
}

/** The claims of a finished turn, judged. */
function judged(turn, prev, at) {
    const claims = claimsIn(turn.text);
    if (claims.length === 0) return [];
    // A summary turn that ran nothing, or only looked (a registry read, a status read), rests on the turn before.
    const lean = (turn.items.length === 0 || turn.items.every(looksOnly)) && !turn.work && prev && prev.items.length > 0;
    return claims.map((claim, index) => {
        let result = judge(claim, turn.items, { prompt: turn.ask });
        // No tool ran, and the person asked for new work: an earlier turn's runs do not show it.
        if (turn.items.length === 0 && turn.work && prev && prev.items.length > 0 && result.verdict === 'unbacked') {
            result = { ...result, why: 'No tool ran in this turn, and it was asked for new work, so the runs before it do not show this.' };
        }
        let from;
        if (lean && result.verdict === 'unbacked') {
            // The turn before, then this turn's own looks after it: each piece of evidence says which turn it came from.
            const before = prev.items.map((i) => ({ ...i, text: `turn ${prev.n}: ${i.text}` }));
            const earlier = judge(claim, [...before, ...turn.items], { prompt: prev.ask ?? '' });
            if (earlier.verdict !== 'unbacked') {
                result = earlier;
                from = prev.n;
            }
        }
        // A write-up of the last turn ("write the update for the channel") that restates its output word for word.
        if (result.verdict === 'unbacked' && turn.items.length === 0 && prev && prev.items.length > 0) {
            const quoted = quotedBy(claim, prev.items);
            if (quoted) {
                result = { ...quoted, evidence: quoted.evidence.map((e) => `turn ${prev.n}: ${e}`) };
                from = prev.n;
            }
        }
        return {
            id: `${turn.n}:${index}`,
            turn: turn.n,
            seq: turn.textSeq,
            at,
            kind: claim.kind,
            ...(claim.subject ? { subject: claim.subject } : {}),
            ...(claim.target ? { target: claim.target } : {}),
            text: claim.text,
            part: str(claim.part ?? claim.text, 200),
            verdict: result.verdict,
            evidence: result.evidence.slice(0, 3).map((e) => str(e, 200)),
            why: str(result.why, 300),
            ...(from !== undefined ? { from } : {}),
        };
    });
}

/** One committed event folded into the state. Never throws; the same state when nothing changed. */
export function applyEvent(state, event) {
    try {
        const s = isRecord(state) && state.v === 1 ? state : INITIAL;
        // A check thread has nothing to judge, so nothing changes once it is marked.
        if (!isRecord(event) || typeof event.type !== 'string' || s.check === true) return s;
        const data = isRecord(event.data) ? event.data : {};
        switch (event.type) {
            case 'turn/start': {
                const n = Number.isSafeInteger(data.turn) ? data.turn : (s.turn?.n ?? 0) + 1;
                const prev = s.turn && s.turn.items.length > 0 ? { n: s.turn.n, items: s.turn.items, ask: s.turn.ask ?? '' } : s.prev;
                return { ...s, prev, turn: { n, seq: event.seq ?? 0, at: event.time ?? 0, items: [], calls: {}, text: '', textSeq: 0, work: false, ask: '' } };
            }
            case 'user/message': {
                const kind = data.source?.kind;
                // Only a session's start can make it a check thread: a ledger that has claims is never wiped.
                if (kind === 'cordis-host-runner' && s.claims.length === 0 && replyText(data).startsWith(CHECK_LINE)) {
                    return { v: 1, turn: null, prev: null, claims: [], check: true, ...(Number.isSafeInteger(s.turn?.n) ? { first: s.turn.n } : {}) };
                }
                if (!s.turn) return s;
                if (CONTEXT_SOURCES.has(kind)) return s;
                const said = kind === 'user' ? replyText(data) : '';
                const work = kind === 'user' ? asksForWork(said) : true;
                const ask = s.turn.ask || said.slice(0, MAX_ASK);
                if ((!work || s.turn.work) && ask === s.turn.ask) return s;
                return { ...s, turn: { ...s.turn, work: s.turn.work || work, ask } };
            }
            case 'tool/call': {
                const turn = turnOf(s);
                const id = str(data.callId, 200);
                if (!id) return s;
                const calls = { ...turn.calls, [id]: { name: str(data.name, 80), args: str(typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}), 2000) } };
                const keys = Object.keys(calls);
                if (keys.length > MAX_CALLS) delete calls[keys[0]];
                return { ...s, turn: { ...turn, calls } };
            }
            case 'tool/result': {
                const turn = turnOf(s);
                const message = isRecord(data.message) ? data.message : {};
                const id = str(message.toolCallId ?? message.source?.callId, 200);
                const call = turn.calls[id];
                if (!call) return s;
                const item = itemOf({ name: call.name, args: call.args, text: textOfContent(message.content), isError: message.isError === true });
                const { [id]: _done, ...calls } = turn.calls;
                if (!item) return { ...s, turn: { ...turn, calls } };
                return { ...s, turn: { ...turn, calls, items: capItems([...turn.items, { ...item, seq: event.seq ?? 0 }]) } };
            }
            case 'assistant/message': {
                const text = replyText(data.message);
                if (!text) return s;
                const turn = turnOf(s);
                return { ...s, turn: { ...turn, text: text.slice(0, 20000), textSeq: event.seq ?? 0 } };
            }
            case 'turn/end': {
                if (!s.turn) return s;
                const turn = s.turn;
                const finished = (data.reason?.kind ?? 'completed') === 'completed';
                const fresh = finished ? judged(turn, s.prev, event.time ?? 0) : [];
                const prev = turn.items.length > 0 ? { n: turn.n, items: turn.items, ask: turn.ask ?? '' } : s.prev;
                const claims = fresh.length ? [...s.claims, ...fresh].slice(-MAX_CLAIMS) : s.claims;
                return { ...s, turn: null, prev, claims };
            }
            default:
                return s;
        }
    } catch {
        return isRecord(state) ? state : INITIAL;
    }
}

const VERDICTS = new Set(['backed', 'unbacked', 'contradicted']);

function parseClaim(c) {
    if (!isRecord(c) || typeof c.id !== 'string' || !VERDICTS.has(c.verdict)) return undefined;
    return {
        id: c.id.slice(0, 40),
        turn: Number.isSafeInteger(c.turn) ? c.turn : 0,
        seq: Number.isSafeInteger(c.seq) ? c.seq : 0,
        at: Number.isFinite(c.at) ? c.at : 0,
        kind: ['passed', 'deployed', 'fixed', 'done'].includes(c.kind) ? c.kind : 'done',
        ...(typeof c.subject === 'string' ? { subject: c.subject.slice(0, 10) } : {}),
        ...(typeof c.target === 'string' ? { target: c.target.slice(0, 10) } : {}),
        text: str(c.text, 400),
        part: str(c.part ?? c.text, 200),
        verdict: c.verdict,
        evidence: Array.isArray(c.evidence) ? c.evidence.filter((e) => typeof e === 'string').slice(0, 3).map((e) => e.slice(0, 200)) : [],
        why: str(c.why, 300),
        ...(Number.isSafeInteger(c.from) ? { from: c.from } : {}),
    };
}

function parseItems(items) {
    if (!Array.isArray(items)) return [];
    return items.filter((i) => isRecord(i) && typeof i.kind === 'string' && typeof i.text === 'string').slice(-MAX_ITEMS).map((i) => {
        const { lines, pairs, checks, ...rest } = i;
        const kept = Array.isArray(lines) ? lines.filter((l) => typeof l === 'string').slice(0, 8).map((l) => l.slice(0, 120)) : [];
        const hashes = Array.isArray(pairs) ? pairs.filter((p) => isRecord(p) && typeof p.h === 'string' && typeof p.f === 'string').slice(0, 8) : [];
        const names = Array.isArray(checks) ? checks.filter((c) => typeof c === 'string').slice(0, 16).map((c) => c.slice(0, 60)) : [];
        return { ...rest, ...(kept.length ? { lines: kept } : {}), ...(hashes.length ? { pairs: hashes } : {}), ...(names.length ? { checks: names } : {}) };
    });
}

/** Saved state back from DSH's cache: anything unknown becomes the empty ledger. Never throws. */
export function parseState(value) {
    try {
        if (!isRecord(value) || value.v !== 1) return INITIAL;
        const t = value.turn;
        const turn = isRecord(t) ? {
            n: Number.isSafeInteger(t.n) ? t.n : 0,
            seq: Number.isSafeInteger(t.seq) ? t.seq : 0,
            at: Number.isFinite(t.at) ? t.at : 0,
            items: parseItems(t.items),
            calls: isRecord(t.calls) ? Object.fromEntries(Object.entries(t.calls).filter(([, c]) => isRecord(c) && typeof c.name === 'string').slice(-MAX_CALLS).map(([k, c]) => [k, { name: str(c.name, 80), args: str(c.args, 2000) }])) : {},
            text: str(t.text, 20000),
            textSeq: Number.isSafeInteger(t.textSeq) ? t.textSeq : 0,
            work: t.work === true,
            ask: str(t.ask, MAX_ASK),
        } : null;
        const p = value.prev;
        const prev = isRecord(p) ? { n: Number.isSafeInteger(p.n) ? p.n : 0, items: parseItems(p.items), ask: str(p.ask, MAX_ASK) } : null;
        const claims = Array.isArray(value.claims) ? value.claims.map(parseClaim).filter(Boolean).slice(-MAX_CLAIMS) : [];
        if (value.check === true) return { v: 1, turn: null, prev: null, claims: [], check: true, ...(Number.isSafeInteger(value.first) ? { first: value.first } : {}) };
        return { v: 1, turn, prev, claims };
    } catch {
        return INITIAL;
    }
}


/** Views by the claims list they came from: DSH sends a session's view to the window only when it is a new object. */
const VIEWS = new WeakMap();
const NO_CLAIMS = Object.freeze({ total: 0, flagged: Object.freeze([]) });
const A_CHECK = Object.freeze({ total: 0, flagged: Object.freeze([]), check: true });
/** A check thread's view, one per first turn so DSH sends it once. */
const CHECK_VIEWS = new Map();
function checkView(first) {
    if (!Number.isSafeInteger(first)) return A_CHECK;
    if (!CHECK_VIEWS.has(first)) {
        if (CHECK_VIEWS.size >= 100) CHECK_VIEWS.clear();
        CHECK_VIEWS.set(first, Object.freeze({ total: 0, flagged: Object.freeze([]), check: true, first }));
    }
    return CHECK_VIEWS.get(first);
}

/** What the window and DSH's session list get: how many claims, and the flagged ones (a check thread says only that it is one). */
export function viewOf(state) {
    if (isRecord(state) && state.check === true) return checkView(state.first);
    const claims = isRecord(state) && Array.isArray(state.claims) ? state.claims : undefined;
    if (!claims || claims.length === 0) return NO_CLAIMS;
    const known = VIEWS.get(claims);
    if (known) return known;
    const view = viewFrom(claims);
    VIEWS.set(claims, view);
    return view;
}

function viewFrom(claims) {
    const shown = claims.filter(flagged).slice(-MAX_VIEW).map((c) => ({
        id: c.id, turn: c.turn, seq: c.seq, at: c.at, kind: c.kind, verdict: c.verdict, text: c.text, part: c.part ?? c.text, why: c.why, evidence: c.evidence.slice(0, 2),
        ...(c.from !== undefined ? { from: c.from } : {}),
    }));
    return { total: claims.length, flagged: shown };
}

/** A view back from DSH: anything unknown is no claims. */
export function parseView(value) {
    if (!isRecord(value) || !Array.isArray(value.flagged)) return { total: 0, flagged: [] };
    if (value.check === true) return { total: 0, flagged: [], check: true, ...(Number.isSafeInteger(value.first) ? { first: value.first } : {}) };
    const shown = value.flagged.map(parseClaim).filter(Boolean).slice(-MAX_VIEW);
    return { total: Number.isSafeInteger(value.total) ? value.total : shown.length, flagged: shown };
}

/** The projection definition for DSH's `ctx.sessionProjections.register`. */
export function proofProjection() {
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

/** Fold a whole log (a cold session's, or a test's). */
export function foldAll(events) {
    let state = INITIAL;
    for (const event of events ?? []) state = applyEvent(state, event);
    return state;
}

/** Whether a claim is flagged (shown on its turn). */
export const flagged = (claim) => claim?.verdict === 'unbacked' || claim?.verdict === 'contradicted';
