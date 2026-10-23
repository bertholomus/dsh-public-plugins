/**
 * The suite's event log: every action a plugin takes or decides not to
 * take, with the reason in plain words, kept on disk as JSON lines and in
 * memory for the window.
 *
 * Each line is either a new entry (`{ add: entry }`) or a later change to
 * one (`{ set: id, patch }`), so an entry can say "queued" first and
 * "delivered" once that is proven. On start the log reads its own tail
 * back; past `maxBytes` it rewrites itself from what memory holds.
 *
 * @module suite/shared/journal
 */
import { appendFileSync, chmodSync, closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensurePrivateDir, writeAtomic } from './files.js';
import { errorText, isRecord } from './safe.js';

/** Read at most the last `bytes` of a file as text, from a line start. */
function readTail(file, bytes) {
    let fd;
    try {
        fd = openSync(file, 'r');
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - bytes);
        const buffer = Buffer.alloc(size - start);
        readSync(fd, buffer, 0, buffer.length, start);
        const text = buffer.toString('utf8');
        return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
    } catch {
        return '';
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

export class Journal {
    /**
     * @param {string} file - the JSON-lines file.
     * @param {object} [options]
     * @param {number} [options.keep] - entries held in memory (and kept on a rewrite).
     * @param {number} [options.maxBytes] - past this the file is rewritten from memory.
     * @param {{ warn: Function }} [options.logger]
     * @param {() => void} [options.onChange] - called after every add or change.
     * @param {() => number} [options.now]
     */
    constructor(file, { keep = 400, maxBytes = 1_000_000, logger, onChange, now = Date.now } = {}) {
        this.file = file;
        this.keep = keep;
        this.maxBytes = maxBytes;
        this.logger = logger;
        this.onChange = onChange;
        this.now = now;
        /** Newest last. */
        this.entries = [];
        this.byId = new Map();
        this.seq = 0;
        this.load();
    }

    load() {
        for (const line of readTail(this.file, this.maxBytes).split('\n')) {
            if (line.trim() === '') continue;
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            if (isRecord(row?.add) && typeof row.add.id === 'string') this.remember(row.add);
            else if (typeof row?.set === 'string' && isRecord(row.patch)) {
                const entry = this.byId.get(row.set);
                if (entry) Object.assign(entry, row.patch);
            }
        }
    }

    remember(entry) {
        if (this.byId.has(entry.id)) return;
        this.entries.push(entry);
        this.byId.set(entry.id, entry);
        while (this.entries.length > this.keep) this.byId.delete(this.entries.shift().id);
    }

    write(row) {
        try {
            ensurePrivateDir(dirname(this.file));
            appendFileSync(this.file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
            let size = 0;
            try { size = statSync(this.file).size; } catch { size = 0; }
            if (size > this.maxBytes) {
                writeAtomic(this.file, this.entries.map((entry) => JSON.stringify({ add: entry })).join('\n') + '\n');
            } else if (this.seq === 1) {
                chmodSync(this.file, 0o600);
            }
        } catch (error) {
            this.logger?.warn?.(`could not write the event log ${this.file}: ${errorText(error)}`);
        }
    }

    /**
     * Add an entry. `id` and `at` are filled in.
     * @param {object} fields - what happened: `kind`, `text`, `why`, and whatever else the plugin keeps.
     * @returns {object} the stored entry.
     */
    add(fields) {
        this.seq += 1;
        const at = this.now();
        const entry = { ...fields, id: `${at.toString(36)}-${this.seq.toString(36)}`, at };
        this.remember(entry);
        this.write({ add: entry });
        this.changed();
        return entry;
    }

    /**
     * Change an entry already logged (its outcome, once known).
     * @param {string} id
     * @param {object} patch
     */
    set(id, patch) {
        const entry = this.byId.get(id);
        if (!entry) return undefined;
        Object.assign(entry, patch);
        this.write({ set: id, patch });
        this.changed();
        return entry;
    }

    get(id) {
        return this.byId.get(id);
    }

    /** Entries, newest first, optionally for one session. */
    list({ sessionId, limit = 200 } = {}) {
        const out = [];
        for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i -= 1) {
            const entry = this.entries[i];
            if (sessionId === undefined || entry.sessionId === sessionId) out.push(entry);
        }
        return out;
    }

    changed() {
        try { this.onChange?.(); } catch { /* a listener never stops the log */ }
    }
}
