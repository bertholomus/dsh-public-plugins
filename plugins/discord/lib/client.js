/**
 * Zero-dependency Discord client: REST over `fetch` and the Gateway over the
 * global `WebSocket` (Node 22+). Implements identify, heartbeating, resume, a
 * bounded reconnect ladder, slash-command registration, interaction callbacks,
 * multipart file upload, and thread management. Deliberately minimal: no
 * voice, no member cache — event routing plus the REST surface the plugin needs.
 *
 * @module dsh-plugin-discord/client
 */
import { splitForDiscord } from './split.js';

/** Discord REST base. */
const REST_BASE = 'https://discord.com/api/v10';

/** Close codes that must never be retried: the fix is configuration, not time. */
const FATAL_CLOSE_CODES = new Map([
    [4004, 'authentication failed — check the bot token'],
    [4010, 'invalid shard — this client is single-shard'],
    [4011, 'sharding required — the bot is in too many guilds'],
    [4013, 'invalid intent(s) — check the configured intents bitmask'],
    [4014, 'disallowed intent(s) — enable "Message Content Intent" and any other privileged intents in the Discord Developer Portal for this application'],
]);

/** Default intents: GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15). */
export const DEFAULT_INTENTS = 0x1 | 0x200 | 0x1000 | 0x8000;

/**
 * One authenticated REST call. Retries once on 429 honoring `retry_after`;
 * throws a descriptive Error on other non-2xx responses.
 * @param {object} options
 * @param {string} options.apiBase
 * @param {string} options.token - bot token.
 * @param {string} options.method - HTTP verb.
 * @param {string} options.path - path beginning with `/`.
 * @param {object|FormData} [options.body] - JSON body (or FormData for multipart).
 * @param {string} [options.reason] - audit-log reason header.
 * @param {number} [options.timeoutMs]
 * @param {string} [options.overrideToken] - use instead of the bot token (interaction callbacks).
 * @param {boolean} [options.json] - false to return the raw Response.
 * @returns {Promise<object|Response|null>}
 */
async function restCall({ apiBase, token, method, path, body, reason, timeoutMs = 15000, overrideToken, json = true }) {
    const url = `${apiBase}${path}`;
    for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            const headers = {
                ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
                ...(reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason) } : {}),
            };
            const auth = overrideToken ?? token;
            if (auth) headers.Authorization = auth.startsWith('Bot ') ? auth : `Bot ${auth}`;
            response = await fetch(url, {
                method,
                signal: controller.signal,
                headers,
                body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
            });
        } finally {
            clearTimeout(timer);
        }
        if (response.status === 429 && attempt === 0) {
            const retryBody = await response.json().catch(() => ({}));
            const seconds = Number(retryBody?.retry_after) || 1;
            await sleep(seconds * 1000);
            continue;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            const error = new Error(`discord REST ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
            error.status = response.status;
            throw error;
        }
        if (!json) return response;
        if (response.status === 204) return null;
        return await response.json().catch(() => null);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A live Discord connection with typed REST helpers. */
export class DiscordClient {
    /**
     * @param {object} options
     * @param {string} options.token - bot token (already resolved from the credential store).
     * @param {(message: object) => void} options.onMessage - every MESSAGE_CREATE payload.
     * @param {(interaction: object) => void} [options.onInteraction] - every INTERACTION_CREATE payload.
     * @param {object} [options.logger] - cordis-style logger (info/warn/debug).
     * @param {(event: string, status: string, data?: object) => void} [options.trace] - plugin trace sink.
     * @param {number} [options.intents] - gateway intents bitmask.
     * @param {number} [options.requestTimeoutMs] - per-REST-call timeout.
     * @param {string} [options.apiBase] - REST base override (tests).
     */
    constructor({ token, onMessage, onInteraction, logger, trace, intents = DEFAULT_INTENTS, requestTimeoutMs = 15000, apiBase = REST_BASE }) {
        this.token = token;
        this.onMessage = onMessage;
        this.onInteraction = onInteraction ?? (() => {});
        this.logger = logger ?? { info() {}, warn() {}, debug() {} };
        this.trace = trace ?? (() => {});
        this.intents = intents;
        this.requestTimeoutMs = requestTimeoutMs;
        this.apiBase = apiBase;
        this.ws = null;
        this.botUser = null;
        this.lastSeq = null;
        this.sessionId = null;
        this.heartbeat = null;
        this.heartbeatAcked = true;
        this.closing = false;
        this.connectAttempt = 0;
        /** Set by start() and kept for stop(); not awaited by callers. */
        this.runner = null;
        /** Resolves on first READY, rejects on fatal configuration failure. */
        this.readyResolved = false;
        this.ready = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
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
            ...options,
        });
    }

    /**
     * Open the gateway, identify (or resume), and keep the connection alive.
     * Resolves once READY establishes the bot identity; reconnects continue in
     * the background for the lifetime of the client.
     */
    async start() {
        const { url } = await this.rest('GET', '/gateway/bot');
        this.runner = this.runGateway(url);
        // Wait for the first READY (or fatal failure) before returning so the
        // plugin knows its identity; later reconnects are transparent.
        await this.ready;
    }

    /** Drive connect → events → reconnect until stop(). */
    async runGateway(gatewayUrl) {
        for (;;) {
            if (this.closing) {
                this.settleReady(new Error('discord: client stopped before connecting'));
                return;
            }
            try {
                await this.connect(gatewayUrl);
            } catch (error) {
                if (this.closing) return;
                if (error?.fatal) {
                    this.logger.warn('discord: %s', error.message);
                    this.settleReady(error);
                    return;
                }
                const delay = Math.min(30000, 1000 * 2 ** Math.min(this.connectAttempt, 5));
                this.connectAttempt += 1;
                this.trace('gateway', 'retry-scheduled', { delayMs: delay, error: String(error?.message ?? error).slice(0, 200) });
                this.logger.warn('discord: gateway disconnected (%s); reconnecting in %dms', error?.message ?? error, delay);
                await sleep(delay);
                continue;
            }
            if (this.closing) return;
            // connect() resolved because the socket closed cleanly; retry.
            this.connectAttempt += 1;
            await sleep(Math.min(30000, 1000 * 2 ** Math.min(this.connectAttempt, 5)));
        }
    }

    /** Settle the first-READY promise exactly once. */
    settleReady(error) {
        if (this.readyResolved) return;
        this.readyResolved = true;
        if (error === undefined) this.readyResolve();
        else this.readyReject(error);
    }

    /**
     * Open one gateway session and return when it ends (cleanly or not).
     * @param {string} gatewayUrl - wss URL from /gateway/bot.
     * @returns {Promise<void>} resolves on socket close; rejects with `.fatal` set for non-retryable close codes.
     */
    connect(gatewayUrl) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`${gatewayUrl}?v=10&encoding=json`);
            this.ws = ws;
            let identified = false;

            /** Deliver a fatal or ordinary close to the run loop. */
            const finish = (error) => {
                this.clearHeartbeat();
                try { ws.close(); } catch {}
                if (identified) resolve();
                else reject(error);
            };

            ws.onopen = () => {
                this.logger.debug('discord: gateway socket open');
                this.trace('gateway', 'open', {});
            };
            ws.onmessage = (event) => {
                let payload;
                try {
                    payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
                } catch {
                    return;
                }
                this.handlePayload(payload, {
                    onHello: () => {
                        // Resume when we own a live session id; identify otherwise.
                        if (this.sessionId !== null && this.lastSeq !== null) {
                            this.send(ws, 6, { token: this.token, session_id: this.sessionId, seq: this.lastSeq });
                            this.trace('gateway', 'resume-sent', { sessionId: this.sessionId });
                        } else {
                            this.send(ws, 2, {
                                token: this.token,
                                intents: this.intents,
                                properties: { os: process.platform, browser: 'dsh-plugin-discord', device: 'dsh-plugin-discord' },
                            });
                            this.trace('gateway', 'identify-sent', { intents: this.intents });
                        }
                        this.startHeartbeat(payload.d.heartbeat_interval);
                    },
                    onDispatch: (t, d, s) => {
                        if (s !== null && s !== undefined) this.lastSeq = s;
                        if (t === 'READY') {
                            this.botUser = d.user;
                            this.sessionId = d.session_id;
                            this.connectAttempt = 0;
                            identified = true;
                            this.settleReady();
                            this.trace('gateway', 'ready', { botId: d.user.id, sessionId: d.session_id });
                            this.logger.info('discord: connected as %s (%s)', d.user.username, d.user.id);
                        } else if (t === 'MESSAGE_CREATE') {
                            this.trace('message', 'received', {
                                authorId: d?.author?.id,
                                isBot: d?.author?.bot === true,
                                channelId: d?.channel_id,
                                guildId: d?.guild_id ?? null,
                                contentLength: typeof d?.content === 'string' ? d.content.length : -1,
                                preview: typeof d?.content === 'string' ? d.content.slice(0, 80) : '',
                            });
                            try {
                                this.onMessage(d);
                            } catch (error) {
                                this.trace('message', 'handler-error', { error: String(error?.stack ?? error).slice(0, 400) });
                                this.logger.warn('discord: MESSAGE_CREATE handler failed: %s', error?.stack ?? error);
                            }
                        } else if (t === 'INTERACTION_CREATE') {
                            this.trace('interaction', 'received', { name: d?.data?.name, channelId: d?.channel?.id });
                            try {
                                this.onInteraction(d);
                            } catch (error) {
                                this.trace('interaction', 'handler-error', { error: String(error?.stack ?? error).slice(0, 400) });
                                this.logger.warn('discord: INTERACTION_CREATE handler failed: %s', error?.stack ?? error);
                            }
                        } else if (t === 'RESUMED') {
                            identified = true;
                            this.trace('gateway', 'resumed', {});
                            this.logger.info('discord: gateway session resumed');
                        }
                    },
                    onReconnect: () => {
                        // Server-requested reconnect: drop to RESUME on the next dial.
                        this.trace('gateway', 'reconnect-requested', {});
                        finish(new Error('server requested reconnect'));
                    },
                    onInvalidSession: (resumable) => {
                        if (!resumable) {
                            this.sessionId = null;
                            this.lastSeq = null;
                        }
                        this.trace('gateway', 'invalid-session', { resumable });
                        finish(new Error('invalid session'));
                    },
                    onHeartbeatRequest: () => {
                        this.send(ws, 1, this.lastSeq);
                    },
                });
            };
            ws.onclose = (event) => {
                const fatalMessage = FATAL_CLOSE_CODES.get(event.code);
                this.clearHeartbeat();
                this.trace('gateway', 'closed', { code: event.code, fatal: fatalMessage !== undefined, reason: fatalMessage ?? null });
                const error = new Error(
                    fatalMessage
                        ? `gateway closed (${event.code}): ${fatalMessage}`
                        : `gateway closed (${event.code})`,
                );
                error.fatal = fatalMessage !== undefined;
                if (event.code === 4007) {
                    // Invalid seq: discard resume state so the next dial identifies.
                    this.sessionId = null;
                    this.lastSeq = null;
                }
                finish(error);
            };
            ws.onerror = () => {
                // onclose always follows; nothing to do here.
            };
        });
    }

    /** Send one JSON payload over the gateway. */
    send(ws, op, d) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ op, d }));
    }

    /** Periodically prove liveness; a missed ack terminates the socket. */
    startHeartbeat(intervalMs) {
        this.clearHeartbeat();
        const beat = () => {
            if (this.closing || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            if (!this.heartbeatAcked) {
                // Missed ack: force a fresh session rather than a zombie socket.
                this.logger.warn('discord: missed heartbeat ack; forcing reconnect');
                try { this.ws.close(); } catch {}
                return;
            }
            this.heartbeatAcked = false;
            this.send(this.ws, 1, this.lastSeq);
        };
        this.heartbeat = setInterval(beat, Math.max(5000, intervalMs * 0.8));
    }

    clearHeartbeat() {
        if (this.heartbeat !== null) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
        this.heartbeatAcked = true;
    }

    /** Handle one decoded gateway payload. */
    handlePayload(payload, handlers) {
        switch (payload.op) {
            case 10: handlers.onHello(payload.d); break;
            case 11: this.heartbeatAcked = true; break;
            case 1: handlers.onHeartbeatRequest(); break;
            case 7: handlers.onReconnect(); break;
            case 9: handlers.onInvalidSession(payload.d === true); break;
            case 0: handlers.onDispatch(payload.t, payload.d, payload.s); break;
            default: break;
        }
    }

    /** Stop the gateway cleanly; safe to call more than once. */
    async stop() {
        this.closing = true;
        this.clearHeartbeat();
        if (this.ws !== null) {
            try { this.ws.close(1000); } catch {}
            this.ws = null;
        }
    }

    /**
     * Send text to a channel, splitting past Discord's 2000-char limit on
     * paragraph or code-fence boundaries (never inside a code block).
     * @param {string} channelId - snowflake.
     * @param {string} content - text content.
     * @param {object} [extra] - additional message fields (message_reference, flags).
     * @returns {Promise<{messageId: string, chunkCount: number}>} last message id and chunk count.
     */
    async sendMessage(channelId, content, extra) {
        const chunks = splitForDiscord(content, 2000);
        let last = null;
        for (let index = 0; index < chunks.length; index++) {
            const isLast = index === chunks.length - 1;
            const fields = { content: chunks[index] };
            // Only the final chunk carries the reply reference so it anchors
            // to the completed message.
            if (isLast && extra) Object.assign(fields, extra);
            last = await this.rest('POST', `/channels/${channelId}/messages`, fields);
        }
        return { messageId: last?.id ?? null, chunkCount: chunks.length };
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
        form.append('payload_json', JSON.stringify({ content: caption ?? '' }));
        form.append('files[0]', new Blob([file.buffer]), file.filename);
        const message = await restCall({
            apiBase: this.apiBase,
            token: this.token,
            method: 'POST',
            path: `/channels/${channelId}/messages`,
            body: form,
            timeoutMs: Math.max(this.requestTimeoutMs, 60000),
        });
        return { messageId: message?.id ?? null };
    }

    /** Trigger the typing indicator (decays after ~10s or on send). */
    async triggerTyping(channelId) {
        await this.rest('POST', `/channels/${channelId}/typing`);
    }

    /**
     * Create a thread anchored to a message (or a standalone thread in channels that allow it).
     * @param {string} channelId - parent channel (or thread-starter message's channel).
     * @param {string} name - thread name (1-100 chars).
     * @param {object} [options]
     * @param {string} [options.messageId] - anchor message; omit to start without message.
     * @param {number} [options.autoArchiveMinutes] - auto-archive duration in minutes (60/1440/4320/10080).
     * @param {number} [options.rateLimitPerUser] - per-user slowmode seconds.
     * @returns {Promise<{threadId: string, channelId: string}>} created thread.
     */
    async createThread(channelId, name, { messageId, autoArchiveMinutes = 1440 } = {}) {
        const trimmed = String(name ?? '').trim();
        if (trimmed.length < 1 || trimmed.length > 100) {
            throw new Error('discord: thread name must be 1-100 characters');
        }
        let thread;
        if (messageId) {
            thread = await this.rest('POST', `/channels/${channelId}/messages/${messageId}/threads`, {
                name: trimmed,
                auto_archive_duration: autoArchiveMinutes,
            });
        } else {
            thread = await this.rest('POST', `/channels/${channelId}/threads`, {
                name: trimmed,
                type: 11,
                auto_archive_duration: autoArchiveMinutes,
            });
        }
        return { threadId: thread?.id ?? null, channelId: thread?.id ?? null };
    }

    /**
     * Rename a thread. Discord rate-limits thread name changes (~2 per 10 min
     * per thread); a 429 surfaces as an error the caller must tolerate.
     * @param {string} threadId
     * @param {string} name - 1-100 chars.
     * @param {string} [reason] - audit-log reason.
     */
    async renameThread(threadId, name, reason) {
        const trimmed = String(name ?? '').trim();
        if (trimmed.length < 1 || trimmed.length > 100) {
            throw new Error('discord: thread name must be 1-100 characters');
        }
        await this.rest('PATCH', `/channels/${threadId}`, { name: trimmed }, { reason });
    }

    /** Unarchive an archived thread (no-op for open threads is handled by caller). */
    async unarchiveThread(threadId, reason) {
        await this.rest('PATCH', `/channels/${threadId}`, { archived: false }, { reason });
    }

    /** Fetch a channel object (type, name, thread metadata, parent). */
    async getChannel(channelId) {
        return await this.rest('GET', `/channels/${channelId}`);
    }

    /** Add `emoji` (unicode or `name:id`) to a message. */
    async addReaction(channelId, messageId, emoji) {
        await this.rest('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
    }

    /** Fetch a user's public identity. */
    async getUser(userId) {
        return await this.rest('GET', `/users/${userId}`);
    }

    /**
     * Idempotently ensure the given global application commands exist.
     * @param {string} appId - application id (the bot's user id).
     * @param {object[]} commands - Discord application command definitions.
     */
    async ensureCommands(appId, commands) {
        const existing = await this.rest('GET', `/applications/${appId}/commands`);
        const known = new Set((Array.isArray(existing) ? existing : []).map((c) => c.name));
        const missing = commands.filter((command) => !known.has(command.name));
        if (missing.length === 0) {
            this.trace('commands', 'already-registered', { names: [...known] });
            return;
        }
        for (const command of missing) {
            await this.rest('POST', `/applications/${appId}/commands`, command);
        }
        this.trace('commands', 'registered', { names: missing.map((c) => c.name) });
    }

    /** Answer an interaction immediately (type 4 CHANNEL_MESSAGE_WITH_SOURCE). */
    async respondInteraction(interaction, content) {
        await restCall({
            apiBase: this.apiBase,
            token: this.token,
            method: 'POST',
            path: `/interactions/${interaction.id}/${interaction.token}/callback`,
            body: { type: 4, data: { content } },
            timeoutMs: this.requestTimeoutMs,
        });
    }

    /** Defer an interaction (type 5), then edit the original response later. */
    async deferInteraction(interaction) {
        await restCall({
            apiBase: this.apiBase,
            token: this.token,
            method: 'POST',
            path: `/interactions/${interaction.id}/${interaction.token}/callback`,
            body: { type: 5 },
            timeoutMs: this.requestTimeoutMs,
        });
    }

    /** Edit the original response of a deferred interaction. */
    async editInteractionResponse(interaction, content) {
        await restCall({
            apiBase: this.apiBase,
            token: this.token,
            method: 'PATCH',
            path: `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
            body: { content },
            timeoutMs: this.requestTimeoutMs,
        });
    }
}
