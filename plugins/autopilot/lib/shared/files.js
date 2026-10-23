/**
 * Files for the suite's host halves: private folders and a small JSON
 * store with atomic writes. A plugin's folder in DSH's data folder comes
 * from DSH itself (`dshHomePath` from @deepseek-ai/dsh-home-paths), so
 * DSH_HOME and DSH Test move it with everything else.
 *
 * Shared by the suite's plugins. The source lives in `shared/host/`, and
 * `scripts/sync-shared.mjs` copies it into each plugin's `lib/shared/`, so
 * every package stands on its own; `npm test` fails when a copy drifts.
 *
 * @module suite/shared/files
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Create a folder (and missing parents) as mode 700, one level at a time,
 * so a narrowed umask in the shared process cannot leave a parent that
 * nothing can enter. An existing folder keeps its mode unless its owner
 * cannot use it.
 * @param {string} dir
 */
export function ensurePrivateDir(dir) {
    const missing = [];
    for (let d = dir; !existsSync(d); d = dirname(d)) {
        missing.unshift(d);
        if (dirname(d) === d) break;
    }
    if (missing.length === 0) {
        const st = statSync(dir);
        if ((st.mode & 0o700) !== 0o700 && st.uid === process.getuid?.()) chmodSync(dir, (st.mode & 0o777) | 0o700);
        return;
    }
    for (const d of missing) {
        try { mkdirSync(d, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
        chmodSync(d, 0o700);
    }
}

/**
 * Write a file whole or not at all: a temporary file beside it, mode 600,
 * renamed over the old one.
 * @param {string} file
 * @param {string} text
 */
export function writeAtomic(file, text) {
    ensurePrivateDir(dirname(file));
    const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
}

/** Read and parse a JSON file; `undefined` when it is missing or unreadable. */
export function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}

/**
 * One JSON document a plugin keeps across restarts. Reads never throw (a
 * missing or broken file gives the fallback), and writes are atomic and
 * coalesced: `change` marks it dirty and one write follows shortly after.
 * A write that fails is logged and tried again on the next change.
 */
export class JsonStore {
    /**
     * @param {string} file - where the document lives.
     * @param {object} options
     * @param {(value: unknown) => object} options.parse - makes a stored value safe; gets `undefined` when there is none.
     * @param {{ warn: Function }} [options.logger]
     * @param {number} [options.delayMs] - how long changes gather before one write.
     */
    constructor(file, { parse, logger, delayMs = 200 }) {
        this.file = file;
        this.parse = parse;
        this.logger = logger;
        this.delayMs = delayMs;
        this.timer = undefined;
        this.data = parse(readJson(file));
    }

    /** Mark the document changed; it is written shortly after. */
    change() {
        if (this.timer !== undefined) return;
        this.timer = setTimeout(() => this.flush(), this.delayMs);
        this.timer.unref?.();
    }

    /** Write now, if anything changed. Never throws. */
    flush() {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        try {
            writeAtomic(this.file, `${JSON.stringify(this.data, null, 1)}\n`);
            return true;
        } catch (error) {
            this.logger?.warn?.(`could not save ${this.file}: ${error?.message ?? error}`);
            return false;
        }
    }

    /** Write what is pending and stop. */
    close() {
        if (this.timer !== undefined) this.flush();
    }
}
