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
 *    a goal. After a wait (`errorRetrySeconds`, growing) the goal is started
 *    again, or a session with open todos gets a carry-on note; then
 *    Autopilot gives up and says so.
 *
 * Per session the rule is Auto (act), Ask first (raise a question in
 * Decisions and on Autopilot's page) or Off. A kill switch stops everything
 * at once. Every action, and every time it holds back for a reason the
 * person would want to know, goes in the event log with a "why" line; a
 * note's entry follows it until the session's log proves it was read.
 *
 * @module dsh-plugin-autopilot/pilot
 */
import { actionLabel, answerNote, carryOnNote, errorNote, nudgeNote, question, whyBackOff, whyErrorNote, whyGiveUp, whyHeld, whyNudge, whyRearmError, whyRearmIdle, whyResume } from './notes.js';
import { clip, errorText, isRecord } from './shared/safe.js';
import { asksSomeone, cutOff } from './shared/words.js';

export const RULES = Object.freeze(['auto', 'ask', 'off']);
/** The rules in the window's words. */
export const RULE_WORDS = Object.freeze({ auto: 'Auto', ask: 'Ask first', off: 'Off' });

/** How long after a live cut-off (a reload, not a restart) Autopilot looks again. */
const LIVE_CUT_DELAY_MS = 15000;
/** How long a re-armed goal has to start a round before the log says it did not. */
const REARM_PROOF_MS = 120000;
/** After a carry-on note, the goal's next round waits for that turn to end: allow a long turn. */
const AFTER_NOTE_PROOF_MS = 3 * 3600000;
/** A handled trigger is remembered this long, so a restart never repeats one. */
const DONE_KEEP_MS = 7 * 86400000;

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

/** Whether a session moved since `mark`: a todo finished or dropped, or the goal ran a round. */
export function progressed(mark, state) {
    if (!mark) return false;
    const now = markOf(state);
    return now.done > mark.done || now.open < mark.open || now.rounds > mark.rounds;
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
        this.startTimer = undefined;
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
        if (this.ruleOf(sessionId) !== 'off') this.recheck(sessionId);
    }

    setDefaultRule(rule) {
        if (!RULES.includes(rule)) throw new Error(`The rule must be one of ${RULES.join(', ')}.`);
        this.data.defaultRule = rule;
        this.store.change();
        this.journal.add({ kind: 'rule', text: `Sessions without their own rule now use ${RULE_WORDS[rule]}.`, why: 'You changed the default on Autopilot\'s page.', state: 'done', by: 'you' });
        this.changed();
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
            void this.scan('switch');
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
        if (entry) this.journal.set(entry.id, patch);
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

    start() {
        if (this.started) return;
        this.started = true;
        this.offWatch = this.watch.on((event) => this.onWatch(event));
        const delay = Math.max(0, (this.config.startDelaySeconds ?? 20) * 1000);
        this.startTimer = this.setTimer(delay, () => {
            this.startTimer = undefined;
            void this.scan('start').catch((error) => this.logger?.warn?.(`autopilot: the start check failed: ${errorText(error)}`));
        });
    }

    stop() {
        this.stopped = true;
        this.offWatch?.();
        if (this.startTimer !== undefined) this.clearTimer(this.startTimer);
        for (const id of [...this.timers.keys()]) this.cancel(id);
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
            this.journal.set(entry.id, { state: 'withdrawn', stopped: true, reason: 'withdrawn: Autopilot stopped (DSH quit, or Autopilot or Session Watch was switched off); it asks again when it runs, if this still applies' });
        }
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
        if (s && (s.nudges || s.backedOff || s.errorTries || s.mark)) {
            s.nudges = 0;
            s.errorTries = 0;
            delete s.backedOff;
            delete s.mark;
            delete s.gaveUp;
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
        if (!this.active() || this.ruleOf(sessionId) === 'off') return;
        if (cutOff(end)) this.schedule(sessionId, 'resume', LIVE_CUT_DELAY_MS);
        else if (!hasOpenWork(state)) this.cancel(sessionId);
        else if (end.kind === 'error') this.schedule(sessionId, 'error', this.errorDelay(s.errorTries ?? 0));
        else if (end.kind === 'completed' || end.kind === 'max-tokens') this.schedule(sessionId, 'idle', this.idleMs());
        else this.cancel(sessionId);
        this.changed();
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

    /** Look at one session now, as its last turn end calls for. */
    recheck(sessionId) {
        const state = this.watch.stateOf?.(sessionId);
        const end = state?.end;
        if (!end || state.open) return;
        const trigger = cutOff(end) ? 'resume' : end.kind === 'error' ? 'error' : 'idle';
        const due = trigger === 'idle' ? Math.max(0, end.at + this.idleMs() - this.now()) : 0;
        this.schedule(sessionId, trigger, due);
    }

    /**
     * Look at every session: at start (what a stop cut off, and idle
     * sessions with open work that ended lately), and when the kill switch
     * goes back on.
     */
    async scan(reason) {
        if (!this.active()) return;
        if (this.config.resumeAfterRestart !== false && reason === 'start') {
            const withinMs = Math.max(1, this.config.resumeWindowHours ?? 6) * 3600000;
            const cut = await this.watch.cutOffSessions({ withinMs });
            for (const item of cut) {
                if (this.ruleOf(item.sessionId) === 'off') continue;
                this.schedule(item.sessionId, 'resume', 0);
            }
        }
        const rows = await this.watch.list();
        const windowMs = Math.max(1, this.config.idleWindowHours ?? 2) * 3600000;
        for (const row of rows) {
            const id = row.sessionId;
            if (this.timers.has(id) || row.parentSessionId || row.origin === 'subagent') continue;
            if (this.ruleOf(id) === 'off') continue;
            const state = row.state;
            const end = state?.end;
            if (!end || state.open || row.status === 'running') continue;
            if (this.now() - end.at > windowMs && !cutOff(end)) continue;
            if (cutOff(end)) {
                if (reason !== 'start') this.schedule(id, 'resume', 0);
                continue;
            }
            if (!hasOpenWork(state)) continue;
            if (end.kind === 'error') this.schedule(id, 'error', 0);
            else if (end.kind === 'completed' || end.kind === 'max-tokens') this.schedule(id, 'idle', Math.max(0, end.at + this.idleMs() - this.now()));
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
        // A goal the person paused, or one the agent marked blocked, waits for the person, todos and all.
        const held = trigger !== 'resume' && (state.goal?.phase === 'paused' || state.goal?.phase === 'blocked');
        if (held) return none(state.goal.phase === 'paused' ? 'its goal is paused' : 'its goal is blocked and waits for you');
        switch (trigger) {
            case 'resume': {
                if (!cutOff(end)) return none('its last turn was not cut off');
                const windowMs = Math.max(1, this.config.resumeWindowHours ?? 6) * 3600000;
                if (!force && now - end.at > windowMs) return { ...none(`it was cut off more than ${this.config.resumeWindowHours ?? 6} hours ago`, true), ...base, kind: 'resume' };
                return { action: 'note', kind: 'resume', ...base, text: carryOnNote(end, state, now), why: whyResume(end, now), rearmAfter: state.goal?.phase === 'active', summary: 'Told it to carry on after DSH stopped' };
            }
            case 'idle': {
                if (end.kind !== 'completed' && end.kind !== 'max-tokens') return none('its last turn did not end normally');
                const quiet = now - end.at;
                if (!force && quiet < this.idleMs() - 1000) return none('not quiet long enough yet');
                if (asksSomeone(state.text)) return none('its last reply asks you something');
                if (goalStopped) return { action: 'rearm', kind: 'rearm', ...base, why: whyRearmIdle(state, quiet), summary: 'Started its goal again' };
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
                const hasWork = goalStopped || (state.todos?.open ?? 0) > 0;
                if (!hasWork) return none('nothing is open');
                if (tries >= this.errorDelays().length && !force) {
                    if (s.gaveUp) return none('Autopilot already gave up here');
                    return { action: 'giveup', kind: 'giveup', ...base, why: whyGiveUp(tries), summary: 'Stopped retrying after errors' };
                }
                if (goalStopped) return { action: 'rearm', kind: 'rearm', ...base, why: whyRearmError(end, state), summary: 'Started its goal again after an error', retry: true };
                return { action: 'note', kind: 'error', ...base, text: errorNote(end, state), why: whyErrorNote(end, state), summary: 'Told it to carry on after an error', retry: true };
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
            const entry = this.journal.add({ kind: 'giveup', sessionId, title, text: plan.summary, why: plan.why, state: 'backed off', by });
            this.notify?.({ title: `Autopilot stopped retrying${title ? `: ${clip(title, 60)}` : ''}`, body: 'It kept failing; the session is yours.', kind: 'autopilot', sessionId });
            this.changed();
            return { action: 'giveup', entry };
        }
        if (!this.takeNote()) {
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

    /** Put a note into the session and follow it until the session's log shows it was read. */
    async note(sessionId, plan, by) {
        const title = this.titleOf(sessionId);
        const entry = this.journal.add({ kind: plan.kind, sessionId, title, text: plan.summary, note: plan.text, why: plan.why, state: 'sending', by });
        this.changed();
        const delivery = await this.watch.deliver(sessionId, plan.text);
        const show = (d) => {
            const state = d.state === 'delivered' ? 'delivered' : d.state === 'queued' ? 'in the queue' : d.state === 'failed' ? 'not delivered' : 'sending';
            this.journal.set(entry.id, { state, ...(d.turn !== undefined ? { turn: d.turn } : {}), ...(d.reason ? { reason: d.reason } : {}), ...(d.deliveredAt ? { deliveredAt: d.deliveredAt } : {}) });
            this.changed();
        };
        show(delivery);
        delivery.onChange?.(show);
        if (plan.rearmAfter) {
            void delivery.done?.then((d) => {
                if (d.state === 'delivered' && this.active()) {
                    // Part of the same resume, so never held back; it still counts toward the hour, as the setting says.
                    this.data.notes.push(this.now());
                    this.store.change();
                    return this.rearm(sessionId, { ...plan, why: 'Its goal was active when DSH stopped; the carry-on note is read, so the goal goes on after it.', summary: 'Started its goal again after the carry-on note' }, by, { quiet: true });
                }
                return undefined;
            }).catch((error) => this.logger?.warn?.(`autopilot: could not start the goal of ${sessionId}: ${errorText(error)}`));
        }
        return { action: 'note', entry, delivery };
    }

    /**
     * Start a stopped goal again. Resolves once DSH took the start; the
     * proof (the round it begins) follows in the event log, and in
     * `settled` for whoever wants to wait for it.
     */
    async rearm(sessionId, plan, by, { quiet = false } = {}) {
        const title = this.titleOf(sessionId);
        const entry = this.journal.add({ kind: 'rearm', sessionId, title, text: plan.summary, why: plan.why, state: 'starting', by });
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
        const proof = this.awaitRound(sessionId, goal.id, quiet ? AFTER_NOTE_PROOF_MS : REARM_PROOF_MS);
        try {
            goals.resume(agent, { id: goal.id, revision: goal.revision });
        } catch (error) {
            proof.cancel();
            return fail(`DSH refused to start it: ${errorText(error)}`);
        }
        this.journal.set(entry.id, { state: 'waiting for a round' });
        this.changed();
        const settled = proof.promise.then((round) => {
            if (round !== undefined) this.journal.set(entry.id, { state: 'started', reason: `round ${round} began` });
            else this.journal.set(entry.id, { state: 'not started', reason: 'DSH took the start, but no round began' });
            this.changed();
            if (round === undefined) this.logger?.warn?.(`autopilot: ${sessionId}: no goal round after a start`);
            return round !== undefined;
        });
        return { action: 'rearm', entry, ok: true, settled };
    }

    /** Resolve with the round number once a goal round's message shows in the session, or undefined after a while. */
    awaitRound(sessionId, goalId, ms = REARM_PROOF_MS) {
        let off;
        let timer;
        let settle;
        const promise = new Promise((resolve) => {
            settle = (value) => {
                off?.();
                this.clearTimer(timer);
                resolve(value);
            };
        });
        off = this.watch.on((event) => {
            if (event.sessionId !== sessionId || event.type !== 'state' || event.change !== 'user/message') return;
            if (event.state?.inKind === 'goal' && event.state.goal?.id === goalId) settle(event.state.goal.rounds);
        });
        timer = this.setTimer(ms, () => settle(undefined));
        return { promise, cancel: () => settle(undefined) };
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
        const entry = carried ? undefined : this.journal.add({ kind: 'ask', sessionId, title, text: `Asked you whether to ${label[0].toLowerCase()}${label.slice(1)}`, why: `${plan.why} Its rule is Ask first.`, state: 'asked you', by: 'Autopilot', askId: id });
        try {
            this.watch.raiseAsk({
                id,
                sessionId,
                source: 'Autopilot',
                title,
                question: question(plan, title),
                recommendation: label,
                why: plan.why,
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
            this.journal.set(carried.id, { state: 'asked you', stopped: false, reason: '', askedAgainAt: this.now() });
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
        // The row carries the watcher's view; its full state (the last reply's text) when the watcher has it.
        const full = this.watch.stateOf?.(row.sessionId);
        const state = isRecord(full) && full.end ? full : row.state;
        const end = state?.end;
        if (!end || state.open) return undefined;
        const cut = cutOff(end);
        // A cut-off turn gets a carry-on note with or without open work; any other, only with it.
        if (!cut && !hasOpenWork(state)) return undefined;
        const s = this.data.sessions[row.sessionId];
        if (s?.backedOff || s?.gaveUp) return undefined;
        if (!cut && state.goal?.phase === 'paused') return 'waits for you: its goal is paused';
        if (!cut && state.goal?.phase === 'blocked') return 'waits for you: its goal is blocked';
        if (end.kind === 'aborted' && !cut) return 'you stopped its last turn, so Autopilot leaves it to you';
        if (end.kind === 'blocked') return 'waits for you: its last turn was blocked';
        const asking = typeof state.text === 'string' ? asksSomeone(state.text) : isRecord(state.ask) && state.ask.turn === end.turn;
        if ((end.kind === 'completed' || end.kind === 'max-tokens') && asking) return 'waits for you: its last reply asks you something';
        if ((state.inAt ?? 0) > end.at) return undefined;
        const trigger = cut ? 'resume' : end.kind === 'error' ? 'error' : 'idle';
        if (s?.done?.[`${trigger}:${end.turn}:${end.at}`]) return 'Autopilot already handled its last turn; it looks again after the next one';
        const windowHours = trigger === 'resume' ? (this.config.resumeWindowHours ?? 6) : (this.config.idleWindowHours ?? 2);
        if (this.now() - end.at <= Math.max(1, windowHours) * 3600000) {
            if (cut && this.config.resumeAfterRestart === false) return 'cut off when DSH stopped; Resume after a restart is off in Autopilot\'s settings';
            return undefined;
        }
        return cut
            ? `cut off more than ${windowHours} h ago, so Autopilot leaves it to you`
            : `quiet for over ${windowHours} h, longer than Autopilot looks back; it acts again after the session's next turn`;
    }

    /** What is pending, for the window: session id → { trigger, at }. */
    pending() {
        const out = {};
        for (const [id, item] of this.timers) out[id] = { trigger: item.trigger, at: item.at };
        return out;
    }
}
