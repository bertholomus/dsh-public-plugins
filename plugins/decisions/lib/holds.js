/**
 * Holds: Decisions' seat in DSH's own requests for a person's answer.
 *
 * When a tool asks for approval, or an agent asks a question in DSH's
 * question box, DSH runs a waterfall (`approval/request`,
 * `user-questions/request`) that its gateway forwards to every open window.
 * Decisions listens first: it shows the request as a card and passes it on
 * at once, so DSH's own card shows in the session as always. The person may
 * answer in either place, and the first answer wins:
 *
 * - answered in the session: DSH's answer goes back as it always does, and
 *   Decisions drops its card;
 * - answered in Decisions: Decisions gives DSH the answer and cancels the
 *   forwarded request, so DSH takes its card down in every window.
 *
 * Decisions never answers on anyone's behalf and never changes what DSH
 * does without it: when DSH gets no answer from a window (no window is
 * open, the turn stopped), DSH's own outcome stands. A hold is cancelled
 * through a signal of Decisions' own joined to DSH's, so DSH's signal is
 * never aborted for it. Nothing here throws into DSH: when Decisions
 * cannot hold a request, it passes the request on untouched.
 *
 * @module dsh-plugin-decisions/holds
 */
import { clip, errorText, isRecord } from './shared/safe.js';
import { questionOf } from './cards.js';

/** How a held approval is answered, in DSH's words. */
export const APPROVAL_ANSWERS = Object.freeze({ allow: 'allowed-once', reject: 'rejected' });

/** How far back in a session's log Decisions looks for a tool call's arguments. */
const LOOK_BACK = 400;

/** The newest events of a loaded session, newest first (at most `max`). */
export function* recentEvents(session, max = LOOK_BACK) {
    const seq = Number(session?.seq);
    if (!Number.isSafeInteger(seq) || typeof session?.eventAt !== 'function') return;
    for (let at = seq - 1, n = 0; at >= 0 && n < max; at -= 1, n += 1) {
        let event;
        try { event = session.eventAt(at); } catch { return; }
        if (event) yield event;
    }
}

/** The arguments a tool call was made with (from the session's log), or undefined. */
export function callArguments(session, callId) {
    if (typeof callId !== 'string') return undefined;
    for (const event of recentEvents(session)) {
        if (event.type !== 'tool/call' || event.data?.callId !== callId) continue;
        const raw = event.data.arguments;
        if (isRecord(raw)) return raw;
        if (typeof raw !== 'string') return undefined;
        try {
            const parsed = JSON.parse(raw);
            return isRecord(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * Whether DSH recorded an approval's outcome: `true` when the session's log
 * shows `expected` for the call, a sentence when it shows another outcome,
 * `undefined` while it shows none yet.
 */
export function approvalProof(session, callId, expected) {
    const decided = new Map();
    for (const event of recentEvents(session)) {
        if (event.type === 'approval/decided' && typeof event.data?.id === 'string') decided.set(event.data.id, event.data.outcome);
        if (event.type === 'approval/asked' && event.data?.callId === callId) {
            const outcome = decided.get(event.data.id);
            if (outcome === undefined) return undefined;
            return outcome === expected ? true : `the session's log records “${outcome}”`;
        }
    }
    return undefined;
}

/** Whether a question-box call has its result in the session's log (`true`, a sentence for an error, or `undefined`). */
export function questionProof(session, callId) {
    for (const event of recentEvents(session)) {
        if (event.type === 'tool/result' && event.data?.message?.toolCallId === callId) {
            return event.data.error !== undefined || event.data.message.isError === true ? 'the question box returned an error to the agent' : true;
        }
        if (event.type === 'tool/call' && event.data?.callId === callId) return undefined;
    }
    return undefined;
}

/** Whether a late answer to a question-box call was read into a turn (`true` or `undefined`). */
export function lateAnswerProof(session, callId) {
    for (const event of recentEvents(session)) {
        if (event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply' && event.data.source.callId === callId) return true;
    }
    return undefined;
}

/** Keys that say what a tool call does, in the order a person wants them. */
const SAYS = ['command', 'cmd', 'script', 'path', 'file_path', 'filePath', 'paths', 'url', 'query', 'pattern', 'content', 'text', 'message'];

/** Arguments the card already says in words (the access asked for, and why). */
const SAID = new Set(['sandbox_permissions', 'justification']);

/**
 * What a tool call does, as a person reads it: the command, the file, the
 * address. `lines` lists the other arguments as `name: value`, clipped.
 * @param {Record<string, unknown> | undefined} args
 * @returns {{ what?: string, lines: string[] }}
 */
export function describeCall(args) {
    if (!isRecord(args)) return { lines: [] };
    const words = (value) => (typeof value === 'string' ? value : Array.isArray(value) ? value.filter((v) => typeof v === 'string').join(', ') : value === undefined ? '' : JSON.stringify(value));
    const key = SAYS.find((name) => (typeof args[name] === 'string' && args[name].trim() !== '') || (Array.isArray(args[name]) && args[name].length > 0));
    const what = key ? words(args[key]).slice(0, 2000) : undefined;
    const lines = [];
    for (const [name, value] of Object.entries(args)) {
        if (name === key || SAID.has(name) || value === undefined || value === null || value === '') continue;
        const text = words(value);
        if (text) lines.push(`${name}: ${clip(text, 200)}`);
        if (lines.length >= 8) break;
    }
    return { ...(what ? { what } : {}), lines };
}

/** DSH's names for its sandbox modes, as its window shows them. */
const MODE_WORDS = Object.freeze({ 'read-only': 'Read Only', 'workspace-write': 'Workspace Write', 'danger-full-access': 'Full access' });

/**
 * An approval as a question a person answers: a sandbox escalation reads
 * "Allow this command with Full access?" with the agent's justification
 * as its why; any other approval reads as DSH words it.
 * @returns {{ question: string, why?: string }}
 */
export function approvalWords(request) {
    const tool = typeof request?.toolName === 'string' && request.toolName ? request.toolName : 'A tool';
    const escalation = /^escalate sandbox to ([a-z-]+):\s*([\s\S]+)$/.exec(typeof request?.reason === 'string' ? request.reason.trim() : '');
    if (escalation) {
        const subject = /bash|shell|pwsh|powershell|exec|command/i.test(tool) ? 'command' : 'change';
        return { question: `Allow this ${subject} with ${MODE_WORDS[escalation[1]] ?? escalation[1]}?`, why: clip(escalation[2], 600) };
    }
    return { question: reasonText(request) || `${clip(tool, 80)} asks to run with more access than the session allows.` };
}

/** DSH's reason for an approval, in the person's language when it has one. */
export function reasonText(request) {
    const shown = request?.displayReason;
    if (typeof shown === 'string' && shown.trim()) return shown.trim();
    if (isRecord(shown)) {
        const words = shown.en ?? Object.values(shown).find((v) => typeof v === 'string');
        if (typeof words === 'string' && words.trim()) return words.trim();
    }
    return typeof request?.reason === 'string' && request.reason.trim() ? request.reason.trim() : '';
}

export class Holds {
    /**
     * @param {object} options
     * @param {{ warn: Function }} [options.logger]
     * @param {(change: { type: 'held' | 'settled', card: object, by?: string, value?: unknown }) => void} [options.onChange]
     * @param {(sessionId: string) => string} [options.titleOf]
     * @param {() => number} [options.now]
     */
    constructor({ logger, onChange, titleOf, now = Date.now } = {}) {
        this.logger = logger;
        this.onChange = onChange;
        this.titleOf = titleOf ?? (() => '');
        this.now = now;
        /** Held requests by card id. */
        this.items = new Map();
        this.count = 0;
        this.stopped = false;
    }

    changed(change) {
        try { this.onChange?.(change); } catch (error) { this.logger?.warn?.(`decisions: ${errorText(error)}`); }
    }

    /** The cards of the requests held now. */
    cards() {
        return [...this.items.values()].map((item) => item.card);
    }

    get(id) {
        return this.items.get(id);
    }

    /**
     * The `approval/request` listener. Never throws: any failure passes the
     * request on untouched.
     */
    approval(request, next) {
        let card;
        try {
            if (this.stopped || !isRecord(request) || typeof request.agent?.id !== 'string') return next();
            const sessionId = request.agent.id;
            const callId = typeof request.callId === 'string' ? request.callId : `a${(this.count += 1)}`;
            const call = describeCall(callArguments(request.agent.session, request.callId));
            const tool = typeof request.toolName === 'string' && request.toolName ? request.toolName : 'A tool';
            const words = approvalWords(request);
            card = {
                id: `approval:${sessionId}:${callId}`,
                kind: 'approval',
                sessionId,
                title: this.titleOf(sessionId) || 'Untitled session',
                tool: clip(tool, 80),
                question: words.question,
                ...(words.why ? { detail: words.why } : {}),
                ...(call.what ? { what: call.what } : {}),
                ...(call.lines.length ? { lines: call.lines } : {}),
                ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
                answer: 'approval',
            };
        } catch (error) {
            this.logger?.warn?.(`decisions: could not show an approval: ${errorText(error)}`);
            return next();
        }
        return this.hold(card, request, next);
    }

    /**
     * The `user-questions/request` listener: DSH's question box. Never
     * throws: any failure passes the request on untouched.
     */
    question(request, next) {
        let card;
        try {
            if (this.stopped || !isRecord(request) || typeof request.agent?.id !== 'string' || !Array.isArray(request.questions)) return next();
            const questions = request.questions.map(questionOf).filter(Boolean);
            if (questions.length === 0 || questions.length !== request.questions.length) return next();
            const sessionId = request.agent.id;
            const callId = typeof request.wait?.callId === 'string' ? request.wait.callId : undefined;
            card = {
                id: `question:${sessionId}:${callId ?? `q${(this.count += 1)}`}`,
                kind: 'question',
                sessionId,
                title: this.titleOf(sessionId) || 'Untitled session',
                ...(callId ? { callId } : {}),
                questions,
                question: questions[0].question,
                ...(questions.length > 1 ? { more: questions.length - 1 } : {}),
                ...(request.wait?.timed ? { timed: true } : {}),
                answer: 'questions',
            };
        } catch (error) {
            this.logger?.warn?.(`decisions: could not show a question: ${errorText(error)}`);
            return next();
        }
        return this.hold(card, request, next);
    }

    /**
     * Hold one request: pass it on at once, and settle it with the first
     * answer, the window's or Decisions'.
     */
    hold(card, request, next) {
        const original = request.signal;
        if (original?.aborted) return next();
        let ours;
        try {
            ours = new AbortController();
            // DSH's gateway cancels the forwarded request when this signal aborts; DSH's own signal stays DSH's.
            request.signal = original ? AbortSignal.any([original, ours.signal]) : ours.signal;
        } catch (error) {
            this.logger?.warn?.(`decisions: could not hold a request: ${errorText(error)}`);
            return next();
        }
        const forwarded = Promise.resolve().then(next);
        const fromWindow = forwarded.then((value) => ({ value }), (error) => ({ error }));
        let settle;
        const fromUs = new Promise((resolve) => { settle = resolve; });
        const item = { card: { ...card, at: this.now(), running: true, live: true }, settle, ours };
        this.items.set(card.id, item);
        this.changed({ type: 'held', card: item.card });
        return Promise.race([fromWindow, fromUs]).then((result) => {
            if (this.items.get(card.id) === item) this.items.delete(card.id);
            if (result.ours) {
                try { ours.abort(new Error('answered in Decisions')); } catch { /* the request is settled either way */ }
                this.changed({ type: 'settled', card: item.card, by: 'decisions', value: result.value });
                return result.value;
            }
            // Let go: said when it was let go (see release), the window alone answers it now.
            if (result.release) return forwarded;
            this.changed({ type: 'settled', card: item.card, by: 'window', ...('error' in result ? { error: errorText(result.error), ...(typeof result.error?.code === 'string' ? { code: result.error.code } : {}) } : { value: result.value }) });
            if ('error' in result) throw result.error;
            return result.value;
        });
    }

    /**
     * Answer a held request. Returns false when it is no longer held (the
     * session answered it, or its turn stopped).
     */
    answer(id, value) {
        const item = this.items.get(id);
        if (!item) return false;
        this.items.delete(id);
        item.settle({ ours: true, value });
        return true;
    }

    /**
     * Let held requests go back to the window alone: those of one kind
     * ('approval' or 'question', when the person switches that kind off), or
     * all of them. DSH's own card stays where it was and still takes the answer.
     */
    /**
     * Let held requests go back to the window alone: those of `kind`, or all.
     * @param {'approval' | 'question'} [kind]
     * @param {'off' | 'kind'} [why] - Decisions is stopping, or the kind was switched off in its settings.
     */
    release(kind, why = 'off') {
        for (const [id, item] of [...this.items]) {
            if (kind && item.card.kind !== kind) continue;
            this.items.delete(id);
            // Said now, not a tick later: Decisions may be stopping, and what it keeps must be written before it goes.
            this.changed({ type: 'settled', card: item.card, by: 'released', why });
            item.settle({ release: true, why });
        }
    }

    /** Hold again after a stop (Decisions works again). */
    resume() {
        this.stopped = false;
    }

    /** Hold nothing more, and let every held request go back to the window alone (Decisions is stopping). */
    stop() {
        this.stopped = true;
        this.release(undefined, 'off');
    }
}
