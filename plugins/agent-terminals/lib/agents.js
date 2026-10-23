/**
 * The coding agents: each one a command-line coding agent running in a
 * terminal of its own DSH session, read through its own transcript, and
 * kept going across DSH restarts.
 *
 * - Start: the session (a new one in the chosen folder, or one that has no
 *   agent yet), a terminal there with a POSIX shell, and `exec <program>`
 *   typed into it, so the terminal ends when the agent does.
 * - Read: the agent's transcript, as it grows, gives what it was told, what
 *   it is doing and what it answered: working, idle, waiting on you, or
 *   stopped. Session Watch carries that to the session's row, Decisions and
 *   the other suite plugins; a reply that asks raises a Decisions card whose
 *   answer is typed in.
 * - Type: one message at a time, only while the agent is ready for it (not
 *   while it runs a tool, so nothing lands in an approval prompt). Proof is
 *   the agent's own transcript showing the message; no proof while it is
 *   idle means its Enter was swallowed, so Enter goes again.
 * - Restart: DSH ends every terminal when it quits. On the next start each
 *   agent the person did not stop gets its terminal again, with the same id
 *   (the window's tab finds it), and resumes its conversation.
 *
 * Every action, and every action not taken, is a log entry with its reason.
 * Nothing here throws into DSH: the page's endpoints get errors in words.
 *
 * @module dsh-plugin-agent-terminals/agents
 */
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { STYLES, STYLE_IDS, argvOf, expandHome, findFlagsTranscript, findNewTranscript, findTranscriptById, launchLine, pickShell, programName, transcriptPath } from './launch.js';
import { whereIs } from './detect.js';
import { Tail, closeOver, emptyFold, foldEntry, oneLine, parseLines, provenIn, statusOf } from './transcripts.js';
import { MAX_MESSAGE } from './typist.js';
import { clip, errorText, isRecord, later } from './shared/safe.js';

/** Messages kept per agent (finished ones go first). */
const KEEP_DELIVERIES = 30;
/** Programs the start form offers again. */
const KEEP_RECENT = 6;
/** How long a typed message may wait for proof while the agent works. */
const PROOF_WHILE_WORKING_MS = 30 * 60 * 1000;
/** How long a message marked "not proven" is still looked for in its transcript. */
const LATE_PROOF_MS = 24 * 60 * 60 * 1000;
/** How long a new program must run before it counts as started (one that is not there ends at once). */
const START_CHECK_MS = 2500;
/** How long a new session's first turn may take before its log entry stops waiting for its end. */
const FIRST_TURN_MS = 5 * 60 * 1000;
/** A detail-only change (the tool it runs now) reaches the session row at most this often. */
const DETAIL_EVERY_MS = 3000;
/** Terminal size until a window's tab sets its own. */
const COLS = 120;
const ROWS = 32;

const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
});
const DELIVERY_STATES = new Set(['queued', 'waiting', 'typing', 'typed', 'delivered', 'not proven', 'failed', 'cancelled']);
const OPEN = new Set(['queued', 'waiting']);
/** What a Decisions answer's delivery state means to Decisions (`askOutcome`). */
const OUTCOME = Object.freeze({ delivered: 'delivered', 'not proven': 'not proven', failed: 'not delivered', cancelled: 'not delivered', typed: 'typed in' });
const strings = (value, max = 40) => (Array.isArray(value) ? value.filter((part) => typeof part === 'string').slice(0, max) : []);
const text = (value) => (typeof value === 'string' ? value : undefined);
/** A message cut to length with its line breaks kept (`clip` makes one line). */
const clipLines = (value, max) => (String(value).length > max ? `${String(value).slice(0, max - 1)}…` : String(value));
const number = (value) => (Number.isFinite(value) ? value : undefined);

/** A saved document made safe: what a broken or older file lacks is dropped or filled in. */
export function parseData(value) {
    const agents = {};
    for (const [key, a] of Object.entries(isRecord(value?.agents) ? value.agents : {})) {
        if (!isRecord(a) || typeof a.sessionId !== 'string' || typeof a.program !== 'string' || !/^[\w-]{1,40}$/.test(key)) continue;
        const launches = Number.isInteger(a.launches) && a.launches > 0 ? a.launches : 1;
        agents[key] = {
            key,
            sessionId: a.sessionId,
            name: text(a.name) || programName(a.program),
            program: a.program,
            args: strings(a.args),
            style: STYLE_IDS.includes(a.style) ? a.style : 'plain',
            ...(text(a.data) ? { data: a.data } : {}),
            folder: text(a.folder) ?? '',
            terminalId: typeof a.terminalId === 'string' && /^[\w-]{1,128}$/.test(a.terminalId) ? a.terminalId : terminalIdOf(key, launches),
            launches,
            ...(text(a.conversationId) ? { conversationId: a.conversationId } : {}),
            ...(text(a.transcript) ? { transcript: a.transcript } : {}),
            wanted: a.wanted === 'stopped' ? 'stopped' : 'running',
            createdAt: number(a.createdAt) ?? 0,
            ...(number(a.launchedAt) ? { launchedAt: a.launchedAt } : {}),
            ...(number(a.primedAt) ? { primedAt: a.primedAt } : {}),
            ...(Number.isInteger(a.hostPid) ? { hostPid: a.hostPid } : {}),
            ...(isRecord(a.ended) && typeof a.ended.text === 'string' ? { ended: { why: text(a.ended.why) ?? 'stopped', text: a.ended.text, at: number(a.ended.at) ?? 0, ...(Number.isInteger(a.ended.code) ? { code: a.ended.code } : {}) } } : {}),
            ...(text(a.problem) ? { problem: a.problem } : {}),
            ...(text(a.lastAskId) ? { lastAskId: a.lastAskId } : {}),
            deliveries: (Array.isArray(a.deliveries) ? a.deliveries : []).filter((d) => isRecord(d) && typeof d.id === 'string' && typeof d.text === 'string' && DELIVERY_STATES.has(d.state)).slice(-KEEP_DELIVERIES)
                // A message that was being typed when DSH stopped is typed again only if no proof came: the agent re-reads it from the start.
                .map((d) => (d.state === 'typing' ? { ...d, state: 'queued', why: 'DSH stopped while it was being typed in; it is typed in again.' } : d)),
        };
    }
    const recent = (Array.isArray(value?.recent) ? value.recent : []).filter((r) => isRecord(r) && typeof r.program === 'string' && STYLE_IDS.includes(r.style)).slice(0, KEEP_RECENT)
        .map((r) => ({ program: r.program, args: strings(r.args), style: r.style, ...(text(r.data) ? { data: r.data } : {}) }));
    return { version: 1, agents, recent };
}

export const terminalIdOf = (key, launches) => `agent-${key}-${launches}`;

/**
 * Check what the start form sent, in words.
 * @returns {{ program: string, args: string[], style: string, data?: string, folder?: string, sessionId?: string, name: string, task?: string }}
 */
export function checkLaunch(input, { home } = {}) {
    if (!isRecord(input)) throw new Error('Say which program to start.');
    const program = String(input.program ?? '').trim();
    if (!program) throw new Error('Name the program to start: the command you type to run the coding agent.');
    if (program.length > 300 || /[\r\n\0]/.test(program)) throw new Error('The program must be one line, at most 300 characters.');
    if (/\s/.test(program) && !program.includes('/')) throw new Error('The program is one word (put its options under Arguments), or a full path.');
    // "~/bin/agent" is kept as its full path: the start line quotes every word, and a quoted ~ is not the home folder.
    const resolved = /^~(\/|$)/.test(program) ? expandHome(program, home ?? '/') : program;
    const args = Array.isArray(input.args) ? input.args.map(String) : typeof input.args === 'string' ? splitArgs(input.args) : [];
    if (args.length > 40 || args.some((arg) => arg.length > 500 || /[\r\n\0]/.test(arg))) throw new Error('Arguments: at most 40, each one line of at most 500 characters.');
    const style = String(input.style ?? '');
    if (!STYLE_IDS.includes(style)) throw new Error(`Choose how the program resumes a conversation: ${STYLE_IDS.join(', ')}.`);
    const data = typeof input.data === 'string' && input.data.trim() ? input.data.trim() : undefined;
    if (data && !isAbsolute(expandHome(data, home ?? '/'))) throw new Error('Its conversations folder must be a full path, such as ~/.agent.');
    const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : undefined;
    let folder;
    if (!sessionId) {
        const raw = String(input.folder ?? '').trim();
        if (!raw) throw new Error('Choose the folder the agent works in.');
        folder = expandHome(raw, home ?? '/');
        if (!isAbsolute(folder)) throw new Error('The folder must be a full path, such as ~/Projects/app.');
        let isFolder = false;
        try {
            isFolder = statSync(folder).isDirectory();
        } catch {}
        if (!isFolder) throw new Error(`There is no folder at ${folder}: create it first, or choose another.`);
    }
    const name = String(input.name ?? '').trim().slice(0, 80) || `${programName(program)}${folder ? ` · ${basename(folder)}` : ''}`;
    const task = typeof input.task === 'string' && input.task.trim() ? input.task.trim() : undefined;
    if (task && Buffer.byteLength(task, 'utf8') > MAX_MESSAGE) throw new Error(`The first message is longer than ${MAX_MESSAGE / 1024} KB: shorten it, or put it in a file and send the file's path.`);
    return { program: resolved, args, style, ...(data ? { data } : {}), ...(folder ? { folder } : {}), ...(sessionId ? { sessionId } : {}), name, ...(task ? { task } : {}) };
}

/** Arguments typed on one line: split at spaces, with "…" and '…' kept whole. */
export function splitArgs(line) {
    const out = [];
    let word = '';
    let quote;
    let any = false;
    for (const ch of String(line)) {
        if (quote) {
            if (ch === quote) quote = undefined;
            else word += ch;
        } else if (ch === '"' || ch === '\'') {
            quote = ch;
            any = true;
        } else if (/\s/.test(ch)) {
            if (word || any) out.push(word);
            word = '';
            any = false;
        } else {
            word += ch;
        }
    }
    if (quote) throw new Error(`Arguments: a ${quote} is not closed.`);
    if (word || any) out.push(word);
    return out;
}

export class AgentTerminals {
    /**
     * @param {object} options
     * @param {object} options.watch - Session Watch.
     * @param {() => any} options.controller - DSH's terminal controller, or undefined.
     * @param {{ create: (folder: string) => Promise<string>, rename: (sessionId: string, title: string) => Promise<void> }} options.sessions
     * @param {import('./typist.js').Typist} options.typist
     * @param {object} options.config - live settings.
     * @param {import('./shared/files.js').JsonStore} options.store
     * @param {import('./shared/journal.js').Journal} options.journal
     * @param {{ info?: Function, warn: Function }} [options.logger]
     * @param {(item: object) => void} [options.notify]
     * @param {string} options.home - the home folder (where CLIs keep their conversations).
     * @param {() => boolean} [options.working] - false while a setting is wrong.
     * @param {() => void} [options.changed] - what the page shows moved.
     */
    constructor({ watch, controller, sessions, typist, config, store, journal, logger, notify, home, working = () => true, changed, now = Date.now, wait = sleep, tickMs = 1000, startCheckMs = START_CHECK_MS }) {
        this.watch = watch;
        this.controller = controller;
        this.sessions = sessions;
        this.typist = typist;
        this.config = config;
        this.store = store;
        this.journal = journal;
        this.logger = logger;
        this.notify = notify;
        this.home = home;
        this.working = working;
        this.onChange = changed;
        this.now = now;
        this.wait = wait;
        this.tickMs = tickMs;
        this.startCheckMs = startCheckMs;
        /** What only this process knows, by agent key. */
        this.lives = new Map();
        this.timer = undefined;
        this.started = false;
        /** Counts stops: work begun before a stop (a wait for a screen, a proof loop) ends instead of acting after it. */
        this.era = 0;
    }

    get records() {
        return this.store.data.agents;
    }

    liveOf(record) {
        let live = this.lives.get(record.key);
        if (!live) {
            live = { fold: undefined, tail: undefined, tailPath: undefined, hold: undefined, launchAt: 0, ready: false, exited: false, launching: undefined, pumping: false, proving: new Set(), status: { status: 'stopped' }, sent: undefined, sentAt: 0, askId: undefined };
            this.lives.set(record.key, live);
        }
        return live;
    }

    changed() {
        try { this.onChange?.(); } catch {}
    }

    log(fields) {
        try {
            return this.journal.add(fields);
        } catch (error) {
            this.logger?.warn?.(`agent-terminals: could not log: ${errorText(error)}`);
            return undefined;
        }
    }

    // ── Start and stop ─────────────────────────────────────────────────

    /** Pick up every agent: adopt a terminal that still runs, start again one that a restart ended. */
    start() {
        if (this.started) return;
        this.started = true;
        this.schedule(0);
        void this.recover().catch((error) => this.logger?.warn?.(`agent-terminals: could not pick up the agents: ${errorText(error)}`));
    }

    /** Stop reading and typing. Terminals keep running: a plugin restart does not end an agent. */
    stop() {
        this.started = false;
        this.era += 1;
        clearTimeout(this.timer);
        this.timer = undefined;
        for (const record of Object.values(this.records)) {
            const live = this.lives.get(record.key);
            if (!live) continue;
            this.unhold(live);
            if (live.askId) {
                try { this.watch.dropAsk(live.askId); } catch {}
            }
            try { this.watch.setExternal(record.sessionId, null); } catch {}
        }
        this.lives.clear();
        this.typist.close();
        this.store.flush();
    }

    async recover() {
        const records = Object.values(this.records);
        for (const record of records) {
            if (!this.started || !this.records[record.key]) return;
            const live = this.liveOf(record);
            if (record.wanted !== 'running') {
                this.publish(record);
                continue;
            }
            const info = this.terminalInfo(record);
            if (!info && record.hostPid === process.pid) {
                // The same DSH, so not a restart: its terminal was closed while Agent Terminals was not running.
                this.ended(record, 'closed', `Its terminal was closed while Agent Terminals was not running (closing an agent's terminal tab ends the agent). ${this.againWords(record)}`);
                continue;
            }
            if (info?.state === 'running') {
                // Agent Terminals restarted, the agent did not: take it up where it is. What its transcript
                // left open from before this program started (a job a restart cut, an approval prompt)
                // stays closed, as it was at the launch: the cut was logged then.
                live.launchAt = record.launchedAt ?? this.now();
                const primedAt = record.primedAt ?? record.launchedAt;
                if (primedAt) live.primedAt = primedAt;
                live.ready = true;
                live.exited = false;
                try {
                    this.hold(record, await this.watch.resolveAgent(record.sessionId));
                } catch {}
                this.read(record);
                this.publish(record);
                continue;
            }
            if (info) {
                this.ended(record, info.state === 'failed' ? 'failed' : 'exited', info.state === 'failed' ? `Its terminal failed${info.error ? `: ${info.error}` : ''}.` : exitWords(record, info.exitCode, this.againWords(record)), info.exitCode);
                continue;
            }
            // DSH restarted: its terminals ended with it, and so did what was typed in but not yet read.
            this.lostWithRestart(record);
            const resumable = this.canResume(record);
            if (!this.config.resumeAfterRestart || !resumable) {
                record.wanted = 'stopped';
                record.ended = {
                    why: 'restart',
                    text: !resumable
                        ? 'DSH restarted, which ended its terminal. This program cannot resume a conversation, so it was not started again: Start again runs it anew.'
                        : 'DSH restarted, which ended its terminal. Starting agents again after a restart is off: Start again resumes its conversation.',
                    at: this.now(),
                };
                this.store.change();
                this.log({ kind: 'restart', agent: record.key, sessionId: record.sessionId, text: `${record.name} was not started again`, why: record.ended.text, state: 'stopped', by: 'Agent Terminals' });
                this.publish(record);
                continue;
            }
            try {
                await this.run(record, { resume: true });
                this.log({ kind: 'restart', agent: record.key, sessionId: record.sessionId, text: `Started ${record.name} again after DSH restarted`, why: 'DSH ended its terminal when it quit. It resumes its conversation in a new terminal with the same name, so its tab finds it.', state: 'done', by: 'Agent Terminals' });
            } catch (error) {
                // Still meant to run: the next start of DSH (or of Agent Terminals, once a setting is fixed) tries again.
                this.failed(record, error, 'after DSH restarted', { keepWanted: true });
            }
        }
        this.changed();
    }

    schedule(ms = this.tickMs) {
        clearTimeout(this.timer);
        if (!this.started) return;
        this.timer = later(this.logger, 'agent-terminals: tick', ms, () => this.tick());
    }

    tick() {
        try {
            for (const record of Object.values(this.records)) {
                try {
                    this.check(record);
                } catch (error) {
                    this.logger?.warn?.(`agent-terminals: ${record.name}: ${errorText(error)}`);
                }
            }
        } finally {
            this.schedule();
        }
    }

    /** One look at an agent: its terminal, its transcript, its status, its messages. */
    check(record) {
        const live = this.liveOf(record);
        if (record.wanted === 'running' && live.launchAt && !live.launching && !live.exited) {
            const info = this.terminalInfo(record);
            if (!info) this.ended(record, 'closed', `Its terminal was closed (closing an agent's terminal tab ends the agent). ${this.againWords(record)}`);
            else if (info.state === 'exited') this.ended(record, 'exited', exitWords(record, info.exitCode, this.againWords(record)), info.exitCode);
            else if (info.state === 'failed') this.ended(record, 'failed', `Its terminal failed${info.error ? `: ${info.error}` : ''}.`);
        }
        this.read(record);
        this.lateProof(record, live);
        this.publish(record);
        if (record.deliveries.some((d) => OPEN.has(d.state))) void this.pump(record);
    }

    /** DSH's terminal for an agent, from the session's terminal list; undefined when there is none. */
    terminalInfo(record) {
        try {
            const list = this.controller()?.list?.(record.sessionId);
            return (Array.isArray(list) ? list : []).find((info) => info?.id === record.terminalId);
        } catch {
            return undefined;
        }
    }

    // ── Starting ───────────────────────────────────────────────────────

    /**
     * Start a new agent.
     * @returns {Promise<{ agent: object, problem?: string }>}
     */
    async launch(input, { by = 'you' } = {}) {
        this.ensureWorking();
        const spec = checkLaunch(input, { home: this.home });
        // A path that is not a program is said before a session is made for it.
        if (spec.program.includes('/')) {
            const path = expandHome(spec.program, this.home);
            if (!findProgram(path, this.home).found) throw new Error(`There is no program at ${path}: check the path, and that the file is executable.`);
        }
        let sessionId = spec.sessionId;
        let folder = spec.folder;
        if (sessionId) {
            const row = await this.watch.get(sessionId);
            if (!row || (!row.cwd && !this.watch.sessionOf?.(sessionId))) throw new Error('That session is not in DSH any more: choose another, or start the agent in a new session.');
            const taken = this.bySession(sessionId);
            if (taken) throw new Error(`That session already has a coding agent (${taken.name}). Start the new one in a new session, or forget that one first.`);
            folder = row.cwd ?? folder ?? '';
        } else {
            sessionId = await this.sessions.create(folder).catch((error) => {
                throw new Error(`DSH could not make a session in ${folder}: ${errorText(error)}`);
            });
        }
        const key = randomUUID().replace(/-/g, '').slice(0, 8);
        const style = STYLES[spec.style];
        const look = findProgram(spec.program, this.home);
        const record = {
            key,
            sessionId,
            name: spec.name,
            program: spec.program,
            args: spec.args,
            style: spec.style,
            ...(spec.data ? { data: spec.data } : {}),
            folder,
            terminalId: terminalIdOf(key, 1),
            launches: 1,
            ...(style.idAtStart ? { conversationId: randomUUID() } : {}),
            wanted: 'running',
            createdAt: this.now(),
            deliveries: [],
        };
        this.records[key] = record;
        this.store.change();
        const why = `${by === 'you' ? 'You' : by} started ${record.program} in ${folder || 'its session\'s folder'}${spec.sessionId ? '' : ', in a new session'}.`;
        const entry = this.log({ kind: 'start', agent: key, sessionId, text: `Starting ${record.name}`, why, state: 'starting', by, program: record.program });
        if (!spec.sessionId) {
            try {
                await this.sessions.rename(sessionId, record.name);
            } catch (error) {
                this.logger?.warn?.(`agent-terminals: could not name the new session: ${errorText(error)}`);
            }
        }
        if (spec.task) this.queue(record, spec.task, by, 'as its first message');
        let problem;
        try {
            await this.run(record, { resume: false });
            problem = await this.confirmStart(record);
        } catch (error) {
            problem = this.failed(record, error, 'at its start');
        }
        // "Used here before" lists programs that ran, not ones that failed to start.
        if (!problem) {
            this.remember(spec);
            this.store.change();
        }
        if (entry) {
            try {
                this.journal.set(entry.id, problem
                    ? { text: `Could not start ${record.name}`, state: 'failed', reason: problem }
                    : { text: `Started ${record.name}`, state: 'done', ...(look.found ? {} : { why: `${why} DSH did not find ${record.program} where it looks for programs; the shell in its terminal did.` }) });
            } catch {}
        }
        // The session gets its first turn (so DSH lists it) only once the program runs: none for one that is not there.
        if (!problem && !spec.sessionId && this.config.listNewSessions) void this.firstTurn(record);
        this.changed();
        return { agent: this.view(record), ...(problem ? { problem } : {}) };
    }

    /**
     * After the command that starts a program is typed: wait a moment and see
     * that it still runs. A program that is not there, or that fails at once,
     * ends within that moment.
     * @returns {Promise<string | undefined>} why it did not start, in words.
     */
    async confirmStart(record) {
        const live = this.liveOf(record);
        for (let waited = 0; waited < this.startCheckMs; waited += 250) {
            await this.wait(250);
            if (live.exited || record.wanted !== 'running') break;
            const info = this.terminalInfo(record);
            if (!info || info.state !== 'running') {
                this.check(record);
                break;
            }
        }
        if (!live.exited && record.wanted === 'running') return undefined;
        return record.ended?.text ?? record.problem ?? 'It ended at once.';
    }

    /** Start an agent that stopped: resuming its conversation where it can, or a new one with `fresh`. */
    async startAgain(key, { fresh = false, by = 'you' } = {}) {
        this.ensureWorking();
        const record = this.need(key);
        const live = this.liveOf(record);
        if (live.launching) throw new Error('It is starting already.');
        const info = this.terminalInfo(record);
        if (record.wanted === 'running' && info?.state === 'running' && !live.exited) throw new Error('It is running. Stop it first to start it again.');
        // The old terminal, if DSH still lists it, gives its place to the new one.
        if (info) {
            try {
                await this.controller()?.close?.(await this.watch.resolveAgent(record.sessionId), record.terminalId);
            } catch {}
        }
        record.launches += 1;
        record.terminalId = terminalIdOf(record.key, record.launches);
        const resume = !fresh && this.canResume(record);
        if (!resume) {
            delete record.transcript;
            if (STYLES[record.style]?.idAtStart) record.conversationId = randomUUID();
            else delete record.conversationId;
        }
        this.store.change();
        let problem;
        try {
            await this.run(record, { resume });
            problem = await this.confirmStart(record);
            if (!problem) this.log({ kind: 'start', agent: key, sessionId: record.sessionId, text: `Started ${record.name} again`, why: resume ? `${by === 'you' ? 'You' : by} started it again; it resumes its conversation.` : `${by === 'you' ? 'You' : by} started it again${fresh ? ' with a new conversation' : '; this program cannot resume, so it starts anew'}.`, state: 'done', by });
        } catch (error) {
            problem = this.failed(record, error, 'when started again');
        }
        this.changed();
        return { agent: this.view(record), ...(problem ? { problem } : {}) };
    }

    /** What Start again does for an agent, in words. */
    againWords(record) {
        return this.canResume(record) ? 'Start again resumes its conversation.' : 'Start again runs it anew (this program cannot resume a conversation).';
    }

    /** Whether an agent's conversation can be resumed now. */
    canResume(record) {
        const style = STYLES[record.style];
        if (!style?.resume) return false;
        if (style.idAtStart || record.style === 'subcommand') return Boolean(record.conversationId);
        return true;
    }

    /**
     * Open the agent's terminal and type the command that starts it.
     * Throws in words; the caller logs it.
     */
    async run(record, { resume }) {
        const live = this.liveOf(record);
        if (live.launching) return live.launching;
        live.launching = (async () => {
            delete record.problem;
            live.exited = false;
            live.ready = false;
            this.publish(record);
            const controller = this.controller();
            if (typeof controller?.create !== 'function') throw new Error('This DSH has no terminals for plugins (its terminal controller is not running).');
            const argv = argvOf(record, { resume });
            if (!argv) throw new Error('This program cannot resume its conversation: use Start anew.');
            // Typing through DSH's terminal input needs a DSH that has it: said before a terminal opens for nothing.
            if (this.config.typing === 'attached' && !this.typist.attachedOk()) throw new Error(this.typist.way(record.sessionId, record.terminalId).problem);
            let agent;
            try {
                agent = await this.watch.resolveAgent(record.sessionId);
            } catch (error) {
                throw new Error(`Its session could not be opened (${errorText(error)}). If the session was deleted, forget this agent.`);
            }
            // The terminal opens in the session's folder, as DSH keeps it: that is where the agent runs.
            const cwd = agent?.session?.header?.cwd;
            if (typeof cwd === 'string' && cwd !== '' && cwd !== record.folder) {
                record.folder = cwd;
                this.store.change();
            }
            let shells = [];
            try {
                shells = await controller.shells(agent, AbortSignal.timeout(15000));
            } catch (error) {
                throw new Error(`DSH could not list the shells for terminals: ${errorText(error)}`);
            }
            const shell = pickShell(shells);
            if (!shell) throw new Error(`DSH found no zsh or bash for terminals here${shells.length ? ` (only ${shells.map((s) => s.name ?? s.path).join(', ')})` : ''}. Agent Terminals starts the agent with a POSIX shell command.`);
            await this.openTerminal(controller, agent, record, shell);
            try {
                try {
                    controller.rename?.(agent, record.terminalId, clip(record.name, 120));
                } catch {}
                this.hold(record, agent);
                // The shell draws its prompt first (and reads its startup files); then the command that becomes the agent.
                await this.typist.settle(record.sessionId, record.terminalId, { quietMs: 300, maxMs: 5000, fallbackMs: 800 });
                // What its transcript holds now was written by a program that has ended: read it before the new one starts.
                this.prime(record, live);
                await this.typist.write(agent, record.terminalId, `${launchLine(argv)}\r`);
            } catch (error) {
                // Only a shell runs in it: closed, so no empty terminal stays beside the session.
                this.unhold(live);
                try {
                    await controller.close(agent, record.terminalId);
                } catch {}
                throw error;
            }
            if (this.typist.way(record.sessionId, record.terminalId).way === 'attached') this.typist.release(record.sessionId, record.terminalId);
            record.launchedAt = this.now();
            record.hostPid = process.pid;
            delete record.ended;
            record.wanted = 'running';
            live.launchAt = record.launchedAt;
            this.store.change();
            void this.whenReady(record, live.launchAt);
        })().finally(() => {
            live.launching = undefined;
            this.publish(record);
            this.changed();
        });
        return live.launching;
    }

    /** A terminal for the agent: the one DSH has under its id, or a new one. */
    async openTerminal(controller, agent, record, shell) {
        const existing = this.terminalInfo(record);
        if (existing?.state === 'running') throw new Error('Its terminal is running already.');
        if (existing) {
            // An ended terminal keeps its id until it is closed: close it, and use the next id.
            try {
                await controller.close(agent, record.terminalId);
            } catch {}
            record.launches += 1;
            record.terminalId = terminalIdOf(record.key, record.launches);
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                return await controller.create(agent, { id: record.terminalId, cols: COLS, rows: ROWS, shellPath: shell.path }, AbortSignal.timeout(30000));
            } catch (error) {
                const words = errorText(error);
                if (attempt === 0 && /closed in this session|closing or unavailable/i.test(words)) {
                    // DSH keeps a closed id closed until it restarts.
                    record.launches += 1;
                    record.terminalId = terminalIdOf(record.key, record.launches);
                    continue;
                }
                if (/limit/i.test(words)) throw new Error('Its session has as many terminals as DSH allows: close one of its terminal tabs, then Start again.');
                throw new Error(`DSH could not open a terminal: ${words}`);
            }
        }
        throw new Error('DSH could not open a terminal.');
    }

    /** The agent is ready for a message once its screen settles after the start. */
    async whenReady(record, launchAt) {
        const live = this.liveOf(record);
        const era = this.era;
        const wanted = () => this.era === era && live.launchAt === launchAt && !live.exited;
        await this.typist.settle(record.sessionId, record.terminalId, { quietMs: 1200, maxMs: 20000, fallbackMs: 4000, stillWanted: wanted });
        if (!wanted()) return;
        live.ready = true;
        this.publish(record);
        this.changed();
        void this.pump(record);
    }

    /** Keep DSH from ending the terminal while nobody's window holds it (DSH ends unwatched idle terminals after a while). */
    hold(record, agent) {
        if (!this.started) return;
        const live = this.liveOf(record);
        this.unhold(live);
        const controller = this.controller();
        if (typeof controller?.retain !== 'function') return;
        const abort = new AbortController();
        live.hold = abort;
        void (async () => {
            try {
                for await (const frame of controller.retain(record.sessionId, record.terminalId, abort.signal)) void frame;
            } catch {
                // The terminal ended, or this hold was let go.
            }
        })();
        void agent;
    }

    unhold(live) {
        try {
            live.hold?.abort(new Error('Agent Terminals let go'));
        } catch {}
        live.hold = undefined;
    }

    /**
     * The session's model says one line about the agent, so DSH lists the
     * session (it lists none without a turn). Logged as sending, and done
     * when that turn ends.
     */
    async firstTurn(record) {
        const note = `A coding agent runs in this session's terminal: ${record.program} in ${record.folder || 'this session\'s folder'}, started by Agent Terminals. Reply with one short line to say you see it; there is nothing else to do.`;
        const entry = this.log({ kind: 'session', agent: record.key, sessionId: record.sessionId, text: 'Giving its session a first turn', why: 'DSH lists a session in its sidebar once a turn ran in it. The session\'s model answers one line.', state: 'sending', by: 'Agent Terminals' });
        const set = (patch) => {
            if (!entry) return;
            try { this.journal.set(entry.id, patch); } catch {}
        };
        let off;
        let timer;
        try {
            // Its end, from Session Watch; a turn that has not ended after a while is left to run.
            const ended = typeof this.watch.on !== 'function' ? Promise.resolve(undefined) : new Promise((resolve) => {
                off = this.watch.on((event) => {
                    if (event?.type === 'turn-end' && event.sessionId === record.sessionId) resolve(event.end ?? {});
                });
                timer = setTimeout(() => resolve(undefined), FIRST_TURN_MS);
                timer.unref?.();
            });
            const delivery = await this.watch.deliver(record.sessionId, note, { mode: 'queue' });
            if (delivery?.state === 'failed') throw new Error(delivery.reason ?? 'the session did not take it');
            const end = await ended;
            if (!end) set({ text: 'Gave its session a first turn', state: 'done', reason: off ? 'Its session took the message; its turn had not ended 5 minutes later.' : 'Its session took the message.' });
            else if (end.kind === 'completed') set({ text: 'Gave its session a first turn', state: 'done' });
            else set({ text: 'Its session\'s first turn did not finish', state: 'failed', reason: `The turn ended ${end.kind === 'error' ? `with an error${end.error ? `: ${end.error}` : ''}` : end.kind === 'aborted' ? 'stopped' : `as ${end.kind ?? 'unknown'}`}. The session is listed in the sidebar all the same.` });
        } catch (error) {
            set({ text: 'Could not give its session a first turn', state: 'failed', reason: `${errorText(error)}. The session is listed once you open it and send something.` });
        } finally {
            clearTimeout(timer);
            try { off?.(); } catch {}
        }
    }

    // ── Stopping ───────────────────────────────────────────────────────

    async stopAgent(key, { by = 'you' } = {}) {
        this.ensureWorking();
        const record = this.need(key);
        const live = this.liveOf(record);
        record.wanted = 'stopped';
        record.ended = { why: 'stopped', text: `${by === 'you' ? 'You' : by} stopped it. ${this.againWords(record)}`, at: this.now() };
        live.exited = true;
        this.unhold(live);
        this.typist.release(record.sessionId, record.terminalId);
        let closed = true;
        try {
            await this.controller()?.close?.(await this.watch.resolveAgent(record.sessionId), record.terminalId);
        } catch (error) {
            closed = false;
            this.logger?.warn?.(`agent-terminals: could not close the terminal of ${record.name}: ${errorText(error)}`);
        }
        this.waitDeliveries(record, 'The agent is stopped: Start again and this is typed in.');
        this.store.change();
        this.log({ kind: 'stop', agent: key, sessionId: record.sessionId, text: `Stopped ${record.name}`, why: closed ? 'Its terminal was closed, which ends the program in it.' : 'Its terminal could not be closed; it may still run until DSH ends it.', state: closed ? 'done' : 'failed', by });
        this.publish(record);
        this.changed();
        return { agent: this.view(record) };
    }

    /** Forget an agent: stop it if it runs, and drop it from the list (its session stays). */
    async forget(key, { by = 'you' } = {}) {
        this.ensureWorking();
        const record = this.need(key);
        if (record.wanted === 'running' || this.terminalInfo(record)?.state === 'running') await this.stopAgent(key, { by });
        const live = this.liveOf(record);
        if (live.askId) {
            try { this.watch.dropAsk(live.askId); } catch {}
        }
        try { this.watch.setExternal(record.sessionId, null); } catch {}
        this.lives.delete(key);
        delete this.records[key];
        this.store.change();
        this.log({ kind: 'forget', agent: key, sessionId: record.sessionId, text: `Forgot ${record.name}`, why: 'Its session and its own conversation files stay as they are.', state: 'done', by });
        this.changed();
        return { forgotten: key };
    }

    /** An agent's program ended, or its terminal went away. */
    ended(record, why, words, code) {
        const live = this.liveOf(record);
        live.exited = true;
        this.unhold(live);
        this.typist.release(record.sessionId, record.terminalId);
        record.wanted = 'stopped';
        record.ended = { why, text: words, at: this.now(), ...(Number.isInteger(code) ? { code } : {}) };
        this.waitDeliveries(record, 'The agent is not running: Start again and this is typed in.');
        this.store.change();
        this.log({ kind: 'ended', agent: record.key, sessionId: record.sessionId, text: `${record.name} ${why === 'closed' ? 'was closed' : why === 'failed' ? 'failed' : 'stopped'}`, why: words, state: why === 'exited' && (code === 0 || code === undefined) ? 'done' : 'stopped', by: 'Agent Terminals' });
        this.publish(record);
        this.changed();
    }

    /**
     * A start that failed: said on the agent's card and in the log. With
     * `keepWanted` (a start after DSH restarted) it stays meant to run, so
     * the next start of DSH tries again; else it stays stopped until Start again.
     */
    failed(record, error, when, { keepWanted = false } = {}) {
        const words = errorText(error);
        record.problem = words;
        if (!keepWanted) record.wanted = 'stopped';
        const said = /[.!?]$/.test(words) ? words : `${words}.`;
        record.ended = { why: 'failed', text: `It could not start ${when}: ${said}${keepWanted ? ' It is tried again the next time DSH starts; Start again tries now.' : ''}`, at: this.now() };
        this.liveOf(record).exited = true;
        this.store.change();
        this.log({ kind: 'start', agent: record.key, sessionId: record.sessionId, text: `Could not start ${record.name}`, why: words, state: 'failed', by: 'Agent Terminals' });
        this.publish(record);
        return words;
    }

    // ── Reading the transcript ─────────────────────────────────────────

    /**
     * Read an agent's transcript as it is before its program starts again,
     * and close what it left open: the program that had a tool call, an
     * approval prompt or a job open has ended (DSH restarted, or it was
     * stopped), so none of it is waiting any more. A job cut off this way is
     * said on its card and logged once.
     */
    prime(record, live) {
        live.primedAt = this.now();
        // Kept, so a pick-up without a launch (a fixed setting, off and on) closes over the same entries.
        record.primedAt = live.primedAt;
        this.store.change();
        live.fold = undefined;
        live.tail = undefined;
        live.tailPath = undefined;
        const format = STYLES[record.style]?.format ?? 'none';
        if (format === 'none') return;
        const path = transcriptPath(record, this.home);
        if (!path || !existsSync(path)) return;
        live.tail = new Tail(path);
        live.tailPath = path;
        let fold = emptyFold();
        try {
            for (const entry of parseLines(format, live.tail.read().lines, live.primedAt)) fold = foldEntry(fold, entry);
        } catch (error) {
            this.logger?.warn?.(`agent-terminals: could not read the transcript of ${record.name}: ${errorText(error)}`);
        }
        const closed = closeOver(fold, Infinity);
        live.fold = closed;
        if (closed.cut && !fold.cut) {
            this.log({ kind: 'cut', agent: record.key, sessionId: record.sessionId, text: `${record.name}'s job was cut off`, why: `Its program ended while it worked on “${clip(closed.cut.text, 120)}”. It starts again idle in the same conversation: send it a message to carry on.`, state: 'stopped', by: 'Agent Terminals' });
        }
    }

    /** Read what the agent's transcript gained since the last look. */
    read(record) {
        const live = this.liveOf(record);
        const format = STYLES[record.style]?.format ?? 'none';
        if (format === 'none' || !live.launchAt) return;
        if (record.style === 'subcommand') this.findEvents(record, live);
        const path = transcriptPath(record, this.home);
        if (!path) return;
        if (record.style === 'flags' && !existsSync(path) && this.now() - (live.searchedAt ?? 0) >= 5000) {
            // Not where its folder says: the CLI may name the folder another way. Look once in a while.
            live.searchedAt = this.now();
            const found = findFlagsTranscript(record, this.home);
            if (found) {
                record.transcript = found;
                this.store.change();
                return this.read(record);
            }
        }
        if (live.tailPath !== path) {
            live.tail = new Tail(path);
            live.tailPath = path;
            live.fold = emptyFold();
        }
        const { lines, reset } = live.tail.read();
        if (reset) live.fold = emptyFold();
        if (lines.length === 0) return;
        let fold = live.fold ?? emptyFold();
        for (const entry of parseLines(format, lines, this.now())) fold = foldEntry(fold, entry);
        // A program that writes its resumed conversation into a new file repeats the old entries, with their times.
        live.fold = live.primedAt ? closeOver(fold, live.primedAt) : fold;
        // Its first words in the transcript since it started: it is ready, whatever the screen says.
        if (!live.ready && fold.turns > 0 && (!live.primedAt || (fold.activeAt ?? 0) >= live.primedAt)) live.ready = true;
    }

    /** An events-style agent names its conversation in a file it makes after it starts: find it, once. */
    findEvents(record, live) {
        const recent = this.now() - live.launchAt < 120000;
        if (record.transcript && !recent) return;
        const taken = new Set(Object.values(this.records).filter((r) => r.key !== record.key && r.transcript).map((r) => r.transcript));
        let found = findNewTranscript(record, this.home, live.launchAt, taken);
        if (found && record.conversationId && found.id !== record.conversationId) found = undefined;
        if (!found && record.transcript) return;
        if (!found && record.conversationId) {
            const path = findTranscriptById(record, this.home, record.conversationId);
            if (path) found = { path, id: record.conversationId };
        }
        if (found && found.path !== record.transcript) {
            record.transcript = found.path;
            record.conversationId = found.id;
            this.store.change();
        }
    }

    // ── Status ─────────────────────────────────────────────────────────

    /** What the agent is doing now. */
    statusFor(record) {
        const live = this.liveOf(record);
        if (live.launching) return { status: 'starting', detail: 'Starting its terminal.' };
        if (record.wanted !== 'running' || live.exited) return { status: 'stopped', detail: record.ended?.text ?? record.problem ?? 'Not running.' };
        // Agent Terminals is not running its agents (a wrong setting, or no terminals): the agent is not running either.
        if (!this.started && !live.launchAt) {
            // Its program may still run in its terminal (a setting went wrong while it ran): said so, not "stopped".
            if (this.terminalInfo(record)?.state === 'running') {
                return { status: 'running', unfollowed: true, detail: this.working()
                    ? 'Running in its terminal. Agent Terminals picks it up where it is once DSH\'s terminals are there.'
                    : 'Running in its terminal, not followed: Agent Terminals waits for a setting to be fixed (see the top of this page), then picks it up where it is.' };
            }
            return { status: 'stopped', detail: this.working()
                ? 'Not running: DSH\'s terminals are not there, so Agent Terminals cannot pick it up yet.'
                : 'Not running: Agent Terminals waits for a setting to be fixed (see the top of this page), then picks it up again.' };
        }
        if (!live.launchAt) return { status: 'starting', detail: 'Picking it up.' };
        const format = STYLES[record.style]?.format ?? 'none';
        const status = statusOf(live.fold, { now: this.now(), askAfterMs: this.config.askAfterSeconds * 1000, transcript: format !== 'none' });
        if (status.status === 'running') return { status: 'running', detail: 'Running. It keeps no transcript Agent Terminals can read, so its work and its answers show only in its terminal.' };
        if (status.status === 'starting') return live.ready ? { status: 'idle', detail: 'Ready for its first message.' } : { status: 'starting', detail: 'Starting.' };
        return status;
    }

    /** Tell Session Watch (the session's row, Decisions) and raise or drop the agent's question. */
    publish(record) {
        // Stopped (switched off, or DSH unloading it): the rows and Decisions hear nothing more from it.
        if (!this.started) return;
        const live = this.liveOf(record);
        const status = this.statusFor(record);
        live.status = status;
        const now = this.now();
        const sent = live.sent;
        const moved = !sent || sent.status !== status.status;
        if (moved || (sent.detail !== status.detail && now - live.sentAt >= DETAIL_EVERY_MS)) {
            live.sent = { status: status.status, detail: status.detail };
            live.sentAt = now;
            try {
                this.watch.setExternal(record.sessionId, { status: status.status, label: record.name, ...(status.detail ? { detail: status.detail } : {}), agent: record.key });
            } catch (error) {
                this.logger?.warn?.(`agent-terminals: could not tell Session Watch: ${errorText(error)}`);
            }
            if (moved) this.changed();
        }
        this.askFor(record, live, status);
    }

    askFor(record, live, status) {
        const fold = live.fold;
        let ask;
        if (status.status === 'waiting on you' && status.ask) {
            const question = clip(String(status.ask.question ?? ''), 600);
            ask = {
                id: `agent-terminals:${record.key}:reply:${fold?.turns ?? 0}:${shortHash(question)}`,
                question,
                ...(status.ask.recommendation ? { recommendation: clip(status.ask.recommendation, 300), options: [{ id: 'recommended', label: 'Go with the recommendation' }] } : {}),
                freeText: true,
                why: 'Its last reply asks you. Your answer is typed into its terminal.',
            };
        } else if (status.status === 'waiting on you' && status.call) {
            const what = status.call.summary ? `to run “${clip(status.call.summary, 160)}”` : `to use ${status.call.tool ?? 'a tool'}`;
            ask = {
                id: `agent-terminals:${record.key}:call:${status.call.callId ?? 'approval'}`,
                question: `It asks ${what}.`,
                why: status.call.approval ? 'It asks for your approval in its terminal.' : `The call has waited for its result for ${this.config.askAfterSeconds} s or more: its terminal is most likely asking you.`,
                answerHint: 'Answer in its terminal: open the session, then the agent\'s terminal tab.',
            };
        }
        if (live.askId && live.askId !== ask?.id) {
            try { this.watch.dropAsk(live.askId); } catch {}
            live.askId = undefined;
        }
        if (!ask || live.askId === ask.id) return;
        live.askId = ask.id;
        try {
            this.watch.raiseAsk({
                ...ask,
                sessionId: record.sessionId,
                source: 'Agent Terminals',
                title: record.name,
                ...(ask.options || ask.freeText ? { onAnswer: (answer, by) => this.answer(record.key, ask, answer, by) } : {}),
            });
        } catch (error) {
            this.logger?.warn?.(`agent-terminals: could not raise the question: ${errorText(error)}`);
            return;
        }
        // Asked before a restart is not asked again: no second log entry or notification.
        if (record.lastAskId === ask.id) return;
        record.lastAskId = ask.id;
        this.store.change();
        this.log({ kind: 'ask', agent: record.key, sessionId: record.sessionId, text: `${record.name} waits on you`, why: `${ask.question}${ask.recommendation ? ` Recommended: ${ask.recommendation}` : ''}`, state: 'waiting on you', by: 'Agent Terminals' });
        if (this.config.notify) {
            try {
                this.notify?.({ title: `${record.name} waits on you`, body: clip(ask.question, 240), kind: 'decision', sessionId: record.sessionId });
            } catch (error) {
                this.logger?.warn?.(`agent-terminals: a notification failed: ${errorText(error)}`);
            }
        }
    }

    /** A Decisions answer to the agent's question: typed into its terminal. */
    answer(key, ask, answer, by = 'you') {
        const record = this.records[key];
        if (!record) {
            const error = new Error('That agent was forgotten.');
            throw error;
        }
        if (!this.working()) {
            const error = new Error('Agent Terminals is waiting for a setting to be fixed, so it types nothing in now.');
            error.refused = true;
            throw error;
        }
        const words = answer === 'recommended' && ask.recommendation ? `Go with your recommendation: ${ask.recommendation}` : String(answer ?? '').trim();
        if (!words) throw new Error('The answer is empty.');
        const item = this.queue(record, words, by, 'as an answer in Decisions', { askId: ask.id });
        return { text: `It goes into “${record.name}”'s terminal when the agent is ready, and counts as delivered once its transcript shows it.`, delivery: item.id };
    }

    // ── Messages ───────────────────────────────────────────────────────

    /** Send a message to an agent: typed in when it is ready, then proven from its transcript. */
    send(key, words, { by = 'you' } = {}) {
        this.ensureWorking();
        const record = this.need(key);
        const body = String(words ?? '').trim();
        if (!body) throw new Error('Write the message first.');
        if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE) throw new Error(`The message is longer than ${MAX_MESSAGE / 1024} KB: shorten it, or put it in a file and send the file's path.`);
        const item = this.queue(record, body, by);
        return { delivery: { ...item } };
    }

    /**
     * @param {string} by - who sent it ('you', or a plugin's name).
     * @param {string} [via] - how, in words ('in Decisions').
     */
    queue(record, body, by, via = '', { askId } = {}) {
        const item = { id: `m-${this.now().toString(36)}-${randomUUID().slice(0, 4)}`, text: body, by, ...(via ? { via } : {}), ...(askId ? { askId } : {}), at: this.now(), state: 'queued' };
        record.deliveries.push(item);
        this.trimDeliveries(record);
        const who = by === 'you' ? 'You' : by;
        const entry = this.log({ kind: 'message', agent: record.key, sessionId: record.sessionId, text: `Message for ${record.name}`, why: `${who} sent it${via ? ` ${via}` : ''}: “${clip(body, 200)}”`, state: 'queued', by, delivery: item.id });
        if (entry) item.entry = entry.id;
        this.store.change();
        this.changed();
        void this.pump(record);
        return item;
    }

    /** Take back a message that is not typed in yet. */
    cancel(key, id) {
        this.ensureWorking();
        const record = this.need(key);
        const item = record.deliveries.find((d) => d.id === id);
        if (!item) throw new Error('That message is not in its list any more.');
        if (item.state === 'cancelled') throw new Error('It was taken back already.');
        if (!OPEN.has(item.state)) throw new Error('It is typed in already, so it cannot be taken back.');
        this.settle(record, item, 'cancelled', 'You took it back before it was typed in.');
        return { delivery: { ...item } };
    }

    trimDeliveries(record) {
        while (record.deliveries.length > KEEP_DELIVERIES) {
            const at = record.deliveries.findIndex((d) => !OPEN.has(d.state) && d.state !== 'typing');
            record.deliveries.splice(at === -1 ? 0 : at, 1);
        }
    }

    waitDeliveries(record, why) {
        for (const item of record.deliveries) {
            if (OPEN.has(item.state) && item.why !== why) {
                item.state = 'waiting';
                item.why = why;
            }
        }
    }

    /** Record what became of a message, on it and in its log entry. */
    settle(record, item, state, why, more = {}) {
        Object.assign(item, { state, why }, more);
        if (item.entry) {
            try { this.journal.set(item.entry, { state, reason: why }); } catch {}
        }
        // An answer that did not go in leaves its question unanswered: it is raised again first, so the
        // card Decisions brings back (on hearing "not delivered") has a question to show.
        if (item.askId && (state === 'failed' || state === 'cancelled')) {
            const live = this.lives.get(record.key);
            if (live?.askId === item.askId) {
                live.askId = undefined;
                this.publish(record);
            }
        }
        // An answer to a question in Decisions: what became of it goes back there ("typed" is final only
        // for a program that keeps no transcript; else its proof is still looked for).
        if (item.askId && OUTCOME[state] && (state !== 'typed' || STYLES[record.style]?.format === 'none')) {
            try {
                this.watch.askOutcome?.(item.askId, { state: OUTCOME[state], text: why, by: 'Agent Terminals', sessionId: record.sessionId });
            } catch (error) {
                this.logger?.warn?.(`agent-terminals: could not tell Decisions: ${errorText(error)}`);
            }
        }
        this.store.change();
        this.changed();
    }

    /** Why a message cannot be typed in now, or undefined when it can. */
    gate(record) {
        const live = this.liveOf(record);
        if (!this.working()) return 'Agent Terminals is waiting for a setting to be fixed (see the top of its page).';
        if (live.launching || (record.wanted === 'running' && !live.ready && !live.exited)) return 'The agent is starting; this is typed in when it is ready.';
        if (record.wanted !== 'running' || live.exited) return 'The agent is not running: Start again and this is typed in.';
        // A fresh look at its transcript: a tool call that opened a moment ago holds this too.
        this.read(record);
        const status = this.statusFor(record);
        if (status.status === 'waiting on you' && status.call) {
            const what = status.call.summary ? `to run “${clip(status.call.summary, 120)}”` : `to use ${status.call.tool ?? 'a tool'}`;
            return status.call.approval
                ? `Held while the agent asks you in its terminal ${what}; this is typed in after you answer there.`
                : `Held while a tool call waits in its terminal (${what}); this is typed in after it ends. If its terminal asks you something, answer there.`;
        }
        const calls = live.fold ? Object.values(live.fold.calls) : [];
        if (calls.length || live.fold?.approval) {
            const call = calls[0];
            return `Held while the agent runs ${call ? `${call.tool}${call.summary ? ` (${clip(call.summary, 80)})` : ''}` : 'a tool'}; this is typed in after, so it never lands in an approval prompt.`;
        }
        if (status.status === 'working' && !this.config.typeWhileWorking) return 'The agent is working; this is typed in when it is idle.';
        const way = this.typist.way(record.sessionId, record.terminalId);
        if ('problem' in way) return way.problem;
        return undefined;
    }

    /** Type an agent's messages, one at a time, while it is ready for them. */
    async pump(record) {
        if (!this.started) return;
        const live = this.liveOf(record);
        if (live.pumping) return;
        live.pumping = true;
        try {
            for (;;) {
                if (!this.started || !this.records[record.key]) return;
                const item = record.deliveries.find((d) => OPEN.has(d.state));
                if (!item) return;
                const why = this.gate(record);
                if (why) {
                    if (item.state !== 'waiting' || item.why !== why) {
                        item.state = 'waiting';
                        item.why = why;
                        this.store.change();
                        this.changed();
                    }
                    return;
                }
                await this.deliverOne(record, item);
            }
        } catch (error) {
            this.logger?.warn?.(`agent-terminals: typing for ${record.name}: ${errorText(error)}`);
        } finally {
            live.pumping = false;
        }
    }

    async deliverOne(record, item) {
        const live = this.liveOf(record);
        const format = STYLES[record.style]?.format ?? 'none';
        item.state = 'typing';
        item.why = 'Typing it in.';
        this.changed();
        let agent;
        let typed;
        const since = this.now();
        try {
            agent = await this.watch.resolveAgent(record.sessionId);
            typed = await this.typist.type(agent, record.terminalId, item.text);
        } catch (error) {
            this.typist.release(record.sessionId, record.terminalId);
            this.settle(record, item, 'failed', `Not typed in: ${errorText(error)}`);
            return;
        }
        const pasted = typed.paste ? 'pasted' : 'typed';
        item.typedAt = since;
        item.way = typed.way;
        item.enters = 1;
        if (format === 'none') {
            this.typist.release(record.sessionId, record.terminalId);
            this.settle(record, item, 'typed', `${pasted === 'pasted' ? 'Pasted' : 'Typed'} in, then Enter. This program keeps no transcript Agent Terminals can read, so it cannot prove the agent read it: look at its terminal.`);
            return;
        }
        this.settle(record, item, 'typed', `${pasted === 'pasted' ? 'Pasted' : 'Typed'} in, then Enter; waiting for its transcript to show it.${typed.flattened ? ' Its line breaks went in as spaces: this program did not ask for pasted text.' : ''}`);
        let lastEnter = since;
        const era = this.era;
        live.proving.add(item.id);
        try {
            for (;;) {
                await this.wait(250);
                // Stopped: the next start looks for its proof (lateProof); it presses no Enter.
                if (this.era !== era || !this.records[record.key]) return;
                this.read(record);
                const proof = provenIn(live.fold, item.text, since);
                if (proof) {
                    this.settle(record, item, 'delivered', `Its transcript shows it${item.enters > 1 ? `, after Enter ${item.enters} times (the first was swallowed)` : ''}.`, { provenAt: proof.at || this.now() });
                    this.log({ kind: 'proof', agent: record.key, sessionId: record.sessionId, text: `${record.name} has the message`, why: `Its own transcript shows “${clip(item.text, 120)}”.`, state: 'done', by: 'Agent Terminals' });
                    this.publish(record);
                    return;
                }
                if (record.wanted !== 'running' || live.exited) {
                    this.settle(record, item, 'not proven', 'The agent stopped before its transcript showed the message.');
                    return;
                }
                const status = this.statusFor(record);
                const now = this.now();
                // No key while a tool call or an approval prompt is open (Enter there could answer it), and
                // none while it works: the proof clock starts again once it is idle.
                const callOpen = Boolean(status.call) || Boolean(live.fold?.approval) || Object.keys(live.fold?.calls ?? {}).length > 0;
                if (status.status === 'working' || callOpen) {
                    lastEnter = now;
                    if (now - since > PROOF_WHILE_WORKING_MS) {
                        this.settle(record, item, 'not proven', 'Typed in 30 minutes ago, and its transcript still does not show it. Look at its terminal.');
                        return;
                    }
                    continue;
                }
                if (now - lastEnter < this.config.proofSeconds * 1000) continue;
                if (item.enters <= this.config.enterRetries) {
                    // Idle, and no proof: the program took the text but not its Enter.
                    try {
                        await this.typist.enter(agent, record.terminalId);
                    } catch (error) {
                        this.settle(record, item, 'not proven', `Typed in, but Enter could not be pressed again: ${errorText(error)}`);
                        return;
                    }
                    item.enters += 1;
                    lastEnter = this.now();
                    this.settle(record, item, 'typed', `No proof after ${this.config.proofSeconds} s while the agent was idle: pressed Enter again (${item.enters - 1} of ${this.config.enterRetries}).`);
                    continue;
                }
                this.settle(record, item, 'not proven', `Typed in, but its transcript has not shown it, after Enter ${item.enters} time${item.enters === 1 ? '' : 's'}. Look at its terminal: the message may still be in its input box. It turns delivered if its transcript shows it later.`);
                const noProof = this.log({ kind: 'proof', agent: record.key, sessionId: record.sessionId, text: `No proof that ${record.name} read a message`, why: `Its transcript has not shown “${clip(item.text, 120)}”.`, state: 'failed', by: 'Agent Terminals' });
                if (noProof) item.noProof = noProof.id;
                this.store.change();
                return;
            }
        } finally {
            live.proving.delete(item.id);
            if (item.way === 'attached') this.typist.release(record.sessionId, record.terminalId);
        }
    }

    /**
     * A message typed in before Agent Terminals stopped (a plugin reload)
     * still has its proof looked for, without pressing Enter again.
     */
    lateProof(record, live) {
        if (!live.fold || STYLES[record.style]?.format === 'none') return;
        for (const item of record.deliveries) {
            if (!item.typedAt || live.proving.has(item.id)) continue;
            const late = item.state === 'not proven';
            if (item.state !== 'typed' && !(late && this.now() - item.typedAt <= LATE_PROOF_MS)) continue;
            const proof = provenIn(live.fold, item.text, item.typedAt);
            if (proof && late) {
                this.settle(record, item, 'delivered', 'Its transcript shows it, later than Agent Terminals looked for it (it was marked not proven).', { provenAt: proof.at || this.now() });
                this.log({ kind: 'proof', agent: record.key, sessionId: record.sessionId, text: `${record.name} has the message after all`, why: `Its own transcript shows “${clip(item.text, 120)}”, later than Agent Terminals looked for it.`, state: 'done', by: 'Agent Terminals' });
                if (item.noProof) {
                    try { this.journal.set(item.noProof, { state: 'done', reason: 'Seen later: its transcript shows it.' }); } catch {}
                }
            } else if (proof) {
                this.settle(record, item, 'delivered', 'Its transcript shows it.', { provenAt: proof.at || this.now() });
            } else if (!late && this.now() - item.typedAt > PROOF_WHILE_WORKING_MS) {
                this.settle(record, item, 'not proven', 'Typed in 30 minutes ago, and its transcript still does not show it. Look at its terminal.');
            }
        }
    }

    /**
     * DSH restarted, which ended the agent's program: a message typed in but
     * not yet in its transcript sat in that program's input line, and went
     * with it. Its transcript decides: shown there, it is delivered; else it
     * is typed in again, once, when the agent runs again. Lost a second time,
     * it failed, and an answer's question comes back in Decisions.
     */
    lostWithRestart(record) {
        const format = STYLES[record.style]?.format ?? 'none';
        const typed = record.deliveries.filter((d) => d.state === 'typed' && d.typedAt);
        // A program that keeps no transcript proves nothing either way: its messages stay "typed in".
        if (format === 'none' || typed.length === 0) return;
        let fold = emptyFold();
        const path = transcriptPath(record, this.home);
        try {
            if (path && existsSync(path)) for (const entry of parseLines(format, new Tail(path).read().lines, this.now())) fold = foldEntry(fold, entry);
        } catch (error) {
            this.logger?.warn?.(`agent-terminals: could not read the transcript of ${record.name}: ${errorText(error)}`);
        }
        for (const item of typed) {
            const proof = provenIn(fold, item.text, item.typedAt);
            if (proof) {
                this.settle(record, item, 'delivered', 'Its transcript shows it.', { provenAt: proof.at || this.now() });
            } else if (item.again) {
                this.settle(record, item, 'failed', 'DSH restarted twice before the agent read it, and each time its program ended with the message unread in its input line. Send it again.');
                this.log({ kind: 'restart', agent: record.key, sessionId: record.sessionId, text: `A message for ${record.name} was lost`, why: `DSH restarted twice before the agent read “${clip(item.text, 120)}”.`, state: 'failed', by: 'Agent Terminals' });
            } else {
                delete item.typedAt;
                delete item.enters;
                delete item.way;
                this.settle(record, item, 'queued', 'DSH restarted before the agent read it (it was in the input line of the program that ended), so it is typed in again.', { again: true });
            }
        }
    }

    // ── Reading for the page ───────────────────────────────────────────

    need(key) {
        const record = typeof key === 'string' ? this.records[key] : undefined;
        if (!record) throw new Error('That agent is not in the list any more.');
        return record;
    }

    bySession(sessionId) {
        return Object.values(this.records).find((record) => record.sessionId === sessionId);
    }

    ensureWorking() {
        if (!this.working()) throw new Error('Agent Terminals is waiting for a setting to be fixed: see the top of its page.');
    }

    remember(spec) {
        const entry = { program: spec.program, args: spec.args, style: spec.style, ...(spec.data ? { data: spec.data } : {}) };
        const same = (r) => r.program === entry.program && r.style === entry.style && JSON.stringify(r.args) === JSON.stringify(entry.args) && r.data === entry.data;
        this.store.data.recent = [entry, ...this.store.data.recent.filter((r) => !same(r))].slice(0, KEEP_RECENT);
    }

    /** One agent as the page shows it. */
    view(record) {
        const live = this.liveOf(record);
        // Not running its agents: nothing published a status, so it is worked out here.
        const status = this.started ? live.status ?? this.statusFor(record) : this.statusFor(record);
        const info = this.terminalInfo(record);
        const fold = live.fold;
        return {
            key: record.key,
            sessionId: record.sessionId,
            name: record.name,
            program: record.program,
            programName: programName(record.program),
            args: record.args,
            style: record.style,
            ...(record.data ? { data: record.data } : {}),
            folder: record.folder,
            terminalId: record.terminalId,
            followed: this.started,
            terminal: info ? { state: info.state, ...(Number.isInteger(info.exitCode) ? { exitCode: info.exitCode } : {}), title: info.title } : null,
            status: status.status,
            ...(status.detail ? { detail: status.detail } : {}),
            ...(status.ask ? { ask: { question: status.ask.question, ...(status.ask.recommendation ? { recommendation: status.ask.recommendation } : {}) } } : {}),
            ...(status.call ? { call: { tool: status.call.tool, summary: status.call.summary, approval: status.call.approval === true } } : {}),
            wanted: record.wanted,
            ready: live.ready,
            launching: Boolean(live.launching),
            canResume: this.canResume(record),
            ...(record.conversationId ? { conversationId: record.conversationId } : {}),
            ...(transcriptPath(record, this.home) ? { transcript: transcriptPath(record, this.home) } : {}),
            keepsTranscript: STYLES[record.style]?.format !== 'none',
            ...(fold ? { turns: fold.turns, ...(fold.reply ? { lastReply: { at: fold.reply.at, text: clip(fold.reply.text, 600) } } : {}), ...(fold.user ? { lastMessage: { at: fold.user.at, text: clip(fold.user.text, 300) } } : {}) } : {}),
            ...(record.ended ? { ended: record.ended } : {}),
            ...(record.problem ? { problem: record.problem } : {}),
            createdAt: record.createdAt,
            ...(record.launchedAt ? { launchedAt: record.launchedAt } : {}),
            launches: record.launches,
            typing: this.typist.way(record.sessionId, record.terminalId).way ?? null,
            controlTakenAt: this.typist.takenAt(record.sessionId, record.terminalId),
            deliveries: record.deliveries.slice(-12).reverse().map((d) => ({ id: d.id, text: clipLines(d.text, 400), by: d.by, at: d.at, state: d.state, ...(d.why ? { why: d.why } : {}), ...(d.enters ? { enters: d.enters } : {}), ...(d.way ? { way: d.way } : {}), ...(d.provenAt ? { provenAt: d.provenAt } : {}) })),
        };
    }

    /** Every agent, the ones waiting on you first, then by name. */
    list() {
        const order = { 'waiting on you': 0, working: 1, starting: 2, running: 3, idle: 4, stopped: 5 };
        return Object.values(this.records).map((record) => this.view(record))
            .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name));
    }

    /** What a window needs to show agents' terminals and marks: one small row per agent. */
    marks() {
        return Object.values(this.records).map((record) => {
            const live = this.liveOf(record);
            // Not running its agents: nothing published a status, so it is worked out here.
            const status = this.started ? live.status ?? this.statusFor(record) : this.statusFor(record);
            return {
                key: record.key,
                sessionId: record.sessionId,
                name: record.name,
                terminalId: record.terminalId,
                running: record.wanted === 'running' && !live.exited && !live.launching && this.terminalInfo(record)?.state === 'running',
                status: status.status,
                ...(status.detail ? { detail: oneLine(status.detail, 160) } : {}),
                controlTakenAt: this.typist.takenAt(record.sessionId, record.terminalId),
            };
        });
    }

    get recent() {
        return this.store.data.recent;
    }
}

/** Why an agent's program ended, in words, from its exit code. */
export function exitWords(record, code, again = 'Start again resumes its conversation.') {
    if (code === 127) return `It exited with code 127: the shell could not find ${record.program}. Use its full path (“which ${programName(record.program)}” in a terminal shows it), or check the name.`;
    if (code === 126) return `It exited with code 126: ${record.program} is not a program the shell can run. Check the path and that it is executable.`;
    if (code === 0) return `It exited by itself (code 0). ${again}`;
    if (code === 130 || code === 129 || code === 143) return `It was interrupted (code ${code}). ${again}`;
    return `It exited${Number.isInteger(code) ? ` with code ${code}` : ''}. Its terminal shows why. ${again}`;
}

/**
 * Where a program is: a path as given, or a name where the start form's
 * finder looks (DSH's PATH and the folders shells usually add). The shell
 * in an agent's terminal reads the person's own startup files, so a name
 * not found here may still run there: a miss is said, never refused.
 * @returns {{ found: boolean, path?: string }}
 */
export function findProgram(program, home) {
    const name = String(program ?? '').trim();
    if (!name) return { found: false };
    if (!name.includes('/')) {
        const path = whereIs(name, { home });
        return path ? { found: true, path } : { found: false };
    }
    const path = expandHome(name, home ?? '/');
    try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile() ? { found: true, path } : { found: false };
    } catch {
        return { found: false };
    }
}

/** A short, stable hash of some words (to tell one question from the next). */
export function shortHash(words) {
    let h = 2166136261;
    for (const ch of String(words)) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}
