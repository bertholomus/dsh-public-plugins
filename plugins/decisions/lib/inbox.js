/**
 * The inbox: everything waiting on a person, kept current from the
 * watcher's events, and Decisions' ways to answer it.
 *
 * Cards come from what the suite already knows (lib/cards.js): the ask at
 * the end of each session's last reply, DSH's question box, the
 * coordinator's thread roster, approvals, and the questions suite plugins
 * raise. Approvals and question-box calls asked while Decisions runs are
 * also held (lib/holds.js), so they can be answered here as well as in the
 * session.
 *
 * Nothing polls: the watcher's events start a scan, which finds new cards,
 * tells the person (the notifications plugin, the mirror) once per card
 * across restarts, and moves the page's channel. Every answer is logged
 * when it goes and again when the session's own log proves it arrived (or
 * shows it did not); a failed answer puts the card back with the reason.
 *
 * @module dsh-plugin-decisions/inbox
 */
import { clip, errorText, isRecord, later } from './shared/safe.js';
import { cutOff, plainError } from './shared/words.js';
import { APPROVAL_ANSWERS, Holds, approvalProof, approvalWords, lateAnswerProof, questionProof } from './holds.js';
import { ANSWER_MAX, answerMessage, answerWords, askCard, byUrgency, checkAnswers, coordinatorView, handbacksOf, headline, lead, ownThreadCard, questionCards, readable, replyCard, threadCards, threadsOf } from './cards.js';

/** Ids kept per list in the store (the newest). */
const KEEP = 600;

/** More new cards than this at once make one notification, not one each. */
const NOTIFY_EACH = 3;

/** How long an answer may take to show in the session's log before it is reported unconfirmed. */
const PROOF_MS = 10 * 60 * 1000;

/**
 * How long a coordinator thread's own question stands before it is listed,
 * when its turn did not hand back: the coordinator nudges such a thread at
 * once ("Finish the task and call thread_handback"), and the handback that
 * follows is the card.
 */
const THREAD_SETTLE_MS = 5000;

/** How long reading a reply's text from its session's log may take (a restart leaves it out of the saved state). */
const READ_MS = 15000;

/** The most of a reply kept for its card's lines and pick, from its end. */
const TEXT_KEEP = 8000;

/** A stored id list: `{ [cardId]: ms }`, only well-formed entries. */
function idMap(value) {
    if (!isRecord(value)) return {};
    const out = {};
    for (const [id, at] of Object.entries(value)) if (typeof id === 'string' && id.length <= 400 && Number.isFinite(at)) out[id] = at;
    return out;
}

/** Requests held when they were last seen, by card id, so a restart can say what became of them. */
function heldMap(value) {
    if (!isRecord(value)) return {};
    const out = {};
    for (const [id, item] of Object.entries(value).slice(-100)) {
        if (typeof id !== 'string' || id.length > 400 || !isRecord(item) || typeof item.sessionId !== 'string' || !['approval', 'question'].includes(item.kind)) continue;
        out[id] = {
            sessionId: item.sessionId.slice(0, 128),
            kind: item.kind,
            title: typeof item.title === 'string' ? item.title.slice(0, 120) : '',
            question: typeof item.question === 'string' ? item.question.slice(0, 300) : '',
            at: Number.isFinite(item.at) ? item.at : 0,
            ...(Number.isSafeInteger(item.turn) && item.turn >= 0 ? { turn: item.turn } : {}),
            ...(item.released === 'off' || item.released === 'kind' ? { released: item.released } : {}),
        };
    }
    return out;
}

/** Handbacks seen in coordinating chats, by "<thread>:<at>" (the newest 200): what a chat's relay can be about. */
function handbackMap(value) {
    if (!isRecord(value)) return {};
    const kept = Object.entries(value)
        .filter(([key, item]) => typeof key === 'string' && key.length <= 300 && isRecord(item) && typeof item.thread === 'string' && typeof item.chat === 'string' && Number.isFinite(item.at))
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 200);
    return Object.fromEntries(kept.map(([key, item]) => [key, { thread: item.thread.slice(0, 128), chat: item.chat.slice(0, 128), at: item.at, asks: item.asks === true }]));
}

/** When the once-an-hour notes were last said: `{ [note]: { at, text } }`. */
function saidMap(value) {
    if (!isRecord(value)) return {};
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 20)) {
        if (typeof key === 'string' && key.length <= 40 && isRecord(item) && Number.isFinite(item.at)) out[key] = { at: item.at, text: typeof item.text === 'string' ? item.text.slice(0, 300) : '' };
    }
    return out;
}

/** Each setting's hash when Decisions last ran (lib/config.js settingHashes), or undefined. */
function settingsMap(value) {
    if (!isRecord(value)) return undefined;
    const out = {};
    for (const [key, hash] of Object.entries(value).slice(0, 40)) if (key.length <= 60 && typeof hash === 'string' && hash.length <= 64) out[key] = hash;
    return out;
}

/** Make a stored value safe. */
export function parseData(value) {
    return {
        version: 1,
        seeded: value?.seeded === true,
        seen: idMap(value?.seen),
        dismissed: idMap(value?.dismissed),
        answered: idMap(value?.answered),
        held: heldMap(value?.held),
        handbacks: handbackMap(value?.handbacks),
        // Notes said at most once an hour (a notification that could not show, the mirror held back or unable
        // to send): when each was last said, so a restart does not say them again.
        said: saidMap(value?.said),
        // When the mirror's messages of the last hour went (sent ones only), for its hourly limit.
        sent: Array.isArray(value?.sent) ? value.sent.filter((at) => Number.isFinite(at)).slice(-500) : [],
        // Each setting's hash when Decisions last ran, so a start can say what an edit of DSH's profile changed.
        ...(settingsMap(value?.settings) ? { settings: settingsMap(value.settings) } : {}),
    };
}

/** What became of a notification, from the notifications plugin's answer. */
export function notifyOutcome(result) {
    switch (result) {
        case 'desktop': return { state: 'shown', where: 'on this computer' };
        case 'browser': return { state: 'shown', where: 'in the DSH window' };
        case 'cli': return { state: 'shown', where: 'by the system' };
        case 'off': return { state: 'not shown', reason: 'notifications are switched off in the Notifications plugin\'s settings' };
        case 'none': return { state: 'not shown', reason: 'nothing could show it: no DSH window is open, and the system did not take it' };
        case undefined: return { state: 'not shown', reason: 'the Notifications plugin is not running' };
        default: return { state: 'not shown', reason: typeof result === 'string' ? result : 'the Notifications plugin gave no answer' };
    }
}

/**
 * What became of a request Decisions held that no longer waits and has no
 * outcome in the log (a restart cut its turn off, or it went back to DSH's
 * own card when Decisions or its kind was switched off): answered in the
 * session when its turn went on, else stopped. Undefined while it still
 * waits in the session, or while the session cannot be read.
 */
export function heldOutcome(id, entry, row) {
    const state = row?.state;
    if (!isRecord(state)) return undefined;
    const running = row.status === 'running';
    const turn = Number(entry.turn) || 0;
    if (running && entry.kind === 'approval' && (state.approvals ?? []).some((item) => `approval:${entry.sessionId}:${item.call ?? item.id}` === id)) return undefined;
    if (running && entry.kind === 'question' && state.asking && `question:${entry.sessionId}:${state.asking.call}` === id) return undefined;
    const end = isRecord(state.end) ? state.end : undefined;
    const ended = end !== undefined && (Number(end.turn) || 0) >= turn;
    // Its turn is going on, or ended as a turn does: the session's own card took the answer.
    const wentOn = (running && state.open && (Number(state.turn) || 0) === turn && state.cancelled?.kind !== entry.kind)
        || (ended && !cutOff(end) && end.kind === 'completed');
    return wentOn
        ? { text: 'Answered in the session', state: 'answered' }
        : { text: 'The turn stopped before anyone answered', state: 'stopped' };
}

/** Keep the newest `keep` ids of a map. */
function trimmed(map, keep = KEEP) {
    const entries = Object.entries(map);
    if (entries.length <= keep) return map;
    return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, keep));
}

/** DSH's question-box refusals in words. */
function questionRefusal(error) {
    switch (error?.code) {
        case 'REPLY_QUEUED': return 'an answer to this question is already waiting to be read';
        case 'BAD_ANSWER': return 'the answer must cover each question once';
        case 'CALLER_NOT_LIVE':
        case 'DELEGATED_CALLER': return 'the session cannot take answers right now; open it and answer there';
        default: return plainError(errorText(error, 200));
    }
}

const sessionWords = (card) => (card.title ? `“${clip(card.title, 80)}”` : 'the session');

/** How near a handback and the chat's message that relays it are, when the chat's state does not name its sender. */
const RELAY_MS = 10000;

/**
 * The open thread card a coordinating chat's last reply answers: the
 * chat's last message came from that thread (the coordinator relays a
 * handback as the thread's message), so its reply is about the handback.
 */
export function relayedThread(state, cards) {
    if (!cards.length || state?.inKind !== 'agent-message') return undefined;
    if (typeof state.inFrom === 'string') return cards.find((card) => card.sessionId === state.inFrom);
    const inAt = Number(state.inAt) || 0;
    return cards.find((card) => card.at > 0 && Math.abs(card.at - inAt) <= RELAY_MS);
}

/**
 * The handback a coordinating chat's last message relays, among those
 * Decisions has seen in that chat: the newest one from the message's
 * sender (or, when the chat's state names none, the one that came at the
 * same time) that came before the message. Returned only when it asked the
 * person: the chat's reply to it says the same thing, so it is never a card
 * of its own, while the thread's card waits and after it is answered.
 * @param {object | undefined} state - the chat's watcher state.
 * @param {Array<{ thread: string, at: number, asks: boolean }>} handbacks - the chat's handbacks.
 */
export function relayedHandback(state, handbacks) {
    if (!handbacks.length || state?.inKind !== 'agent-message') return undefined;
    const inAt = Number(state.inAt) || 0;
    const from = typeof state.inFrom === 'string' ? state.inFrom : undefined;
    const before = handbacks
        .filter((h) => (from ? h.thread === from : Math.abs(h.at - inAt) <= RELAY_MS) && (!inAt || h.at <= inAt + RELAY_MS))
        .sort((a, b) => b.at - a.at)[0];
    return before?.asks ? before : undefined;
}

/** What an asker's outcome (`askOutcome`) makes of an answer's log entry. */
const OUTCOME_STATES = Object.freeze({ delivered: 'delivered', 'not proven': 'not confirmed', 'not delivered': 'not delivered', 'typed in': 'typed in' });

export class Inbox {
    /**
     * @param {object} options
     * @param {import('../../session-watch/lib/watch.js').SessionWatch} options.watch
     * @param {object} options.config
     * @param {import('./shared/files.js').JsonStore} options.store
     * @param {import('./shared/journal.js').Journal} options.journal
     * @param {{ warn: Function }} [options.logger]
     * @param {(item: object) => void} [options.notify]
     * @param {import('./mirror.js').Mirror} [options.mirror]
     * @param {() => any} [options.questions] - DSH's question service, when it runs.
     * @param {() => void} [options.changed] - what the page shows changed.
     * @param {() => number} [options.now]
     * @param {typeof later} [options.after]
     */
    constructor({ watch, config, store, journal, logger, notify, mirror, questions, changed, now = Date.now, after = later }) {
        this.watch = watch;
        this.config = config;
        this.store = store;
        this.journal = journal;
        this.logger = logger;
        this.notify = notify;
        this.mirror = mirror;
        this.questions = questions ?? (() => undefined);
        this.changedHook = changed;
        this.now = now;
        this.after = after;
        this.holds = new Holds({ logger, now, titleOf: (id) => attemptTitle(watch, id), onChange: (change) => this.onHold(change) });
        /** Card ids an answer is on its way to. */
        this.answering = new Set();
        /** The reason an answer failed, by card id, until the card goes or is answered again. */
        this.errors = new Map();
        /** Answers waiting for the session's log to prove them. */
        this.proofs = new Set();
        this.started = false;
        this.scanning = false;
        this.again = false;
        this.queued = false;
        this.print = '';
        /** Replies read from cold sessions' logs, by session: `{ turn, text }` (text undefined when it could not be read). */
        this.texts = new Map();
        /** "<session>:<turn>" being read now. */
        this.reading = new Set();
        /** Reads go one at a time. */
        this.reads = Promise.resolve();
    }

    changed() {
        try { this.changedHook?.(); } catch { /* the page refreshes on its next change */ }
    }

    // ── Life ───────────────────────────────────────────────────────────

    start() {
        if (this.started) return;
        this.started = true;
        this.holds.resume();
        this.off = this.watch.on((event) => this.onWatch(event));
        this.soon(0);
    }

    stop() {
        this.started = false;
        this.off?.();
        this.off = undefined;
        this.holds.stop();
        this.proofs.clear();
    }

    onWatch(event) {
        if (!this.started || !isRecord(event)) return;
        if (event.type === 'ask' && event.change === 'outcome') {
            this.onOutcome(event);
            return;
        }
        if (typeof event.sessionId === 'string') for (const proof of [...this.proofs]) if (proof.sessionId === event.sessionId) this.prove(proof);
        if (event.type === 'delivery') return;
        this.soon();
    }

    /** Scan shortly: events come in bursts, one scan follows them. */
    soon(ms = 400) {
        if (!this.started || this.queued) return;
        this.queued = true;
        this.after(this.logger, 'decisions: scan', ms, () => {
            this.queued = false;
            return this.scan();
        });
    }

    onHold(change) {
        const card = change.card;
        const data = this.store.data;
        if (change.type === 'held') {
            // Kept until its outcome is in the log, so a restart that cuts its turn off can say so.
            let turn;
            try { turn = this.watch.stateOf?.(card.sessionId)?.turn; } catch { /* the turn is not needed to say what became of it */ }
            data.held[card.id] = {
                sessionId: card.sessionId,
                kind: card.kind,
                title: card.title ?? '',
                question: clip(String(card.question ?? ''), 300),
                at: card.at || this.now(),
                ...(Number.isSafeInteger(turn) ? { turn } : {}),
            };
            this.store.change();
            this.soon(30);
            this.changed();
            return;
        }
        // Answered here or in the session: its outcome is logged where it was taken. Let go (Decisions or its
        // kind switched off): the session's own card still waits, and a later scan says what became of it.
        if (change.by !== 'released' && Object.hasOwn(data.held, card.id)) {
            delete data.held[card.id];
            this.store.change();
        }
        if (change.by === 'released') {
            const why = change.why === 'kind' ? 'kind' : 'off';
            if (Object.hasOwn(data.held, card.id)) {
                data.held[card.id] = { ...data.held[card.id], released: why };
                this.store.change();
            }
            this.journal.add({
                kind: 'released',
                cardId: card.id,
                sessionId: card.sessionId,
                title: card.title,
                text: 'Handed back to the session\'s own card',
                why: why === 'kind'
                    ? `${card.kind === 'approval' ? 'Approvals were' : 'Questions in the question box were'} switched off in Decisions' settings while Decisions held this; answer it in the session.`
                    : 'Decisions stopped while it held this; answer it in the session.',
                question: card.question,
                state: 'handed back',
            });
        }
        // A question whose wait ran out stays open as a late question; nothing to log.
        if (change.by === 'window' && this.started && change.code !== 'ASK_TIMED_OUT') {
            const answered = change.error === undefined;
            this.journal.add({
                kind: 'elsewhere',
                cardId: card.id,
                sessionId: card.sessionId,
                title: card.title,
                text: answered ? `Answered in the session: ${card.kind === 'approval' ? (change.value === 'allowed-once' ? 'allowed once' : change.value === 'rejected' ? 'rejected' : String(change.value ?? '')) : 'the question box'}` : 'The turn stopped before anyone answered',
                question: card.question,
                state: answered ? 'answered' : 'stopped',
            });
        }
        this.soon(30);
        this.changed();
    }

    // ── Cards ──────────────────────────────────────────────────────────

    /**
     * Everything waiting, most urgent first, and what the person dismissed.
     * Never throws: what cannot be read is left out.
     * @returns {Promise<{ waiting: object[], dismissed: object[] }>}
     */
    async list() {
        const config = this.config;
        const now = this.now();
        const windowMs = config.windowHours * 3600000;
        const data = this.store.data;
        let rows = [];
        try { rows = await this.watch.list(); } catch (error) { this.logger?.warn?.(`decisions: could not read the sessions: ${errorText(error)}`); }
        const byId = new Map(rows.map((row) => [row.sessionId, row]));
        const found = new Map();
        const add = (card) => { if (card && !found.has(card.id)) found.set(card.id, card); };
        const handbacks = [];
        // Which chat coordinates each thread session, so a card from inside a thread says whose thread it is.
        const chats = new Map();
        // Coordinator threads' own questions, made the thread's cards once every chat is read.
        const own = [];
        // A held request's title as DSH lists it now (a new session's title may come after its first request).
        for (const card of this.holds.cards()) {
            if (config[card.kind === 'approval' ? 'approvals' : 'questions'] === false) continue;
            const row = byId.get(card.sessionId);
            // DSH 0.2.0 names no call for a question it asks: the session's state has the question-box call that waits, so its answer is proven too.
            const asking = card.kind === 'question' && !card.callId && typeof row?.state?.asking?.call === 'string' ? row.state.asking.call : undefined;
            add({ ...card, title: row?.title || card.title, ...(asking ? { callId: asking } : {}) });
        }
        for (const row of rows) {
            if (!readable(row)) continue;
            try {
                if (config.approvals && row.status === 'running') {
                    for (const item of row.state?.approvals ?? []) {
                        const words = approvalWords({ toolName: item.tool, reason: item.reason });
                        const id = `approval:${row.sessionId}:${item.call ?? item.id}`;
                        const released = data.held[id]?.released;
                        add({
                            id,
                            kind: 'approval',
                            sessionId: row.sessionId,
                            title: row.title || 'Untitled session',
                            tool: item.tool,
                            question: words.question,
                            ...(words.why ? { detail: words.why } : {}),
                            at: Number(item.at) || 0,
                            running: true,
                            answer: 'open',
                            // Decisions held it, and gave it back to the session's own card when it (or approvals) was switched off.
                            ...(released ? { released, hint: released === 'kind'
                                ? 'Decisions handed this back to the session\'s own card when approvals were switched off in its settings: answer it in the session.'
                                : 'Decisions handed this back to the session\'s own card when it stopped: answer it in the session.' } : {}),
                        });
                    }
                }
                if (config.questions) {
                    for (const card of questionCards(row, this.watch.projection?.(row.sessionId, 'userQuestions'))) {
                        if (card.answer === 'open' && row.status !== 'running') continue;
                        if (card.answer === 'questions' && windowMs > 0 && now - (Number(row.updatedAt) || 0) > windowMs) continue;
                        add(card);
                    }
                }
                const projection = this.watch.projection?.(row.sessionId, 'coordinatorSession');
                const asked = this.replyCardOf(row, { replies: config.replies, windowMs, now });
                // A coordinator thread's own question is the thread's card, under the id its handback takes.
                const view = asked && config.threads ? coordinatorView(projection?.value) : undefined;
                if (view?.role === 'thread') own.push({ card: asked, view });
                else add(asked);
                for (const thread of threadsOf(row, projection)) chats.set(thread.session, thread.chat);
                if (config.threads) {
                    for (const card of threadCards(row, projection, byId, (id) => coordinatorView(this.watch.projection?.(id, 'coordinatorSession')?.value))) add(card);
                    handbacks.push(...handbacksOf(row, projection));
                }
            } catch (error) {
                this.logger?.warn?.(`decisions: could not read ${row.sessionId}: ${errorText(error)}`);
            }
        }
        for (const ask of this.watch.asks?.() ?? []) add(askCard(ask, byId));
        // A thread's own question and its handback, for the same turn, are one card under one id: the handback's
        // words (they are written for the person), the reply's pick when it has one (so it never changes when the
        // handback lands late). Asked without a handback, it stands a few seconds first: the coordinator nudges such
        // a thread to hand back at once, and the handback is the card.
        for (const { card, view } of own) {
            const chat = chats.get(card.sessionId) ?? (typeof view.coordinator === 'string' && byId.has(view.coordinator) ? { sessionId: view.coordinator, title: byId.get(view.coordinator).title || 'Untitled session' } : undefined);
            const thread = ownThreadCard(card, view, chat);
            const handback = found.get(thread.id);
            if (handback) {
                if (thread.recommendation) handback.recommendation = thread.recommendation;
                if (thread.reading) handback.reading = true;
                continue;
            }
            const left = THREAD_SETTLE_MS - (now - (thread.at || now));
            if (!thread.handedBack && left > 0) {
                this.soon(left + 50);
                continue;
            }
            add(thread);
        }
        // Thread cards were keyed by their handback's time before: what was seen, dismissed or answered under that id carries over.
        for (const card of found.values()) if (card.legacy) this.carry(card.legacy, card.id);
        // A thread's handback, its own last reply and its coordinating chat's relay of it say the same
        // thing: keep the handback's card, with any recommendation. Once the handback is answered (here,
        // in the thread or in the chat), the chat's relay of it asks nothing new: it is not listed again.
        const threads = [...found.values()].filter((card) => card.kind === 'thread');
        const known = config.threads ? this.rememberHandbacks(handbacks) : [];
        for (const card of [...found.values()]) {
            if (!['decision', 'blocked', 'reply'].includes(card.kind)) continue;
            const chat = byId.get(card.sessionId)?.state;
            const open = threads.find((t) => t.sessionId === card.sessionId) ?? relayedThread(chat, threads.filter((t) => t.via?.sessionId === card.sessionId));
            if (!open && !relayedHandback(chat, known.filter((h) => h.chat === card.sessionId))) continue;
            found.delete(card.id);
            if (open && card.recommendation && !open.recommendation) open.recommendation = card.recommendation;
        }
        for (const card of found.values()) {
            if (card.kind !== 'thread' && !card.via && chats.has(card.sessionId)) card.via = chats.get(card.sessionId);
        }
        const waiting = [];
        const dismissed = [];
        for (const card of found.values()) {
            if (Object.hasOwn(data.answered, card.id) && !this.errors.has(card.id)) continue;
            // How long it has waited: from when it was first seen, which a re-raise or a restart does not move.
            const first = Math.min(card.at || Infinity, data.seen[card.id] || Infinity);
            const { legacy, ...shown } = card;
            const item = {
                ...shown,
                at: Number.isFinite(first) ? first : now,
                ...(this.errors.has(card.id) ? { error: this.errors.get(card.id) } : {}),
                ...(this.answering.has(card.id) ? { sending: true } : {}),
            };
            if (Object.hasOwn(data.dismissed, card.id)) dismissed.push({ ...item, dismissedAt: data.dismissed[card.id] });
            else waiting.push(item);
        }
        for (const id of [...this.errors.keys()]) if (!found.has(id)) this.errors.delete(id);
        waiting.sort(byUrgency);
        dismissed.sort((a, b) => b.dismissedAt - a.dismissedAt);
        return { waiting, dismissed, rows: byId };
    }

    /**
     * A session's reply card, with the reply's lines and pick: the reply's
     * text is not in a row; the watcher's state has it while the session is
     * loaded. A session that is not (after a restart, say) has it only in its
     * log, which is read once per turn, in the background: until then the card
     * says `reading`, and is not announced.
     */
    replyCardOf(row, options) {
        const bare = replyCard(row, options);
        if (!bare) return undefined;
        const turn = row.state.ask.turn;
        let full;
        try { full = this.watch.stateOf?.(row.sessionId); } catch { full = undefined; }
        if (typeof full?.text === 'string' && full.textTurn === turn) return replyCard(row, { ...options, reply: { text: full.text, turn } });
        const kept = this.texts.get(row.sessionId);
        if (kept?.turn === turn) return typeof kept.text === 'string' ? replyCard(row, { ...options, reply: kept }) : bare;
        if (typeof this.watch.fullState !== 'function') return bare;
        this.readReply(row.sessionId, turn);
        return { ...bare, reading: true };
    }

    /** Read a cold session's reply from its log, once per turn, then scan again. */
    readReply(sessionId, turn) {
        const key = `${sessionId}:${turn}`;
        if (this.reading.has(key)) return;
        this.reading.add(key);
        this.reads = this.reads.then(async () => {
            let timer;
            const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(READ_MS) : undefined;
            const late = new Promise((resolve) => {
                timer = setTimeout(resolve, READ_MS + 1000);
                timer.unref?.();
            });
            let state;
            try {
                state = await Promise.race([this.watch.fullState(sessionId, signal), late]);
            } catch (error) {
                this.logger?.warn?.(`decisions: could not read the reply of ${sessionId}: ${errorText(error)}`);
            } finally {
                clearTimeout(timer);
            }
            const text = typeof state?.text === 'string' && state.textTurn === turn ? state.text.slice(-TEXT_KEEP) : undefined;
            this.texts.set(sessionId, { turn, text });
            if (this.texts.size > 300) this.texts.delete(this.texts.keys().next().value);
            this.reading.delete(key);
            this.soon(30);
        });
    }

    /** What was seen, dismissed or answered under a card's old id goes with its new one. */
    carry(from, to) {
        const data = this.store.data;
        let changed = false;
        for (const name of ['seen', 'dismissed', 'answered']) {
            if (Object.hasOwn(data[name], from) && !Object.hasOwn(data[name], to)) {
                data[name][to] = data[name][from];
                changed = true;
            }
        }
        if (changed) this.store.change();
    }

    /**
     * Keep the handbacks just seen, so a chat's relay of one is still known
     * after its thread's card goes (answered, or the thread moved on) and
     * after a restart.
     * @param {Array<{ thread: string, chat: string, at: number, asks: boolean }>} seen
     * @returns {Array<{ thread: string, chat: string, at: number, asks: boolean }>} every handback kept.
     */
    rememberHandbacks(seen) {
        const data = this.store.data;
        let changed = false;
        for (const item of seen) {
            const key = `${item.thread}:${item.at}`;
            const was = data.handbacks[key];
            if (was && was.asks === item.asks && was.chat === item.chat) continue;
            data.handbacks[key] = { thread: item.thread, chat: item.chat, at: item.at, asks: item.asks };
            changed = true;
        }
        if (changed) {
            data.handbacks = parseData({ handbacks: data.handbacks }).handbacks;
            this.store.change();
        }
        return Object.values(data.handbacks);
    }

    /**
     * Say what became of held requests that no longer wait and have no
     * outcome in the log: a restart cut their turn off, or the session's own
     * card took the answer while Decisions was off.
     * @param {Map<string, object>} rows - the sessions as just listed.
     */
    async settleHeld(rows) {
        const data = this.store.data;
        let changed = false;
        for (const [id, entry] of Object.entries(data.held)) {
            if (this.holds.get(id)) continue;
            let row = rows.get(entry.sessionId);
            // A session that is not loaded may have a saved state from before the request (DSH saves it at a
            // turn's end): its log says what happened.
            if (row && row.status !== 'running' && row.status !== 'idle' && !((Number(row.state?.at) || 0) >= entry.at)) {
                let state;
                try { state = await this.watch.fullState?.(entry.sessionId); } catch { /* read again on the next scan */ }
                if (isRecord(state)) row = { ...row, state };
            }
            // A session that cannot be read is let go after a day, unsaid.
            const outcome = row ? heldOutcome(id, entry, row) : this.now() - entry.at > 86400000 ? null : undefined;
            if (outcome === undefined) continue;
            delete data.held[id];
            changed = true;
            if (!outcome) continue;
            this.journal.add({
                kind: 'elsewhere',
                cardId: id,
                sessionId: entry.sessionId,
                title: row?.title || entry.title,
                text: outcome.text,
                question: entry.question,
                state: outcome.state,
                ...(outcome.state === 'stopped' ? { why: 'Decisions showed it, but the turn ended (a restart or a stop) before an answer came.' } : {}),
            });
        }
        if (changed) this.store.change();
    }

    /** Find new cards, tell the person about them once, and move the page. */
    async scan() {
        if (!this.started) return;
        if (this.scanning) {
            this.again = true;
            return;
        }
        this.scanning = true;
        try {
            const { waiting, dismissed, rows } = await this.list();
            if (Object.keys(this.store.data.held).length) await this.settleHeld(rows);
            const data = this.store.data;
            const now = this.now();
            // A card whose reply is still being read from its log is announced once it is read, with its lines and
            // pick; on the first look after install everything that waits is only listed, read or not.
            const unseen = (card) => !Object.hasOwn(data.seen, card.id) && (!card.reading || !data.seeded);
            const fresh = waiting.filter(unseen);
            for (const card of [...fresh, ...dismissed.filter(unseen)]) data.seen[card.id] = card.at || now;
            if (fresh.length) data.seen = trimmed(data.seen);
            if (!data.seeded) {
                // The first look after install: what waits already is listed, not announced.
                data.seeded = true;
                this.store.change();
            } else if (fresh.length) {
                this.store.change();
                this.announce(fresh);
            }
            // What the page shows of each card: a card's words change when its reply is read, or its thread's handback lands.
            const print = waiting.map((c) => `${c.id}|${c.running ? 1 : 0}|${c.error ?? ''}|${c.reading ? 1 : 0}|${String(c.question ?? '').length}|${String(c.context ?? '').length}|${c.recommendation ?? ''}`).join('\n');
            if (print !== this.print) {
                this.print = print;
                this.changed();
            }
        } catch (error) {
            this.logger?.warn?.(`decisions: scan failed: ${errorText(error)}`);
        } finally {
            this.scanning = false;
            if (this.again) {
                this.again = false;
                this.soon(50);
            }
        }
    }

    /** Log new cards, and tell the person: notifications (unless the raising plugin tells them itself) and the mirror. */
    announce(cards) {
        for (const card of cards) {
            this.journal.add({
                kind: 'new',
                cardId: card.id,
                ...(card.sessionId ? { sessionId: card.sessionId } : {}),
                title: card.title ?? '',
                // The row links the session, so its title is not said twice.
                text: card.sessionId ? lead(card) : headline(card),
                question: clip(String(card.question ?? ''), 300),
                ...(card.recommendation ? { recommendation: clip(card.recommendation, 200) } : {}),
            });
        }
        if (this.config.notify) {
            // Plugins' questions and threads' handbacks are announced by the plugin that raised them, and so are a thread's
            // approvals. A thread's own question that came without a handback is Decisions' to announce.
            const notable = cards.filter((card) => card.kind !== 'ask' && !(card.kind === 'thread' && (card.handback || card.handedBack)) && !(card.kind === 'approval' && this.inThread(card.sessionId)));
            if (notable.length > NOTIFY_EACH) {
                this.say({ title: 'Decisions', body: `${notable.length} things wait on you. Open Decisions to answer them.`, kind: 'decision' }, { count: notable.length });
            } else {
                for (const card of notable) this.say({ title: headline(card), body: clip(String(card.question ?? ''), 240), kind: 'decision', ...(card.sessionId ? { sessionId: card.sessionId } : {}) }, { card });
            }
        }
        if (this.mirror?.on) {
            for (const card of cards) {
                this.mirror.send(card).then(undefined, (error) => this.logger?.warn?.(`decisions: mirror: ${errorText(error)}`));
            }
        }
    }

    /** Whether a session is a coordinator's thread (the coordinator announces its approvals). */
    inThread(sessionId) {
        try { return coordinatorView(this.watch.projection?.(sessionId, 'coordinatorSession')?.value)?.role === 'thread'; } catch { return false; }
    }

    /**
     * Notify the person, and log what became of it: each notification shown,
     * and a reason it could not be shown once an hour (each card would give
     * the same one).
     * @param {object} item - the notification.
     * @param {{ card?: object, count?: number }} about - the card it is for, or how many it sums up.
     */
    say(item, { card, count } = {}) {
        let result;
        try {
            result = this.notify?.(item);
        } catch (error) {
            this.logger?.warn?.(`decisions: a notification failed: ${errorText(error)}`);
            result = `it failed: ${plainError(errorText(error, 160))}`;
        }
        // A notifier that answers later: its outcome is not known here.
        if (result && typeof result.then === 'function') {
            result.then(undefined, (error) => this.logger?.warn?.(`decisions: a notification failed: ${errorText(error)}`));
            result = 'desktop';
        }
        const outcome = notifyOutcome(result);
        const now = this.now();
        // A notification that could not show is said once an hour (kept across restarts), not for every card.
        const said = this.store.data.said;
        if (outcome.state !== 'shown') {
            if (said.unshown?.text === outcome.reason && now - said.unshown.at < 3600000) return;
            said.unshown = { at: now, text: outcome.reason };
            this.store.change();
        } else if (said.unshown) {
            delete said.unshown;
            this.store.change();
        }
        this.journal.add({
            kind: 'notify',
            ...(card?.id ? { cardId: card.id } : {}),
            ...(card?.sessionId ? { sessionId: card.sessionId } : {}),
            title: card?.title ?? '',
            text: outcome.state === 'shown'
                ? `Notified you ${outcome.where}${count ? ` of ${count} new cards` : ''}`
                : `Did not notify you${count ? ` of ${count} new cards` : ''}`,
            state: outcome.state,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
        });
    }

    /** The count the sidebar shows. */
    async badge() {
        const { waiting } = await this.list();
        return { waiting: waiting.length, urgent: waiting.filter((card) => card.answer === 'approval' || card.live).length };
    }

    // ── Answers ────────────────────────────────────────────────────────

    /**
     * Answer a card. `input` by the card's kind:
     * approval `{ decision: 'allow' | 'reject' }`; question box
     * `{ answers: [{ id, selected, custom? }] }`; a reply or a thread
     * `{ text }` or `{ recommended: true }`; a plugin's question
     * `{ option }` or `{ text }`.
     * @returns {Promise<{ state: string }>} where the answer is now.
     * @throws {Error} in words, when the answer cannot go.
     */
    async answer(id, input) {
        if (typeof id !== 'string' || id === '') throw new Error('Name what you are answering.');
        if (!isRecord(input)) throw new Error('The answer is empty.');
        if (this.answering.has(id)) throw new Error('An answer to this is already on its way.');
        const { waiting, dismissed } = await this.list();
        const card = [...waiting, ...dismissed].find((c) => c.id === id);
        if (!card) throw new Error('This is no longer waiting: it was answered, or the session moved on.');
        this.answering.add(id);
        this.errors.delete(id);
        this.changed();
        try {
            switch (card.answer) {
                case 'approval': return this.answerApproval(card, input);
                case 'questions': return await this.answerQuestions(card, input);
                case 'text': return await this.answerText(card, input);
                case 'ask': return await this.answerAsk(card, input);
                default: throw new Error('Only the session can answer this: open it and answer there.');
            }
        } finally {
            this.answering.delete(id);
            this.soon(30);
            this.changed();
        }
    }

    answered(card) {
        const data = this.store.data;
        data.answered[card.id] = this.now();
        data.answered = trimmed(data.answered);
        delete data.dismissed[card.id];
        this.store.change();
    }

    /** An answer that was taken failed later: the card comes back, saying why. */
    failed(card, reason) {
        delete this.store.data.answered[card.id];
        this.store.change();
        this.errors.set(card.id, reason);
        this.soon(30);
        this.changed();
    }

    logAnswer(card, fields) {
        return this.journal.add({
            kind: 'answer',
            cardId: card.id,
            cardKind: card.kind,
            ...(card.sessionId ? { sessionId: card.sessionId } : {}),
            title: card.title ?? '',
            question: clip(String(card.question ?? ''), 300),
            by: 'you',
            ...fields,
        });
    }

    answerApproval(card, input) {
        const outcome = APPROVAL_ANSWERS[input.decision];
        if (!outcome) throw new Error('Choose Allow once or Reject.');
        const entry = this.logAnswer(card, { text: input.decision === 'allow' ? 'Allowed once' : 'Rejected', answer: input.decision === 'allow' ? 'Allow once' : 'Reject', state: 'sending' });
        if (!this.holds.answer(card.id, outcome)) {
            const reason = 'the session answered it first, or its turn stopped';
            this.journal.set(entry.id, { state: 'not delivered', reason });
            throw new Error(`This approval is no longer waiting: ${reason}.`);
        }
        this.answered(card);
        if (card.callId) this.confirm(entry.id, card, (session) => approvalProof(session, card.callId, outcome));
        else this.journal.set(entry.id, { state: 'answered' });
        return { state: 'sending' };
    }

    async answerQuestions(card, input) {
        let batch;
        try { batch = checkAnswers(card.questions ?? [], input.answers); } catch (error) { throw new Error(errorText(error)); }
        const entry = this.logAnswer(card, { text: `Answered: ${answerWords(batch.answers)}`, answer: answerWords(batch.answers), state: 'sending' });
        if (card.live) {
            if (!this.holds.answer(card.id, batch)) {
                const reason = 'the session answered it first, or its turn stopped';
                this.journal.set(entry.id, { state: 'not delivered', reason });
                throw new Error(`This question is no longer waiting: ${reason}.`);
            }
            this.answered(card);
            if (card.callId) this.confirm(entry.id, card, (session) => questionProof(session, card.callId));
            else this.journal.set(entry.id, { state: 'answered' });
            return { state: 'sending' };
        }
        // Its wait ran out: DSH's question service takes the late answer into the session.
        const service = this.questions();
        if (typeof service?.answer !== 'function') {
            const reason = 'DSH\'s question box is not running here, so only the session can take this answer';
            this.journal.set(entry.id, { state: 'not delivered', reason });
            throw new Error(`Not sent: ${reason}.`);
        }
        let agent;
        try {
            agent = await this.watch.resolveAgent(card.sessionId);
        } catch (error) {
            const reason = `the session could not be opened (${plainError(errorText(error, 160))})`;
            this.journal.set(entry.id, { state: 'not delivered', reason });
            throw new Error(`Not sent: ${reason}.`);
        }
        let accepted;
        try {
            accepted = service.answer(agent, card.callId, batch);
        } catch (error) {
            const reason = questionRefusal(error);
            this.journal.set(entry.id, { state: 'not delivered', reason });
            throw new Error(`Not sent: ${reason}.`);
        }
        if (accepted === false) {
            const reason = 'the question was already answered';
            this.journal.set(entry.id, { state: 'not delivered', reason });
            throw new Error(`Not sent: ${reason}.`);
        }
        this.answered(card);
        this.journal.set(entry.id, { state: 'in the queue' });
        this.confirm(entry.id, card, (session) => lateAnswerProof(session, card.callId), { pending: 'in the queue' });
        return { state: 'in the queue' };
    }

    async answerText(card, input) {
        const recommended = input.recommended === true;
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (recommended && !card.recommendation) throw new Error('This has no recommendation to go with: write your answer.');
        if (!recommended && text === '') throw new Error('Write your answer first, or go with the recommendation.');
        if (text.length > ANSWER_MAX) throw new Error(`Keep the answer under ${ANSWER_MAX} characters.`);
        const message = answerMessage(card, { text, recommended });
        let running = false;
        try { running = (await this.watch.get(card.sessionId))?.status === 'running'; } catch { /* treated as idle */ }
        const entry = this.logAnswer(card, {
            text: recommended ? `Went with the recommendation: ${clip(card.recommendation, 160)}` : `Answered: ${clip(text, 160)}`,
            answer: recommended ? card.recommendation : text,
            note: message,
            state: 'sending',
            ...(running ? { why: 'The session was running, so the answer steers its current turn.' } : {}),
        });
        const delivery = await this.watch.deliver(card.sessionId, message, { mode: running ? 'steer' : 'queue' });
        if (delivery.state === 'failed') {
            this.journal.set(entry.id, { state: 'not delivered', reason: delivery.reason });
            throw new Error(`Not delivered: ${delivery.reason}.`);
        }
        this.answered(card);
        this.journal.set(entry.id, { state: delivery.state === 'delivered' ? 'delivered' : 'in the queue', ...(delivery.turn !== undefined ? { turn: delivery.turn } : {}) });
        delivery.done.then((done) => {
            if (done.state === 'delivered') {
                this.journal.set(entry.id, { state: 'delivered', ...(done.turn !== undefined ? { turn: done.turn } : {}) });
            } else {
                this.journal.set(entry.id, { state: 'not delivered', reason: done.reason });
                this.failed(card, `Not delivered: ${done.reason}.`);
            }
        }, (error) => this.logger?.warn?.(`decisions: ${errorText(error)}`));
        return { state: delivery.state === 'delivered' ? 'delivered' : 'in the queue' };
    }

    async answerAsk(card, input) {
        const option = typeof input.option === 'string' ? input.option : undefined;
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (option !== undefined && !card.options.some((o) => o.id === option)) throw new Error('That is not one of the choices.');
        if (option === undefined && (!card.freeText || text === '')) throw new Error(card.freeText ? 'Choose an answer or write one.' : 'Choose one of the answers.');
        if (text.length > ANSWER_MAX) throw new Error(`Keep the answer under ${ANSWER_MAX} characters.`);
        const label = option !== undefined ? card.options.find((o) => o.id === option).label : text;
        const entry = this.logAnswer(card, { text: `Answered ${card.source}: ${clip(label, 160)}`, answer: label, state: 'sending', askId: card.askId });
        const result = await this.watch.answerAsk(card.askId, option ?? text, 'you');
        if (!result?.ok) {
            const reason = plainError(String(result?.error ?? 'it did not take the answer'));
            this.journal.set(entry.id, { state: 'not delivered', reason });
            throw new Error(`Not sent: ${reason}`);
        }
        this.answered(card);
        // What the plugin that asked does with it, in its words. One that proves it only later (an answer
        // typed into a coding agent's terminal) says what became of it then (onOutcome).
        const told = typeof result.text === 'string' && result.text.trim() ? clip(result.text.trim(), 300) : undefined;
        this.journal.set(entry.id, { state: 'answered', why: told ?? `${card.source} carries it out and logs what it did on its own page.` });
        return { state: 'answered', ...(told ? { text: told } : {}) };
    }

    /**
     * What became of an answer, said by the plugin that asked once it knows
     * (Session Watch's `askOutcome`): its log entry turns delivered, not
     * confirmed or not delivered, with the reason. Not delivered, the
     * question is unanswered again: its card comes back, saying why.
     */
    onOutcome(event) {
        const outcome = isRecord(event.outcome) ? event.outcome : undefined;
        const state = OUTCOME_STATES[outcome?.state];
        if (typeof event.id !== 'string' || !state) return;
        const entry = this.journal.list({ limit: 400 }).find((e) => e.kind === 'answer' && e.askId === event.id);
        if (!entry || entry.state === state) return;
        const words = typeof outcome.text === 'string' && outcome.text ? clip(outcome.text, 300) : undefined;
        const good = state === 'delivered' || state === 'typed in';
        this.journal.set(entry.id, { state, ...(words ? (good ? { why: words } : { reason: words }) : {}) });
        if (state === 'not delivered' && typeof entry.cardId === 'string') this.failed({ id: entry.cardId }, `Your answer did not reach it: ${words ?? 'it was not typed in'}`);
        this.changed();
    }

    /**
     * Prove an answer in the session's log: checked shortly after, on every
     * watcher event of that session, and given up after PROOF_MS.
     * @param {string} entryId - the log entry to update.
     * @param {object} card
     * @param {(session: object) => true | string | undefined} check
     */
    confirm(entryId, card, check, { pending } = {}) {
        const proof = { entryId, sessionId: card.sessionId, card, check, pending };
        this.proofs.add(proof);
        for (const ms of [250, 2000, 10000]) this.after(this.logger, 'decisions: proof', ms, () => this.prove(proof));
        this.after(this.logger, 'decisions: proof', PROOF_MS, () => {
            if (!this.proofs.delete(proof)) return;
            this.journal.set(entryId, { state: 'not confirmed', reason: 'the session\'s log does not show it yet' });
        });
    }

    prove(proof) {
        if (!this.proofs.has(proof)) return;
        let session;
        try { session = this.watch.sessionOf?.(proof.sessionId); } catch { session = undefined; }
        if (!session) return;
        let verdict;
        try { verdict = proof.check(session); } catch { verdict = undefined; }
        if (verdict === undefined) return;
        this.proofs.delete(proof);
        if (verdict === true) {
            this.journal.set(proof.entryId, { state: proof.pending ? 'delivered' : 'answered', provedAt: this.now() });
            return;
        }
        this.journal.set(proof.entryId, { state: 'not delivered', reason: verdict });
        this.failed(proof.card, `Not delivered: ${verdict}.`);
    }

    // ── Dismiss ────────────────────────────────────────────────────────

    async dismiss(id) {
        const { waiting } = await this.list();
        const card = waiting.find((c) => c.id === id);
        if (!card) throw new Error('This is no longer waiting.');
        this.store.data.dismissed[id] = this.now();
        this.store.data.dismissed = trimmed(this.store.data.dismissed);
        this.store.change();
        this.errors.delete(id);
        this.journal.add({ kind: 'dismiss', cardId: id, ...(card.sessionId ? { sessionId: card.sessionId } : {}), title: card.title ?? '', text: card.sessionId ? 'Dismissed' : `Dismissed: ${headline(card)}`, question: clip(String(card.question ?? ''), 300), by: 'you', ...(card.answer === 'approval' || card.live ? { why: `${sessionWords(card)} still waits for an answer in the session.` } : {}) });
        this.soon(30);
        this.changed();
        return { ok: true };
    }

    async undismiss(id) {
        if (!Object.hasOwn(this.store.data.dismissed, id)) throw new Error('This is not dismissed.');
        // Which card, for the history: the list still has it while it waits.
        let card;
        try { card = (await this.list()).dismissed.find((c) => c.id === id); } catch { card = undefined; }
        delete this.store.data.dismissed[id];
        this.store.change();
        this.journal.add({
            kind: 'undismiss',
            cardId: id,
            ...(card?.sessionId ? { sessionId: card.sessionId } : {}),
            title: card?.title ?? '',
            text: card ? (card.sessionId ? 'Brought back' : `Brought back: ${headline(card)}`) : 'Brought back a dismissed item',
            ...(card?.question ? { question: clip(String(card.question), 300) } : {}),
            by: 'you',
        });
        this.soon(30);
        this.changed();
        return { ok: true };
    }
}

/** A session's title from the watcher, or '' (never throws). */
function attemptTitle(watch, sessionId) {
    try { return watch.titleOf?.(sessionId) ?? ''; } catch { return ''; }
}
