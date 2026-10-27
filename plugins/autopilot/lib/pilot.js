/**
 * Autopilot's engine: it watches every session through the session watcher
 * and keeps work moving when nobody is there.
 *
 * Three things make it act, each checked again at the moment it would act:
 *
 * 1. **Cut off by a stop.** DSH restarted, crashed or reloaded under a
 *    running turn. A short carry-on note goes in; an active goal that the
 *    stop disarmed is started again once the note is read.
 * 2. **Idle with open work.** A turn ended, the session stayed quiet for
 *    `idleSeconds`, its todos are open or its goal is active but stopped,
 *    and its last reply asked nobody anything. One note (or the goal is
 *    started again). Two notes in a row with no progress (no todo done, no
 *    goal round) and Autopilot backs off until the person writes or the
 *    session moves on its own.
 * 3. **A failed turn.** A model or provider error ends a turn, which stops
 *    a goal. After a wait (`errorRetrySeconds`, growing) the session gets a
 *    carry-on note, which costs no goal round; its goal starts again only
 *    once a turn has ended without an error, so an outage never spends the
 *    goal's rounds. After the last try Autopilot gives up and says so.
 *
 * Per session the rule is Auto (act), Ask first (raise a question in
 * Decisions and on Autopilot's page) or Off. A kill switch stops everything
 * at once. Every action, and every time it holds back for a reason the
 * person would want to know, goes in the event log with a "why" line; a
 * note's entry follows it until the session's log proves it was read, and a
 * goal start's entry until a round of that start begins. What a process left
 * open when it was killed (a crash, a forced quit) is settled against the
 * sessions' logs when Autopilot starts again, before it acts.
 *
 * @module dsh-plugin-autopilot/pilot
 */
import { actionLabel, answerNote, carryOnNote, errorNote, nudgeNote, question, whyBackOff, whyErrorNote, whyGiveUp, whyHeld, whyNudge, whyRearmError, whyRearmIdle, whyResume } from './notes.js';
import { clip, errorText, isRecord } from './shared/safe.js';
import { asksForAnswer, cutOff } from './shared/words.js';
import { handOverIn } from './ends.js';

export const RULES = Object.freeze(['auto', 'ask', 'off']);
/** The rules in the window's words. */
export const RULE_WORDS = Object.freeze({ auto: 'Auto', ask: 'Ask first', off: 'Off' });

/** How long after a live cut-off (a reload, not a restart) Autopilot looks again. */
const LIVE_CUT_DELAY_MS = 15000;
/** How long a goal start has to begin its round before the log says it did not (Autopilot starts a goal only while its session is idle). */
const ROUND_PROOF_MS = 5 * 60000;
/** Log states that wait for an outcome: what a killed process left open. */
const OPEN_NOTE = new Set(['sending', 'in the queue']);
const OPEN_START = new Set(['starting', 'waiting for a round']);
/** A handled trigger is remembered this long, so a restart never repeats one. */
const DONE_KEEP_MS = 7 * 86400000;
/** What Autopilot's first look follows, in the words of a row that waits for it (see start). */
const START_WORDS = Object.freeze({
    dsh: 'after DSH starts',
    settings: 'after the setting was fixed',
    again: 'after Autopilot starts again',
});
/** How long after a session moves Autopilot reads its log for a note a killed run left in its queue. */
const QUEUED_LOOK_MS = 1500;

/** The store's empty shape. */
export function emptyData() {
    return { version: 1, paused: false, defaultRule: undefined, rules: {}, sessions: {}, notes: [] };
}

/** A stored document made safe. */
export function parseData(value) {
    const data = emptyData();
    if (!isRecord(value)) return data;
    data.paused = value.paused === true;
    if (RULES.includes(value.defaultRule)) data.defaultRule = value.defaultRule;
    if (isRecord(value.rules)) for (const [id, rule] of Object.entries(value.rules)) if (RULES.includes(rule)) data.rules[id] = rule;
    if (isRecord(value.sessions)) for (const [id, s] of Object.entries(value.sessions)) if (isRecord(s)) data.sessions[id] = { ...s, done: isRecord(s.done) ? { ...s.done } : {} };
    if (Array.isArray(value.notes)) data.notes = value.notes.filter((at) => Number.isFinite(at)).slice(-1000);
    return data;
}

/** What counts toward progress after a note: todos done or dropped, goal rounds. */
export function markOf(state) {
    return { done: state?.todos?.done ?? 0, open: state?.todos?.open ?? 0, rounds: state?.goal?.rounds ?? 0, tools: state?.tools ?? 0 };
}

/** Open todos or an active goal: what an idle or failed session may be told to carry on with. */
export function hasOpenWork(state) {
    return (state?.todos?.open ?? 0) > 0 || state?.goal?.phase === 'active';
}

/**
 * Whether a turn belongs to a carry-on after a stop that has not ended
 * well yet: `s.carry` names the turn Autopilot's carry-on note started
 * (after DSH stopped under an earlier one). Until a turn from there on ends
 * without an error, the work that stop cut off counts as open, so a carry-on
 * turn that fails (a gateway still down after a power blip) is tried again
 * like any failed turn with open work.
 */
export function carrying(s, end) {
    const carry = s?.carry;
    return isRecord(carry) && Number.isSafeInteger(carry.turn) && Number.isSafeInteger(end?.turn) && end.turn >= carry.turn;
}

/** Whether a session moved since `mark`: a todo finished or dropped, or the goal ran a round. */
export function progressed(mark, state) {
    if (!mark) return false;
    const now = markOf(state);
    return now.done > mark.done || now.open < mark.open || now.rounds > mark.rounds;
}

/** "round 3 of 4" (or "round 3" for a goal with no limit): the round a start of this goal begins. */
export function nextRound(goal) {
    const next = (goal?.rounds ?? 0) + 1;
    return goal?.max ? `round ${next} of ${goal.max}` : `round ${next}`;
}

/** Whether a goal used every round its limit allows (DSH refuses to start it again). */
export function goalSpent(goal) {
    return Boolean(goal?.max) && (goal.rounds ?? 0) >= goal.max;
}

/** "20 seconds", "1 minute": a short wait in words. */
const spanSeconds = (seconds) => {
    const n = Math.max(0, Math.round(Number(seconds) || 0));
    return n % 60 === 0 && n > 0 ? `${n / 60} minute${n === 60 ? '' : 's'}` : `${n} second${n === 1 ? '' : 's'}`;
};

/** The text of a message in a session's log. */
const messageText = (data) => (Array.isArray(data?.content) ? data.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('') : typeof data?.content === 'string' ? data.content : '');

/** Whether a message in a session's log is the one a note's log entry sent (by its id, else its words). */
const ownMessage = (entry, message) => (entry.messageId ? message?.id === entry.messageId : messageText(message) === entry.note);

/**
 * Where a session's log shows a note's message read into a turn: the turn
 * (the last one begun before it) and when, or undefined while it does not.
 */
function readIn(entry, events) {
    let turn;
    for (const e of events) {
        if (e?.type === 'turn/start' && Number.isSafeInteger(e.data?.turn)) turn = e.data.turn;
        if (e?.type === 'user/message' && (Number.isFinite(e?.time) ? e.time >= (entry.at ?? 0) - 1000 : true) && ownMessage(entry, e.data)) {
            return { ...(turn !== undefined ? { turn } : {}), ...(Number.isFinite(e.time) ? { deliveredAt: e.time } : {}) };
        }
    }
    return undefined;
}

export class Pilot {
    /**
     * @param {object} options
     * @param {object} options.watch - the session watcher (`sessionWatch` service).
     * @param {object} options.config - the plugin's config.
     * @param {{ data: object, change: Function }} options.store - Autopilot's own document (parseData shape).
     * @param {import('./shared/journal.js').Journal} options.journal
     * @param {{ info?: Function, warn?: Function }} [options.logger]
     * @param {() => number} [options.now]
     * @param {(ms: number, fn: Function) => any} [options.setTimer]
     * @param {(timer: any) => void} [options.clearTimer]
     * @param {(item: object) => void} [options.notify] - a system notification, when the notifications plugin runs.
     * @param {() => void} [options.changed] - the window's view moved.
     * @param {() => boolean} [options.settingsOk] - whether every setting is right (Autopilot does no work while one is wrong).
     */
    constructor({ watch, config, store, journal, logger, now = Date.now, setTimer, clearTimer, notify, changed, settingsOk = () => true }) {
        this.watch = watch;
        this.config = config;
        this.store = store;
        this.journal = journal;
        this.logger = logger;
        this.now = now;
        this.setTimer = setTimer ?? ((ms, fn) => {
            const t = setTimeout(fn, ms);
            t.unref?.();
            return t;
        });
        this.clearTimer = clearTimer ?? ((t) => clearTimeout(t));
        this.notify = notify;
        this.changed = changed ?? (() => {});
        this.settingsOk = settingsOk;
        /** Pending checks: `${sessionId}` → { trigger, timer, at }. */
        this.timers = new Map();
        /** Goal starts waiting for their round: cancelled (not written) when Autopilot stops. */
        this.proofs = new Set();
        /** The cut-off turns the last look at the logs found, by session (for rows whose saved state is still open). */
        this.cutSeen = new Map();
        /** Notes a killed run left in DSH's queue ("not proven"), by session: their log entries, settled once the session reads them. */
        this.queued = new Map();
        /** Pending reads of those sessions' logs, by session. */
        this.queuedLooks = new Map();
        this.startTimer = undefined;
        /** Settling what the last process left open; the first look waits for it. */
        this.settling = undefined;
        this.stopped = false;
        this.started = false;
    }

    get data() {
        return this.store.data;
    }

    // ── Rules and switches ────────────────────────────────────────────

    /** Whether Autopilot may act at all now. */
    active() {
        return !this.stopped && this.config.enabled !== false && this.data.paused !== true && this.settingsOk();
    }

    defaultRule() {
        return this.data.defaultRule ?? this.config.defaultRule ?? 'auto';
    }

    ruleOf(sessionId) {
        return this.data.rules[sessionId] ?? this.defaultRule();
    }

    /** Set one session's rule; `undefined` goes back to the default. */
    setRule(sessionId, rule) {
        if (rule !== undefined && !RULES.includes(rule)) throw new Error(`The rule must be one of ${RULES.join(', ')}.`);
        if (rule === undefined) delete this.data.rules[sessionId];
        else this.data.rules[sessionId] = rule;
        this.store.change();
        if (rule === 'off') {
            this.cancel(sessionId);
            this.dropAsks((ask) => ask.sessionId === sessionId, 'you set its rule to Off');
        }
        this.journal.add({ kind: 'rule', sessionId, title: this.titleOf(sessionId), text: `Rule set to ${RULE_WORDS[rule ?? this.defaultRule()]}${rule === undefined ? ' (the default)' : ''}.`, why: 'You changed it on Autopilot\'s page.', state: 'done', by: 'you' });
        this.changed();
        if (this.ruleOf(sessionId) !== 'off') void this.recheck(sessionId).catch((error) => this.logger?.warn?.(`autopilot: the look after a rule change failed: ${errorText(error)}`));
    }

    setDefaultRule(rule) {
        if (!RULES.includes(rule)) throw new Error(`The rule must be one of ${RULES.join(', ')}.`);
        this.data.defaultRule = rule;
        this.store.change();
        const ownRule = (sessionId) => Object.hasOwn(this.data.rules, sessionId);
        let dropped = 0;
        if (rule === 'off') {
            for (const id of [...this.timers.keys()]) if (!ownRule(id)) this.cancel(id);
            dropped = this.dropAsks((ask) => !ownRule(ask.sessionId), 'you set the rule for sessions without their own to Off');
        }
        this.journal.add({ kind: 'rule', text: `Sessions without their own rule now use ${RULE_WORDS[rule]}.`, why: `You changed the default on Autopilot's page.${dropped ? ` ${dropped === 1 ? 'Its question is' : `${dropped} questions are`} withdrawn.` : ''}`, state: 'done', by: 'you' });
        this.changed();
        // Sessions that now fall under Auto or Ask first get a look, cut-off ones found in their logs included.
        if (rule !== 'off') void this.scan('rule').catch((error) => this.logger?.warn?.(`autopilot: the look after a rule change failed: ${errorText(error)}`));
    }

    /** The kill switch: `true` stops every pending action at once. */
    setPaused(paused) {
        this.data.paused = paused === true;
        this.store.change();
        if (this.data.paused) {
            for (const id of [...this.timers.keys()]) this.cancel(id);
            const dropped = this.dropAsks(() => true, 'you switched Autopilot off');
            this.journal.add({ kind: 'switch', text: 'Autopilot is off: no notes, no resumes, no goal starts.', why: `You switched it off.${dropped ? ` Its ${dropped === 1 ? 'question is' : `${dropped} questions are`} withdrawn; it asks again when it is on.` : ''}`, state: 'done', by: 'you' });
        } else {
            this.journal.add({ kind: 'switch', text: 'Autopilot is on.', why: 'You switched it on. It looks at every session again now.', state: 'done', by: 'you' });
            void this.scan('switch').catch((error) => this.logger?.warn?.(`autopilot: the look after switching on failed: ${errorText(error)}`));
        }
        this.changed();
    }

    /**
     * Withdraw Autopilot's questions that `which` picks, and mark each in the
     * log as withdrawn, with why; returns how many went.
     */
    dropAsks(which, reason) {
        let n = 0;
        for (const ask of this.watch.asks?.() ?? []) {
            if (ask.source !== 'Autopilot' || !which(ask)) continue;
            let gone = false;
            try { gone = this.watch.dropAsk(ask.id) !== false; } catch { /* already gone */ }
            if (!gone) continue;
            n += 1;
            this.settleAsk(ask.id, { state: 'withdrawn', reason: `withdrawn: ${reason}` });
        }
        return n;
    }

    /** Give the log entry of a question still waiting its outcome (only the newest one: a question can come back). */
    settleAsk(askId, patch) {
        const entry = this.journal.list({ limit: 400 }).find((e) => e.kind === 'ask' && e.askId === askId && e.state === 'asked you');
        if (entry) this.journal.set(entry.id, { ...patch, settledAt: this.now() });
    }

    /** Why the person's own action cannot go now (the switch, the session's rule, a setting), or undefined. */
    refusal(sessionId) {
        if (this.stopped) return 'Autopilot is not running.';
        if (!this.settingsOk()) return 'Autopilot is waiting for a setting to be fixed: see the top of its page.';
        if (this.config.enabled === false) return 'Autopilot is switched off in DSH\'s profile (enabled: false).';
        if (this.data.paused === true) return 'Autopilot is off: switch it on at the top of its page first.';
        if (sessionId && this.ruleOf(sessionId) === 'off') return 'This session\'s rule is Off: set it to Auto or Ask first, then try again.';
        return undefined;
    }

    /**
     * A setting changed while Autopilot runs: pending idle checks move to the
     * new quiet time. When the save fixed a wrong setting, Autopilot looks at
     * every session again, as when it is switched back on.
     */
    settingsChanged({ fixed = false } = {}) {
        if (this.stopped) return;
        for (const [id, item] of [...this.timers]) if (item.trigger === 'idle') this.recheck(id);
        if (fixed) void this.scan('settings').catch((error) => this.logger?.warn?.(`autopilot: the check after a settings fix failed: ${errorText(error)}`));
        this.changed();
    }

    // ── Start and events ──────────────────────────────────────────────

    /**
     * Start watching. `after` says what the start follows, for the words of a
     * row that waits for the first look: `dsh` (DSH started), `settings` (a
     * wrong setting was fixed) or `again` (Autopilot or Session Watch was
     * switched back on).
     */
    start({ after = 'dsh' } = {}) {
        if (this.started) return;
        this.started = true;
        this.startedAfter = Object.hasOwn(START_WORDS, after) ? after : 'dsh';
        this.offWatch = this.watch.on((event) => this.onWatch(event));
        // What a killed process left open is settled first: its questions are set aside (asked again under their own
        // entries), its notes and goal starts checked against the sessions' logs.
        this.settling = this.settleLeft().catch((error) => this.logger?.warn?.(`autopilot: could not settle what the last run left: ${errorText(error)}`));
        const delay = Math.max(0, (this.config.startDelaySeconds ?? 20) * 1000);
        this.startTimer = this.setTimer(delay, () => {
            this.startTimer = undefined;
            void Promise.resolve(this.settling).then(() => this.scan('start')).catch((error) => this.logger?.warn?.(`autopilot: the start check failed: ${errorText(error)}`));
        });
    }

    stop() {
        this.stopped = true;
        this.offWatch?.();
        if (this.startTimer !== undefined) this.clearTimer(this.startTimer);
        for (const timer of this.queuedLooks.values()) this.clearTimer(timer);
        this.queuedLooks.clear();
        for (const id of [...this.timers.keys()]) this.cancel(id);
        // A goal start still waiting for its round stays open in the log: the next start checks it in the session's log.
        for (const proof of [...this.proofs]) proof.cancel();
        this.setAsksAside();
    }

    /**
     * Autopilot stops (DSH quits, Autopilot or Session Watch is switched off):
     * its questions leave the cards, and their log entries say so. A question
     * that still applies when Autopilot runs again comes back under the same
     * entry; one that no longer applies stays withdrawn. Written at once, so
     * it is saved before DSH exits.
     */
    setAsksAside() {
        for (const ask of this.watch.asks?.() ?? []) {
            if (ask.source !== 'Autopilot') continue;
            try { this.watch.dropAsk(ask.id); } catch { /* already gone */ }
        }
        for (const entry of this.journal.list({ limit: 400 })) {
            if (entry.kind !== 'ask' || entry.state !== 'asked you') continue;
            this.journal.set(entry.id, { state: 'withdrawn', stopped: true, settledAt: this.now(), reason: 'withdrawn: Autopilot stopped (DSH quit, or Autopilot or Session Watch was switched off); it asks again when it runs, if this still applies' });
        }
    }

    /**
     * At start: settle what an earlier run left open, which it does when it
     * was killed (a crash, a forced quit) before it could. Its questions
     * still marked "asked you" are set aside as a stop does, so a question
     * that still applies is asked again under its own entry and time. Its
     * notes still "sending" or "in the queue" are looked up in the session's
     * log: read into a turn ("delivered", with the turn); still in DSH's
     * queue, which DSH keeps in the log ("not proven": the session may still
     * read it, so it is not sent again); else "not delivered", and the
     * trigger is freed so this run can act on it. Its goal starts still
     * waiting are looked up the same way: a round of that start's revision
     * ("started"), else "not started", and the trigger is freed so the goal
     * can be started again.
     */
    async settleLeft() {
        const live = new Set((this.watch.asks?.() ?? []).map((ask) => ask.id));
        const open = [];
        for (const entry of this.journal.list({ limit: 400 })) {
            if (entry.kind === 'ask' && entry.state === 'asked you' && !live.has(entry.askId)) {
                this.journal.set(entry.id, { state: 'withdrawn', stopped: true, settledAt: this.now(), reason: 'withdrawn: DSH stopped before it was answered (a crash or a forced quit); it asks again when it runs, if this still applies' });
            } else if (typeof entry.sessionId === 'string' && ((typeof entry.note === 'string' && OPEN_NOTE.has(entry.state)) || (entry.kind === 'rearm' && OPEN_START.has(entry.state)))) {
                open.push(entry);
            } else if (typeof entry.sessionId === 'string' && typeof entry.note === 'string' && entry.state === 'not proven' && entry.queued === true && this.now() - (entry.at ?? 0) < DONE_KEEP_MS) {
                // Left in DSH's queue by an earlier kill: the session may have read it since, or may read it yet.
                open.push(entry);
            }
        }
        if (open.length === 0) return;
        const bySession = new Map();
        for (const entry of open) bySession.set(entry.sessionId, [...(bySession.get(entry.sessionId) ?? []), entry]);
        for (const [sessionId, list] of bySession) {
            const read = await this.watch.readLog?.(sessionId);
            if (this.stopped) return;
            if (!Array.isArray(read?.events)) {
                // No log to check against: say so, and keep the trigger handled, so nothing is sent twice.
                for (const entry of list) this.journal.set(entry.id, { state: 'not proven', settledAt: this.now(), reason: 'DSH stopped first, and the session\'s log could not be read' });
                continue;
            }
            for (const entry of list) this.settleFromLog(sessionId, entry, read.events);
        }
        this.changed();
    }

    /** One open entry of an earlier run, settled against its session's log (see settleLeft). */
    settleFromLog(sessionId, entry, events) {
        const after = events.filter((e) => Number.isFinite(e?.time) ? e.time >= entry.at - 1000 : true);
        // Nothing happened, so the trigger is free again: this run's first look acts on it, if it still applies.
        const free = () => {
            const s = this.data.sessions[sessionId];
            if (entry.key && s?.done?.[entry.key]) {
                delete s.done[entry.key];
                this.store.change();
            }
        };
        const settledAt = this.now();
        if (typeof entry.note === 'string') {
            const read = readIn(entry, events);
            if (read) {
                this.journal.set(entry.id, { state: 'delivered', settledAt, ...read, reason: '', ...(entry.queued ? { queued: false } : {}) });
            } else if (after.some((e) => e?.type === 'agent/inbox/spliced' && Array.isArray(e.data?.inserted) && e.data.inserted.some((m) => ownMessage(entry, m)))) {
                // DSH keeps its queue in the session's log, so the session may still read it: it is never sent twice,
                // and Autopilot reads the log again as the session moves, to mark it delivered once it is read.
                if (entry.state !== 'not proven') this.journal.set(entry.id, { state: 'not proven', queued: true, settledAt, reason: 'DSH stopped with it in the session\'s queue (a crash or a forced quit); the session may still read it when it next runs, and this entry says so when it does' });
                this.follow(sessionId, entry.id);
            } else if (entry.queued !== true) {
                this.journal.set(entry.id, { state: 'not delivered', settledAt, reason: 'DSH stopped before it reached the session (a crash or a forced quit)' });
                free();
            }
            // (One an earlier kill left in the queue that the log no longer shows stays not proven: never sent twice.)
            return;
        }
        const goal = entry.goal;
        const round = goal ? after.find((e) => e?.type === 'user/message' && e.data?.source?.kind === 'goal' && e.data.source.goalId === goal.id && e.data.source.revision === goal.rev) : undefined;
        if (round) {
            const n = round.data.source.round;
            this.journal.set(entry.id, { state: 'started', settledAt, reason: `round ${n}${goal.max ? ` of ${goal.max}` : ''} began` });
            return;
        }
        this.journal.set(entry.id, { state: 'not started', settledAt, reason: entry.state === 'starting' ? 'DSH stopped before it could start the goal (a crash or a forced quit)' : 'DSH stopped before a round began (a crash or a forced quit)' });
        free();
    }

    /** Follow a note a killed run left in DSH's queue: its session's log is read again as the session moves. */
    follow(sessionId, entryId) {
        let ids = this.queued.get(sessionId);
        if (!ids) {
            ids = new Set();
            this.queued.set(sessionId, ids);
        }
        ids.add(entryId);
    }

    /** A followed session moved (a turn began or ended, a message came in): read its log in a moment. */
    lookQueued(sessionId) {
        if (!this.queued.has(sessionId) || this.queuedLooks.has(sessionId) || this.stopped) return;
        const timer = this.setTimer(QUEUED_LOOK_MS, () => {
            this.queuedLooks.delete(sessionId);
            void this.readQueued(sessionId).catch((error) => this.logger?.warn?.(`autopilot: could not read the log of ${sessionId}: ${errorText(error)}`));
        });
        this.queuedLooks.set(sessionId, timer);
    }

    /** The followed notes of one session that its log now shows read into a turn: delivered, with that turn. */
    async readQueued(sessionId) {
        const ids = this.queued.get(sessionId);
        if (!ids?.size || this.stopped) return;
        const log = await this.watch.readLog?.(sessionId);
        if (this.stopped || !Array.isArray(log?.events)) return;
        for (const entryId of [...ids]) {
            const entry = this.journal.get(entryId);
            if (!entry || entry.state !== 'not proven') {
                ids.delete(entryId);
                continue;
            }
            const read = readIn(entry, log.events);
            if (!read) continue;
            this.journal.set(entryId, { state: 'delivered', settledAt: this.now(), ...read, reason: '', queued: false });
            ids.delete(entryId);
        }
        if (ids.size === 0) this.queued.delete(sessionId);
        this.changed();
    }

    sessionData(sessionId) {
        let s = this.data.sessions[sessionId];
        if (!s) {
            s = { done: {} };
            this.data.sessions[sessionId] = s;
        }
        s.done ??= {};
        return s;
    }

    titleOf(sessionId) {
        try { return this.watch.titleOf?.(sessionId) || this.watch.rowOf?.(sessionId)?.title || ''; } catch { return ''; }
    }

    onWatch(event) {
        if (this.stopped || !isRecord(event) || typeof event.sessionId !== 'string') return;
        const id = event.sessionId;
        // A note a killed run left in this session's queue may be read now.
        if (this.queued.has(id) && (event.type === 'turn-start' || event.type === 'turn-end' || (event.type === 'state' && event.change === 'user/message'))) this.lookQueued(id);
        switch (event.type) {
            case 'turn-start':
                // It is working: whatever was pending waits for this turn's end.
                this.cancel(id);
                return;
            case 'turn-end':
                this.onTurnEnd(id, event.state);
                return;
            case 'state':
                if (event.change === 'user/message' && event.state?.inKind === 'user') this.onPersonWrote(id);
                return;
            default:
        }
    }

    /** The person wrote in a session: they are on it, so Autopilot starts fresh there. */
    onPersonWrote(sessionId) {
        const s = this.data.sessions[sessionId];
        if (s && (s.nudges || s.backedOff || s.errorTries || s.mark || s.carry)) {
            s.nudges = 0;
            s.errorTries = 0;
            delete s.backedOff;
            delete s.mark;
            delete s.gaveUp;
            // The person took the session over: what a stop cut off is theirs now.
            delete s.carry;
            this.store.change();
            this.changed();
        }
        this.dropAsks((ask) => ask.sessionId === sessionId, 'you wrote in the session, so it no longer applies');
    }

    onTurnEnd(sessionId, state) {
        const end = state?.end;
        if (!end) return;
        const s = this.sessionData(sessionId);
        if (s.mark && progressed(s.mark, state)) {
            s.nudges = 0;
            delete s.mark;
            delete s.backedOff;
            this.store.change();
        }
        if (end.kind === 'completed') {
            if (s.errorTries) s.errorTries = 0;
            delete s.gaveUp;
        }
        // A carry-on after a stop is over once a turn of it ends without an error (or the person stopped it, or it
        // was blocked): what the stop cut off is no longer Autopilot's to retry. A failed one keeps it (see carrying).
        if (s.carry && carrying(s, end) && end.kind !== 'error' && !cutOff(end)) {
            delete s.carry;
            this.store.change();
        }
        // The turn a carry-on note started (after a restart or an error) is over: its goal waited for it.
        const after = s.goalAfter;
        if (after && Number.isSafeInteger(end.turn) && end.turn >= after.turn) {
            delete s.goalAfter;
            this.store.change();
            if ((end.kind === 'completed' || end.kind === 'max-tokens') && this.active() && this.ruleOf(sessionId) !== 'off') {
                this.cancel(sessionId);
                void this.goalAfterNote(sessionId, state, after).catch((error) => this.logger?.warn?.(`autopilot: could not start the goal of ${sessionId}: ${errorText(error)}`));
                this.changed();
                return;
            }
        }
        if (!this.active() || this.ruleOf(sessionId) === 'off') return;
        if (cutOff(end)) this.schedule(sessionId, 'resume', LIVE_CUT_DELAY_MS);
        else if (!hasOpenWork(state) && !(end.kind === 'error' && carrying(s, end))) this.cancel(sessionId);
        else if (end.kind === 'error') this.schedule(sessionId, 'error', this.dueIn('error', end, sessionId));
        else if (end.kind === 'completed' || end.kind === 'max-tokens') this.schedule(sessionId, 'idle', this.idleMs());
        else this.cancel(sessionId);
        this.changed();
    }

    /**
     * The turn after a carry-on note ended without an error: start the goal
     * that waited for it. Part of the note's action, so never held back or
     * asked again; Autopilot's own start counts toward the hour.
     */
    async goalAfterNote(sessionId, state, after) {
        const goal = state?.goal;
        if (goal?.phase !== 'active' || this.goalArmed(sessionId)) return undefined;
        const by = after.by === 'you' ? 'you' : 'Autopilot';
        if (by !== 'you') {
            this.data.notes.push(this.now());
            this.store.change();
        }
        const why = `${after.kind === 'error' ? 'The turn after its carry-on note ended without an error' : 'Its goal was active when DSH stopped, and the turn after its carry-on note has ended'}, so its goal goes on: this start begins ${nextRound(goal)}.`;
        return this.rearm(sessionId, { key: `goal-after:${after.turn}:${state.end?.at ?? 0}`, why, summary: after.kind === 'error' ? 'Started its goal again after an error' : 'Started its goal again after the carry-on note' }, by, { quiet: true });
    }

    idleMs() {
        return Math.max(1, this.config.idleSeconds ?? 600) * 1000;
    }

    errorDelays() {
        const list = Array.isArray(this.config.errorRetrySeconds) ? this.config.errorRetrySeconds.filter((n) => Number.isFinite(n) && n >= 0) : [];
        return list.length ? list : [120, 600, 1800];
    }

    errorDelay(tries) {
        const list = this.errorDelays();
        return list[Math.min(tries, list.length - 1)] * 1000;
    }

    /**
     * How long from now a check of this trigger is due: an idle session's
     * quiet time from its turn's end; a failed turn's wait for its next try
     * from its end (at once when the tries are spent, so the give-up says so
     * as soon as the last try failed).
     */
    dueIn(trigger, end, sessionId) {
        if (trigger === 'idle') return Math.max(0, (end?.at ?? 0) + this.idleMs() - this.now());
        if (trigger === 'error') {
            const tries = this.data.sessions[sessionId]?.errorTries ?? 0;
            if (tries >= this.errorDelays().length) return 0;
            return Math.max(0, (end?.at ?? 0) + this.errorDelay(tries) - this.now());
        }
        return 0;
    }

    // ── Timers ────────────────────────────────────────────────────────

    schedule(sessionId, trigger, ms) {
        this.cancel(sessionId);
        const at = this.now() + ms;
        const timer = this.setTimer(ms, () => {
            if (this.timers.get(sessionId)?.timer !== timer) return;
            this.timers.delete(sessionId);
            void this.check(sessionId, trigger).catch((error) => this.logger?.warn?.(`autopilot: the ${trigger} check of ${sessionId} failed: ${errorText(error)}`));
        });
        this.timers.set(sessionId, { trigger, timer, at });
    }

    cancel(sessionId) {
        const pending = this.timers.get(sessionId);
        if (!pending) return;
        this.clearTimer(pending.timer);
        this.timers.delete(sessionId);
    }

    /**
     * Look at one session again, as its last turn end calls for (its rule or
     * a setting changed). A session whose saved state still shows its turn
     * open (DSH was killed under it) is read from its log, where DSH closes
     * that turn as cut off.
     */
    async recheck(sessionId) {
        if (!this.active() || this.ruleOf(sessionId) === 'off') return;
        let state = this.watch.stateOf?.(sessionId);
        if ((!state?.end || state.open) && this.watch.statusOf?.(sessionId) !== 'running') {
            try {
                state = (await this.watch.fullState?.(sessionId)) ?? state;
            } catch (error) {
                this.logger?.warn?.(`autopilot: could not read ${sessionId}: ${errorText(error)}`);
            }
            if (!this.active() || this.ruleOf(sessionId) === 'off') return;
        }
        const end = state?.end;
        if (!end || state.open) return;
        if (cutOff(end)) this.cutSeen.set(sessionId, end);
        const trigger = cutOff(end) ? 'resume' : end.kind === 'error' ? 'error' : 'idle';
        this.schedule(sessionId, trigger, this.dueIn(trigger, end, sessionId));
        this.changed();
    }

    /**
     * Look at every session: at start, when the switch goes back on, when a
     * setting is fixed and when the default rule changes. Cut-off sessions
     * are found in their logs each time (as at start), so one whose rule left
     * Off later is offered too; idle sessions with open work that ended
     * within `idleWindowHours` get their check at its due time.
     */
    async scan(reason) {
        if (!this.active()) return;
        if (this.config.resumeAfterRestart !== false) {
            const withinMs = Math.max(1, this.config.resumeWindowHours ?? 6) * 3600000;
            let cut = [];
            try {
                cut = await this.watch.cutOffSessions({ withinMs });
            } catch (error) {
                this.logger?.warn?.(`autopilot: could not look for cut-off sessions (${reason}): ${errorText(error)}`);
            }
            if (!this.active()) return;
            for (const item of cut) {
                this.cutSeen.set(item.sessionId, item.end);
                if (this.ruleOf(item.sessionId) === 'off' || this.timers.has(item.sessionId)) continue;
                this.schedule(item.sessionId, 'resume', 0);
            }
        }
        const rows = await this.watch.list();
        if (!this.active()) return;
        const windowMs = Math.max(1, this.config.idleWindowHours ?? 2) * 3600000;
        for (const row of rows) {
            const id = row.sessionId;
            if (this.timers.has(id) || row.parentSessionId || row.origin === 'subagent') continue;
            if (this.ruleOf(id) === 'off') continue;
            const state = row.state;
            const end = state?.end;
            // Cut-off sessions came from their logs above.
            if (!end || state.open || row.status === 'running' || cutOff(end)) continue;
            if (this.now() - end.at > windowMs) continue;
            // A failed carry-on after a stop counts as open work too (see carrying).
            if (!hasOpenWork(state) && !(end.kind === 'error' && carrying(this.data.sessions[id], end))) continue;
            if (end.kind === 'error') this.schedule(id, 'error', this.dueIn('error', end, id));
            else if (end.kind === 'completed' || end.kind === 'max-tokens') this.schedule(id, 'idle', this.dueIn('idle', end, id));
        }
        this.changed();
    }

    // ── Deciding ──────────────────────────────────────────────────────

    /** Whether the goal of a loaded session is armed (cold sessions' goals are always disarmed). */
    goalArmed(sessionId) {
        try {
            const agent = this.watch.agentOf?.(sessionId);
            if (!agent) return false;
            return this.watch.goals?.get?.(agent)?.activation === 'armed';
        } catch {
            return false;
        }
    }

    /**
     * What to do for one session now, from its state: a plan to act on, or
     * `{ action: 'none' }` with the reason (`log: true` when the person
     * would want to see it).
     */
    plan(sessionId, trigger, { force = false, state = this.watch.stateOf?.(sessionId) } = {}) {
        const row = this.watch.rowOf?.(sessionId) ?? {};
        const none = (why, log = false) => ({ action: 'none', why, log });
        if (!state) return none('no state for it yet');
        if (row.parentSessionId || row.origin === 'subagent') return none('a subagent\'s session; its parent carries it');
        if (row.status === 'running' || this.watch.statusOf?.(sessionId) === 'running') return none('it is working');
        if (state.open) return none('a turn is open');
        const end = state.end;
        if (!end) return none('it has not ended a turn');
        const s = this.data.sessions[sessionId] ?? { done: {} };
        const key = `${trigger}:${end.turn}:${end.at}`;
        const base = { key, end, state, trigger };
        if (!force && s.done?.[key]) return none('already handled');
        if ((state.inAt ?? 0) > end.at) return none('something was written in it after that turn');
        const now = this.now();
        const goalStopped = state.goal?.phase === 'active' && !this.goalArmed(sessionId);
        // A goal that used every round its limit allows cannot be started again (DSH refuses): it waits for the person.
        const spent = goalStopped && goalSpent(state.goal);
        const startable = goalStopped && !spent;
        // A goal the person paused, or one the agent marked blocked, waits for the person, todos and all.
        const held = trigger !== 'resume' && (state.goal?.phase === 'paused' || state.goal?.phase === 'blocked');
        if (held) return none(state.goal.phase === 'paused' ? 'its goal is paused' : 'its goal is blocked and waits for you');
        switch (trigger) {
            case 'resume': {
                if (!cutOff(end)) return none('its last turn was not cut off');
                const windowMs = Math.max(1, this.config.resumeWindowHours ?? 6) * 3600000;
                if (!force && now - end.at > windowMs) return { ...none(`it was cut off more than ${this.config.resumeWindowHours ?? 6} hours ago`, true), ...base, kind: 'resume' };
                // An active goal waits for the carry-on turn to end, then starts again (lib/pilot.js onTurnEnd).
                return { action: 'note', kind: 'resume', ...base, text: carryOnNote(end, state, now), why: whyResume(end, now), goalAfter: state.goal?.phase === 'active' && !goalSpent(state.goal), summary: 'Told it to carry on after DSH stopped' };
            }
            case 'idle': {
                if (end.kind !== 'completed' && end.kind !== 'max-tokens') return none('its last turn did not end normally');
                const quiet = now - end.at;
                if (!force && quiet < this.idleMs() - 1000) return none('not quiet long enough yet');
                // Only an ask, or an offer that hands the next step to the person, holds the note (lib/ends.js).
                if (asksForAnswer(state.text)) return none('its last reply asks you something');
                if (handOverIn(state.text)) return none('its last reply leaves the next step to you');
                if (startable) return { action: 'rearm', kind: 'rearm', ...base, why: whyRearmIdle(state, quiet), summary: 'Started its goal again' };
                if (spent && (state.todos?.open ?? 0) === 0) return { ...none(`its goal used all ${state.goal.max} of its rounds; raise its round limit to let it go on`, true), ...base };
                if ((state.todos?.open ?? 0) > 0) {
                    if (s.backedOff && !force) return none('Autopilot backed off here');
                    const max = Math.max(1, this.config.maxNudges ?? 2);
                    if ((s.nudges ?? 0) >= max && !force) return { action: 'backoff', kind: 'backoff', ...base, why: whyBackOff(max), summary: 'Backed off: notes brought no progress' };
                    return { action: 'note', kind: 'nudge', ...base, text: nudgeNote(state), why: whyNudge(state, quiet), summary: 'Told it to carry on with its todos' };
                }
                return none('nothing is open');
            }
            case 'error': {
                if (end.kind !== 'error') return none('its last turn did not fail');
                const tries = s.errorTries ?? 0;
                // A carry-on after a stop that failed: the work the stop cut off is still open, todos or not.
                const carry = carrying(s, end) ? s.carry : undefined;
                const hasWork = startable || (state.todos?.open ?? 0) > 0 || Boolean(carry);
                if (!hasWork) return spent ? { ...none(`its goal used all ${state.goal.max} of its rounds; raise its round limit to let it go on`, true), ...base } : none('nothing is open');
                if (tries >= this.errorDelays().length && !force) {
                    if (s.gaveUp) return none('Autopilot already gave up here');
                    return { action: 'giveup', kind: 'giveup', ...base, why: whyGiveUp(tries), summary: 'Stopped retrying after errors' };
                }
                // A note first, never a blind goal start: a start begins a goal round, and a failing provider would spend
                // the goal's rounds. The goal starts again once a turn ends without an error (onTurnEnd).
                return { action: 'note', kind: 'error', ...base, text: errorNote(end, state, { carry }), why: startable ? whyRearmError(end, state) : whyErrorNote(end, state, { carry }), summary: 'Told it to carry on after an error', retry: true, goalAfter: startable, ...(carry ? { carry: { ...carry } } : {}) };
            }
            default:
                return none(`unknown trigger ${trigger}`);
        }
    }

    /** Check a session and act on what the plan says. */
    async check(sessionId, trigger, { force = false, by = 'Autopilot', why } = {}) {
        if (!this.active() && !force) return { action: 'none', why: 'Autopilot is off' };
        const rule = this.ruleOf(sessionId);
        if (rule === 'off' && !force) return { action: 'none', why: 'its rule is Off' };
        let state;
        try {
            state = await this.watch.fullState(sessionId);
        } catch (error) {
            return { action: 'none', why: `its state could not be read: ${errorText(error)}` };
        }
        // The read took a moment: the switch or the rule may have changed meanwhile.
        if (!force && (!this.active() || this.ruleOf(sessionId) === 'off')) return { action: 'none', why: 'Autopilot or its rule went off' };
        const planned = this.plan(sessionId, trigger, { force, state });
        // The person's own action: its Why line says who asked for it.
        const plan = why && planned.action !== 'none' ? { ...planned, why } : planned;
        if (plan.action === 'none') {
            if (plan.log && plan.key) {
                this.sessionData(sessionId).done[plan.key] = this.now();
                this.store.change();
                this.journal.add({ kind: 'skip', sessionId, title: this.titleOf(sessionId), text: 'Left it alone', why: `${plan.why[0].toUpperCase()}${plan.why.slice(1)}.`, state: 'done', by: 'Autopilot' });
                this.changed();
            }
            return plan;
        }
        if (rule === 'ask' && !force && plan.action !== 'backoff' && plan.action !== 'giveup') return this.ask(sessionId, plan);
        return this.perform(sessionId, plan, by);
    }

    // ── Acting ────────────────────────────────────────────────────────

    /** Whether the hourly limit has room for one more note, and take it. */
    takeNote() {
        const hourAgo = this.now() - 3600000;
        this.data.notes = this.data.notes.filter((at) => at > hourAgo);
        const limit = Math.max(1, this.config.maxNotesPerHour ?? 20);
        if (this.data.notes.length >= limit) return false;
        this.data.notes.push(this.now());
        return true;
    }

    async perform(sessionId, plan, by = 'Autopilot') {
        const s = this.sessionData(sessionId);
        const title = this.titleOf(sessionId);
        s.done[plan.key] = this.now();
        this.prune(s);
        this.store.change();
        if (plan.action === 'backoff') {
            s.backedOff = this.now();
            this.store.change();
            const entry = this.journal.add({ kind: 'backoff', sessionId, title, text: plan.summary, why: plan.why, state: 'backed off', by });
            this.notify?.({ title: `Autopilot backed off${title ? `: ${clip(title, 60)}` : ''}`, body: 'Its notes brought no progress; the session is yours.', kind: 'autopilot', sessionId });
            this.changed();
            return { action: 'backoff', entry };
        }
        if (plan.action === 'giveup') {
            s.gaveUp = this.now();
            this.store.change();
            const entry = this.journal.add({ kind: 'giveup', sessionId, title, text: plan.summary, why: plan.why, state: 'gave up', by });
            this.notify?.({ title: `Autopilot stopped retrying${title ? `: ${clip(title, 60)}` : ''}`, body: 'It kept failing; the session is yours.', kind: 'autopilot', sessionId });
            this.changed();
            return { action: 'giveup', entry };
        }
        // The limit stops Autopilot, not the person: their own answer or Try again is never held back, nor counted.
        if (by !== 'you' && !this.takeNote()) {
            delete s.done[plan.key];
            this.store.change();
            const hourKey = `held:${Math.floor(this.now() / 3600000)}`;
            if (!this.data.heldAt || this.data.heldAt !== hourKey) {
                this.data.heldAt = hourKey;
                this.journal.add({ kind: 'held', sessionId, title, text: 'Held back', why: whyHeld(this.config.maxNotesPerHour ?? 20), state: 'held', by });
            }
            // Look again once the hour has room.
            this.schedule(sessionId, plan.kind === 'resume' ? 'resume' : plan.kind === 'error' ? 'error' : 'idle', 10 * 60000);
            this.changed();
            return { action: 'held' };
        }
        if (plan.retry) s.errorTries = (s.errorTries ?? 0) + 1;
        if (plan.kind === 'nudge') {
            s.nudges = (s.nudges ?? 0) + 1;
            s.mark = markOf(plan.state);
        }
        this.store.change();
        if (plan.action === 'rearm') return this.rearm(sessionId, plan, by);
        return this.note(sessionId, plan, by);
    }

    /**
     * Put a note into the session and follow it until the session's log shows
     * it was read. A goal that waits on the note (after a restart or an
     * error) is started once the turn the note began ends without an error.
     */
    async note(sessionId, plan, by) {
        const title = this.titleOf(sessionId);
        const entry = this.journal.add({ kind: plan.kind, sessionId, title, text: plan.summary, note: plan.text, why: plan.why, state: 'sending', by, ...(plan.key ? { key: plan.key } : {}) });
        // A carry-on after a stop: until a turn from it ends without an error, the cut-off work counts as open. Set
        // before the note goes, so a turn that fails at once (before the delivery is known) still counts.
        const carry = plan.kind === 'resume' && Number.isSafeInteger(plan.end?.turn) ? { turn: plan.end.turn + 1, cut: plan.end.turn, at: this.now() } : undefined;
        if (carry) {
            this.sessionData(sessionId).carry = carry;
            this.store.change();
        }
        this.changed();
        const delivery = await this.watch.deliver(sessionId, plan.text);
        let marked = false;
        const show = (d) => {
            // Stopped: the next start settles this entry from the session's log.
            if (this.stopped) return;
            const state = d.state === 'delivered' ? 'delivered' : d.state === 'queued' ? 'in the queue' : d.state === 'failed' ? 'not delivered' : 'sending';
            this.journal.set(entry.id, { state, ...(typeof d.id === 'string' ? { messageId: d.id } : {}), ...(d.turn !== undefined ? { turn: d.turn } : {}), ...(d.reason ? { reason: d.reason } : {}), ...(d.deliveredAt ? { deliveredAt: d.deliveredAt } : {}) });
            const s = this.sessionData(sessionId);
            if (carry && s.carry === carry) {
                // The turn that read it is the carry-on's first; a note that never arrived carried nothing on.
                if (d.state === 'delivered' && Number.isSafeInteger(d.turn)) carry.turn = d.turn;
                else if (d.state === 'failed') delete s.carry;
                this.store.change();
            }
            if (plan.goalAfter && d.state === 'delivered' && Number.isSafeInteger(d.turn) && !marked) {
                marked = true;
                s.goalAfter = { turn: d.turn, at: this.now(), by, kind: plan.kind };
                this.store.change();
            }
            this.changed();
        };
        show(delivery);
        delivery.onChange?.(show);
        return { action: 'note', entry, delivery };
    }

    /**
     * Start a stopped goal again. Resolves once DSH took the start; the
     * proof (a round of the revision this start made) follows in the event
     * log, and in `settled` for whoever wants to wait for it.
     */
    async rearm(sessionId, plan, by, { quiet = false } = {}) {
        const title = this.titleOf(sessionId);
        const entry = this.journal.add({ kind: 'rearm', sessionId, title, text: plan.summary, why: plan.why, state: 'starting', by, ...(plan.key ? { key: plan.key } : {}) });
        this.changed();
        const fail = (reason, state = 'not started') => {
            this.journal.set(entry.id, { state, reason });
            this.changed();
            return { action: 'rearm', entry, ok: false, reason, settled: Promise.resolve(false) };
        };
        const goals = this.watch.goals;
        if (!goals?.get || !goals?.resume) return fail('this DSH has no goal service');
        let agent;
        try {
            agent = await this.watch.resolveAgent(sessionId);
        } catch (error) {
            return fail(`the session could not be opened: ${errorText(error)}`);
        }
        let goal;
        try { goal = goals.get(agent); } catch (error) { return fail(`its goal could not be read: ${errorText(error)}`); }
        // After a carry-on note the turn may have finished the goal: nothing to start, and nothing went wrong.
        if (!goal || goal.phase !== 'active') return quiet ? fail('its goal is no longer active, so there was nothing to start', 'done') : fail('its goal is no longer active');
        if (goal.activation === 'armed') {
            this.journal.set(entry.id, { state: 'started', reason: 'its goal was already running' });
            this.changed();
            return { action: 'rearm', entry, ok: true, settled: Promise.resolve(true) };
        }
        const max = Number.isSafeInteger(goal.maxGoalRounds) ? goal.maxGoalRounds : 0;
        const used = Number.isSafeInteger(goal.roundsStarted) ? goal.roundsStarted : 0;
        if (max > 0 && used >= max) return fail(`its goal used all ${max} of its rounds; raise its round limit to let it go on`);
        // DSH's start writes the goal's next revision, and the round it begins carries that revision: only that round proves this start.
        const want = { id: goal.id, rev: goal.revision + 1, round: used + 1, max };
        const proof = this.awaitRound(sessionId, want);
        try {
            goals.resume(agent, { id: goal.id, revision: goal.revision });
        } catch (error) {
            proof.cancel();
            return fail(`DSH refused to start it: ${errorText(error)}`);
        }
        try {
            const now = goals.get(agent);
            if (now?.id === goal.id && Number.isSafeInteger(now.revision)) want.rev = now.revision;
        } catch { /* the revision DSH's start writes */ }
        if (this.journal.get(entry.id)?.state === 'starting') this.journal.set(entry.id, { state: 'waiting for a round', goal: { ...want } });
        this.changed();
        const settled = proof.promise.then((result) => {
            if (result.stopped) return false;
            if (result.round !== undefined) this.journal.set(entry.id, { state: 'started', goal: { ...want }, reason: `round ${result.round}${max ? ` of ${max}` : ''} began` });
            else this.journal.set(entry.id, { state: 'not started', goal: { ...want }, reason: result.why });
            this.changed();
            if (result.round === undefined) this.logger?.warn?.(`autopilot: ${sessionId}: no goal round after a start (${result.why})`);
            return result.round !== undefined;
        });
        return { action: 'rearm', entry, ok: true, settled };
    }

    /**
     * Wait for the round a goal start begins: a goal round's message in the
     * session under the revision the start wrote. Settles without one when
     * the session's turn fails first (an error stops a goal), when the goal
     * changes first (paused, blocked, done, or started again by someone
     * else), after `ms`, or when Autopilot stops (`stopped`: nothing is
     * written then; the next start reads the log).
     * @returns {{ promise: Promise<{ round?: number, why?: string, stopped?: boolean }>, cancel: () => void }}
     */
    awaitRound(sessionId, want, ms = ROUND_PROOF_MS) {
        let off;
        let timer;
        let settle;
        const proof = {};
        proof.promise = new Promise((resolve) => {
            settle = (value) => {
                off?.();
                this.clearTimer(timer);
                this.proofs.delete(proof);
                resolve(value);
            };
        });
        off = this.watch.on((event) => {
            if (event?.sessionId !== sessionId) return;
            const goal = event.state?.goal;
            if (event.type === 'state' && event.change === 'user/message' && event.state?.inKind === 'goal' && goal?.id === want.id && goal.rev === want.rev) {
                settle({ round: goal.rounds });
            } else if (event.type === 'state' && event.change === 'goal/change' && goal?.id === want.id && (goal.rev > want.rev || goal.phase !== 'active')) {
                settle({ why: goal.phase === 'blocked' ? `DSH blocked the goal before a round began${goal.blocked ? `: ${goal.blocked}` : ''}`
                    : goal.phase === 'paused' ? 'the goal was paused before a round began'
                        : goal.phase === 'complete' ? 'the goal was marked done before a round began'
                            : 'the goal was changed or started again before a round of this start began' });
            } else if (event.type === 'state' && event.change === 'goal/change' && !goal) {
                settle({ why: 'the goal was cleared before a round began' });
            } else if (event.type === 'turn-end' && event.end?.kind === 'error') {
                settle({ why: 'the turn running in the session failed before a round began (an error stops a goal)' });
            }
        });
        timer = this.setTimer(ms, () => settle({ why: `DSH took the start, but no round began within ${Math.round(ms / 60000)} minutes` }));
        proof.cancel = () => settle({ stopped: true });
        this.proofs.add(proof);
        return proof;
    }

    /** Raise a question instead of acting (the Ask first rule). */
    ask(sessionId, plan) {
        const title = this.titleOf(sessionId);
        const id = `autopilot:${sessionId}:${plan.key}`;
        // Asked already and still waiting: once is enough. Not marked handled until answered, so a
        // question lost to a reload is asked again.
        if ((this.watch.asks?.() ?? []).some((ask) => ask.id === id)) return { action: 'ask', id, again: true };
        const label = actionLabel(plan);
        // The same question set aside when Autopilot last stopped: asked again under its first entry and time, without a second notification.
        const earlier = this.journal.list({ limit: 400 }).find((e) => e.kind === 'ask' && e.askId === id);
        const carried = earlier?.stopped === true && earlier.state === 'withdrawn' ? earlier : undefined;
        // The log row shows the session's name beside it: the entry says what was asked, the Why line why. Logged
        // first, so the question and its entry carry one time.
        const entry = carried ? undefined : this.journal.add({ kind: 'ask', sessionId, title, text: `Asked you whether to ${label[0].toLowerCase()}${label.slice(1)}`, why: `${plan.why} Its rule is Ask first.`, askWhy: plan.why, state: 'asked you', by: 'Autopilot', askId: id });
        // Asked again: the card keeps the Why its log entry has (the moment it was first asked), not one worked out now.
        const why = carried ? (typeof carried.askWhy === 'string' ? carried.askWhy : String(carried.why ?? plan.why).replace(/ Its rule is Ask first\.$/, '')) : plan.why;
        try {
            this.watch.raiseAsk({
                id,
                sessionId,
                source: 'Autopilot',
                title,
                question: question(plan, title),
                recommendation: label,
                why,
                options: [{ id: 'go', label }, { id: 'skip', label: 'Leave it' }],
                freeText: plan.action === 'note',
                at: carried ? carried.at : entry.at,
                onAnswer: (answer, by) => this.answered(sessionId, plan, answer, by),
            });
        } catch (error) {
            if (entry) this.journal.set(entry.id, { state: 'withdrawn', reason: `withdrawn: it could not be listed (${errorText(error).replace(/\.$/, '')})` });
            throw error;
        }
        if (carried) {
            this.journal.set(carried.id, { state: 'asked you', stopped: false, reason: '', settledAt: null, askedAgainAt: this.now() });
            this.changed();
            return { action: 'ask', id, again: true };
        }
        this.notify?.({ title: `Autopilot asks${title ? ` about ${clip(title, 50)}` : ''}`, body: question(plan, title), kind: 'decision', sessionId });
        this.changed();
        return { action: 'ask', id };
    }

    /** The person answered a question Autopilot raised. */
    async answered(sessionId, plan, answer, by = 'you') {
        const refused = answer === 'skip' ? undefined : this.refusal(sessionId);
        if (refused) throw Object.assign(new Error(refused), { refused: true });
        this.sessionData(sessionId).done[plan.key] = this.now();
        this.store.change();
        this.settleAsk(`autopilot:${sessionId}:${plan.key}`, { state: 'answered' });
        if (answer === 'skip') {
            this.journal.add({ kind: 'answer', sessionId, title: this.titleOf(sessionId), text: 'Left it alone', why: 'You chose Leave it.', state: 'done', by });
            this.changed();
            return { done: 'left alone' };
        }
        if (answer === 'go') {
            // The session may have moved since the question: decide again, now, as the person said go.
            const result = await this.check(sessionId, plan.trigger ?? 'idle', { force: true, by, why: `You chose “${actionLabel(plan)}”.` });
            if (result.action === 'none') {
                this.journal.add({ kind: 'skip', sessionId, title: this.titleOf(sessionId), text: 'Nothing to do now', why: `You said go, but ${result.why}.`, state: 'done', by });
                this.changed();
            }
            return result;
        }
        if (typeof answer === 'string' && answer.trim() !== '') {
            return this.note(sessionId, { ...plan, text: answerNote(answer.trim()), summary: 'Passed on your answer', why: 'You answered its question in your own words.' }, by);
        }
        throw new Error('That answer is empty.');
    }

    /** Try a backed-off or failed session again now (the page's Try again). */
    async retry(sessionId) {
        const refused = this.refusal(sessionId);
        if (refused) throw new Error(refused);
        const s = this.sessionData(sessionId);
        s.nudges = 0;
        s.errorTries = 0;
        delete s.backedOff;
        delete s.gaveUp;
        delete s.mark;
        this.store.change();
        const state = this.watch.stateOf?.(sessionId);
        const end = state?.end;
        const trigger = cutOff(end) ? 'resume' : end?.kind === 'error' ? 'error' : 'idle';
        const result = await this.check(sessionId, trigger, { force: true, by: 'you', why: 'You pressed Try again on Autopilot\'s page.' });
        if (result.action === 'none') {
            this.journal.add({ kind: 'skip', sessionId, title: this.titleOf(sessionId), text: 'Nothing to do', why: `You pressed Try again, but ${result.why}.`, state: 'done', by: 'you' });
            this.changed();
        }
        return result;
    }

    /** Forget handled triggers older than a week. */
    prune(s) {
        const old = this.now() - DONE_KEEP_MS;
        for (const [key, at] of Object.entries(s.done ?? {})) if (!(at > old)) delete s.done[key];
    }

    /**
     * Why a quiet session with open work gets nothing from Autopilot now, in
     * a few words for its row ("waits for you: its last reply asks you
     * something"), or undefined when there is nothing to explain: no open
     * work, a check is pending, or the switch, the rule or the row's own
     * word already says it.
     */
    holdOf(row) {
        if (!isRecord(row) || typeof row.sessionId !== 'string' || row.parentSessionId || row.origin === 'subagent') return undefined;
        // Off, or a rule of Off, says it in the switch and the rule: no hold on top.
        if (!this.active() || this.ruleOf(row.sessionId) === 'off') return undefined;
        if (row.status === 'running') {
            // A running turn is the session's own: say so only when it waits on the person, which Autopilot never answers.
            if (row.state?.approvals?.length) return 'waits for you: a tool waits for you to allow or reject it';
            if (row.state?.asking) return 'waits for you: a question in DSH\'s question box';
            return undefined;
        }
        // A question of Autopilot's waits on the person: the row says so (the question is in the Waiting card).
        const ask = (this.watch.asks?.() ?? []).find((a) => a.source === 'Autopilot' && a.sessionId === row.sessionId);
        if (ask) return `waits for your answer: Autopilot asked whether to ${String(ask.recommendation || 'go ahead').replace(/^./, (c) => c.toLowerCase())}`;
        // The row carries the watcher's view; its full state (the last reply's text) when the watcher has it.
        const full = this.watch.stateOf?.(row.sessionId);
        let state = isRecord(full) && full.end ? full : row.state;
        // DSH was killed under its turn, so the saved state still shows it open: the log has the cut-off end.
        if (state?.open && this.cutSeen.has(row.sessionId)) state = { ...state, open: false, end: this.cutSeen.get(row.sessionId) };
        const end = state?.end;
        if (!end || state.open) return undefined;
        const cut = cutOff(end);
        const s = this.data.sessions[row.sessionId];
        // A cut-off turn gets a carry-on note with or without open work; a failed carry-on after a stop is open work
        // too (see carrying); any other turn, only with open work.
        if (!cut && !hasOpenWork(state) && !(end.kind === 'error' && carrying(s, end))) {
            // A failed turn with nothing open is the person's: the row says so, so "failed" never stands alone.
            return end.kind === 'error' ? 'its last turn failed with nothing left open (no todos, no goal), so Autopilot leaves it to you' : undefined;
        }
        if (s?.backedOff || s?.gaveUp) return undefined;
        if (!cut && state.goal?.phase === 'active' && goalSpent(state.goal) && !this.goalArmed(row.sessionId) && (state.todos?.open ?? 0) === 0) {
            return `waits for you: its goal used all ${state.goal.max} of its rounds; raise its round limit to let it go on`;
        }
        if (!cut && state.goal?.phase === 'paused') return 'waits for you: its goal is paused';
        if (!cut && state.goal?.phase === 'blocked') return 'waits for you: its goal is blocked';
        if (end.kind === 'aborted' && !cut) return 'you stopped its last turn, so Autopilot leaves it to you';
        if (end.kind === 'blocked') return 'waits for you: its last turn was blocked';
        if (end.kind === 'completed' || end.kind === 'max-tokens') {
            // Without the reply's text (an old saved state), the ask Session Watch read from it: an offer counts only
            // when its own words hand the next step over.
            const text = typeof state.text === 'string' ? state.text : undefined;
            const ask = isRecord(state.ask) && state.ask.turn === end.turn ? state.ask : undefined;
            if (text !== undefined ? asksForAnswer(text) : Boolean(ask) && ask.soft !== true) return 'waits for you: its last reply asks you something';
            const handOver = text !== undefined ? handOverIn(text) : ask?.soft === true ? handOverIn(ask.question) : undefined;
            if (handOver) return `waits for you: its last reply leaves the next step to you (“${handOver.length > 90 ? `${handOver.slice(0, 89)}…` : handOver}”)`;
        }
        if ((state.inAt ?? 0) > end.at) return undefined;
        const trigger = cut ? 'resume' : end.kind === 'error' ? 'error' : 'idle';
        if (s?.done?.[`${trigger}:${end.turn}:${end.at}`]) return 'Autopilot already handled its last turn; it looks again after the next one';
        const windowHours = trigger === 'resume' ? (this.config.resumeWindowHours ?? 6) : (this.config.idleWindowHours ?? 2);
        if (this.now() - end.at <= Math.max(1, windowHours) * 3600000) {
            if (cut && this.config.resumeAfterRestart === false) return 'cut off when DSH stopped; Resume after a restart is off in Autopilot\'s settings';
            // Autopilot's first look comes a moment after it starts: with DSH, after a setting was fixed, or again.
            if (this.startTimer !== undefined) return `Autopilot looks at it ${spanSeconds(this.config.startDelaySeconds ?? 20)} ${START_WORDS[this.startedAfter] ?? START_WORDS.dsh}`;
            return undefined;
        }
        return cut
            ? `cut off more than ${windowHours} h ago, so Autopilot leaves it to you`
            : `quiet for over ${windowHours} h, longer than Autopilot looks back; it acts again after the session's next turn`;
    }

    /** What is pending, for the window: session id → { trigger, at } ('giveup' when a failed session's tries are spent). */
    pending() {
        const out = {};
        for (const [id, item] of this.timers) {
            const spentTries = item.trigger === 'error' && (this.data.sessions[id]?.errorTries ?? 0) >= this.errorDelays().length;
            out[id] = { trigger: spentTries ? 'giveup' : item.trigger, at: item.at };
        }
        return out;
    }
}
