/**
 * Plugin-local trace sink. The host log only captured boot-time lines, so the
 * runtime message path was invisible during bring-up. This appends one JSON
 * line per event to a mode-600 file, truncated on plugin start. Enabled by
 * config.traceFile; set it to '' to disable.
 *
 * @module dsh-plugin-discord/trace
 */
import { appendFileSync, chmodSync, closeSync, openSync } from 'node:fs';
import { homedir } from 'node:os';

/** @type {string|null} resolved trace path, or null when disabled */
let tracePath = null;

/**
 * Enable tracing to a file. Called once from apply().
 * @param {string|undefined} file - target path; '' or undefined disables.
 */
export function initTrace(file) {
    tracePath = null;
    if (typeof file !== 'string' || file.trim() === '') return;
    const path = file.startsWith('~') ? `${homedir()}${file.slice(1)}` : file;
    try {
        // 'a' creates the file when missing; truncateSync alone would ENOENT.
        const fd = openSync(path, 'a');
        closeSync(fd);
        chmodSync(path, 0o600);
        tracePath = path;
        write('trace', 'enabled', { path });
    } catch {
        tracePath = null; // tracing must never break the plugin
    }
}

/**
 * Append one trace event. Never throws.
 * @param {string} event - short event name.
 * @param {string} status - ok|fail|drop|info.
 * @param {object} [data] - bounded JSON payload (no token material).
 */
export function write(event, status, data) {
    if (tracePath === null) return;
    try {
        const line = `${JSON.stringify({ t: new Date().toISOString(), event, status, ...data })}\n`;
        appendFileSync(tracePath, line);
    } catch {
        // Swallow: tracing is best-effort by contract.
    }
}
