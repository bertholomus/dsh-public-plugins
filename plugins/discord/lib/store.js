/**
 * Durable thread → session store. One JSON file, atomic writes, so sessions
 * survive restarts. Shape:
 *
 * { version: 1, threads: { [threadId]: { sessionId, title, tempName, renamed,
 *   parentChannelId, anchorMessageId, anchorText, createdAt } } }
 *
 * @module dsh-plugin-discord/store
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

/** Resolve a '~'-prefixed path. */
function expand(p) {
    return p.startsWith('~') ? `${homedir()}${p.slice(1)}` : p;
}

export class SessionStore {
    /** @param {string} file - store path. */
    constructor(file) {
        this.file = expand(file);
        /** @type {Record<string, object>} */
        this.threads = {};
        this.load();
    }

    load() {
        try {
            const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
            if (parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.threads && typeof parsed.threads === 'object') {
                this.threads = parsed.threads;
            }
        } catch {
            this.threads = {}; // missing or corrupt store: start clean, never crash
        }
    }

    /** Persist atomically; the store must survive crashes mid-write. */
    save() {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            writeFileSync(tmp, `${JSON.stringify({ version: 1, threads: this.threads }, null, 2)}\n`, { mode: 0o600 });
            chmodSync(tmp, 0o600);
            renameSync(tmp, this.file);
        } catch {
            // Persistence is best-effort for availability; next mutation retries.
        }
    }

    /** @param {string} threadId */
    get(threadId) {
        return this.threads[threadId] ?? null;
    }

    /**
     * @param {string} threadId
     * @param {object} entry
     */
    put(threadId, entry) {
        this.threads[threadId] = { ...this.threads[threadId], ...entry };
        this.save();
    }

    /** @param {string} threadId */
    delete(threadId) {
        if (threadId in this.threads) {
            delete this.threads[threadId];
            this.save();
        }
    }

    /** All known titles (for uniqueness), excluding one thread's own. */
    titlesExcluding(threadId) {
        return Object.entries(this.threads)
            .filter(([id]) => id !== threadId)
            .map(([, entry]) => entry.title)
            .filter((t) => typeof t === 'string' && t.length > 0);
    }
}
