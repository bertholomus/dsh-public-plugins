/**
 * The outbound mirror: a short message for each new card, sent where the
 * person is when they are away from DSH. Off unless the settings turn it on.
 *
 * - `webhook`: a POST of `{ content }` (Discord's webhook shape) to the
 *   webhook address, which must be https (or http to this machine, for a
 *   local sink). The address is a secret: it lives in DSH's key store under
 *   `mirrorUrlEnv` (set on Decisions' page in Plugins), or in the
 *   environment DSH starts in, and is read again for every message; it is
 *   never in the settings file. Mentions are switched off, so an agent's
 *   text can never ping anyone.
 * - `command`: `mirrorCommand` (the program's full path, then its
 *   arguments) run without a shell, with the card as JSON on stdin.
 *
 * At most `mirrorPerHour` messages an hour (counting the ones that went,
 * across restarts); past that it holds back and says so once. Every send
 * and every failure goes in the event log, which names the host or the
 * program, never the address.
 *
 * @module dsh-plugin-decisions/mirror
 */
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { clip, errorText } from './shared/safe.js';
import { cutLines, mirrorText } from './cards.js';

/** Hosts an http (not https) webhook may use: this machine only. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Longest message a webhook gets (Discord takes 2000 characters). */
const WEBHOOK_MAX = 1900;

/** What the page and the log say when the webhook has no address. */
export const NO_ADDRESS = 'No webhook address is set yet: add it in Decisions\' settings in Plugins';

/**
 * Check a webhook address: https, or http to this machine. Returns the URL,
 * or throws in words (which never repeat the address).
 */
export function checkWebhook(text) {
    if (typeof text !== 'string' || text.trim() === '') throw new Error(NO_ADDRESS);
    let url;
    try { url = new URL(text.trim()); } catch { throw new Error('The webhook address is not a web address: give the whole address, starting with https://'); }
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url;
    throw new Error(`The webhook address must start with https:// (http:// only to this machine), not ${url.protocol}//`);
}

/** Where the command is changed, said after what is wrong with it. */
const WHERE_COMMAND = 'change mirrorCommand in Decisions\' entry in DSH\'s profile (cordis.patch.yml)';

/**
 * Check a command sink: the program's full path, then plain arguments.
 * Throws in words that say where to change it. Only the mirror checks it,
 * and only while new cards go to a command: a wrong command stops nothing
 * else.
 */
export function checkCommand(command) {
    if (command === undefined || command === null || (Array.isArray(command) && command.length === 0)) {
        throw new Error('No command is set: add mirrorCommand (the program\'s full path, then its arguments) to Decisions\' entry in DSH\'s profile (cordis.patch.yml)');
    }
    if (!Array.isArray(command) || command.some((part) => typeof part !== 'string')) {
        throw new Error(`The command must be a list of the program's full path and then its arguments, such as [/usr/local/bin/notify-me, --from, dsh] (it is ${clip(JSON.stringify(command) ?? String(command), 80)}): ${WHERE_COMMAND}`);
    }
    if (!isAbsolute(command[0])) throw new Error(`The command must start with the program's full path (it starts with ${JSON.stringify(clip(command[0], 80))}): ${WHERE_COMMAND}`);
    return command;
}

/** Programs that run a script named after them: the script, not the program, names where cards go. */
const RUNNERS = /^(?:sh|bash|zsh|dash|ksh|fish|env|node|nodejs|bun|deno|python(?:\d+(?:\.\d+)?)?|ruby|perl|php|osascript)$/;

/**
 * The name the page and the log give a command: its program's name, or,
 * for a shell or an interpreter running a script, the script's name
 * ("cmdsink.sh" for [/bin/sh, /path/cmdsink.sh]). Code given inline
 * (`sh -c …`) keeps the program's name.
 */
export function programName(command) {
    const name = basename(command[0]);
    if (!RUNNERS.test(name)) return name;
    for (const part of command.slice(1)) {
        if (/^-(?:c|e|m|-eval|-command)$/.test(part)) return name;
        if (part.startsWith('-') || /^\w+=/.test(part)) continue;
        if (RUNNERS.test(part)) continue;
        if (part.includes('/') || /\.\w{1,5}$/.test(part)) return basename(part);
        return name;
    }
    return name;
}

export class Mirror {
    /**
     * @param {object} options
     * @param {object} options.config - Decisions' settings (read when used).
     * @param {import('./shared/journal.js').Journal} options.journal
     * @param {import('./shared/files.js').JsonStore} [options.store] - Decisions' state, where the hour's sends are kept (`sent`).
     * @param {() => Promise<string | undefined>} [options.readAddress] - the webhook address from DSH's key store, read for each message.
     * @param {{ warn: Function }} [options.logger]
     * @param {typeof fetch} [options.fetch]
     * @param {typeof spawnProcess} [options.spawn]
     * @param {(path: string) => boolean} [options.exists]
     * @param {() => number} [options.now]
     */
    constructor({ config, journal, store, readAddress = async () => undefined, logger, fetch = globalThis.fetch, spawn = spawnProcess, exists = existsSync, now = Date.now }) {
        this.config = config;
        this.journal = journal;
        this.store = store;
        this.readAddress = readAddress;
        this.logger = logger;
        this.fetch = fetch;
        this.spawn = spawn;
        this.exists = exists;
        this.now = now;
        /** When each message of the last hour went, without a store. */
        this.memory = [];
        /** Messages on their way now: they count toward the limit until they go or fail. */
        this.inFlight = 0;
        /** The hour (ms) the limit was last reported for, so it is said once an hour. */
        this.heldReported = 0;
        /** The last reason nothing could be sent, and when it was logged, so it is said once an hour. */
        this.problemReported = { text: '', at: 0 };
        /** The webhook's host the last time its address was read (never the address). */
        this.host = '';
        /** The last send's outcome, for the page. */
        this.last = undefined;
    }

    /**
     * When a once-an-hour note was last said ('held', 'problem'), kept in
     * Decisions' state when there is one, so a restart does not say it again.
     */
    saidAt(note) {
        const said = this.store?.data?.said;
        if (said) return said[note] ?? { at: 0, text: '' };
        return note === 'held' ? { at: this.heldReported, text: '' } : this.problemReported;
    }

    say(note, text, at) {
        const said = this.store?.data?.said;
        if (said) {
            said[note] = { at, text };
            this.store.change();
        } else if (note === 'held') {
            this.heldReported = at;
        } else {
            this.problemReported = { text, at };
        }
    }

    /** When the messages of the last hour went (only those that went). */
    recent(now = this.now()) {
        const list = Array.isArray(this.store?.data?.sent) ? this.store.data.sent : this.memory;
        return list.filter((at) => at > now - 3600000);
    }

    /** Count a message that went. */
    record(at) {
        const list = [...this.recent(at), at].slice(-500);
        if (this.store?.data) {
            this.store.data.sent = list;
            this.store.change();
        } else {
            this.memory = list;
        }
    }

    get on() {
        return this.config.mirror === 'webhook' || this.config.mirror === 'command';
    }

    /** Where it sends, in words safe to show: a host or a program name. */
    get place() {
        if (this.config.mirror === 'webhook') return this.host;
        if (this.config.mirror === 'command') {
            try { return programName(checkCommand(this.config.mirrorCommand)); } catch { return ''; }
        }
        return '';
    }

    /**
     * Where a message would go now: the webhook (its address read from DSH's
     * key store each time) or the command, or the reason it cannot go.
     * @returns {Promise<{ kind: 'webhook', url: URL, place: string } | { kind: 'command', command: string[], place: string } | { problem: string }>}
     */
    async target() {
        const mode = this.config.mirror;
        if (mode === 'webhook') {
            let raw;
            try { raw = await this.readAddress(); } catch (error) { return { problem: `DSH's key store did not answer: ${errorText(error, 120)}` }; }
            try {
                const url = checkWebhook(raw);
                this.host = url.host;
                return { kind: 'webhook', url, place: url.host };
            } catch (error) {
                return { problem: errorText(error, 200) };
            }
        }
        if (mode === 'command') {
            try {
                const command = checkCommand(this.config.mirrorCommand);
                if (!this.exists(command[0])) return { problem: `The command's program ${clip(command[0], 120)} does not exist` };
                return { kind: 'command', command, place: programName(command) };
            } catch (error) {
                return { problem: errorText(error, 200) };
            }
        }
        return { problem: 'The mirror is off' };
    }

    /** What the page shows about the mirror (reads the webhook address's host, never the address). */
    async describe() {
        const target = this.on ? await this.target() : undefined;
        return {
            mode: this.on ? this.config.mirror : 'off',
            place: target?.place ?? this.place,
            key: typeof this.config.mirrorUrlEnv === 'string' ? this.config.mirrorUrlEnv : '',
            perHour: this.config.mirrorPerHour,
            lastHour: this.recent().length,
            ...(target?.problem ? { problem: target.problem } : {}),
            ...(this.last ? { last: this.last } : {}),
        };
    }

    /**
     * Mirror one card. Never throws; resolves to `{ ok, reason? }` and logs
     * the outcome.
     * @param {object} card
     */
    async send(card) {
        if (!this.on) return { ok: false, reason: 'the mirror is off' };
        const now = this.now();
        if (this.recent(now).length + this.inFlight >= this.config.mirrorPerHour) {
            if (now - this.saidAt('held').at > 3600000) {
                this.say('held', '', now);
                const where = this.config.mirror === 'webhook' ? (this.place ? `the webhook at ${this.place}` : 'the webhook') : (this.place || 'your command');
                this.journal.add({ kind: 'mirror', text: `Held back new cards: ${this.config.mirrorPerHour} went to ${where} in the last hour`, why: 'The hourly limit in Decisions\' settings caps them; Decisions still lists every card. This is said once an hour.', state: 'held' });
            }
            this.last = { at: now, ok: false, reason: 'the hourly limit is reached', held: true };
            return { ok: false, reason: 'the hourly limit is reached' };
        }
        // Its place in the hour is taken now, before anything is awaited, so a burst of new cards cannot pass the limit.
        this.inFlight += 1;
        let result;
        try {
            const target = await this.target();
            if (target.problem) {
                // Said once an hour, or when the reason changes: every card would say the same.
                const said = this.saidAt('problem');
                if (said.text !== target.problem || now - said.at > 3600000) {
                    this.say('problem', target.problem, now);
                    this.journal.add({ kind: 'mirror', text: 'Could not send new cards elsewhere', reason: target.problem, state: 'not sent' });
                }
                this.last = { at: now, ok: false, reason: target.problem };
                return { ok: false, reason: target.problem };
            }
            const entry = this.journal.add({
                kind: 'mirror',
                cardId: card.id,
                ...(card.sessionId ? { sessionId: card.sessionId } : {}),
                title: card.title ?? '',
                text: `Sending to ${target.place}`,
                state: 'sending',
            });
            result = await this.deliver(target, mirrorText(card), card);
            if (result.ok) this.record(this.now());
            this.journal.set(entry.id, result.ok ? { text: `Sent to ${target.place}`, state: 'sent' } : { text: `Not sent to ${target.place}`, state: 'not sent', reason: result.reason });
        } finally {
            this.inFlight -= 1;
        }
        this.last = { at: this.now(), ok: result.ok, ...(result.reason ? { reason: result.reason } : {}) };
        return result;
    }

    /** Send a test message now (from the page), past the hourly limit. */
    async test() {
        if (!this.on) return { ok: false, reason: 'Sending elsewhere is off. Choose Webhook or Command in Decisions\' settings in Plugins first.' };
        const target = await this.target();
        const to = target.place ? ` to ${target.place}` : '';
        const entry = this.journal.add({ kind: 'mirror', text: `Sending a test message${to}`, state: 'sending', by: 'you' });
        const result = target.problem ? { ok: false, reason: target.problem }
            : await this.deliver(target, 'Decisions can reach you here. When something waits on you in DSH, a short note comes here.', { kind: 'test', title: 'Test', question: 'Decisions can reach you here.' });
        this.journal.set(entry.id, result.ok ? { text: `Sent a test message${to}`, state: 'sent' } : { text: `Test message not sent${to}`, state: 'not sent', reason: result.reason });
        this.last = { at: this.now(), ok: result.ok, test: true, ...(result.reason ? { reason: result.reason } : {}) };
        return { ...result, place: target.place ?? '' };
    }

    async deliver(target, text, card) {
        try {
            if (target.kind === 'webhook') return await this.post(target.url, text);
            return await this.run(target.command, text, card);
        } catch (error) {
            return { ok: false, reason: errorText(error, 200) };
        }
    }

    async post(url, text) {
        if (typeof this.fetch !== 'function') return { ok: false, reason: 'this DSH has no way to make web requests' };
        let response;
        try {
            response = await this.fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ content: cutLines(text, WEBHOOK_MAX), allowed_mentions: { parse: [] } }),
                signal: AbortSignal.timeout(10000),
                redirect: 'error',
            });
        } catch (error) {
            const why = error?.name === 'TimeoutError' ? 'it did not answer within 10 seconds' : 'it could not be reached';
            return { ok: false, reason: `${url.host}: ${why}` };
        }
        try { await response.body?.cancel?.(); } catch { /* the answer's body is not needed */ }
        if (response.ok) return { ok: true };
        return { ok: false, reason: `${url.host} answered ${response.status}${response.status === 401 || response.status === 403 || response.status === 404 ? ' (check the webhook address)' : response.status === 429 ? ' (too many messages; it will take more later)' : ''}` };
    }

    run(command, text, card) {
        const name = programName(command);
        return new Promise((resolve) => {
            let child;
            let done = false;
            const finish = (result) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(() => {
                try { child?.kill('SIGTERM'); } catch { /* it is gone */ }
                finish({ ok: false, reason: `${name} did not finish within 15 seconds` });
            }, 15000);
            timer.unref?.();
            try {
                child = this.spawn(command[0], command.slice(1), { shell: false, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
            } catch (error) {
                finish({ ok: false, reason: `${name} could not start: ${errorText(error, 120)}` });
                return;
            }
            let stderr = '';
            child.stderr?.on?.('data', (chunk) => { if (stderr.length < 400) stderr += String(chunk); });
            child.on('error', (error) => finish({ ok: false, reason: `${name} could not start: ${error?.code === 'ENOENT' ? 'no such program' : error?.code === 'EACCES' ? 'it is not executable' : errorText(error, 120)}` }));
            child.on('close', (code, signal) => {
                if (code === 0) finish({ ok: true });
                else finish({ ok: false, reason: `${name} ${signal ? `stopped on ${signal}` : `exited with ${code}`}${stderr.trim() ? `: ${clip(stderr, 160)}` : ''}` });
            });
            const payload = {
                text,
                kind: card?.kind ?? '',
                title: card?.title ?? '',
                question: card?.question ?? '',
                ...(card?.context ? { context: card.context } : {}),
                ...(card?.recommendation ? { recommendation: card.recommendation } : {}),
                ...(card?.sessionId ? { sessionId: card.sessionId } : {}),
            };
            try {
                child.stdin?.on?.('error', () => { /* a program that does not read stdin */ });
                child.stdin?.end?.(`${JSON.stringify(payload)}\n`);
            } catch { /* the close handler reports the outcome */ }
        });
    }
}
