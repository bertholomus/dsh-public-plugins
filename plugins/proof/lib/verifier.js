/**
 * Proof's independent check: a short, fresh thread on a cheap local model
 * that re-runs or re-reads what would show one claim, and answers VERIFIED
 * or NOT VERIFIED with its reason.
 *
 * A check starts when the person presses Check on a flagged claim (the
 * setting's "When I press Check"), or by itself for each new flagged claim
 * ("By itself"). It opens an ordinary DSH session in the checked session's
 * workspace, titled "Proof check · …", so the person can open it and see
 * what it ran. Before its first turn the thread is made read-only: DSH's
 * read-only file policy (nothing it runs can write a file, not even in
 * /tmp), approvals that never ask (an action that needs one is refused, so
 * a check never waits on the person), its model offered only tools that
 * read or run (DSH adds its own subagent tool to every thread, where no
 * plugin can take it away), and a guard that refuses any other tool, that
 * one included, and any command that sends something elsewhere (a push, a
 * publish, a deploy, a request that does more than read, a command on
 * another machine) or changes the work (a commit, a reset, an install, a
 * killed process). Its model is the one Proof's settings name, for that
 * thread only: DSH's default model is never changed.
 *
 * The reply's last line that starts with VERIFIED or NOT VERIFIED is the
 * verdict; a reply with neither, a turn that ended in an error, and a check
 * that took longer than its minutes (it is stopped) are "unclear" or "could
 * not check", with the reason in words. At most `verifierPerHour` checks
 * start in an hour, one at a time; the rest wait their turn.
 *
 * Everything DSH does goes through `dsh` (lib/index.js builds it), so this
 * module has no DSH packages and its tests stand in for DSH.
 *
 * @module dsh-plugin-proof/verifier
 */
import { randomUUID } from 'node:crypto';
import { CHECK_LINE } from './projection.js';
import { ledgerOf } from './ledger.js';
import { sendOf, described } from './shared/sends.js';
import { clip, errorText, isRecord, later } from './shared/safe.js';
import { timeWords } from './shared/words.js';

/** Tools a check thread may use: they read, or run a command under the read-only policy. */
export const CHECK_TOOLS = Object.freeze(['read', 'read_image', 'grep', 'glob', 'bash', 'pwsh', 'job_output', 'job_list', 'todo_write', 'web_fetch', 'web_search']);
const ALLOWED = new Set(CHECK_TOOLS);
const SHELLS = new Set(['bash', 'pwsh']);

/** Checks running at once. */
const AT_ONCE = 1;
/** Checks kept (the oldest finished ones go first). */
const KEEP = 400;
/** Start times kept for the hour's count (more than the most an hour allows). */
const MAX_STARTS = 200;
const HOUR = 3600_000;

const STATES = new Set(['queued', 'running', 'verified', 'not-verified', 'unclear', 'failed']);
const ACTIVE = new Set(['queued', 'running']);

/** Where a command starts in a command line: its start, after ; & | ( or a backquote, past sudo, env and the like and any NAME=value. */
const POS = String.raw`(?:^|[;&|(\n` + '`' + String.raw`]|\$\()\s*(?:(?:sudo|xargs|env|nohup|time|command|exec|nice)\s+(?:-\S+\s+)*)*(?:\w+=\S*\s+)*`;
const at = (body) => new RegExp(`${POS}${body}`, 'im');

/**
 * Commands that change the work or this machine, said in words. The
 * read-only file policy stops writes already; these are refused before
 * they run, so the thread hears why, and so nothing outside files (a
 * process, a container, the git index) changes either.
 */
const CHANGES = [
    [at(String.raw`git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*(commit|push|reset|checkout|switch|restore|stash|clean|rebase|merge|cherry-pick|revert|tag|am|apply|rm|mv|add|init|pull|gc|prune|worktree|submodule|update-ref|notes)\b`), (m) => `git ${m[1]} changes the repository`],
    [at(String.raw`git\s+(?:-C\s+\S+\s+)*branch\s+(?:\S+\s+)*-[a-zA-Z]*[dDmMcC]\b`), () => 'git branch with that option changes the repository'],
    [at(String.raw`(npm|pnpm|yarn|bun)\s+(?:-\S+\s+)*(install|i|add|ci|update|up|upgrade|remove|rm|uninstall|publish|link|unlink|version|dedupe|prune)\b`), (m) => `${m[1]} ${m[2]} changes the installed packages`],
    [at(String.raw`(pip3?|uv\s+pip|poetry|pipx|gem|cargo|go|brew|port|apt|apt-get|yum|dnf|pacman)\s+(install|uninstall|remove|add|upgrade|update|get|publish)\b`), (m) => `${m[1]} ${m[2]} changes what is installed`],
    [at(String.raw`(kill|pkill|killall|launchctl|systemctl|shutdown|reboot|halt)\b`), (m) => `${m[1]} changes running processes`],
    [at(String.raw`(docker|podman)\s+(?:compose\s+)?(rm|rmi|stop|kill|restart|run|start|exec|up|down|create|pull|push|build)\b`), (m) => `${m[1]} ${m[2]} changes containers`],
    [at(String.raw`sed\s+(?:-[a-zA-Z]*i\b|--in-place)`), () => 'sed -i edits files'],
    [at(String.raw`crontab\s+(?!-l\b)\S`), () => 'crontab changes scheduled jobs'],
];

/**
 * Why a check thread's tool call is refused, or undefined to let it run.
 * @param {{ name?: string, arguments?: unknown }} exec - the call, as DSH's tools.guard gets it.
 * @param {{ cwd?: string }} [where]
 */
export function refusalOf(exec, { cwd } = {}) {
    const name = String(exec?.name ?? '');
    if (!ALLOWED.has(name)) return `Proof's check threads only read and run commands, so ${name || 'this tool'} is refused. Answer from what you can read and run.`;
    if (!SHELLS.has(name)) return undefined;
    let args = exec?.arguments;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = { command: args }; }
    }
    const command = typeof args?.command === 'string' ? args.command : typeof args?.cmd === 'string' ? args.cmd : '';
    if (!command.trim()) return undefined;
    let send;
    try { send = sendOf(command, { shell: name === 'pwsh' ? 'pwsh' : 'bash', cwd }); } catch { send = null; }
    if (send) return `Refused: it ${described(send)}, and a check never sends anything elsewhere. Check by reading instead.`;
    for (const [pattern, words] of CHANGES) {
        const m = pattern.exec(command);
        if (m) return `Refused: ${words(m)}, and a check only reads and runs. Check without changing anything.`;
    }
    return undefined;
}

/**
 * The verdict in a check's reply: the last line that starts with VERIFIED
 * or NOT VERIFIED (markdown marks before it are fine), and its reason.
 * @returns {{ state: 'verified'|'not-verified', reason: string } | undefined}
 */
export function verdictIn(reply) {
    const lines = String(reply ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].replace(/^(?:[>#*_`\-•]+\s*)+/, '');
        const m = /^(NOT\s+VERIFIED|VERIFIED)\b(?:\*\*|__|`)?\s*[:.\-—–]?\s*(.*)$/i.exec(line);
        if (!m) continue;
        const state = /^not/i.test(m[1]) ? 'not-verified' : 'verified';
        let reason = m[2].replace(/(?:\*\*|__|`)+\s*$/, '').replace(/^(?:\*\*|__)+/, '').trim();
        // "VERIFIED" alone on its line: the line before says why.
        if (!reason && i > 0) reason = lines[i - 1].replace(/^(?:[>#*_`\-•]+\s*)+/, '');
        return { state, reason: clip(reason, 300) };
    }
    return undefined;
}

/** What a check thread is asked, in full. */
export function promptFor({ claim, title, cwd, minutes }) {
    const quote = (text) => String(text ?? '').split(/\r?\n/).map((l) => `> ${l}`).join('\n');
    const where = cwd ? ` (in ${cwd})` : '';
    const lines = [
        `${CHECK_LINE} Check one claim another session made, on your own, without changing anything.`,
        '',
        `The claim, from turn ${claim.turn} of ${title ? `"${clip(title, 80)}"` : 'that session'}${where}:`,
        quote(clip(claim.text, 600)),
    ];
    if (claim.ask) lines.push('', 'What the person asked in that turn:', quote(clip(claim.ask, 400)));
    lines.push('', claim.from !== undefined ? `What turn ${claim.from} ran (that turn ran nothing itself):` : 'What that turn ran:');
    if (claim.ran?.length) for (const r of claim.ran.slice(-10)) lines.push(`- ${clip(r, 200)}`);
    else lines.push('- nothing: it ran no command and read no file.');
    lines.push(
        '',
        `Proof's reading: ${clip(claim.why, 300) || 'nothing in that turn shows it.'}`,
        '',
        `Re-run or re-read what would show the claim: run the same command again, read the file, look at git, check the hash or the address.${cwd ? ` Work in ${cwd}.` : ''}`,
        'This thread can read files and run commands, but nothing it runs can write a file, not even in /tmp, and Proof refuses edits, commits, pushes, installs, deploys and requests that change something elsewhere. If a run fails only because it cannot write, answer from what you could read, and say so.',
        `You have about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        '',
        'End your reply with one line that starts with VERIFIED or NOT VERIFIED, then the reason in one sentence.',
    );
    return lines.join('\n');
}

/**
 * A turn end that was not a finished turn, in words: the reason only (the
 * check's state is said by its tag). DSH ends a turn `interrupted` when it
 * starts again after a restart cut the turn off, and `aborted` with the
 * cause when something stopped it. `restarted`: read from the thread's log
 * after Proof started again, so a thread DSH closed was closed by its stop.
 */
export function endWords(reason, { restarted = false } = {}) {
    const kind = isRecord(reason) ? String(reason.kind ?? '') : String(reason ?? '');
    const cause = isRecord(reason) && isRecord(reason.reason) ? String(reason.reason.kind ?? '') : '';
    const said = (text) => clip(String(text ?? '').replace(/\s+/g, ' ').trim(), 200);
    if (kind === 'interrupted' || (kind === 'aborted' && cause === 'disposed' && restarted)) return 'DSH restarted while it ran, so it ended before it answered.';
    if (kind === 'aborted' && cause === 'disposed') return 'DSH closed its thread while it ran, so it ended before it answered.';
    if (kind === 'aborted' && cause === 'hook') {
        const why = said(reason.reason.reason);
        return `A plugin stopped it before it answered${why ? `: ${why.replace(/[.!?]$/, '')}` : ''}.`;
    }
    if (kind === 'aborted' || kind === 'cancelled' || kind === 'canceled' || kind === 'user') return 'It was stopped before it answered.';
    if (kind === 'error') {
        const why = isRecord(reason) ? said(reason.error?.message ?? reason.message ?? reason.reason) : '';
        return `Its turn ended with an error${why ? `: ${why.replace(/[.!?]$/, '')}` : ''}.`;
    }
    if (kind === 'max-tokens') return 'Its reply ran past the model\'s length limit before it answered.';
    if (kind === 'blocked') return 'DSH did not let its turn run (an archived thread cannot run).';
    if (kind === 'forked') return 'Its thread was forked before it answered.';
    return 'Its turn ended before it answered.';
}

/**
 * The effort a check asks for, given the model's reasoning efforts (DSH's
 * `resolveModelInfo`): low, else minimal, else none (the model's default).
 * A check re-runs a command or reads a file, so it needs little thought,
 * and a busy gateway answers a low-effort request sooner.
 */
export const CHECK_EFFORTS = Object.freeze(['low', 'minimal']);
export function effortFor(info) {
    const offered = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map((e) => e?.id) : [];
    return CHECK_EFFORTS.find((id) => offered.includes(id));
}

/** An assistant message's reply text. */
function replyOf(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n').trim();
}

/** When a check last moved, the time its row shows and is ordered by: when it ended, else started, else was asked for. */
export const checkTime = (c) => c?.endedAt ?? c?.startedAt ?? c?.queuedAt ?? 0;

/** What the check store holds, made safe. */
export function parseChecks(value) {
    const data = { v: 1, checks: {}, sessions: {}, autoSince: 0, starts: [] };
    if (!isRecord(value) || value.v !== 1) return data;
    for (const [key, c] of Object.entries(isRecord(value.checks) ? value.checks : {})) {
        if (!isRecord(c) || typeof c.sessionId !== 'string' || typeof c.claimId !== 'string' || !STATES.has(c.state)) continue;
        data.checks[key] = {
            key,
            sessionId: c.sessionId,
            claimId: c.claimId,
            turn: Number.isSafeInteger(c.turn) ? c.turn : 0,
            claim: clip(String(c.claim ?? ''), 400),
            verdict: typeof c.verdict === 'string' ? c.verdict : '',
            state: c.state,
            reason: clip(String(c.reason ?? ''), 400),
            by: c.by === 'auto' ? 'auto' : 'you',
            model: clip(String(c.model ?? ''), 160),
            ...(Number.isSafeInteger(c.minutes) && c.minutes > 0 && c.minutes <= 1440 ? { minutes: c.minutes } : {}),
            ...(typeof c.effort === 'string' && c.effort ? { effort: clip(c.effort, 40) } : {}),
            ...(typeof c.checkSessionId === 'string' ? { checkSessionId: c.checkSessionId } : {}),
            queuedAt: Number.isFinite(c.queuedAt) ? c.queuedAt : 0,
            ...(Number.isFinite(c.startedAt) ? { startedAt: c.startedAt } : {}),
            ...(Number.isFinite(c.endedAt) ? { endedAt: c.endedAt } : {}),
            ...(typeof c.reply === 'string' ? { reply: c.reply.slice(-600) } : {}),
        };
    }
    for (const [id, key] of Object.entries(isRecord(value.sessions) ? value.sessions : {})) {
        if (typeof key === 'string') data.sessions[id] = key;
    }
    data.autoSince = Number.isFinite(value.autoSince) ? value.autoSince : 0;
    data.starts = (Array.isArray(value.starts) ? value.starts : []).filter((at) => Number.isFinite(at)).slice(-MAX_STARTS);
    return data;
}

export class Verifier {
    /**
     * @param {object} options
     * @param {object} options.config - Proof's live settings.
     * @param {() => boolean} options.working - whether Proof works now (switched on, settings right).
     * @param {object} options.dsh - what it asks of DSH (lib/index.js): inspect, resolveModel, createNear, rename, agentOf,
     *   prepare, select, send, cancel.
     * @param {import('./shared/files.js').JsonStore} options.store - holds parseChecks data.
     * @param {import('./shared/journal.js').Journal} options.journal
     * @param {{ warn: Function, info?: Function }} [options.logger]
     * @param {() => void} [options.changed] - the page's data moved.
     * @param {() => number} [options.now]
     * @param {(logger: object, label: string, ms: number, fn: Function) => unknown} [options.after] - a timer (tests move time by hand).
     * @param {(timer: unknown) => void} [options.clear] - stops one.
     */
    constructor({ config, working, dsh, store, journal, logger, changed, now = Date.now, after = later, clear = clearTimeout }) {
        this.config = config;
        this.working = working;
        this.dsh = dsh;
        this.store = store;
        this.journal = journal;
        this.logger = logger;
        this.changed = changed ?? (() => {});
        this.now = now;
        this.after = after;
        this.clear = clear;
        /** check key → its timeout timer. */
        this.timers = new Map();
        /** check session id → the reply so far. */
        this.replies = new Map();
        this.pumpTimer = undefined;
        this.stopped = false;
    }

    get data() {
        return this.store.data;
    }

    get mode() {
        const m = this.config.verifier;
        return m === 'auto' || m === 'ask' ? m : 'off';
    }

    /** Whether a session is one of Proof's own check threads. */
    isCheckSession(sessionId) {
        return typeof sessionId === 'string' && Object.hasOwn(this.data.sessions, sessionId);
    }

    /** The checks of one session's claims, newest first. */
    checksFor(sessionId) {
        return Object.values(this.data.checks).filter((c) => c.sessionId === sessionId).sort((a, b) => (b.queuedAt ?? 0) - (a.queuedAt ?? 0));
    }

    /** The check one of Proof's check threads runs; undefined for any other session. */
    checkOf(checkSessionId) {
        if (!this.isCheckSession(checkSessionId)) return undefined;
        const check = this.data.checks[this.data.sessions[checkSessionId]];
        // "Check again" runs in a new thread: an older thread's check is gone.
        return check?.checkSessionId === checkSessionId ? check : undefined;
    }

    /** The latest checks, newest first by the time the page shows for each (checkTime). */
    recent(limit = 50) {
        return Object.values(this.data.checks).sort((a, b) => checkTime(b) - checkTime(a)).slice(0, limit);
    }

    /**
     * Checks started in the last hour, and when the next one may start (0
     * when one may now). Every start is counted, a check run again included:
     * its new run replaces the old one in the store, but not in the count.
     */
    budget(now = this.now()) {
        const limit = Number.isSafeInteger(this.config.verifierPerHour) ? this.config.verifierPerHour : 12;
        const starts = this.data.starts.filter((at) => now - at < HOUR).sort((a, b) => a - b);
        const used = starts.length;
        return { limit, used, nextAt: used < limit ? 0 : starts[used - limit] + HOUR };
    }

    /** Start: finish what a restart cut off, and carry on with what waits. */
    start() {
        this.settingsChanged();
        for (const check of Object.values(this.data.checks)) {
            if (check.state !== 'running') continue;
            if (!check.checkSessionId) {
                this.finish(check, 'failed', 'Proof restarted before it began.');
                continue;
            }
            void this.resume(check);
        }
        this.pump();
    }

    /** A check that was running when Proof stopped: its answer may be in its thread already. */
    async resume(check) {
        try {
            const { events } = await this.dsh.inspect(check.checkSessionId);
            let reply = '';
            let ended;
            for (const event of Array.isArray(events) ? events : []) {
                if (event?.type === 'assistant/message') reply = replyOf(event.data?.message) || reply;
                else if (event?.type === 'turn/end') ended = event.data?.reason ?? { kind: 'completed' };
            }
            if (ended) return this.settle(check, reply, ended, { restarted: true });
            this.replies.set(check.checkSessionId, reply);
            // The minutes it was given when it started, whatever the setting says now.
            const minutes = check.minutes ?? this.minutes();
            this.arm(check, Math.max(30_000, (check.startedAt ?? this.now()) + minutes * 60_000 - this.now()));
        } catch (error) {
            this.finish(check, 'unclear', `Proof restarted while it ran, and could not read its thread afterwards (${errorText(error, 160)}).`);
        }
    }

    /** The minutes a check starting now is given (the setting, else the default). */
    minutes() {
        return Number.isSafeInteger(this.config.verifierMinutes) ? this.config.verifierMinutes : 15;
    }

    /** Why a check cannot be asked for now, or undefined. */
    refusal() {
        if (!this.working()) return 'Proof is not working now: see the top of its page.';
        if (this.mode === 'off') return 'The independent check is off. Turn it on in Proof\'s settings ("Independent check").';
        return undefined;
    }

    /**
     * Ask for one claim's check. Says no in words when it cannot; a check
     * already waiting or running for the claim is given back as it is.
     * @param {string} sessionId
     * @param {string} claimId
     * @param {{ by?: 'you'|'auto', claim?: object }} [options] - `claim` from the session's view (auto), to queue without reading the log.
     */
    async request(sessionId, claimId, { by = 'you', claim } = {}) {
        const no = this.refusal();
        if (no) throw new Error(no);
        if (typeof sessionId !== 'string' || sessionId === '' || typeof claimId !== 'string' || claimId === '') throw new Error('Name the session and the claim to check.');
        if (this.isCheckSession(sessionId)) throw new Error('That is one of Proof\'s own check threads; its claims are not checked.');
        const key = `${sessionId}#${claimId}`;
        const known = this.data.checks[key];
        if (known && ACTIVE.has(known.state)) return known;
        let found = claim;
        if (!found) {
            const { events } = await this.dsh.inspect(sessionId);
            found = ledgerOf(events).claims.find((c) => c.id === claimId);
            if (!found) throw new Error('That claim is not in the session\'s log any more, so it cannot be checked.');
        }
        const check = {
            key,
            sessionId,
            claimId,
            turn: Number.isSafeInteger(found.turn) ? found.turn : 0,
            claim: clip(String(found.text ?? ''), 400),
            verdict: String(found.verdict ?? ''),
            state: 'queued',
            reason: '',
            by,
            model: `${this.config.verifierModel} from ${this.config.verifierProvider}`,
            queuedAt: this.now(),
        };
        this.data.checks[key] = check;
        this.trim();
        this.store.change();
        const { nextAt } = this.budget();
        if (nextAt) {
            const n = this.config.verifierPerHour;
            check.reason = `Waits until ${timeWords(nextAt, this.now())}: ${n} check${n === 1 ? ' has' : 's have'} started in the last hour, the most Proof's settings allow.`;
        }
        this.journal.add({
            kind: 'check',
            sessionId,
            claimId,
            text: `Check asked for: “${clip(check.claim, 120)}”`,
            why: by === 'auto' ? 'Proof checks each new flagged claim by itself (Independent check: by itself).' : 'You pressed Check.',
            state: 'queued',
        });
        this.changed();
        this.pump();
        return check;
    }

    /** Start the next waiting check when there is room for it. */
    pump() {
        if (this.stopped) return;
        if (this.pumpTimer) {
            this.clear(this.pumpTimer);
            this.pumpTimer = undefined;
        }
        const all = Object.values(this.data.checks);
        const waiting = all.filter((c) => c.state === 'queued').sort((a, b) => a.queuedAt - b.queuedAt);
        if (waiting.length === 0) return;
        if (this.mode === 'off' || !this.working()) {
            for (const check of waiting) this.finish(check, 'failed', this.mode === 'off' ? 'The independent check was switched off before it started.' : 'Proof stopped working before it started (see the top of its page).');
            return;
        }
        if (all.filter((c) => c.state === 'running').length >= AT_ONCE) return;
        const { nextAt } = this.budget();
        if (nextAt) {
            this.pumpTimer = this.after(this.logger, 'proof: next check', nextAt - this.now() + 1000, () => this.pump());
            return;
        }
        void this.run(waiting[0]);
    }

    /** Run one check: a fresh thread, read-only, on the check model. */
    async run(check) {
        check.state = 'running';
        check.startedAt = this.now();
        check.reason = '';
        // The minutes it is given, kept on the check from its start: a later change of the setting does not change them.
        check.minutes = this.minutes();
        this.data.starts = [...this.data.starts.filter((at) => check.startedAt - at < HOUR), check.startedAt].slice(-MAX_STARTS);
        this.store.change();
        this.changed();
        const step = { now: 'reading the session' };
        try {
            const { meta, events } = await this.dsh.inspect(check.sessionId);
            const claim = ledgerOf(events).claims.find((c) => c.id === check.claimId);
            if (!claim) return this.finish(check, 'failed', 'The claim is not in the session\'s log any more.');
            step.now = 'finding the check model';
            const provider = this.config.verifierProvider;
            const model = this.config.verifierModel;
            let selection;
            try {
                selection = await this.dsh.resolveModel({ provider, model });
            } catch (error) {
                return this.finish(check, 'failed', `DSH has no model ${model} from ${provider} to check with (${errorText(error, 160)}). Pick one DSH lists in Proof's settings ("Check with the model").`);
            }
            // Named as DSH's model menu names them; the effort is the lowest the model offers (effortFor).
            check.model = `${selection.modelName || selection.model || model} from ${selection.providerName || selection.provider || provider}`;
            check.effort = selection.reasoningEffort ? String(selection.effortName || selection.reasoningEffort) : '';
            const choice = {
                provider: selection.provider ?? provider,
                model: selection.model ?? model,
                ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
            };
            const id = `session-${randomUUID()}`;
            // Known as a check before DSH makes its agent, so the guard is on from the first call.
            this.data.sessions[id] = check.key;
            check.checkSessionId = id;
            this.store.change();
            step.now = 'opening the check thread';
            const title = await this.titleOf(check.sessionId);
            await this.dsh.createNear(check.sessionId, id, typeof meta?.cwd === 'string' ? meta.cwd : undefined);
            try {
                await this.dsh.rename(id, `Proof check · ${clip(check.claim, 60)}`);
            } catch (error) {
                this.logger?.warn?.(`proof: could not title the check thread: ${errorText(error)}`);
            }
            step.now = 'making the thread read-only';
            const agent = await this.dsh.agentOf(id);
            this.dsh.prepare(agent, { cwd: meta?.cwd });
            step.now = 'choosing the check model';
            await this.dsh.select(agent, choice);
            step.now = 'asking the check model';
            this.replies.set(id, '');
            const minutes = check.minutes;
            this.journal.add({
                kind: 'check',
                sessionId: check.sessionId,
                claimId: check.claimId,
                checkSessionId: id,
                text: `Checking “${clip(check.claim, 120)}”`,
                why: `In a new read-only thread on ${check.model}${check.effort ? ` at ${check.effort.toLowerCase()} effort` : ''}, for at most ${minutes} minute${minutes === 1 ? '' : 's'}.`,
                state: 'running',
            });
            this.arm(check, minutes * 60_000);
            await this.dsh.send(agent, promptFor({ claim, title, cwd: meta?.cwd, minutes }));
            this.changed();
        } catch (error) {
            this.finish(check, 'failed', `It stopped while ${step.now}: ${errorText(error, 200)}.`);
        }
    }

    async titleOf(sessionId) {
        try {
            return (await this.dsh.titleOf?.(sessionId)) ?? '';
        } catch {
            return '';
        }
    }

    /** Stop waiting after `ms`: the check thread is stopped and its answer is unclear. */
    arm(check, ms) {
        this.clear(this.timers.get(check.key));
        this.timers.set(check.key, this.after(this.logger, 'proof: check timeout', ms, () => {
            this.timers.delete(check.key);
            const live = this.data.checks[check.key];
            if (live?.state !== 'running') return;
            if (live.checkSessionId) {
                Promise.resolve().then(() => this.dsh.cancel(live.checkSessionId)).catch((error) => this.logger?.warn?.(`proof: could not stop a check: ${errorText(error)}`));
            }
            const given = live.minutes ?? this.minutes();
            this.finish(live, 'unclear', `It took longer than the ${given} minute${given === 1 ? '' : 's'} it was given, so Proof stopped it.`);
        }));
    }

    /** Every committed event of every session: a check thread's reply and its turn's end. */
    onEvent(session, event) {
        const id = session?.id;
        if (!this.isCheckSession(id) || !isRecord(event)) return;
        const check = this.data.checks[this.data.sessions[id]];
        if (check?.state !== 'running') return;
        if (event.type === 'assistant/message') {
            const text = replyOf(event.data?.message);
            if (text) this.replies.set(id, text);
        } else if (event.type === 'turn/end') {
            this.settle(check, this.replies.get(id) ?? '', event.data?.reason ?? { kind: 'completed' });
        }
    }

    /** The check's turn ended: read its verdict. `restarted`: read from its log after Proof started again. */
    settle(check, reply, reason, { restarted = false } = {}) {
        if (check.state !== 'running') return;
        const kind = isRecord(reason) ? reason.kind : reason;
        if (kind !== 'completed') return this.finish(check, kind === 'error' ? 'failed' : 'unclear', endWords(reason, { restarted }), reply);
        const verdict = verdictIn(reply);
        if (!verdict) return this.finish(check, 'unclear', reply.trim() ? 'Its reply did not end with VERIFIED or NOT VERIFIED.' : 'It ended without a reply.', reply);
        return this.finish(check, verdict.state, verdict.reason || 'It gave no reason.', reply);
    }

    /** A check is over: keep its outcome, log it, and start the next. */
    finish(check, state, reason, reply) {
        this.clear(this.timers.get(check.key));
        this.timers.delete(check.key);
        if (check.checkSessionId) this.replies.delete(check.checkSessionId);
        check.state = state;
        check.reason = clip(String(reason ?? ''), 400);
        check.endedAt = this.now();
        if (typeof reply === 'string' && reply.trim()) check.reply = reply.trim().slice(-600);
        this.store.change();
        const words = { verified: 'Verified', 'not-verified': 'Not verified', unclear: 'Check unclear', failed: 'Could not check' }[state] ?? state;
        this.journal.add({
            kind: 'check',
            sessionId: check.sessionId,
            claimId: check.claimId,
            ...(check.checkSessionId ? { checkSessionId: check.checkSessionId } : {}),
            text: `${words}: “${clip(check.claim, 120)}”`,
            why: check.reason,
            state: state === 'verified' ? 'done' : state === 'not-verified' ? 'not proven' : state === 'failed' ? 'failed' : 'not confirmed',
        });
        this.changed();
        queueMicrotask(() => this.pump());
    }

    /**
     * A session's view changed (DSH's projection feed): with "By itself",
     * each new flagged claim is checked. Claims made before it was switched
     * on are left for the person.
     */
    onView(sessionId, view) {
        if (this.mode !== 'auto' || !this.working() || this.isCheckSession(sessionId) || !isRecord(view) || view.check) return;
        const since = this.data.autoSince;
        for (const claim of Array.isArray(view.flagged) ? view.flagged : []) {
            if (!Number.isFinite(claim?.at) || claim.at < since) continue;
            const key = `${sessionId}#${claim.id}`;
            if (this.data.checks[key]) continue;
            this.request(sessionId, claim.id, { by: 'auto', claim }).catch((error) => this.logger?.warn?.(`proof: could not queue a check: ${errorText(error)}`));
        }
    }

    /** The settings were saved: note when "By itself" began, and drop waiting checks when checks were switched off. */
    settingsChanged() {
        if (this.mode === 'auto' && !this.data.autoSince) {
            this.data.autoSince = this.now();
            this.store.change();
        } else if (this.mode !== 'auto' && this.data.autoSince) {
            this.data.autoSince = 0;
            this.store.change();
        }
        this.pump();
    }

    /** Forget the oldest finished checks past KEEP. */
    trim() {
        const all = Object.values(this.data.checks);
        if (all.length <= KEEP) return;
        const done = all.filter((c) => !ACTIVE.has(c.state)).sort((a, b) => (a.endedAt ?? a.queuedAt) - (b.endedAt ?? b.queuedAt));
        for (const c of done.slice(0, all.length - KEEP)) delete this.data.checks[c.key];
        // Threads whose check is gone: their logs say they are check threads (the projection), so nothing judges them.
        const kept = new Set(Object.keys(this.data.checks));
        for (const [id, key] of Object.entries(this.data.sessions)) if (!kept.has(key)) delete this.data.sessions[id];
    }

    stop() {
        this.stopped = true;
        this.clear(this.pumpTimer);
        for (const timer of this.timers.values()) this.clear(timer);
        this.timers.clear();
    }
}
