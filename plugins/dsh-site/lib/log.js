/**
 * dsh-site's own log: one line per event, owner-only (mode 600), kept under
 * a size cap (the file moves to `<name>.1` when it passes `maxBytes`, so the
 * log never holds more than about twice that). Refusals from one address are
 * written once and then at most once a minute with a count, so a port scan
 * cannot flood it. Never a cookie, never a request body.
 *
 * @module dsh-plugin-dsh-site/log
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @param {string} file - the log file, or '' for none.
 * @param {{ maxBytes?: number, now?: () => number }} [options]
 *   maxBytes: the size at which the file moves to `<name>.1`; now: the clock (for tests).
 */
export function createLog(file, { maxBytes = 2 * 1024 * 1024, now = Date.now } = {}) {
    let ready = false;
    let size = -1;
    const quiet = new Map(); // key -> { at, skipped }

    const write = (line) => {
        if (!file) return;
        try {
            if (!ready) {
                mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
                ready = true;
            }
            if (size < 0) {
                try {
                    size = statSync(file).size;
                } catch {
                    size = 0;
                }
            }
            const text = `${new Date(now()).toISOString()} ${line}\n`;
            if (size + text.length > maxBytes) {
                try {
                    renameSync(file, `${file}.1`);
                } catch {}
                size = 0;
            }
            appendFileSync(file, text, { mode: 0o600 });
            size += Buffer.byteLength(text);
        } catch {
            // A log that cannot be written never stops the edge.
        }
    };

    /** A line for an event that can repeat fast (a refusal): once, then once a minute per key, with a count. */
    const often = (key, line) => {
        const at = now();
        const seen = quiet.get(key);
        if (seen && at - seen.at < 60000) {
            seen.skipped += 1;
            return false;
        }
        const more = seen?.skipped ? ` (and ${seen.skipped} more like it in the last minute)` : '';
        quiet.set(key, { at, skipped: 0 });
        if (quiet.size > 2000) quiet.delete(quiet.keys().next().value);
        write(`${line}${more}`);
        return true;
    };

    return { write, often, file };
}
