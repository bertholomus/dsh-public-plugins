/**
 * Typing into a coding agent's terminal, and reading its screen.
 *
 * DSH keeps each session terminal in its terminal controller: the process,
 * and a screen it draws for windows. A message can be typed in two ways:
 *
 * - `direct`: into the terminal's own process input, where the tab's keys
 *   go too. The tab keeps its input control, so the person can type in it
 *   at the same time, and the screen can be read without attaching. This
 *   reaches inside DSH's terminal controller (DSH 0.2.1 gives plugins no
 *   other way to type), so it is checked before every use.
 * - `attached`: DSH's terminal input for plugins (`follow`, then `write`;
 *   DSH 0.2.0). It takes the tab's input control while it types: the tab
 *   shows "read-only" until the window takes control back, which Agent
 *   Terminals' browser half does as soon as the message is in.
 *
 * `auto` (the default) types direct where it can and attached elsewhere.
 * Nothing here throws a raw error at the engine: failures come back as
 * errors with a sentence that says what to do.
 *
 * @module dsh-plugin-agent-terminals/typist
 */
import { randomUUID } from 'node:crypto';
import { errorText } from './shared/safe.js';

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
const MODE = /\x1b\[\?2004([hl])/g;
/** The largest message typed in (DSH's own limit for one write is 64 KiB). */
export const MAX_MESSAGE = 32 * 1024;
const CHUNK = 1024;

const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
});

/** The last bracketed-paste switch in some terminal output: true (on), false (off), or undefined (none). */
export function pasteSwitch(text) {
    let last;
    for (const match of String(text ?? '').matchAll(MODE)) last = match[1] === 'h';
    return last;
}

/**
 * What to send for a message: bracketed paste when the program asked for
 * it (its lines stay one message), else the text typed as keys with its
 * line breaks as spaces (a line break would send it early).
 * @param {string} text
 * @param {boolean | undefined} paste - the program's paste mode; undefined when unknown.
 * @returns {{ data: string, paste: boolean, flattened: boolean }}
 */
export function messageKeys(text, paste) {
    const body = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\x1b/g, '');
    const multiline = body.includes('\n');
    // Unknown: a one-line message is safe as keys anywhere; more lines need a paste to stay one message.
    const usePaste = paste ?? multiline;
    if (usePaste) return { data: `${PASTE_START}${body.replace(/\n/g, '\r')}${PASTE_END}`, paste: true, flattened: false };
    return { data: multiline ? body.replace(/\n+/g, ' ') : body, paste: false, flattened: multiline };
}

export class Typist {
    /**
     * @param {object} options
     * @param {() => any} options.controller - DSH's terminal controller, or undefined.
     * @param {() => string} [options.method] - 'auto', 'direct' or 'attached'.
     * @param {{ warn: Function }} [options.logger]
     * @param {(ms: number) => Promise<void>} [options.wait]
     */
    constructor({ controller, method = () => 'auto', logger, wait = sleep }) {
        this.controller = controller;
        this.method = method;
        this.logger = logger;
        this.wait = wait;
        /** Attached inputs by terminal: { attachmentId, abort, paste, lost, closed }. */
        this.links = new Map();
        /** When the attached way last took a terminal's control, by terminal (the browser half gives it back). */
        this.taken = new Map();
    }

    /** DSH's own object for a terminal, when it can be reached. */
    inner(sessionId, terminalId) {
        try {
            const terminal = this.controller()?.owners?.get?.(sessionId)?.terminals?.get?.(terminalId);
            return terminal !== null && typeof terminal === 'object' ? terminal : undefined;
        } catch {
            return undefined;
        }
    }

    directOk(sessionId, terminalId) {
        const terminal = this.inner(sessionId, terminalId);
        return typeof terminal?.handle?.write === 'function' && terminal.info?.state === 'running' && terminal.closing === undefined;
    }

    attachedOk() {
        const controller = this.controller();
        return typeof controller?.follow === 'function' && typeof controller?.write === 'function';
    }

    /**
     * The way a message would be typed into a terminal now.
     * @returns {{ way: 'direct' | 'attached' } | { problem: string }}
     */
    way(sessionId, terminalId) {
        const choice = this.method?.() ?? 'auto';
        if (choice !== 'attached' && this.directOk(sessionId, terminalId)) return { way: 'direct' };
        if (choice !== 'direct' && this.attachedOk()) return { way: 'attached' };
        if (choice === 'direct') return { problem: 'This DSH does not let Agent Terminals type straight into a terminal. Set "How messages are typed in" (typing) to auto in its profile settings.' };
        if (choice === 'attached') return { problem: 'This DSH has no terminal input for plugins. Set "How messages are typed in" (typing) to auto in its profile settings.' };
        return { problem: 'This DSH gives plugins no way to type into a terminal. Type the message into the agent\'s terminal tab yourself.' };
    }

    /** Whether the program in the terminal asked for bracketed paste, or undefined when it cannot be read. */
    pasteMode(sessionId, terminalId) {
        const mode = this.inner(sessionId, terminalId)?.screen?.modes?.bracketedPasteMode;
        if (typeof mode === 'boolean') return mode;
        return this.links.get(keyOf(sessionId, terminalId))?.paste;
    }

    /** The terminal's visible lines, top to bottom, when they can be read (direct only). */
    screenLines(sessionId, terminalId) {
        try {
            const screen = this.inner(sessionId, terminalId)?.screen;
            const buffer = screen?.buffer?.active;
            if (!buffer || !Number.isInteger(screen.rows) || typeof buffer.getLine !== 'function') return undefined;
            const top = Number.isInteger(buffer.baseY) ? buffer.baseY : 0;
            const lines = [];
            for (let y = top; y < top + screen.rows; y += 1) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
            return lines;
        } catch {
            return undefined;
        }
    }

    /**
     * Wait until the screen stops changing for `quietMs` (and has something
     * on it), or `maxMs` passes. Without a readable screen: `fallbackMs`.
     * @returns {Promise<boolean>} whether it went quiet.
     */
    async settle(sessionId, terminalId, { quietMs = 600, maxMs = 8000, fallbackMs = 1500, stillWanted = () => true } = {}) {
        if (!this.screenLines(sessionId, terminalId)) {
            await this.wait(fallbackMs);
            return false;
        }
        const started = Date.now();
        let last = '';
        let since = Date.now();
        while (Date.now() - started < maxMs && stillWanted()) {
            const now = (this.screenLines(sessionId, terminalId) ?? []).join('\n');
            if (now !== last) {
                last = now;
                since = Date.now();
            } else if (now.trim() !== '' && Date.now() - since >= quietMs) {
                return true;
            }
            await this.wait(100);
        }
        return false;
    }

    /**
     * Send raw input.
     * @param {object} agent - the session's agent (its id is the session's).
     * @param {string} terminalId
     * @param {string} data
     * @returns {Promise<'direct' | 'attached'>} the way it went.
     */
    async write(agent, terminalId, data) {
        const chosen = this.way(agent.id, terminalId);
        if ('problem' in chosen) throw new Error(chosen.problem);
        if (chosen.way === 'direct') {
            const terminal = this.inner(agent.id, terminalId);
            for (let at = 0; at < data.length; at += CHUNK) {
                await terminal.handle.write(data.slice(at, at + CHUNK));
            }
            return 'direct';
        }
        await this.writeAttached(agent, terminalId, data);
        return 'attached';
    }

    /**
     * Type a message (pasted when the program asked for it), then Enter
     * after a short pause, so a program that reads a paste in pieces does
     * not take the Enter as part of it.
     * @returns {Promise<{ way: string, paste: boolean, flattened: boolean }>}
     */
    async type(agent, terminalId, text, { enterAfterMs = 200 } = {}) {
        if (Buffer.byteLength(String(text ?? ''), 'utf8') > MAX_MESSAGE) throw new Error(`The message is longer than ${MAX_MESSAGE / 1024} KB: shorten it, or put it in a file and send the file's path.`);
        const chosen = this.way(agent.id, terminalId);
        if ('problem' in chosen) throw new Error(chosen.problem);
        // The attached way learns whether to paste from the screen it gets when it attaches: attach first.
        if (chosen.way === 'attached') await this.link(agent, terminalId);
        const keys = messageKeys(text, this.pasteMode(agent.id, terminalId));
        const way = await this.write(agent, terminalId, keys.data);
        await this.wait(enterAfterMs);
        await this.write(agent, terminalId, '\r');
        return { way, paste: keys.paste, flattened: keys.flattened };
    }

    /** Press Enter once more (a program that swallowed the first). */
    async enter(agent, terminalId) {
        return this.write(agent, terminalId, '\r');
    }

    // ── The attached way ───────────────────────────────────────────────

    async writeAttached(agent, terminalId, data) {
        const controller = this.controller();
        let link = await this.link(agent, terminalId);
        try {
            await controller.write(agent, terminalId, link.attachmentId, data);
        } catch (error) {
            // The window took control back while a message was going in: take it again, once.
            if (!/control|read-only/i.test(`${error?.code ?? ''} ${errorText(error)}`)) throw error;
            link = await this.link(agent, terminalId, { fresh: true });
            await controller.write(agent, terminalId, link.attachmentId, data);
        }
    }

    /** An attachment that holds the terminal's input, opened when needed. */
    async link(agent, terminalId, { fresh = false } = {}) {
        const key = keyOf(agent.id, terminalId);
        const held = this.links.get(key);
        if (held && !held.closed && !held.lost && !fresh) return held;
        if (held) this.drop(key);
        const controller = this.controller();
        const abort = new AbortController();
        const link = { attachmentId: `agent-terminals-${randomUUID().slice(0, 12)}`, abort, paste: undefined, lost: false, closed: false };
        const stream = controller.follow(agent, terminalId, link.attachmentId, abort.signal);
        const iterator = stream[Symbol.asyncIterator]();
        // The first frame is the screen; getting it takes the input control.
        const first = await iterator.next();
        if (first.done) throw new Error('The terminal ended before the message could be typed in.');
        learn(link, first.value);
        this.links.set(key, link);
        this.taken.set(key, Date.now());
        void (async () => {
            try {
                for (;;) {
                    const next = await iterator.next();
                    if (next.done) break;
                    learn(link, next.value);
                }
            } catch {
                // Ended or cancelled: the next message attaches again.
            } finally {
                link.closed = true;
            }
        })();
        return link;
    }

    /** Let go of a terminal's input, so the window can take it back. */
    release(sessionId, terminalId) {
        this.drop(keyOf(sessionId, terminalId));
    }

    drop(key) {
        const link = this.links.get(key);
        if (!link) return;
        this.links.delete(key);
        link.closed = true;
        try {
            link.abort.abort(new Error('Agent Terminals let go of the terminal'));
        } catch {}
    }

    /** When the attached way last took a terminal's input control (0 when never). */
    takenAt(sessionId, terminalId) {
        return this.taken.get(keyOf(sessionId, terminalId)) ?? 0;
    }

    close() {
        for (const key of [...this.links.keys()]) this.drop(key);
    }
}

function learn(link, frame) {
    if (frame?.type === 'snapshot') {
        const mode = pasteSwitch(frame.screen);
        if (mode !== undefined) link.paste = mode;
    } else if (frame?.type === 'output') {
        const mode = pasteSwitch(frame.data);
        if (mode !== undefined) link.paste = mode;
    } else if (frame?.type === 'state') {
        // Another attachment holds the input now (0.2.0 names it; 0.2.1 says whether this one may write).
        if ((frame.info?.controllerId !== undefined && frame.info.controllerId !== link.attachmentId) || frame.writable === false) link.lost = true;
    }
}

const keyOf = (sessionId, terminalId) => `${sessionId}\u0000${terminalId}`;
