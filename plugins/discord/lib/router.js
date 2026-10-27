/**
 * Thread routing: the heart of the bot. Every inbound message is gated,
 * deduplicated, classified (parent channel or thread) and mapped to one
 * agent session per thread. A top-level message in an allowed parent channel
 * gets a public thread anchored to it; all work happens in threads. Sessions
 * are keyed by thread id and persisted, so they survive restarts; one thread's
 * messages are handled in order (a busy thread queues turns), and different
 * threads run at once.
 *
 * The person in Discord is never left in silence: a turn that ends without a
 * Discord reply is reminded once to send one, then its last words are posted;
 * a turn that fails says so in the thread.
 *
 * DSH packages come in through `host` (brandString, createUserMessage), so
 * this module also runs in plain unit tests.
 *
 * @module dsh-plugin-discord/router
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionStore, newerId } from './store.js';
import { cleanTitle, deriveFallbackTitle, uniquifyTitle, capTitle, TITLE_MAX } from './titles.js';
import { generateTitle } from './llm.js';
import { write as defaultTrace } from './trace.js';

/** Channel types that are threads (public, private, announcement). */
const THREAD_TYPES = new Set([10, 11, 12]);
/** Channel types a bot thread can hang off (text, announcement). */
const PARENT_TYPES = new Set([0, 5]);
/** Message types that are a person's words: default (0) and reply (19). Discord's system lines ("started a thread", joins, pins) are not. */
const RELAYED_TYPES = new Set([0, 19]);
/** Catch-up reads a channel 100 messages at a time, at most this many pages (then says the rest was not read). */
const CATCH_UP_PAGES = 20;
/** Discord's epoch (2015-01-01), for a message id that stands for a moment. */
const DISCORD_EPOCH = 1420070400000n;
/** A catch-up read that failed on a passing fault (Discord down, no network) is tried again this often, this long apart. */
const CATCH_UP_RETRIES = 3;
const CATCH_UP_RETRY_MS = 60 * 1000;
/** The typing indicator gives up after this long (a turn this long still finishes). */
const TYPING_MAX_MS = 30 * 60 * 1000;
/** Bound for a notice summary in DSH's chat. */
const SUMMARY_MAX = 120;
/** An approval still open after this long is said in the thread (one answered at once in DSH needs no line). */
export const APPROVAL_NOTICE_MS = 3000;

/** The tools that put the agent's words in Discord. */
export const SEND_TOOLS = Object.freeze(['discord_send', 'discord_send_file']);

/** First ~80 chars of the prompt, for the temporary thread name (trimmed, as Discord trims a channel name). */
function tempName(text) {
    const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
    return capTitle(oneLine.slice(0, 80).trim() || 'conversation', 100);
}

/** Two thread names are the same when they differ only in spacing (Discord trims and folds the names it stores). */
const sameName = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();

const short = (text, max) => {
    const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};

/** An approval request's reason for a person: DSH's English display text ({ en, zh, ... }), else its plain reason. */
export function reasonText(req) {
    const shown = req?.displayReason;
    if (typeof shown === 'string' && shown.trim()) return shown;
    if (shown && typeof shown === 'object') {
        const text = typeof shown.en === 'string' && shown.en.trim() ? shown.en : Object.values(shown).find((v) => typeof v === 'string' && v.trim());
        if (text) return text;
    }
    return typeof req?.reason === 'string' ? req.reason : '';
}

/**
 * An error in words, for a person: its message, without stack or paths. A message that ends in a JSON
 * error body (`400 {"error":{"message":"..."}}`, as model servers answer) gives that body's message instead.
 */
export function inWords(error) {
    const raw = error?.message ?? error?.failure?.message ?? (typeof error === 'string' ? error : '') ?? '';
    const text = String(bodyMessage(String(raw || '')) || error?.kind || 'an unknown error').replace(/\s+/g, ' ').replace(/(?:\/[\w.@-]+){2,}/g, '(path)').trim();
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** A message whose tail is a JSON error body, with the body's own message in place of the JSON; any other message as it is. */
function bodyMessage(text) {
    const start = text.indexOf('{');
    if (start < 0) return text;
    let body;
    try {
        body = JSON.parse(text.slice(start));
    } catch {
        return text;
    }
    const said = [body?.error?.message, body?.message, body?.error, body?.detail].find((v) => typeof v === 'string' && v.trim());
    if (!said) return text;
    const before = text.slice(0, start).replace(/[\s:,-]+$/, '');
    return before ? `${before}: ${said}` : said;
}

/**
 * An error for a person in Discord: inWords, without the request it was (method and path) or a bare HTTP status.
 * "Discord refused POST (path): 403 Missing Permissions" says "Discord said: Missing Permissions".
 */
export function forPeople(error) {
    const said = { 400: 'it could not take the request', 401: 'the bot token was refused', 403: 'the bot lacks a permission there', 404: 'it does not know that channel or message', 429: 'it asked the bot to slow down' };
    let text = inWords(error);
    const refused = /^Discord refused (?:GET|POST|PUT|PATCH|DELETE) \S+: (\d{3})\s*(.*)$/.exec(text);
    if (refused) text = `Discord said ${refused[2].trim() ? `“${refused[2].trim().replace(/\.$/, '')}”` : (said[refused[1]] ?? (Number(refused[1]) >= 500 ? 'it had a fault' : 'no'))}`;
    text = text.replace(/\b(?:GET|POST|PUT|PATCH|DELETE) \(path\)/g, 'a request').replace(/^\d{3}:\s+/, '');
    return text;
}

/** What a tool waiting for an approval would do, in plain words (never the tool's own name). */
export function toolAction(toolName) {
    const name = String(toolName ?? '').toLowerCase();
    if (/bash|shell|command|exec|terminal|run/.test(name)) return 'run a command';
    if (/edit|write|patch|replace|create|delete|move|rename|mkdir/.test(name)) return 'change files';
    if (/read|view|list|glob|grep|search|find/.test(name)) return 'read files';
    if (/fetch|browse|web|http|url/.test(name)) return 'open a web page';
    return 'use one of its tools';
}

/**
 * The standing reply instruction appended to every relayed turn.
 * @param {string} threadId
 */
export function replyInstruction(threadId) {
    return `Reply in Discord with the discord_send tool using channel_id "${threadId}". ` +
        'Everything you send with discord_send lands in this thread; plain text output never reaches the person. ' +
        'When you generate an artifact file, deliver it with discord_send_file.';
}

/** The one reminder a turn gets when it is about to end without a Discord reply. */
export function nudgeText(threadId) {
    return `Your reply has not reached Discord yet: the person there sees only what you send with discord_send. ` +
        `Send your answer now with discord_send, channel_id "${threadId}".`;
}

/** The text blocks of a message, joined, or ''. */
function messageText(message) {
    const content = message?.content;
    if (!Array.isArray(content)) return '';
    return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
}

/**
 * The agent's last words in the turn that is ending: the newest assistant text after the message the turn
 * began with, read from the session's history (`deriveMessages`; a message keeps its id there).
 * @param {{ deriveMessages?: () => readonly object[] }} session
 * @param {string | undefined} startId - the id of the first message the turn took up.
 * @returns {string} '' when the turn said nothing, or its first message is not in the history.
 */
export function turnReplyText(session, startId) {
    if (startId === undefined) return '';
    let messages = [];
    try {
        messages = session?.deriveMessages?.() ?? [];
    } catch {
        return '';
    }
    const start = messages.findIndex((m) => m?.id === startId);
    if (start < 0) return '';
    for (let i = messages.length - 1; i > start; i--) {
        if (messages[i]?.role !== 'assistant') continue;
        const text = messageText(messages[i]);
        if (text) return text;
    }
    return '';
}

/**
 * Owns gating, thread lifecycle, session lifecycle, typing, titles, slash
 * commands and the never-silent rules. One agent per thread.
 */
export class ThreadRouter {
    /**
     * @param {object} options
     * @param {object} options.ctx - runtime context owning created agents.
     * @param {object} options.config - checked settings (lib/config.js).
     * @param {object} options.logger - cordis-style logger.
     * @param {{ brandString: (s: string) => string, createUserMessage: (m: object) => object }} options.host - DSH helpers.
     * @param {SessionStore} [options.store] - the thread store (tests pass their own).
     * @param {(event: string, status: string, data?: object) => void} [options.trace]
     * @param {() => object} [options.botState] - the client's connection state, for /status.
     */
    constructor({ ctx, config, logger, host, store, trace, botState }) {
        this.ctx = ctx;
        this.config = config;
        this.logger = logger ?? { info() {}, warn() {}, debug() {} };
        this.host = host;
        this.trace = trace ?? defaultTrace;
        this.client = null;
        this.botState = botState ?? (() => null);
        this.tools = [];
        /** agent scope → what the router put on it (its listeners and the Discord tools), to take them off again. */
        this.hooks = new Map();
        this.store = store ?? new SessionStore(config.storeFile, {
            onError: (what, error) => {
                this.trace('store', `${what}-failed`, { error: inWords(error) });
                this.logger.warn('discord: could not %s the thread store (%s); threads keep working, but a restart may forget them', what, inWords(error));
            },
        });
        /** threadId → live agent state. */
        this.live = new Map();
        /** threadId → the tail of its serial work. */
        this.chains = new Map();
        /** threadId → typing interval handle. */
        this.typing = new Map();
        /** channelId → channel object cache. */
        this.channelCache = new Map();
        this.disposed = false;
        this.catchingUp = null;
        /** Threads whose last handed-over message was still being worked on when DSH stopped (a previous run's). */
        this.interrupted = Object.entries(this.store.threads ?? {})
            .filter(([, entry]) => entry?.pendingMessageId)
            .map(([threadId, entry]) => ({ threadId, messageId: entry.pendingMessageId, text: entry.pendingText ?? '' }));
        /** Messages a previous run took but never handed to an agent (it stopped in between). */
        this.untaken = Object.entries(this.store.pending ?? {}).map(([messageId, entry]) => ({ messageId, ...entry }));
        /** Catch-up tries again when Discord could not be read: how many tries so far, the wait, and the timer. */
        this.catchUpRetries = 0;
        this.catchUpRetryMs = CATCH_UP_RETRY_MS;
        this.catchUpTimer = null;
    }

    /** Attach the live client once the plugin has started it. */
    attachClient(client) {
        this.client = client;
    }

    /** One trace line per event with its thread id; message text never longer than 80 characters. */
    log(threadId, event, data = {}) {
        this.trace('router', event, { threadId, ...data });
    }

    /** Run `work` after everything already queued for `key` (one thread's work never interleaves). */
    serial(key, work) {
        const before = this.chains.get(key) ?? Promise.resolve();
        const next = before.then(work, work);
        const tail = next.then(() => {}, () => {});
        this.chains.set(key, tail);
        void tail.then(() => {
            if (this.chains.get(key) === tail) this.chains.delete(key);
        });
        return next;
    }

    /** Stop typing loops and detach every agent this router created; called on plugin unload. */
    async dispose() {
        this.disposed = true;
        // A session DSH keeps open (one the bot picked up rather than started) outlives the plugin: take the
        // Discord tools and the router's listeners out of its scope, so no session keeps them once the plugin
        // is unloaded or switched off.
        for (const agentCtx of [...this.hooks.keys()]) this.release(agentCtx);
        if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
        for (const timer of this.typing.values()) clearInterval(timer);
        this.typing.clear();
        await Promise.allSettled([...this.live.values()].map(async (live) => {
            if (live.owned) await live.handle.dispose();
        }));
        this.live.clear();
    }

    // ── inbound messages ────────────────────────────────────────────────────

    /**
     * Gate and route one MESSAGE_CREATE payload (from the gateway, or from catch-up). Never throws.
     * @param {object} d - Discord message object.
     * @param {{ catchUp?: boolean }} [options]
     * @returns {Promise<string>} what happened, in one word (for tests and the trace).
     */
    async handleMessage(d, { catchUp = false } = {}) {
        try {
            return await this.routeMessage(d, catchUp);
        } catch (error) {
            this.log(d?.channel_id ?? null, 'error', { where: 'message', error: inWords(error) });
            this.logger.warn('discord: a message could not be handled: %s', inWords(error));
            return 'error';
        }
    }

    /**
     * Whether a message is one the bot would answer, before any lookup: a person's own words (not a bot, not a
     * system line), from an allowed person, with text or files. null when it is; else why not, in one word.
     */
    unanswerable(d) {
        if (!d || typeof d !== 'object' || typeof d.id !== 'string') return 'ignored';
        const author = d.author;
        if (!author || author.bot) return 'ignored'; // bots, including this one
        const me = this.client?.botUser;
        if (me && author.id === me.id) return 'ignored';
        if (d.type !== undefined && d.type !== null && !RELAYED_TYPES.has(d.type)) return 'system';
        if (this.config.allowedUserIds.length > 0 && !this.config.allowedUserIds.includes(author.id)) return 'dropped';
        const content = typeof d.content === 'string' ? d.content.trim() : '';
        const attachments = Array.isArray(d.attachments) ? d.attachments : [];
        if (content.length === 0 && attachments.length === 0) return 'ignored';
        return null;
    }

    async routeMessage(d, catchUp) {
        const why = this.unanswerable(d);
        if (why === 'system') {
            this.log(d.channel_id, 'inbound', { result: 'drop', reason: `a Discord system message (type ${d.type}), not a person's words`, messageId: d.id });
            return 'ignored';
        }
        if (why === 'dropped') {
            this.log(d.channel_id, 'inbound', { result: 'drop', reason: 'user not allowlisted', authorId: d.author.id });
            return 'dropped';
        }
        if (why !== null) return why;
        const author = d.author;
        const content = typeof d.content === 'string' ? d.content.trim() : '';
        const attachments = Array.isArray(d.attachments) ? d.attachments : [];
        if (this.store.hasSeen(d.id)) {
            this.log(d.channel_id, 'inbound', { result: 'duplicate', messageId: d.id, catchUp });
            return 'duplicate';
        }

        const info = await this.channelInfo(d.channel_id);
        if (info === null) {
            this.log(d.channel_id, 'inbound', { result: 'drop', reason: 'channel lookup failed' });
            return 'dropped';
        }
        if (THREAD_TYPES.has(info.type)) return await this.handleThreadMessage(d, info, content, attachments, author, catchUp);
        if (PARENT_TYPES.has(info.type)) return await this.handleParentMessage(d, info, content, attachments, author, catchUp);
        this.log(d.channel_id, 'inbound', { result: 'drop', reason: `channel type ${info.type} is not handled (direct messages are not)` });
        return 'dropped';
    }

    /** Fetch (and cache) a channel object; null when Discord would not say. */
    async channelInfo(channelId) {
        if (this.channelCache.has(channelId)) return this.channelCache.get(channelId);
        if (!this.client) return null;
        try {
            const channel = await this.client.getChannel(channelId);
            if (channel?.id) {
                this.channelCache.set(channelId, channel);
                return channel;
            }
        } catch (error) {
            this.log(channelId, 'inbound', { result: 'drop', reason: `channel lookup: ${inWords(error)}` });
        }
        return null;
    }

    /**
     * A channel the bot works in: an allowed channel, or a thread under one (by the thread's own parent, or the
     * channel the store keeps for it). A thread whose channel left the allowlist is no longer the bot's.
     */
    inScope(channelId, parentId) {
        const allowed = this.config.allowedChannelIds;
        return allowed.includes(channelId) || (parentId ? allowed.includes(parentId) : false) || this.storedUnder(channelId, allowed);
    }

    /** A thread the store keeps (or cleared with /new) whose channel is one of `channels`. */
    storedUnder(threadId, channels) {
        const entry = this.store.get(threadId) ?? this.store.cleared?.[threadId] ?? null;
        const parent = entry?.parentChannelId;
        return typeof parent === 'string' && channels.includes(parent);
    }

    /** The first words of a message, for the store and the lines that name it. */
    static gist(content, attachments) {
        return short(content || attachments.map((a) => a.filename).join(', '), 60);
    }

    /** A message inside a thread: every message is a turn, no mention needed. */
    async handleThreadMessage(d, info, content, attachments, author, catchUp) {
        const threadId = d.channel_id;
        if (this.config.allowedChannelIds.length === 0 || !(this.config.allowedChannelIds.includes(info.id) || this.config.allowedChannelIds.includes(info.parent_id))) {
            this.log(threadId, 'inbound', { result: 'drop', reason: 'thread outside allowlist' });
            return 'dropped';
        }
        return await this.serial(threadId, async () => {
            if (this.store.hasSeen(d.id)) return 'duplicate';
            // Taken and pending in one write: a quit before it reaches the agent is said after the restart.
            this.store.markSeen(d.id, { channelId: threadId, threadId: this.store.get(threadId) ? threadId : null, pending: ThreadRouter.gist(content, attachments) });
            this.log(threadId, 'inbound', { result: 'accepted', messageId: d.id, catchUp });
            if (info.thread_metadata?.archived) {
                try {
                    await this.client.unarchiveThread(threadId, 'continuing agent session');
                    info.thread_metadata.archived = false;
                    this.log(threadId, 'unarchive', {});
                } catch (error) {
                    this.log(threadId, 'error', { where: 'unarchive', error: inWords(error) });
                }
            }
            await this.ensureTurn(threadId, d.id, content, attachments, author, info, { catchUp });
            return 'relayed';
        });
    }

    /**
     * A top-level message in a parent channel: gate, then auto-thread. Nothing
     * is posted in the parent except one line when the thread cannot be made.
     */
    async handleParentMessage(d, info, content, attachments, author, catchUp) {
        if (!this.config.allowedChannelIds.includes(d.channel_id)) {
            this.log(d.channel_id, 'inbound', { result: 'drop', reason: 'channel not allowlisted' });
            return 'dropped';
        }
        const me = this.client?.botUser;
        if (this.config.requireMention) {
            const mentioned = me ? content.includes(`<@${me.id}>`) || content.includes(`<@!${me.id}>`) : false;
            if (!mentioned) {
                this.log(d.channel_id, 'inbound', { result: 'drop', reason: 'mention required' });
                return 'dropped';
            }
        }
        if (catchUp && d.thread?.id) {
            // Already threaded before the restart: its thread is caught up on its own.
            this.store.markSeen(d.id, { channelId: d.channel_id });
            return 'duplicate';
        }
        let anchorText = content;
        if (me) anchorText = content.split(`<@${me.id}>`).join('').split(`<@!${me.id}>`).join('').trim();

        if (!this.config.autoThread) {
            // Threads off: the parent channel itself is the session key.
            return await this.serial(d.channel_id, async () => {
                if (this.store.hasSeen(d.id)) return 'duplicate';
                this.store.markSeen(d.id, { channelId: d.channel_id, threadId: this.store.get(d.channel_id) ? d.channel_id : null, pending: ThreadRouter.gist(anchorText, attachments) });
                await this.ensureTurn(d.channel_id, d.id, anchorText, attachments, author, info, { catchUp });
                return 'relayed';
            });
        }

        return await this.serial(`parent:${d.channel_id}`, async () => {
            if (this.store.hasSeen(d.id)) return 'duplicate';
            this.store.markSeen(d.id, { channelId: d.channel_id, pending: ThreadRouter.gist(anchorText, attachments) });
            let threadId = null;
            let lastError = null;
            for (let attempt = 1; attempt <= 2 && threadId === null; attempt++) {
                try {
                    const created = await this.client.createThread(d.channel_id, tempName(anchorText || attachments[0]?.filename), {
                        messageId: d.id,
                        autoArchiveMinutes: this.config.threadArchiveMinutes,
                    });
                    threadId = created.threadId;
                } catch (error) {
                    lastError = error;
                    this.log(d.channel_id, 'error', { where: `thread-create attempt ${attempt}`, error: inWords(error) });
                }
            }
            if (threadId === null) {
                try {
                    await this.client.sendMessage(d.channel_id, `Could not open a thread for this message, so no agent was started (${forPeople(lastError ?? 'Discord gave no thread')}). Check that the bot may create public threads here, then send it again.`, {
                        message_reference: { message_id: d.id, fail_if_not_exists: false },
                    });
                } catch {}
                this.store.handedOver(d.id); // answered, with the reason
                this.log(d.channel_id, 'error', { where: 'thread-create', error: 'gave up after a retry' });
                return 'failed';
            }
            this.store.pendingIn(d.id, threadId);
            this.log(threadId, 'thread_created', { parentChannelId: d.channel_id, anchorMessageId: d.id });
            const threadInfo = { id: threadId, name: tempName(anchorText || attachments[0]?.filename), type: 11, parent_id: d.channel_id };
            this.channelCache.set(threadId, threadInfo);
            await this.serial(threadId, () => this.ensureTurn(threadId, d.id, anchorText, attachments, author, threadInfo, { catchUp }));
            return 'relayed';
        });
    }

    /**
     * Ensure the thread's session exists (create, or resume from disk after a
     * restart) and hand this message over as the next turn. Runs inside the
     * thread's serial chain, so two messages never race to create a session.
     */
    async ensureTurn(threadId, messageId, content, attachments, author, info, { catchUp = false } = {}) {
        let live = this.live.get(threadId);
        if (!live) {
            live = await this.startSession(threadId, info, content);
            if (!live) {
                this.store.handedOver(messageId); // the thread was told why no agent started
                return;
            }
        }
        const stored = this.store.get(threadId);
        const isFirstTurn = live.turnCount === 0;
        live.turnCount += 1;
        const fields = { turnCount: live.turnCount, lastActiveAt: new Date().toISOString() };
        if (isFirstTurn) {
            live.firstReplyPending = true;
            fields.anchorMessageId = messageId;
            fields.anchorText = (content || attachments.map((a) => a.filename).join(', ')).slice(0, 500);
        }
        this.store.put(threadId, fields);
        this.store.markSeen(messageId, { channelId: threadId, threadId });

        const header = `**Discord message from @${author.username}** (display name: ${author.global_name ?? author.displayName ?? author.username}, user id: ${author.id}) in the thread **${stored?.title ?? info?.name ?? threadId}**${catchUp ? ' (sent while DSH was not running; answer it now)' : ''}`;
        const files = attachments.map((a) => `- ${a.filename} (${a.content_type ?? 'file'}, ${a.size ?? '?'} bytes): ${a.url}`);
        const tail = replyInstruction(threadId);
        const room = Math.max(200, this.config.maxPromptChars - header.length - tail.length - files.join('\n').length - 80);
        const body = content.length > room ? `${content.slice(0, room)}\n\n(message cut at ${room} characters)` : content;
        const text = [header, '', body, ...(files.length > 0 ? ['', 'Attached files (download them if you need them):', ...files] : []), '', tail].join('\n');

        this.startTyping(threadId);
        this.log(threadId, 'turn_start', { turn: live.turnCount, messageId, authorId: author.id, content: content.slice(0, 80), catchUp });
        const message = () => this.host.createUserMessage({
            content: [{ type: 'text', text }],
            source: {
                kind: 'discord',
                channelId: threadId,
                messageId,
                authorId: author.id,
                form: 'notice',
                summary: short(`@${author.username} on Discord: ${content || files.length + ' file(s)'}`, SUMMARY_MAX),
            },
        });
        try {
            live.handle.agent.followup(message());
        } catch (error) {
            // The agent went away under us (closed in DSH, say): open the session again and hand the message over once more.
            this.log(threadId, 'error', { where: 'followup', error: inWords(error) });
            this.live.delete(threadId);
            this.release(live.agentCtx);
            const again = await this.startSession(threadId, info, content);
            if (!again) {
                this.store.handedOver(messageId);
                return;
            }
            again.turnCount = live.turnCount;
            again.handle.agent.followup(message());
            live = again;
        }
        // Handed over: from now on, a quit before the turn ends is said as a cut-off turn (pendingMessageId).
        delete this.store.pending[messageId];
        this.store.put(threadId, { pendingMessageId: messageId, pendingText: ThreadRouter.gist(content, attachments) });
        this.log(threadId, 'turn_relayed', { turn: live.turnCount, sessionId: live.sessionId });
    }

    /** Resume the thread's stored session, or create one; says in the thread when it cannot. */
    async startSession(threadId, info, content) {
        const stored = this.store.get(threadId);
        if (stored?.sessionId) {
            try {
                return await this.resume(threadId, stored);
            } catch (error) {
                this.log(threadId, 'error', { where: 'session-resume', error: inWords(error) });
                await this.post(threadId, `The earlier agent session for this thread could not be opened (${forPeople(error)}), so a new one starts now; it does not remember the earlier messages.`);
            }
        }
        try {
            return await this.create(threadId, info, { anchorText: content });
        } catch (error) {
            this.log(threadId, 'error', { where: 'session-create', error: inWords(error) });
            this.logger.warn('discord: could not start an agent for a thread: %s', inWords(error));
            this.stopTyping(threadId);
            await this.post(threadId, `Could not start an agent for this message (${forPeople(error)}). Check the Discord plugin's settings in DSH (workspacePath, agentPreset, permissionPreset), then send the message again.`);
            return null;
        }
    }

    /** Create a fresh agent session for a thread. */
    async create(threadId, info, options = {}) {
        const ctx = this.ctx;
        const config = this.config;
        if (!config.workspacePath) throw new Error('workspacePath is not set');
        ctx.permissionPresets.resolve(config.permissionPreset);
        const preset = await ctx.agentPresets.resolve(config.agentPreset);
        const lease = await ctx.agentPresets.acquireScope(preset.id);
        try {
            const workspace = await ctx.workspaceRegistry.create(config.workspacePath);
            const tempNameValue = tempName(options.anchorText ?? info?.name ?? 'conversation');
            const sessionId = this.host.brandString(`discord-t${threadId}-${randomUUID().slice(0, 8)}`);
            const selected = ctx.agentDefaultModel.currentSelection();
            let scoped;
            const handle = await ctx.agents.create({
                sessionId,
                meta: { cwd: workspace.path, agentPreset: preset.id },
                agentOptions: { provider: selected.provider, model: selected.model },
                setup: async (agentCtx) => {
                    scoped = agentCtx;
                    await ctx.agentPresets.mount(agentCtx, preset.id);
                    this.installHooks(agentCtx, threadId, sessionId);
                },
            });
            await workspace.attachSession(sessionId);
            ctx.permissionPresets.set(handle.agent.session, config.permissionPreset);
            // A thread cleared with /new numbers its next session, so DSH never lists two sessions under one name.
            const generation = this.store.cleared?.[threadId]?.generation ?? 1;
            // A thread that already has a name (cleared with /new, or opened by hand) gives it to its new session at
            // once; tempName stays the message's words, so the first title still sees a name a person gave as theirs.
            const shown = tempName(info?.name ?? tempNameValue);
            ctx.sessionTitle.rename(handle.agent.session, sessionName(shown, generation));
            if (this.store.cleared?.[threadId]) delete this.store.cleared[threadId];
            this.store.put(threadId, {
                sessionId,
                title: shown,
                tempName: tempNameValue,
                renamed: false,
                parentChannelId: info?.parent_id ?? null,
                turnCount: 0,
                generation,
                createdAt: new Date().toISOString(),
            });
            const live = this.newLive(sessionId, handle, 0, true, scoped);
            this.live.set(threadId, live);
            this.log(threadId, 'session_created', { sessionId });
            return live;
        } finally {
            await lease[Symbol.asyncDispose]();
        }
    }

    /** Resume a persisted session for a thread (restart survival); adopt it when DSH already has it open. */
    async resume(threadId, stored) {
        const ctx = this.ctx;
        const config = this.config;
        const open = ctx.agents.get?.(stored.sessionId);
        if (open) {
            this.installHooks(open.ctx, threadId, stored.sessionId);
            const live = this.newLive(stored.sessionId, { agent: open, dispose: async () => {} }, stored.turnCount ?? 1, false, open.ctx);
            this.live.set(threadId, live);
            this.log(threadId, 'session_adopted', { sessionId: stored.sessionId });
            return live;
        }
        ctx.permissionPresets.resolve(config.permissionPreset);
        const preset = await ctx.agentPresets.resolve(config.agentPreset);
        const lease = await ctx.agentPresets.acquireScope(preset.id);
        try {
            const selected = ctx.agentDefaultModel.currentSelection();
            let scoped;
            const handle = await ctx.agents.resume({
                resumeSessionId: stored.sessionId,
                agentOptions: { provider: selected.provider, model: selected.model },
                setup: async (agentCtx) => {
                    scoped = agentCtx;
                    await ctx.agentPresets.mount(agentCtx, preset.id);
                    this.installHooks(agentCtx, threadId, stored.sessionId);
                },
            });
            ctx.permissionPresets.set(handle.agent.session, config.permissionPreset);
            const live = this.newLive(stored.sessionId, handle, stored.turnCount ?? 1, true, scoped);
            this.live.set(threadId, live);
            this.log(threadId, 'session_resumed', { sessionId: stored.sessionId });
            return live;
        } finally {
            await lease[Symbol.asyncDispose]();
        }
    }

    newLive(sessionId, handle, turnCount, owned, agentCtx) {
        return {
            sessionId, handle, owned, turnCount, agentCtx,
            status: 'idle', firstReplyPending: false, turn: 0,
            discordTurns: new Set(), sentTurns: new Set(), nudgedTurns: new Set(), answeredTurns: new Set(),
            turnStarts: new Map(), // turn → the id of the first message it took up (where its last words are looked for)
        };
    }

    /** The Discord tools this router offers to the sessions it runs (see toolsFor). */
    offerTools(tools) {
        this.tools = Array.isArray(tools) ? tools : [];
    }

    /**
     * Register the Discord tools in one Discord session's own agent scope: DSH offers a tool registered there
     * to that agent only, so no other DSH session is offered them. Each one's way back goes into `undo`.
     */
    toolsFor(agentCtx, threadId, undo) {
        for (const tool of this.tools) {
            try {
                const unregister = agentCtx.tools.register(tool);
                if (typeof unregister === 'function') undo.push(unregister);
            } catch (error) {
                this.log(threadId, 'error', { where: 'tools', tool: tool.name, error: inWords(error) });
            }
        }
    }

    /**
     * Take the router's listeners and the Discord tools off one agent scope (a session cleared with /new, or
     * every session at unload). A session the bot started goes away with its scope; one DSH keeps open (picked
     * up rather than started) stays in DSH, without any Discord tool. Never throws.
     */
    release(agentCtx) {
        const undo = agentCtx ? this.hooks.get(agentCtx) : undefined;
        if (!undo) return;
        this.hooks.delete(agentCtx);
        for (const off of undo.splice(0).reverse()) {
            try { off(); } catch {}
        }
    }

    /**
     * The per-agent hooks: status (typing, titles), the /model and /effort
     * route override, and the never-silent rules (a reminder when a Discord
     * turn is about to end without a reply, its last words after that, and a
     * line when a turn fails). Each listener catches its own faults.
     */
    installHooks(agentCtx, threadId, sessionId) {
        if (this.disposed || !agentCtx || this.hooks.has(agentCtx)) return; // once per agent scope
        const undo = [];
        this.hooks.set(agentCtx, undo);
        if (this.tools.length > 0) this.toolsFor(agentCtx, threadId, undo);
        const on = (name, listener, options) => {
            const off = agentCtx.on(name, listener, options);
            if (typeof off === 'function') undo.push(off);
        };
        const liveFor = (agent) => {
            const live = this.live.get(threadId);
            return live && (agent === undefined || live.handle.agent === agent || live.sessionId === agent?.session?.id) ? live : null;
        };
        on('agent/status', ({ agent, status }) => {
            try {
                this.onAgentStatus(threadId, status, liveFor(agent));
            } catch (error) {
                this.log(threadId, 'error', { where: 'status', error: inWords(error) });
            }
        });
        on('agent/inbox/claimed', ({ agent, message, turn }) => {
            const live = liveFor(agent);
            if (!live) return;
            live.turn = turn;
            if (!live.turnStarts.has(turn) && message?.id !== undefined) live.turnStarts.set(turn, message.id);
            if (message?.source?.kind === 'discord' && message.source.form === 'notice' && message.source.messageId) live.discordTurns.add(turn);
        });
        // Prepended, so it has the last word: DSH's own model selection, which DSH puts on a session it opens
        // (in its window, or through its API) and which sets the model that session used last, runs inside it.
        on('agent/request', async (_event, next) => {
            const resolved = await next();
            try {
                const stored = this.store.get(threadId);
                if (!stored || (sessionId !== undefined && stored.sessionId !== sessionId)) return resolved; // a cleared session keeps DSH's choice
                // /model default (null): DSH's default model. DSH's own choice for a session it opened follows the
                // model the session used last, which would keep the one /model set, so the default is named here.
                const model = stored.modelOverride === null ? this.defaultModelSpec() : stored.modelOverride ?? undefined;
                return applyRouteOverride(resolved, model, stored.effortOverride === undefined ? undefined : stored.effortOverride);
            } catch (error) {
                this.log(threadId, 'error', { where: 'route-override', error: inWords(error) });
                return resolved;
            }
        }, { prepend: true });
        on('agent/turn-stopping', async ({ agent, turn }) => {
            try {
                await this.onTurnStopping(threadId, liveFor(agent), agent, turn);
            } catch (error) {
                this.log(threadId, 'error', { where: 'turn-stopping', error: inWords(error) });
            }
        });
        // Prepended: DSH's window forwarding listens from boot, and an open window that answers ends the chain there,
        // so a listener added after it would never hear the request. This one only watches: it always passes it on.
        on('approval/request', async (req, next) => {
            // Nobody on Discord can approve: when a Discord turn waits for an approval in DSH, the thread is told what and where.
            const live = liveFor(req?.agent);
            let timer;
            if (live && live.discordTurns.has(live.turn)) {
                timer = setTimeout(() => {
                    const reason = reasonText(req);
                    const what = `${toolAction(req.toolName)}${reason ? ` (${short(reason, 160)})` : ''}`;
                    const name = this.sessionNameOf(threadId);
                    this.log(threadId, 'approval_waiting', { tool: req.toolName ?? null });
                    void this.post(threadId, `The agent is waiting for your approval in DSH to ${what}. Allow or refuse it in DSH${name ? `, in the session “${name}”` : ''}; it cannot be answered from Discord.`);
                }, APPROVAL_NOTICE_MS);
                timer.unref?.();
            }
            try {
                return await next();
            } finally {
                clearTimeout(timer);
            }
        }, { prepend: true });
        on('agent/error', ({ agent, turn, error }) => {
            const live = liveFor(agent);
            if (!live || !live.discordTurns.has(turn) || live.answeredTurns.has(turn)) return;
            live.answeredTurns.add(turn);
            this.log(threadId, 'turn_failed', { turn, error: inWords(error) });
            if (!this.config.postErrors) return;
            // The reason's own closing period gives way to the sentence's, so the line never shows "..".
            void this.post(threadId, `The agent's turn failed: ${forPeople(error).replace(/\.+$/, '')}. Send your message again to retry; /status shows the session.`);
        });
    }

    /** A Discord turn about to end: remind once, then post its last words, so nobody waits on silence. */
    async onTurnStopping(threadId, live, agent, turn) {
        if (!live || !this.config.replyFallback) return;
        if (!live.discordTurns.has(turn) || live.sentTurns.has(turn) || live.answeredTurns.has(turn)) return;
        if (!live.nudgedTurns.has(turn)) {
            live.nudgedTurns.add(turn);
            agent.steer(this.host.createUserMessage({
                content: [{ type: 'text', text: nudgeText(threadId) }],
                source: { kind: 'discord', channelId: threadId, form: 'notice', summary: 'Reminder: the reply has not been sent to Discord' },
            }));
            this.log(threadId, 'reply_nudged', { turn });
            return;
        }
        live.answeredTurns.add(turn);
        const text = turnReplyText(agent.session, live.turnStarts.get(turn));
        const sent = await this.post(threadId, text || 'The agent finished this turn without a reply. Ask again, or open the session in DSH to see what it did.');
        this.log(threadId, 'reply_fallback', { turn, chars: text.length, posted: sent });
    }

    /** A Discord tool reached a channel: the turn that sent it has replied. */
    noteSent(sessionId, channelId) {
        if (!sessionId) return;
        for (const [threadId, live] of this.live) {
            if (live.sessionId === sessionId && threadId === channelId) {
                live.sentTurns.add(live.turn);
                this.log(threadId, 'reply_sent', { turn: live.turn });
            }
        }
    }

    /** Post a line in a thread; true when Discord took it. Never throws. */
    async post(threadId, content) {
        if (!this.client) return false;
        try {
            await this.client.sendMessage(threadId, content);
            return true;
        } catch (error) {
            this.log(threadId, 'error', { where: 'post', error: inWords(error) });
            return false;
        }
    }

    /** Status transitions: stop typing at idle; titles after the first reply. */
    onAgentStatus(threadId, status, live) {
        if (!live) return;
        live.status = status;
        if (status === 'idle') {
            this.stopTyping(threadId);
            this.log(threadId, 'turn_end', {});
            if (this.store.get(threadId)?.pendingMessageId) this.store.put(threadId, { pendingMessageId: null, pendingText: null });
            if (live.firstReplyPending) {
                live.firstReplyPending = false;
                void this.autoRename(threadId);
            }
        }
    }

    /** Typing loop for a thread: every 8 s until the turn ends (at most 30 minutes). */
    startTyping(threadId) {
        if (this.typing.has(threadId) || !this.client) return;
        const startedAt = Date.now();
        const timer = setInterval(() => {
            if (Date.now() - startedAt > TYPING_MAX_MS || this.disposed) {
                this.stopTyping(threadId);
                return;
            }
            this.client.triggerTyping(threadId).catch(() => this.stopTyping(threadId));
        }, 8000);
        timer.unref?.();
        void this.client.triggerTyping(threadId).catch(() => {});
        this.typing.set(threadId, timer);
    }

    stopTyping(threadId) {
        const timer = this.typing.get(threadId);
        if (timer) {
            clearInterval(timer);
            this.typing.delete(threadId);
        }
    }

    // ── catch-up after a restart ───────────────────────────────────────────

    /**
     * Once per start: a thread whose last message was still being worked on when DSH stopped (a crash, a quit
     * mid-turn) is told so, and so is a message the previous run took but never handed to an agent (it stopped
     * in the seconds between), so nobody waits on an answer that is not coming. Never throws.
     */
    async noticeInterrupted() {
        const due = this.interrupted;
        this.interrupted = [];
        for (const { threadId, messageId, text } of due) {
            if (this.disposed || !this.store.get(threadId)) continue;
            if (this.store.get(threadId).pendingMessageId !== messageId) continue; // a newer message is already being handled
            this.store.put(threadId, { pendingMessageId: null, pendingText: null });
            const what = text ? ` (“${text}”)` : '';
            const sent = await this.post(threadId, `DSH stopped before the agent finished your last message${what}. Send it again if you still need the answer.`);
            this.log(threadId, 'turn_interrupted', { messageId, posted: sent });
        }
        const untaken = this.untaken;
        this.untaken = [];
        for (const { messageId, channelId, threadId, text } of untaken) {
            if (this.disposed) break;
            if (!(messageId in this.store.pending)) continue; // handed over since
            this.store.handedOver(messageId);
            const what = text ? ` (“${text}”)` : '';
            const line = `DSH stopped before your message${what} reached an agent, so it was not answered. Send it again if you still need the answer.`;
            const sent = threadId ? await this.post(threadId, line) : await this.reply(channelId, messageId, line);
            this.log(threadId ?? channelId, 'message_untaken', { messageId, posted: sent });
        }
    }

    /** Answer one message in its channel (a reply to it); true when Discord took it. Never throws. */
    async reply(channelId, messageId, content) {
        if (!this.client || !channelId) return false;
        try {
            await this.client.sendMessage(channelId, content, { message_reference: { message_id: messageId, fail_if_not_exists: false } });
            return true;
        } catch (error) {
            this.log(channelId, 'error', { where: 'post', error: inWords(error) });
            return false;
        }
    }

    /** A message that mentions the bot (for requireMention). */
    mentionsMe(content) {
        const me = this.client?.botUser;
        return me ? content.includes(`<@${me.id}>`) || content.includes(`<@!${me.id}>`) : false;
    }

    /**
     * Every message after `after` in a channel, oldest first, read 100 at a time up to the newest one (at most
     * CATCH_UP_PAGES pages). `complete` is false when the rest could not be read; `passing` when that was a fault
     * that may pass (Discord down, no network), so a later try may read it.
     * @returns {Promise<{messages: object[]|null, complete: boolean, passing?: boolean}>} messages null when nothing could be read.
     */
    async readAfter(channelId, after) {
        const messages = [];
        let cursor = after;
        for (let page = 0; page < CATCH_UP_PAGES; page++) {
            let batch;
            try {
                batch = await this.client.getMessagesAfter(channelId, { after: cursor, limit: 100 });
            } catch (error) {
                this.log(channelId, 'error', { where: 'catch-up', page, error: inWords(error) });
                return { messages: page === 0 ? null : messages, complete: false, passing: error?.retryable === true };
            }
            messages.push(...batch);
            if (batch.length < 100) return { messages, complete: true };
            cursor = batch.at(-1).id;
        }
        return { messages, complete: false };
    }

    /**
     * After a fresh gateway session (not a resume, which Discord replays itself): read what was posted while the
     * bot was away, and answer it as if it had come live, telling the agent it came late. It reads every thread
     * the store keeps under an allowed channel (one cleared with /new too) and every allowed channel, from the
     * newest message the bot handled there, page by page to the newest one, however long the thread was idle.
     * A message older than catchUpMinutes is not answered, and its thread (or, for a message in a channel, the
     * message itself) is told so. Handled ids are skipped, so nothing runs twice. Only when an older build wrote
     * the store last (it answered without keeping ids) is a message the bot replied after taken as answered.
     * A read that fails on a passing fault is tried again (CATCH_UP_RETRIES times, a minute apart, from the newest
     * message handled); what still cannot be read is said where it was posted. Never throws.
     * @returns {Promise<{checked: number, handled: number, late: number}>}
     */
    async catchUp() {
        if (!this.client) return { checked: 0, handled: 0, late: 0 };
        if (this.catchingUp) return this.catchingUp;
        this.catchingUp = (async () => {
            if (this.catchUpTimer) clearTimeout(this.catchUpTimer); // this run is the next try
            this.catchUpTimer = null;
            const minutes = this.config.catchUpMinutes;
            const since = Date.now() - minutes * 60000;
            const allowed = this.config.allowedChannelIds;
            const targets = [];
            for (const [threadId, entry] of Object.entries(this.store.threads)) {
                if (entry?.lastMessageId && (allowed.includes(threadId) || this.storedUnder(threadId, allowed))) targets.push({ channelId: threadId, after: entry.lastMessageId, thread: true });
            }
            for (const [threadId, entry] of Object.entries(this.store.cleared ?? {})) {
                if (entry?.lastMessageId && !this.store.get(threadId) && this.storedUnder(threadId, allowed)) targets.push({ channelId: threadId, after: entry.lastMessageId, thread: true });
            }
            for (const channelId of allowed) {
                if (this.store.get(channelId)) continue; // autoThread false: the channel is a session, read above
                const last = this.store.channels[channelId]?.lastMessageId;
                if (last) targets.push({ channelId, after: last, thread: false });
                // A channel the bot has had no message from: from now on, catch-up reads it from this moment.
                else this.store.startChannel(channelId, String((BigInt(Date.now()) - DISCORD_EPOCH) << 22n));
            }
            let checked = 0;
            let handled = 0;
            let late = 0;
            let again = false;
            const me = this.client.botUser?.id;
            const unread = 'Not every message sent here while DSH was not running could be read, so some were not answered. Send again what still needs an answer.';
            for (const target of targets) {
                if (this.disposed) break;
                const { messages: read, complete, passing } = await this.readAfter(target.channelId, target.after);
                // A fault that may pass: read this place again later (from the newest message handled) before saying anything.
                // A thread found by this read is not found again later, so what cannot be read there is said at once.
                const retry = !complete && passing === true && this.catchUpRetries < CATCH_UP_RETRIES && !target.found;
                if (retry) again = true;
                // A thread opened by hand from a person's message: that message is the thread's first one.
                const messages = read && target.starter ? [{ ...target.starter, channel_id: target.channelId, thread: undefined }, ...read] : read;
                if (messages === null) {
                    if (!retry) {
                        const sent = await this.post(target.channelId, unread);
                        this.log(target.channelId, 'catch_up_incomplete', { read: 0, posted: sent });
                    }
                    continue;
                }
                // An older build answered without keeping ids: a message the bot replied after counts as answered.
                const lastReply = this.store.legacy && me ? messages.filter((m) => m.author?.id === me).at(-1)?.id : undefined;
                const tooOld = [];
                for (const message of messages) {
                    checked += 1;
                    const d = { ...message, channel_id: message.channel_id ?? target.channelId };
                    const where = { channelId: target.channelId, threadId: this.store.get(target.channelId) ? target.channelId : null };
                    if (!target.thread) {
                        // A thread someone opened by hand in an allowed channel while DSH was not running (from their
                        // message, or on its own): the bot does not know it yet, so it reads it next, from its start.
                        const opened = d.thread?.id ?? (d.type === 18 ? d.message_reference?.channel_id : undefined);
                        if (typeof opened === 'string' && /^\d{17,20}$/.test(opened) && !this.store.get(opened) && !this.store.cleared?.[opened]) {
                            if (!targets.some((t) => t.channelId === opened)) {
                                const starter = d.thread?.id === opened && this.unanswerable(d) === null && !this.store.hasSeen(d.id) ? d : null;
                                targets.push({ channelId: opened, after: opened, thread: true, found: true, starter });
                            }
                            continue;
                        }
                    }
                    if (lastReply && newerId(lastReply, d.id)) {
                        if (!d.author?.bot) this.store.markSeen(d.id, where);
                        continue;
                    }
                    const at = Date.parse(d.timestamp ?? '');
                    // catchUpMinutes 0: no late message is answered, however recent (each is still told).
                    if (minutes === 0 || (Number.isFinite(at) && at < since)) {
                        const answerable = this.unanswerable(d) === null && !this.store.hasSeen(d.id)
                            && (target.thread || (!d.thread?.id && (!this.config.requireMention || this.mentionsMe(d.content ?? ''))));
                        if (answerable) {
                            this.store.markSeen(d.id, where);
                            tooOld.push(d);
                        }
                        continue;
                    }
                    const outcome = await this.handleMessage(d, { catchUp: true });
                    if (outcome === 'relayed') handled += 1;
                }
                if (tooOld.length > 0) {
                    late += tooOld.length;
                    await this.sayTooOld(target, tooOld, minutes);
                }
                // Everything read here was answered, told or passed over by rule: the next catch-up starts after it.
                if (read && read.length > 0 && !this.disposed) this.store.advance(target.channelId, read.at(-1).id);
                if (!complete && !retry) {
                    const sent = await this.post(target.channelId, unread);
                    this.log(target.channelId, 'catch_up_incomplete', { read: messages.length, posted: sent });
                }
            }
            if (again && !this.disposed) {
                this.catchUpRetries += 1;
                if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
                this.catchUpTimer = setTimeout(() => {
                    this.catchUpTimer = null;
                    if (!this.disposed) void this.catchUp();
                }, this.catchUpRetryMs);
                this.catchUpTimer.unref?.();
                this.log(null, 'catch_up_retry', { attempt: this.catchUpRetries, inMs: this.catchUpRetryMs });
            } else {
                this.catchUpRetries = 0;
            }
            // After the catch-up (whose own posts must not count as answers): a turn DSH stopped in the middle of is said.
            await this.noticeInterrupted();
            // An older build's store is taken as such for the first catch-up only: from now on this build keeps the ids.
            if (!again) this.store.legacy = false;
            this.trace('router', 'catch_up', { targets: targets.length, checked, handled, late });
            if (handled > 0) this.logger.info('discord: answered %d message(s) sent while DSH was not running', handled);
            if (late > 0) this.logger.info('discord: %d message(s) sent while DSH was not running were too old to answer (catchUpMinutes %d); each was told', late, minutes);
            return { checked, handled, late };
        })();
        try {
            return await this.catchingUp;
        } finally {
            this.catchingUp = null;
        }
    }

    /** Say where messages that came too late are: one line in a thread, or one reply in a channel per message. */
    async sayTooOld(target, messages, minutes) {
        const why = (verb) => (minutes > 0 ? ` and ${verb} older than ${minutes} minutes, the longest the bot answers late` : '; the bot is set not to answer late messages');
        if (target.thread) {
            const first = messages[0];
            const gist = ThreadRouter.gist(typeof first.content === 'string' ? first.content.trim() : '', Array.isArray(first.attachments) ? first.attachments : []);
            const line = messages.length === 1
                ? `Your message (“${gist}”) came while DSH was not running${why('is')}, so the agent was not given it. Send it again if it still needs an answer.`
                : `${messages.length} messages here (the first: “${gist}”) came while DSH was not running${why('are')}, so the agent was not given them. Send again what still needs an answer.`;
            const sent = await this.post(target.channelId, line);
            this.log(target.channelId, 'catch_up_too_old', { count: messages.length, posted: sent });
            return;
        }
        for (const message of messages) {
            const sent = await this.reply(target.channelId, message.id, `This message came while DSH was not running${why('is')}, so no agent was started for it. Send it again if it still needs an answer.`);
            this.log(target.channelId, 'catch_up_too_old', { messageId: message.id, posted: sent });
        }
    }

    // ── titles ──────────────────────────────────────────────────────────────

    /**
     * Auto-rename a thread once, after its first reply: one cheap model call,
     * cleaned, with a fallback from the person's own words, unique in the
     * store, and only while the thread still carries its temporary name. Never throws.
     */
    async autoRename(threadId) {
        try {
            const stored = this.store.get(threadId);
            if (!stored || stored.renamed) return;
            this.log(threadId, 'rename_attempt', { mode: 'auto' });
            const title = await this.makeTitle(threadId, stored);
            if (title === null) return;
            await this.applyRename(threadId, stored, title, 'auto');
        } catch (error) {
            this.log(threadId, 'rename_result', { outcome: 'failed', error: inWords(error) });
        }
    }

    /** Generate and clean a title; null when nothing usable came back. */
    async makeTitle(threadId, stored) {
        try {
            const route = this.config.titleModel
                ? parseTitleModel(this.config.titleModel, this.ctx)
                : (() => { const s = this.ctx.agentDefaultModel.currentSelection(); return [s.provider, s.model]; })();
            const raw = await generateTitle(this.ctx, this.host, {
                provider: route[0],
                model: route[1],
                sessionId: stored.sessionId,
                text: stored.anchorText ?? '',
                timeoutMs: this.config.titleTimeoutMs,
            });
            let title = cleanTitle(raw, stored.anchorText ?? '');
            if (title.length === 0) {
                title = deriveFallbackTitle(stored.anchorText ?? '');
                this.log(threadId, 'rename_result', { outcome: 'fallback-derived', title: title.slice(0, 80) });
            }
            return title;
        } catch (error) {
            this.log(threadId, 'error', { where: 'title-generate', error: inWords(error) });
            const title = deriveFallbackTitle(stored.anchorText ?? '');
            this.log(threadId, 'rename_result', { outcome: 'fallback-derived', title: title.slice(0, 80) });
            return title;
        }
    }

    /**
     * Apply a title: unique suffix, the temporary-name guard (a manual
     * rename wins), the Discord rename, the DSH session title, the store.
     * @returns {Promise<{ok: boolean, title?: string, reason?: string}>} never throws.
     */
    async applyRename(threadId, stored, title, mode) {
        try {
            const unique = uniquifyTitle(title, threadId, () => this.store.titlesExcluding(threadId));
            let currentName = null;
            try {
                const channel = await this.client.getChannel(threadId);
                currentName = channel?.name ?? null;
            } catch {}
            if (mode === 'auto' && currentName !== null && !sameName(currentName, stored.tempName)) {
                // The person named the thread (in Discord, or with /rename before a /new): keep it, and give the DSH session the same name.
                this.log(threadId, 'rename_result', { outcome: 'skipped-manual-rename', currentName: currentName.slice(0, 80) });
                this.store.put(threadId, { renamed: true, title: currentName });
                this.renameSession(threadId, currentName);
                return { ok: false, reason: 'renamed by hand' };
            }
            await this.client.renameThread(threadId, unique, 'dsh-plugin-discord title');
            this.channelCache.delete(threadId);
            this.store.put(threadId, { renamed: true, title: unique });
            this.renameSession(threadId, unique);
            this.log(threadId, 'rename_result', { outcome: 'renamed', title: unique.slice(0, 80), mode });
            return { ok: true, title: unique };
        } catch (error) {
            this.log(threadId, 'rename_result', { outcome: 'failed', error: inWords(error) });
            return { ok: false, reason: inWords(error) };
        }
    }

    /** The thread's DSH session takes the thread's name ("Discord — <name>", numbered after a /new). Never throws. */
    renameSession(threadId, name) {
        const live = this.live.get(threadId);
        if (!live?.handle?.agent?.session) return;
        try {
            this.ctx.sessionTitle.rename(live.handle.agent.session, sessionName(name, this.store.get(threadId)?.generation));
        } catch {}
    }

    /** DSH's default model as "provider:model", or undefined when DSH does not say. */
    defaultModelSpec() {
        try {
            const selected = this.ctx.agentDefaultModel.currentSelection();
            return selected?.provider && selected?.model ? `${selected.provider}:${selected.model}` : undefined;
        } catch {
            return undefined;
        }
    }

    /** The name DSH lists the thread's session under, or '' when it has none. */
    sessionNameOf(threadId) {
        const stored = this.store.get(threadId);
        const title = stored?.title ?? stored?.tempName;
        return title ? sessionName(title, stored.generation) : '';
    }

    // ── slash commands ──────────────────────────────────────────────────────

    /**
     * Handle one slash-command interaction. Only allowed people, only in the
     * bot's own channels and threads. Never throws.
     * @param {object} d - INTERACTION_CREATE payload.
     * @returns {Promise<string>} what happened, in one word.
     */
    async handleInteraction(d) {
        const name = d?.data?.name;
        const threadId = d?.channel?.id ?? d?.channel_id;
        if (d?.type !== 2 || !name || !threadId) return 'ignored';
        const userId = d.member?.user?.id ?? d.user?.id;
        try {
            if (this.config.allowedUserIds.length > 0 && !this.config.allowedUserIds.includes(userId)) {
                this.log(threadId, 'command', { command: name, result: 'refused', reason: 'user not allowlisted', userId });
                await this.client.respondInteraction(d, 'This bot answers only the people it is set up for.', { ephemeral: true });
                return 'refused';
            }
            if (!this.inScope(threadId, d.channel?.parent_id)) {
                this.log(threadId, 'command', { command: name, result: 'refused', reason: 'channel outside allowlist' });
                await this.client.respondInteraction(d, 'This bot works only in its own channels and their threads.', { ephemeral: true });
                return 'refused';
            }
            this.log(threadId, 'command', { command: name, result: 'accepted' });
            const arg = (d.data.options ?? [])[0]?.value ?? null;
            const answer = await this.runCommand(name, threadId, arg, d);
            return answer;
        } catch (error) {
            this.log(threadId, 'error', { where: 'interaction', command: name, error: inWords(error) });
            try {
                await this.client.respondInteraction(d, `Not done: ${inWords(error)}`, { ephemeral: true });
            } catch {
                try {
                    await this.client.editInteractionResponse(d, `Not done: ${inWords(error)}`);
                } catch {}
            }
            return 'failed';
        }
    }

    async runCommand(name, threadId, arg, d) {
        const client = this.client;
        const text = arg !== null && String(arg).trim() !== '' ? String(arg).trim() : null;
        if (name === 'rename') {
            await client.deferInteraction(d);
            const stored = this.store.get(threadId);
            if (!stored) {
                await client.editInteractionResponse(d, 'This thread has no agent session yet; send a message first.');
                return 'answered';
            }
            const title = text !== null ? capTitle(cleanTitle(text) || text, TITLE_MAX) : await this.makeTitle(threadId, stored);
            const result = await this.applyRename(threadId, stored, title, 'slash');
            await client.editInteractionResponse(d, result.ok ? `Renamed to “${result.title}”.` : `Not renamed: ${result.reason}. Discord allows about two renames per thread every 10 minutes.`);
            return result.ok ? 'done' : 'failed';
        }
        if (name === 'new' || name === 'reset') {
            await client.deferInteraction(d);
            const stored = this.store.get(threadId);
            if (!stored) {
                await client.editInteractionResponse(d, 'This thread has no agent session, so there is nothing to clear.');
                return 'answered';
            }
            let generation = 2;
            await this.serial(threadId, async () => {
                const live = this.live.get(threadId);
                if (live) {
                    try {
                        live.handle.agent.cancel({ kind: 'user' });
                    } catch {}
                    // The cleared session is no longer this thread's: it keeps no Discord tool and no listener of the bot's.
                    this.release(live.agentCtx);
                    if (live.owned) await live.handle.dispose().catch(() => {});
                    this.live.delete(threadId);
                }
                this.stopTyping(threadId);
                generation = this.store.clear(threadId);
            });
            this.log(threadId, 'session_cleared', { command: name, sessionId: stored.sessionId, generation });
            await client.editInteractionResponse(d, `Session cleared. Your next message here starts a fresh session, listed in DSH as “${sessionName(stored.title ?? stored.tempName ?? 'conversation', generation)}”; the old one stays in DSH under its own name.`);
            return 'done';
        }
        if (name === 'model') {
            await client.deferInteraction(d);
            const stored = this.store.get(threadId);
            if (text === null) {
                const current = stored?.modelOverride ?? 'the DSH default';
                const menu = this.config.models.length > 0 ? `\nChoices: ${this.config.models.map((m) => '`' + m + '`').join(', ')}` : '';
                await client.editInteractionResponse(d, `Model for this thread: **${current}**.${menu}\nTo switch, give one, for example \`/model provider:model\`; \`/model default\` goes back to the DSH default. /new clears it.`);
                return 'answered';
            }
            if (!stored) {
                await client.editInteractionResponse(d, 'This thread has no agent session yet; send a message first.');
                return 'answered';
            }
            if (/^(clear|default|none|off)$/i.test(text)) {
                this.store.put(threadId, { modelOverride: null });
                this.log(threadId, 'model_override', { cleared: true });
                await client.editInteractionResponse(d, 'Model for this thread back to the DSH default, from the next turn.');
                return 'done';
            }
            const [provider, model] = parseTitleModel(text, this.ctx);
            this.store.put(threadId, { modelOverride: text });
            this.log(threadId, 'model_override', { provider, model });
            await client.editInteractionResponse(d, `Model for this thread set to **${provider}:${model}**, from the next turn.`);
            return 'done';
        }
        if (name === 'effort') {
            await client.deferInteraction(d);
            const stored = this.store.get(threadId);
            if (!stored) {
                await client.editInteractionResponse(d, 'This thread has no agent session yet; send a message first.');
                return 'answered';
            }
            if (text === null) {
                const current = stored.effortOverride === undefined ? 'the model default' : stored.effortOverride === null ? 'the model default (cleared)' : `**${stored.effortOverride}**`;
                await client.editInteractionResponse(d, `Reasoning effort for this thread: ${current}.\nGive a level to set it (the model decides which it takes, for example low, medium or high), or \`clear\` to go back to the default.`);
                return 'answered';
            }
            const normalized = /^(clear|none|off|default)$/i.test(text) ? null : text;
            this.store.put(threadId, { effortOverride: normalized });
            this.log(threadId, 'effort_override', { effort: normalized });
            await client.editInteractionResponse(d, normalized === null
                ? 'Reasoning effort back to the model default, from the next turn.'
                : `Reasoning effort for this thread set to **${normalized}**, from the next turn.`);
            return 'done';
        }
        if (name === 'stop') {
            const live = this.live.get(threadId);
            if (!live || live.status !== 'running') {
                await client.respondInteraction(d, 'Nothing is running in this thread.', { ephemeral: true });
                return 'answered';
            }
            live.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
            if (live.turn) live.answeredTurns.add(live.turn);
            this.stopTyping(threadId);
            this.log(threadId, 'turn_stopped', { command: 'stop', turn: live.turn });
            await client.respondInteraction(d, 'Stopped the running turn. Messages sent after it are still queued and run next.');
            return 'done';
        }
        if (name === 'status') {
            await client.respondInteraction(d, this.statusText(threadId), { ephemeral: true });
            return 'answered';
        }
        await client.respondInteraction(d, `“${name}” is not a command of this bot.`, { ephemeral: true });
        return 'answered';
    }

    /** /status in words. */
    statusText(threadId) {
        const stored = this.store.get(threadId);
        const live = this.live.get(threadId);
        const bot = this.botState() ?? {};
        const lines = [];
        if (!stored) {
            lines.push('**This thread:** no agent session yet; send a message to start one.');
        } else {
            const state = live ? (live.status === 'running' ? 'working on a turn' : 'idle, waiting for a message') : 'not open (it opens with the next message)';
            lines.push(`**This thread:** ${state}; ${stored.turnCount ?? 0} message(s) handed over since it started.`);
            lines.push(`**DSH session:** “${this.sessionNameOf(threadId) || 'Discord — untitled'}”, working in the folder ${this.config.workspacePath ? `“${basename(this.config.workspacePath)}”` : '(none set)'}.`);
            lines.push(`**Model:** ${stored.modelOverride ?? 'the DSH default'}; **effort:** ${stored.effortOverride ?? 'the model default'}.`);
        }
        // A Discord timestamp: each reader sees it in their own time zone.
        const since = Date.parse(bot.since ?? '');
        lines.push(`**Bot:** ${bot.connected ? `connected${Number.isFinite(since) ? ` since <t:${Math.floor(since / 1000)}:f>` : ''}` : 'reconnecting'}${bot.reconnects ? `, ${bot.reconnects} reconnect(s)` : ''}.`);
        return lines.join('\n');
    }
}

/**
 * The name DSH lists a Discord thread's session under: "Discord — <thread name>", and "(session N)" for the Nth
 * session of a thread cleared with /new, so two sessions never share a name. At most 80 characters.
 */
export function sessionName(title, generation = 1) {
    const suffix = Number.isInteger(generation) && generation > 1 ? ` (session ${generation})` : '';
    return `Discord — ${capTitle(String(title ?? '').trim() || 'conversation', 80 - 'Discord — '.length - suffix.length)}${suffix}`;
}

/**
 * Apply a per-thread route override to one resolved request config.
 * `modelSpec` ("provider:model" / "provider/model" / bare model) replaces the
 * route; an absent spec keeps it. `effortSpec`: undefined = no change,
 * null = clear the override, string = set the reasoning effort.
 * @param {object} resolved - the proposed request config from the waterfall.
 * @param {string|null|undefined} modelSpec
 * @param {string|null|undefined} effortSpec
 * @returns {object} the rewritten config.
 */
export function applyRouteOverride(resolved, modelSpec, effortSpec) {
    const next = { ...resolved };
    if (typeof modelSpec === 'string' && modelSpec.trim() !== '') {
        const [provider, model] = parseTitleModel(modelSpec, { agentDefaultModel: { currentSelection: () => next } });
        next.provider = provider;
        next.model = model;
    }
    if (effortSpec === null) delete next.reasoningEffort;
    else if (typeof effortSpec === 'string' && effortSpec.trim() !== '') next.reasoningEffort = effortSpec.trim();
    return next;
}

/**
 * Parse a model spec: "provider:model" or "provider/model", or a bare model
 * id combined with the deployment's default provider.
 * @param {string} spec - config value.
 * @param {object} ctx - runtime context (for the default selection).
 * @returns {[string, string]} [provider, model]
 */
export function parseTitleModel(spec, ctx) {
    const value = String(spec ?? '').trim();
    const sepMatch = value.match(/^([a-zA-Z0-9_-]+)[:/](.+)$/);
    if (sepMatch) return [sepMatch[1], sepMatch[2]];
    const selected = ctx.agentDefaultModel.currentSelection();
    return [selected.provider, value];
}

/**
 * Read a local file for attachment, with a size guard (Discord takes 10 MiB from a bot). With `root`, only a
 * file inside that folder: links and ".." are resolved first, a file with other names (hard links) is refused,
 * and the file is read through the one handle that was checked, which must still be the file inside the folder.
 */
export function readAttachment(path, maxBytes = 10 * 1024 * 1024, root) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('the path must be absolute');
    const name = basename(path);
    const tooBig = (size) => new Error(`${name} is ${size} bytes; Discord takes at most ${maxBytes}`);
    if (root === undefined) {
        const stat = statSync(path);
        if (!stat.isFile()) throw new Error(`${name} is not a file`);
        if (stat.size > maxBytes) throw tooBig(stat.size);
        return { buffer: readFileSync(path), filename: name };
    }
    const insideRoot = () => {
        let base;
        let real;
        try {
            base = realpathSync(root);
            real = realpathSync(path);
        } catch {
            throw new Error(`${name} was not found`);
        }
        const inside = relative(base, real);
        if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
            throw new Error(`${name} is outside the workspace folder; only files inside it can be sent`);
        }
        return real;
    };
    const real = insideRoot();
    let fd;
    try {
        fd = openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch {
        throw new Error(`${name} changed while it was being read; try again`);
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Error(`${name} is not a file`);
        if (stat.nlink > 1) throw new Error(`${name} has other names (hard links), which may lie outside the workspace folder; only a file with one name can be sent`);
        if (stat.size > maxBytes) throw tooBig(stat.size);
        const now = statSync(insideRoot());
        if (now.dev !== stat.dev || now.ino !== stat.ino) throw new Error(`${name} changed while it was being read; try again`);
        return { buffer: readFileSync(fd), filename: basename(real) };
    } finally {
        closeSync(fd);
    }
}
