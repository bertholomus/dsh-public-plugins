/**
 * The plugin's own event trace: one JSON line per event in an owner-only
 * file, for "what did the bot do, and why". At each start the previous run's
 * trace moves to `<file>.1` (one run kept), and a run's file stops growing at
 * 20 MB, so it never fills the disk. Message text appears only as the first
 * 80 characters; the token never appears. Every line the plugin logs is in
 * it too, as a `log` event. Set traceFile to '' to switch it off.
 *
 * @module dsh-plugin-discord/trace
 */
import { appendFileSync, chmodSync, closeSync, existsSync, openSync, renameSync, statSync } from 'node:fs';
import { format } from 'node:util';
import { resolvePath } from './paths.js';

/** A run's trace stops at this size. */
const MAX_BYTES = 20 * 1024 * 1024;

/** @type {string|null} resolved trace path, or null when off */
let tracePath = null;
let written = 0;
let full = false;

/**
 * Start a run's trace. Called once from apply().
 * @param {string|undefined} file - target path; '' or undefined switches tracing off.
 * @returns {string|null} the resolved path, or null when off or not writable.
 */
export function initTrace(file) {
    tracePath = null;
    written = 0;
    full = false;
    if (typeof file !== 'string' || file.trim() === '') return null;
    const path = resolvePath(file.trim());
    try {
        if (existsSync(path) && statSync(path).size > 0) renameSync(path, `${path}.1`);
        const fd = openSync(path, 'a', 0o600);
        closeSync(fd);
        chmodSync(path, 0o600);
        tracePath = path;
        write('trace', 'enabled', { path });
        return path;
    } catch {
        tracePath = null; // tracing must never break the plugin
        return null;
    }
}

/** Stop tracing (plugin unload). */
export function stopTrace() {
    tracePath = null;
}

/**
 * Append one trace event. Never throws.
 * @param {string} event - short event name.
 * @param {string} status - what happened.
 * @param {object} [data] - bounded JSON payload (no token material).
 */
export function write(event, status, data) {
    if (tracePath === null || full) return;
    try {
        let line = `${JSON.stringify({ t: new Date().toISOString(), event, status, ...data })}\n`;
        if (written + line.length > MAX_BYTES) {
            full = true;
            line = `${JSON.stringify({ t: new Date().toISOString(), event: 'trace', status: 'full', maxBytes: MAX_BYTES })}\n`;
        }
        appendFileSync(tracePath, line);
        written += line.length;
    } catch {
        // Swallow: tracing is best-effort by contract.
    }
}

/**
 * The plugin's logger: each line goes to DSH's logger and, as a `log` event
 * (`status` the level, `text` the line), to this trace. DSH keeps plugin log
 * lines in memory, so the trace file is where a person reads them back. A
 * logger that throws never breaks the caller.
 * @param {{ info?: Function, warn?: Function }} logger - DSH's logger (ctx.logger).
 * @param {(event: string, status: string, data: object) => void} [sink] - where the copy goes (the trace).
 * @returns {{ info: Function, warn: Function }}
 */
export function teeLogger(logger, sink = write) {
    const line = (level) => (...args) => {
        try {
            logger?.[level]?.(...args);
        } catch {
            // DSH's logger failing must not stop the plugin; the trace still has the line.
        }
        sink('log', level, { text: format(...args) });
    };
    return { info: line('info'), warn: line('warn') };
}
