/**
 * Durable thread → session store. One JSON file (owner-only), written
 * atomically, so sessions survive restarts and crashes. Shape (version 1):
 *
 *   { version: 1,
 *     threads:  { [threadId]: { sessionId, title, tempName, renamed, parentChannelId,
 *                               anchorMessageId, anchorText, turnCount, createdAt, generation?,
 *                               modelOverride?, effortOverride?, lastMessageId?, lastActiveAt?,
 *                               pendingMessageId?, pendingText? } },
 *     channels: { [parentChannelId]: { lastMessageId } },
 *     seen:     [messageId, ...],      // the newest message ids already handled, for "never twice"
 *     pending:  { [messageId]: { channelId, threadId, text } },   // taken, not yet handed to an agent
 *     cleared:  { [threadId]: { parentChannelId, lastMessageId, generation } } }  // after /new
 *
 * Files written by older builds have only `threads`; they load as they are, and `legacy` says so
 * (an older build answered messages without remembering their ids).
 *
 * @module dsh-plugin-discord/store
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePath } from './paths.js';

/** How many handled message ids are remembered. */
const SEEN_MAX = 1000;

/** Compare two snowflakes as numbers (they are too long for Number). */
export function newerId(a, b) {
    if (!a) return false;
    if (!b) return true;
    try {
        return BigInt(a) > BigInt(b);
    } catch {
        return false;
    }
}

export class SessionStore {
    /**
     * @param {string} file - store path (`~/.dsh/...` resolves against DSH's data folder).
     * @param {{ onError?: (what: string, error: unknown) => void }} [options]
     */
    constructor(file, { onError } = {}) {
        this.file = resolvePath(file);
        this.onError = onError ?? (() => {});
        /** @type {Record<string, object>} */
        this.threads = {};
        /** @type {Record<string, {lastMessageId?: string}>} */
        this.channels = {};
        /** @type {string[]} */
        this.seen = [];
        this.seenSet = new Set();
        /** @type {Record<string, {channelId: string, threadId: string|null, text: string}>} messages taken but not yet handed to an agent */
        this.pending = {};
        /** @type {Record<string, {parentChannelId: string|null, lastMessageId?: string, generation: number}>} threads cleared with /new */
        this.cleared = {};
        /** true when an older build wrote the file last: it kept threads but no handled ids. */
        this.legacy = false;
        /** 'empty' (no file yet), 'ok', or 'damaged' (kept aside as <file>.damaged-<time>). */
        this.loaded = 'empty';
        this.load();
    }

    load() {
        let text;
        try {
            text = readFileSync(this.file, 'utf8');
        } catch (error) {
            if (error?.code !== 'ENOENT') this.onError('read', error);
            return;
        }
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.threads && typeof parsed.threads === 'object') {
                this.threads = parsed.threads;
                if (parsed.channels && typeof parsed.channels === 'object') this.channels = parsed.channels;
                if (Array.isArray(parsed.seen)) this.seen = parsed.seen.filter((id) => typeof id === 'string').slice(-SEEN_MAX);
                this.seenSet = new Set(this.seen);
                const map = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
                this.pending = map(parsed.pending);
                this.cleared = map(parsed.cleared);
                // An older build writes only `threads`: it answered messages without keeping their ids.
                this.legacy = !Array.isArray(parsed.seen) && Object.keys(this.threads).length > 0;
                this.loaded = 'ok';
                return;
            }
            throw new Error('not a version 1 store');
        } catch (error) {
            // A damaged file is kept aside, never overwritten blind: the next save starts clean.
            this.loaded = 'damaged';
            this.onError('parse', error);
            try {
                renameSync(this.file, `${this.file}.damaged-${Date.now()}`);
            } catch {}
        }
    }

    /** Persist atomically; returns false (and reports) when the disk refused. */
    save() {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            writeFileSync(tmp, `${JSON.stringify({ version: 1, threads: this.threads, channels: this.channels, seen: this.seen, pending: this.pending, cleared: this.cleared }, null, 2)}\n`, { mode: 0o600 });
            chmodSync(tmp, 0o600);
            renameSync(tmp, this.file);
            return true;
        } catch (error) {
            this.onError('write', error);
            return false;
        }
    }

    /** @param {string} threadId */
    get(threadId) {
        return this.threads[threadId] ?? null;
    }

    /**
     * @param {string} threadId
     * @param {object} entry - fields to merge.
     */
    put(threadId, entry) {
        this.threads[threadId] = { ...this.threads[threadId], ...entry };
        return this.save();
    }

    /** @param {string} threadId */
    delete(threadId) {
        if (threadId in this.threads) {
            delete this.threads[threadId];
            this.save();
        }
    }

    /** The thread whose session has this id, or null. */
    threadOfSession(sessionId) {
        for (const [threadId, entry] of Object.entries(this.threads)) {
            if (entry?.sessionId === sessionId) return threadId;
        }
        return null;
    }

    /** All known titles (for uniqueness), excluding one thread's own. */
    titlesExcluding(threadId) {
        return Object.entries(this.threads)
            .filter(([id]) => id !== threadId)
            .map(([, entry]) => entry.title)
            .filter((t) => typeof t === 'string' && t.length > 0);
    }

    /** Whether a Discord message was handled already. */
    hasSeen(messageId) {
        return this.seenSet.has(messageId);
    }

    /**
     * Remember a handled message (and the newest one per channel, for catch-up). Saved at once,
     * before the message reaches an agent, so a crash right after can never hand it over twice.
     * With `pending` (its first words), the message is also marked as taken but not yet handed to
     * an agent, in the same write: a quit before the hand-over is then said after the restart.
     * @param {string} messageId
     * @param {{ channelId: string, threadId?: string|null, pending?: string }} where - where it was posted.
     */
    markSeen(messageId, { channelId, threadId = null, pending }) {
        if (typeof pending === 'string') this.pending[messageId] = { channelId, threadId: threadId ?? null, text: pending };
        if (!this.seenSet.has(messageId)) {
            this.seen.push(messageId);
            this.seenSet.add(messageId);
            while (this.seen.length > SEEN_MAX) this.seenSet.delete(this.seen.shift());
        }
        if (threadId && this.threads[threadId]) {
            const entry = this.threads[threadId];
            if (newerId(messageId, entry.lastMessageId)) entry.lastMessageId = messageId;
            entry.lastActiveAt = new Date().toISOString();
        } else if (channelId && this.cleared[channelId]) {
            const entry = this.cleared[channelId]; // a thread cleared with /new, until its next session
            if (newerId(messageId, entry.lastMessageId)) entry.lastMessageId = messageId;
        } else if (channelId) {
            const entry = this.channels[channelId] ?? (this.channels[channelId] = {});
            if (newerId(messageId, entry.lastMessageId)) entry.lastMessageId = messageId;
        }
        return this.save();
    }

    /**
     * Catch-up has read a place (thread or channel) up to `messageId`: the next catch-up starts after it, so
     * messages it passed over (other people's, the bot's own) are not read again. Saved when it moves.
     */
    advance(channelId, messageId) {
        const entry = this.threads[channelId] ?? this.cleared[channelId] ?? this.channels[channelId];
        if (!entry || !newerId(messageId, entry.lastMessageId)) return true;
        entry.lastMessageId = messageId;
        return this.save();
    }

    /** Where catch-up starts in an allowed channel the bot has no message from yet (a snowflake for a moment). Saved. */
    startChannel(channelId, messageId) {
        if (this.channels[channelId]?.lastMessageId) return true;
        this.channels[channelId] = { ...(this.channels[channelId] ?? {}), lastMessageId: messageId };
        return this.save();
    }

    /** A taken message's thread is known now (it was made after the message was taken). Saved, so a quit is said there. */
    pendingIn(messageId, threadId) {
        if (!this.pending[messageId]) return true;
        this.pending[messageId].threadId = threadId;
        return this.save();
    }

    /** A taken message reached its agent (or was answered otherwise): it is no longer pending. Saved. */
    handedOver(messageId) {
        if (!(messageId in this.pending)) return true;
        delete this.pending[messageId];
        return this.save();
    }

    /**
     * Clear a thread's session (/new): the thread is forgotten, but its newest handled message and how many
     * sessions it had stay in `cleared`, so catch-up still reads it and the next session is numbered.
     * @returns {number} the number the thread's next session gets.
     */
    clear(threadId) {
        const entry = this.threads[threadId];
        if (!entry) return (this.cleared[threadId]?.generation ?? 1) + 1;
        const generation = (entry.generation ?? 1) + 1;
        const lastMessageId = newerId(this.cleared[threadId]?.lastMessageId, entry.lastMessageId) ? this.cleared[threadId].lastMessageId : entry.lastMessageId;
        this.cleared[threadId] = { parentChannelId: entry.parentChannelId ?? null, ...(lastMessageId ? { lastMessageId } : {}), generation };
        delete this.threads[threadId];
        this.save();
        return generation;
    }
}
