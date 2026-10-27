/**
 * Zero-dependency Discord client: REST over `fetch` and the Gateway over the
 * global `WebSocket` (Node 22+). Identify, heartbeat, resume (on Discord's
 * resume address), a bounded reconnect ladder that never gives up on a
 * network fault, slash-command registration, interaction answers, file
 * upload, message history (for catch-up) and thread management. No voice and
 * no member cache: event routing plus the REST calls the plugin needs.
 *
 * Every address comes from `apiBase` (default Discord's own): the gateway
 * address is whatever `GET /gateway/bot` there returns, so pointing apiBase
 * at a local fake moves REST and the gateway together.
 *
 * @module dsh-plugin-discord/client
 */
import { splitForDiscord } from './split.js';

/** Discord REST base. */
export const REST_BASE = 'https://discord.com/api/v10';

/** Close codes that are never retried: the fix is configuration, not time. */
const FATAL_CLOSE_CODES = new Map([
    [4004, 'Discord refused the bot token; check the token stored under tokenRef'],
    [4010, 'Discord says the shard is invalid; this client is single-shard'],
    [4011, 'Discord asks for sharding: the bot is in too many servers for one connection'],
    [4012, 'Discord refused the gateway version'],
    [4013, 'Discord refused the intents bitmask'],
    [4014, 'Discord refused a privileged intent: enable "Message Content Intent" for this application in the Discord Developer Portal'],
]);

/** Default intents: GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15). */
export const DEFAULT_INTENTS = 0x1 | 0x200 | 0x1000 | 0x8000;

/** Who a message may ping: users only, never @everyone, @here or roles. */
/** A Discord id (a snowflake): digits only, 17 to 20 of them. */
export const SNOWFLAKE = /^\d{17,20}$/;

/**
 * An id for a request path, checked: a Discord id passes as it is, anything else is refused before any request
 * is made, so a value can never change which endpoint a call reaches.
 * @param {unknown} value
 * @param {string} what - what the id names, for the refusal ("channel id", "message id").
 * @returns {string}
 */
export function discordId(value, what = 'id') {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!SNOWFLAKE.test(text)) throw new DiscordError(`${JSON.stringify(String(value ?? '').slice(0, 40))} is not a Discord ${what}`);
    return text;
}

/** One path part that is not an id (an interaction token), encoded. */
const part = (value) => encodeURIComponent(String(value ?? ''));

export const ALLOWED_MENTIONS = Object.freeze({ parse: ['users'], replied_user: false });

/** An error from Discord (or the way there), with the HTTP status when there was one. */
export class DiscordError extends Error {
    constructor(message, { status = 0, code = null, retryable = false } = {}) {
        super(message);
        this.name = 'DiscordError';
        this.status = status;
        this.code = code;
        this.retryable = retryable;
    }
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

/** Seconds Discord asks us to wait, from a 429 body or its headers. */
function retryAfterSeconds(response, body) {
    const fromBody = Number(body?.retry_after);
    if (Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
    const fromHeader = Number(response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset-after'));
    return Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : 1;
}

/**
 * One authenticated REST call. A 429 waits as long as Discord says (up to
 * three times, each wait at most 60 s); any other refusal throws a
 * DiscordError with Discord's own reason, never the token.
 * @param {object} options
 * @param {string} options.apiBase
 * @param {string} options.token - bot token.
 * @param {string} options.method - HTTP verb.
 * @param {string} options.path - path beginning with `/`.
 * @param {object|FormData} [options.body] - JSON body (or FormData for multipart).
 * @param {string} [options.reason] - audit-log reason header.
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.auth] - false for interaction webhooks, which take no bot token.
 * @param {AbortSignal} [options.signal] - stops waiting (plugin unload).
 * @returns {Promise<object|null>}
 */
export async function restCall({ apiBase, token, method, path, body, reason, timeoutMs = 15000, auth = true, signal }) {
    const url = `${apiBase}${path}`;
    const host = (() => {
        try {
            return new URL(apiBase).host;
        } catch {
            return 'Discord';
        }
    })();
    for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        let response;
        try {
            const headers = {
                ...(body instanceof FormData ? {} : body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason) } : {}),
                'User-Agent': 'DiscordBot (dsh-plugin-discord, 0.2.0)',
            };
            if (auth && token) headers.Authorization = token.startsWith('Bot ') ? token : `Bot ${token}`;
            response = await fetch(url, {
                method,
                signal: controller.signal,
                headers,
                body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
            });
        } catch (error) {
            const timedOut = controller.signal.aborted && !signal?.aborted;
            throw new DiscordError(timedOut
                ? `${host} did not answer ${method} ${path} within ${timeoutMs} ms`
                : `could not reach ${host} for ${method} ${path} (${error?.cause?.code ?? error?.code ?? error?.name ?? 'network error'})`, { retryable: true });
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
        if (response.status === 429 && attempt < 3) {
            const retryBody = await response.json().catch(() => ({}));
            const seconds = Math.min(60, retryAfterSeconds(response, retryBody));
            await sleep(seconds * 1000, signal);
            if (signal?.aborted) throw new DiscordError('stopped while waiting for a rate limit');
            continue;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            let reasonText = '';
            let code = null;
            try {
                const parsed = JSON.parse(text);
                reasonText = typeof parsed?.message === 'string' ? parsed.message : '';
                code = parsed?.code ?? null;
            } catch {}
            throw new DiscordError(`Discord refused ${method} ${path}: ${response.status}${reasonText ? ` ${reasonText.slice(0, 160)}` : ''}`, {
                status: response.status,
                code,
                retryable: response.status >= 500 || response.status === 429,
            });
        }
        if (response.status === 204) return null;
        return await response.json().catch(() => null);
    }
}

/** A live Discord connection with typed REST helpers. */
export class DiscordClient {
    /**
     * @param {object} options
     * @param {string} options.token - bot token (already resolved from the credential store).
     * @param {(message: object) => unknown} options.onMessage - every MESSAGE_CREATE payload.
     * @param {(interaction: object) => unknown} [options.onInteraction] - every INTERACTION_CREATE payload.
     * @param {(info: {resumed: boolean, sessionId: string}) => unknown} [options.onReady] - after READY (a new session) and RESUMED.
     * @param {object} [options.logger] - cordis-style logger (info/warn/debug).
     * @param {(event: string, status: string, data?: object) => void} [options.trace] - plugin trace sink.
     * @param {number} [options.intents] - gateway intents bitmask.
     * @param {number} [options.requestTimeoutMs] - per-REST-call timeout.
     * @param {string} [options.apiBase] - REST base (a local fake in tests).
     * @param {number} [options.maxBackoffMs] - the longest wait between reconnects (tests shorten it).
     */
    constructor({ token, onMessage, onInteraction, onReady, logger, trace, intents = DEFAULT_INTENTS, requestTimeoutMs = 15000, apiBase = REST_BASE, maxBackoffMs = 60000 }) {
        this.token = token;
        this.onMessage = onMessage;
        this.onInteraction = onInteraction ?? (() => {});
        this.onReady = onReady ?? (() => {});
        this.logger = logger ?? { info() {}, warn() {}, debug() {} };
        this.trace = trace ?? (() => {});
        this.intents = intents;
        this.requestTimeoutMs = requestTimeoutMs;
        this.apiBase = apiBase || REST_BASE;
        this.maxBackoffMs = maxBackoffMs;
        this.ws = null;
        this.botUser = null;
        this.lastSeq = null;
        this.sessionId = null;
        this.resumeUrl = null;
        this.gatewayUrl = null;
        this.heartbeat = null;
        this.heartbeatAcked = true;
        this.closing = false;
        this.stopper = new AbortController();
        this.connectAttempt = 0;
        /** What /status and the logs report. */
        this.state = { connected: false, since: null, lastEventAt: null, reconnects: 0, lastError: null, fatal: null };
        this.runner = null;
        this.readyResolved = false;
        this.ready = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        // Nobody may be waiting on `ready` (start() is fire-and-forget in the plugin); never an unhandled rejection.
        this.ready.catch(() => {});
    }

    /** Typed REST helper bound to this client. */
    rest(method, path, body, options = {}) {
        return restCall({
            apiBase: this.apiBase,
            token: this.token,
            method,
            path,
            body,
            timeoutMs: this.requestTimeoutMs,
            signal: this.stopper.signal,
            ...options,
        });
    }

    /** The wait before reconnect attempt n: 1 s, 2 s, 4 s ... up to maxBackoffMs, with a little jitter. */
    backoff() {
        const base = Math.min(this.maxBackoffMs, 1000 * 2 ** Math.min(this.connectAttempt, 6));
        this.connectAttempt += 1;
        return Math.round(base * (0.8 + Math.random() * 0.4));
    }

    /**
     * Find the gateway (retrying a network fault for as long as it lasts), then
     * keep a connection open until stop(). Resolves once the first READY
     * names the bot; rejects only on a fault that time cannot fix (a refused
     * token, a refused intent).
     */
    async start() {
        this.runner = this.run();
        await this.ready;
    }

    /** Find the gateway and drive connect → events → reconnect until stop(). */
    async run() {
        while (!this.closing && this.gatewayUrl === null) {
            try {
                const answer = await this.rest('GET', '/gateway/bot');
                if (typeof answer?.url !== 'string' || answer.url === '') throw new DiscordError('Discord gave no gateway address', { retryable: true });
                this.gatewayUrl = answer.url;
            } catch (error) {
                if (this.closing) break;
                if (error?.status === 401 || error?.status === 403) {
                    const message = `Discord refused the bot token (${error.status}); check the token stored under tokenRef`;
                    this.fail(message);
                    return;
                }
                const delay = this.backoff();
                this.state.lastError = error?.message ?? String(error);
                this.trace('gateway', 'lookup-retry', { delayMs: delay, error: String(error?.message ?? error).slice(0, 200) });
                this.logger.warn('discord: %s; trying again in %d s', error?.message ?? error, Math.round(delay / 1000));
                await sleep(delay, this.stopper.signal);
            }
        }
        while (!this.closing) {
            try {
                await this.connect();
            } catch (error) {
                if (this.closing) break;
                if (error?.fatal) {
                    this.fail(error.message);
                    return;
                }
                this.state.lastError = error?.message ?? String(error);
            }
            if (this.closing) break;
            const delay = this.backoff();
            this.state.reconnects += 1;
            this.trace('gateway', 'retry-scheduled', { delayMs: delay, error: String(this.state.lastError ?? '').slice(0, 200) });
            this.logger.warn('discord: gateway disconnected (%s); reconnecting in %d s', this.state.lastError ?? 'closed', Math.round(delay / 1000));
            await sleep(delay, this.stopper.signal);
        }
        this.settleReady(new DiscordError('the client stopped before it connected'));
    }

    /** A fault time cannot fix: say it once, stop for good. */
    fail(message) {
        this.state.fatal = message;
        this.state.connected = false;
        this.trace('gateway', 'fatal', { reason: message });
        this.logger.warn('discord: %s. The bot stays offline until the setting is fixed and the plugin is reloaded.', message);
        this.settleReady(Object.assign(new DiscordError(message), { fatal: true }));
    }

    /** Settle the first-READY promise exactly once. */
    settleReady(error) {
        if (this.readyResolved) return;
        this.readyResolved = true;
        if (error === undefined) this.readyResolve();
        else this.readyReject(error);
    }

    /**
     * Open one gateway session and return when it ends.
     * @returns {Promise<void>} resolves when the socket closes after it was in use; rejects (`.fatal` set for
     *   codes that are never retried) when it closed before READY or RESUMED.
     */
    connect() {
        const resuming = this.sessionId !== null && this.lastSeq !== null;
        const base = resuming && this.resumeUrl ? this.resumeUrl : this.gatewayUrl;
        return new Promise((resolve, reject) => {
            let ws;
            try {
                ws = new WebSocket(`${base}${base.includes('?') ? '&' : '?'}v=10&encoding=json`);
            } catch (error) {
                reject(new DiscordError(`could not open the gateway (${error?.message ?? error})`, { retryable: true }));
                return;
            }
            this.ws = ws;
            let inUse = false;
            let settled = false;

            const finish = (error) => {
                if (settled) return;
                settled = true;
                this.clearHeartbeat();
                this.state.connected = false;
                try { ws.close(4000); } catch {}
                if (inUse && !error?.fatal) resolve();
                else reject(error);
            };

            ws.onopen = () => {
                this.trace('gateway', 'open', { resuming });
            };
            ws.onmessage = (event) => {
                let payload;
                try {
                    payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
                } catch {
                    return;
                }
                this.state.lastEventAt = new Date().toISOString();
                switch (payload.op) {
                    case 10: { // HELLO
                        if (this.sessionId !== null && this.lastSeq !== null) {
                            this.send(ws, 6, { token: this.token, session_id: this.sessionId, seq: this.lastSeq });
                            this.trace('gateway', 'resume-sent', { seq: this.lastSeq });
                        } else {
                            this.send(ws, 2, {
                                token: this.token,
                                intents: this.intents,
                                properties: { os: process.platform, browser: 'dsh-plugin-discord', device: 'dsh-plugin-discord' },
                            });
                            this.trace('gateway', 'identify-sent', { intents: this.intents });
                        }
                        this.startHeartbeat(ws, Number(payload.d?.heartbeat_interval) || 41250);
                        break;
                    }
                    case 11: this.heartbeatAcked = true; break;
                    case 1: this.send(ws, 1, this.lastSeq); break;
                    case 7: // RECONNECT: drop and resume
                        this.trace('gateway', 'reconnect-requested', {});
                        inUse = true;
                        finish(new DiscordError('Discord asked the bot to reconnect', { retryable: true }));
                        break;
                    case 9: { // INVALID SESSION
                        const resumable = payload.d === true;
                        if (!resumable) {
                            this.sessionId = null;
                            this.lastSeq = null;
                            this.resumeUrl = null;
                        }
                        this.trace('gateway', 'invalid-session', { resumable });
                        inUse = true;
                        finish(new DiscordError('Discord ended the gateway session', { retryable: true }));
                        break;
                    }
                    case 0: this.dispatch(payload, () => { inUse = true; }); break;
                    default: break;
                }
            };
            ws.onclose = (event) => {
                const fatalMessage = FATAL_CLOSE_CODES.get(event.code);
                this.trace('gateway', 'closed', { code: event.code, fatal: fatalMessage !== undefined });
                if (event.code === 4007 || event.code === 4009) {
                    // Bad sequence or a timed-out session: the next dial identifies afresh.
                    this.sessionId = null;
                    this.lastSeq = null;
                    this.resumeUrl = null;
                }
                const error = new DiscordError(fatalMessage ?? `the gateway closed (code ${event.code})`, { retryable: fatalMessage === undefined });
                error.fatal = fatalMessage !== undefined;
                finish(error);
            };
            ws.onerror = () => {
                // onclose always follows.
            };
        });
    }

    /** One DISPATCH event (op 0). */
    dispatch(payload, markInUse) {
        const { t, d, s } = payload;
        if (s !== null && s !== undefined) this.lastSeq = s;
        if (t === 'READY') {
            this.botUser = d.user;
            this.sessionId = d.session_id;
            this.resumeUrl = typeof d.resume_gateway_url === 'string' && d.resume_gateway_url !== '' ? d.resume_gateway_url : null;
            this.connectAttempt = 0;
            markInUse();
            this.state.connected = true;
            this.state.since = new Date().toISOString();
            this.state.lastError = null;
            this.settleReady();
            this.trace('gateway', 'ready', { botId: d.user?.id });
            this.logger.info('discord: connected as %s', d.user?.username ?? 'the bot');
            this.handOff('ready', () => this.onReady({ resumed: false, sessionId: d.session_id }));
        } else if (t === 'RESUMED') {
            this.connectAttempt = 0;
            markInUse();
            this.state.connected = true;
            this.trace('gateway', 'resumed', {});
            this.logger.info('discord: gateway session resumed');
            this.handOff('ready', () => this.onReady({ resumed: true, sessionId: this.sessionId }));
        } else if (t === 'MESSAGE_CREATE') {
            this.trace('message', 'received', {
                messageId: d?.id,
                authorId: d?.author?.id,
                isBot: d?.author?.bot === true,
                channelId: d?.channel_id,
                contentLength: typeof d?.content === 'string' ? d.content.length : -1,
            });
            this.handOff('MESSAGE_CREATE', () => this.onMessage(d));
        } else if (t === 'INTERACTION_CREATE') {
            this.trace('interaction', 'received', { name: d?.data?.name, channelId: d?.channel?.id ?? d?.channel_id });
            this.handOff('INTERACTION_CREATE', () => this.onInteraction(d));
        }
    }

    /** Run a handler; its throw or rejection is logged, never left to the host. */
    handOff(what, run) {
        let result;
        try {
            result = run();
        } catch (error) {
            this.handlerFailed(what, error);
            return;
        }
        if (result && typeof result.then === 'function') result.then(undefined, (error) => this.handlerFailed(what, error));
    }

    handlerFailed(what, error) {
        this.trace('handler', 'error', { what, error: String(error?.stack ?? error).slice(0, 400) });
        this.logger.warn('discord: %s handler failed: %s', what, error?.message ?? error);
    }

    /** Send one JSON payload over the gateway. */
    send(ws, op, d) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ op, d }));
    }

    /** Periodically prove liveness; a missed ack drops the socket (and resumes). */
    startHeartbeat(ws, intervalMs) {
        this.clearHeartbeat();
        const beat = () => {
            if (this.closing || ws.readyState !== WebSocket.OPEN) return;
            if (!this.heartbeatAcked) {
                this.trace('gateway', 'heartbeat-missed', {});
                this.logger.warn('discord: Discord did not answer a heartbeat; reconnecting');
                try { ws.close(4000); } catch {}
                return;
            }
            this.heartbeatAcked = false;
            this.send(ws, 1, this.lastSeq);
        };
        this.heartbeat = setInterval(beat, Math.max(1000, Math.round(intervalMs * 0.9)));
    }

    clearHeartbeat() {
        if (this.heartbeat !== null) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
        this.heartbeatAcked = true;
    }

    /** Stop the gateway cleanly; safe to call more than once. */
    async stop() {
        this.closing = true;
        this.stopper.abort();
        this.clearHeartbeat();
        this.state.connected = false;
        if (this.ws !== null) {
            try { this.ws.close(1000); } catch {}
            this.ws = null;
        }
        await this.runner?.catch(() => {});
    }

    /**
     * Send text to a channel, split past Discord's 2000-character limit on
     * paragraph or code-fence boundaries (never inside a code block).
     * @param {string} channelId - snowflake.
     * @param {string} content - text content.
     * @param {object} [extra] - more message fields (message_reference, flags), on the last part only.
     * @returns {Promise<{messageId: string|null, messageIds: string[], chunkCount: number}>}
     */
    async sendMessage(channelId, content, extra) {
        const chunks = splitForDiscord(content, 2000);
        const messageIds = [];
        for (let index = 0; index < chunks.length; index++) {
            const isLast = index === chunks.length - 1;
            const fields = { content: chunks[index], allowed_mentions: ALLOWED_MENTIONS };
            if (isLast && extra) Object.assign(fields, extra);
            const sent = await this.rest('POST', `/channels/${discordId(channelId, 'channel id')}/messages`, fields);
            if (sent?.id) messageIds.push(sent.id);
        }
        return { messageId: messageIds.at(-1) ?? null, messageIds, chunkCount: chunks.length };
    }

    /**
     * Upload one local file as a message attachment.
     * @param {string} channelId - target channel.
     * @param {{buffer: Buffer, filename: string}} file - file content and name.
     * @param {string} [caption] - optional message text.
     * @returns {Promise<{messageId: string|null}>}
     */
    async sendFile(channelId, file, caption) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify({ content: caption ?? '', allowed_mentions: ALLOWED_MENTIONS }));
        form.append('files[0]', new Blob([file.buffer]), file.filename);
        const message = await this.rest('POST', `/channels/${discordId(channelId, 'channel id')}/messages`, form, { timeoutMs: Math.max(this.requestTimeoutMs, 60000) });
        return { messageId: message?.id ?? null };
    }

    /** Trigger the typing indicator (decays after ~10 s or on send). */
    async triggerTyping(channelId) {
        await this.rest('POST', `/channels/${discordId(channelId, 'channel id')}/typing`);
    }

    /**
     * Create a thread anchored to a message (or a standalone thread).
     * @param {string} channelId - parent channel.
     * @param {string} name - thread name (1-100 chars).
     * @param {{messageId?: string, autoArchiveMinutes?: number}} [options]
     * @returns {Promise<{threadId: string|null}>}
     */
    async createThread(channelId, name, { messageId, autoArchiveMinutes = 1440 } = {}) {
        const trimmed = String(name ?? '').trim();
        if (trimmed.length < 1 || trimmed.length > 100) throw new DiscordError('a thread name must be 1 to 100 characters');
        const thread = messageId
            ? await this.rest('POST', `/channels/${discordId(channelId, 'channel id')}/messages/${discordId(messageId, 'message id')}/threads`, { name: trimmed, auto_archive_duration: autoArchiveMinutes })
            : await this.rest('POST', `/channels/${discordId(channelId, 'channel id')}/threads`, { name: trimmed, type: 11, auto_archive_duration: autoArchiveMinutes });
        return { threadId: thread?.id ?? null };
    }

    /** Rename a thread (Discord allows about two renames per 10 minutes per thread). */
    async renameThread(threadId, name, reason) {
        const trimmed = String(name ?? '').trim();
        if (trimmed.length < 1 || trimmed.length > 100) throw new DiscordError('a thread name must be 1 to 100 characters');
        await this.rest('PATCH', `/channels/${discordId(threadId, 'thread id')}`, { name: trimmed }, { reason });
    }

    /** Unarchive an archived thread. */
    async unarchiveThread(threadId, reason) {
        await this.rest('PATCH', `/channels/${discordId(threadId, 'thread id')}`, { archived: false }, { reason });
    }

    /** Fetch a channel object (type, name, thread metadata, parent). */
    async getChannel(channelId) {
        return await this.rest('GET', `/channels/${discordId(channelId, 'channel id')}`);
    }

    /**
     * Messages newer than `after`, oldest first (Discord answers newest first).
     * @param {string} channelId
     * @param {{after: string, limit?: number}} options
     */
    async getMessagesAfter(channelId, { after, limit = 50 }) {
        const list = await this.rest('GET', `/channels/${discordId(channelId, 'channel id')}/messages?after=${encodeURIComponent(after)}&limit=${Math.min(100, Math.max(1, limit))}`);
        return (Array.isArray(list) ? list : []).slice().sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    }

    /** Add `emoji` (unicode or `name:id`) to a message. Plain ASCII that is not name:id (".", "..") is refused: it could change the route. */
    async addReaction(channelId, messageId, emoji) {
        const channel = discordId(channelId, 'channel id');
        const message = discordId(messageId, 'message id');
        const text = typeof emoji === 'string' ? emoji.trim() : '';
        if (text === '' || text.length > 64 || !(/[^\x00-\x7f]/.test(text) || /^\w{2,32}:\d{17,20}$/.test(text))) {
            throw new DiscordError(`${JSON.stringify(String(emoji ?? '').slice(0, 40))} is not an emoji (a unicode emoji, or name:id for a custom one)`);
        }
        await this.rest('PUT', `/channels/${channel}/messages/${message}/reactions/${part(text)}/@me`);
    }

    /** Fetch a user's public identity. */
    async getUser(userId) {
        return await this.rest('GET', `/users/${discordId(userId, 'user id')}`);
    }

    /**
     * Make the application's global slash commands match `commands`: new or
     * changed ones are posted (Discord replaces a command of the same name).
     * @param {string} appId - application id (the bot's user id).
     * @param {object[]} commands - Discord application command definitions.
     * @returns {Promise<string[]>} the names posted.
     */
    async ensureCommands(appId, commands) {
        const existing = await this.rest('GET', `/applications/${discordId(appId, 'application id')}/commands`);
        const byName = new Map((Array.isArray(existing) ? existing : []).map((c) => [c.name, c]));
        const same = (a, b) => a.description === b.description
            && JSON.stringify((a.options ?? []).map(({ name, description, type, required }) => ({ name, description, type, required: Boolean(required) })))
                === JSON.stringify((b.options ?? []).map(({ name, description, type, required }) => ({ name, description, type, required: Boolean(required) })));
        const posted = [];
        for (const command of commands) {
            const now = byName.get(command.name);
            if (now && same(now, command)) continue;
            await this.rest('POST', `/applications/${discordId(appId, 'application id')}/commands`, command);
            posted.push(command.name);
        }
        this.trace('commands', posted.length > 0 ? 'registered' : 'already-registered', { names: posted.length > 0 ? posted : commands.map((c) => c.name) });
        return posted;
    }

    /** Answer an interaction at once (type 4). `ephemeral` shows the answer to the asker only. */
    async respondInteraction(interaction, content, { ephemeral = false } = {}) {
        await this.rest('POST', `/interactions/${discordId(interaction.id, 'interaction id')}/${part(interaction.token)}/callback`, {
            type: 4,
            data: { content, allowed_mentions: ALLOWED_MENTIONS, ...(ephemeral ? { flags: 64 } : {}) },
        }, { auth: false });
    }

    /** Defer an interaction (type 5): Discord shows "thinking" until the answer is edited in. */
    async deferInteraction(interaction, { ephemeral = false } = {}) {
        await this.rest('POST', `/interactions/${discordId(interaction.id, 'interaction id')}/${part(interaction.token)}/callback`, {
            type: 5,
            ...(ephemeral ? { data: { flags: 64 } } : {}),
        }, { auth: false });
    }

    /** Edit the original answer of a deferred interaction. */
    async editInteractionResponse(interaction, content) {
        await this.rest('PATCH', `/webhooks/${discordId(interaction.application_id, 'application id')}/${part(interaction.token)}/messages/@original`, {
            content,
            allowed_mentions: ALLOWED_MENTIONS,
        }, { auth: false });
    }
}
