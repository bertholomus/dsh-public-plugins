/**
 * A fake Discord for the tests: its REST API and its Gateway (a WebSocket
 * server written on node:http, no packages), on 127.0.0.1 only. The plugin
 * is pointed at it with `apiBase`; `GET /gateway/bot` here hands out this
 * server's own gateway address, so nothing ever leaves this computer.
 *
 * It keeps channels, threads and messages like Discord does, records every
 * request, and lets a test play the people in a channel (userMessage,
 * interaction), drop or refuse things (failNext, rateLimitNext, closeSocket,
 * requestReconnect, invalidSession, stopAcking) and replay missed events on a
 * RESUME, as the real gateway does.
 *
 * @module test/support/fake-discord
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DISCORD_EPOCH = 1420070400000n;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `fn` returns something truthy; throws, naming `what`, after `timeout` ms. */
export async function waitFor(fn, what, timeout = 10000, every = 25) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (error) {
            last = error;
        }
        await sleep(every);
    }
    throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

/** One WebSocket connection, server side (RFC 6455, text frames, close, ping/pong). */
class Socket {
    constructor(socket, onText, onClose) {
        this.socket = socket;
        this.open = true;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.onText = onText;
        this.onClose = onClose;
        this.closeCode = null;
        socket.on('data', (chunk) => this.read(chunk));
        socket.on('close', () => this.ended());
        socket.on('error', () => this.ended());
    }

    ended() {
        if (!this.open) return;
        this.open = false;
        this.onClose(this.closeCode ?? 1006);
    }

    read(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            if (this.buffer.length < 2) return;
            const b0 = this.buffer[0];
            const b1 = this.buffer[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let length = b1 & 0x7f;
            let at = 2;
            if (length === 126) {
                if (this.buffer.length < 4) return;
                length = this.buffer.readUInt16BE(2);
                at = 4;
            } else if (length === 127) {
                if (this.buffer.length < 10) return;
                length = Number(this.buffer.readBigUInt64BE(2));
                at = 10;
            }
            const maskAt = at;
            if (masked) at += 4;
            if (this.buffer.length < at + length) return;
            let payload = this.buffer.subarray(at, at + length);
            if (masked) {
                const mask = this.buffer.subarray(maskAt, maskAt + 4);
                payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
            }
            this.buffer = this.buffer.subarray(at + length);
            if (opcode === 0x8) {
                this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                this.frame(0x8, payload.subarray(0, 2));
                this.socket.end();
                this.ended();
                return;
            }
            if (opcode === 0x9) {
                this.frame(0xa, payload);
                continue;
            }
            if (opcode === 0xa) continue;
            if (opcode === 0x1 || opcode === 0x0) {
                this.fragments.push(payload);
                if (fin) {
                    const text = Buffer.concat(this.fragments).toString('utf8');
                    this.fragments = [];
                    this.onText(text);
                }
            }
        }
    }

    frame(opcode, payload) {
        if (this.socket.destroyed) return;
        const length = payload.length;
        let header;
        if (length < 126) {
            header = Buffer.from([0x80 | opcode, length]);
        } else if (length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 126;
            header.writeUInt16BE(length, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(length), 2);
        }
        this.socket.write(Buffer.concat([header, payload]));
    }

    sendJson(value) {
        if (this.open) this.frame(0x1, Buffer.from(JSON.stringify(value)));
    }

    close(code = 1000) {
        if (!this.open) return;
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        this.closeCode = code;
        this.frame(0x8, payload);
        this.socket.end();
        setTimeout(() => this.socket.destroy(), 50).unref?.();
        this.ended();
    }

    drop() {
        this.socket.destroy();
        this.ended();
    }
}

/** Read a request body: JSON, or a multipart upload (its payload_json and its files' names and sizes). */
async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const type = String(req.headers['content-type'] ?? '');
    if (raw.length === 0) return undefined;
    if (type.startsWith('multipart/form-data')) {
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
        const mark = `--${boundary?.[1] ?? boundary?.[2]}`;
        const parts = raw.toString('latin1').split(mark).slice(1, -1);
        const out = { multipart: true, files: [] };
        for (const part of parts) {
            const [head, ...rest] = part.split('\r\n\r\n');
            const content = rest.join('\r\n\r\n').replace(/\r\n$/, '');
            const name = /name="([^"]+)"/.exec(head)?.[1];
            const filename = /filename="([^"]*)"/.exec(head)?.[1];
            if (filename !== undefined) out.files.push({ field: name, filename, size: Buffer.byteLength(content, 'latin1'), text: Buffer.from(content, 'latin1').toString('utf8').slice(0, 200) });
            else if (name === 'payload_json') out.payload = JSON.parse(Buffer.from(content, 'latin1').toString('utf8'));
        }
        return out;
    }
    try {
        return JSON.parse(raw.toString('utf8'));
    } catch {
        return { raw: raw.toString('utf8') };
    }
}

/**
 * Start a fake Discord.
 * @param {object} [options]
 * @param {string} [options.token] - the only bot token it accepts.
 * @param {number} [options.heartbeatMs] - the heartbeat interval it asks for.
 * @param {string} [options.botId] - the bot's user id.
 */
export async function startFakeDiscord({ token = 'fake-bot-token', heartbeatMs = 45000, botId } = {}) {
    let counter = 0n;
    /** A snowflake for now: Discord's epoch-based ids, always increasing. */
    const snowflake = () => {
        counter += 1n;
        return String(((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) + counter);
    };
    const bot = { id: botId ?? snowflake(), username: 'dshbot', global_name: 'DSH Bot', bot: true };
    const users = new Map();
    const channels = new Map();
    const messages = new Map(); // channelId -> message[]
    const commands = [];
    const requests = [];
    const interactions = []; // answers: { id, kind, body }
    const failures = []; // { method, test: RegExp, status, times, body }
    const sessions = new Map(); // session_id -> { events: [{s, t, d}], resumable }
    const gateway = { sockets: [], identifies: [], resumes: [], heartbeats: 0, acking: true, current: null, seq: 0, sessionId: null, connects: 0 };

    const guild = { id: snowflake(), name: 'Test server' };
    const addChannel = (fields) => {
        const channel = { id: snowflake(), type: 0, guild_id: guild.id, name: 'general', ...fields };
        channels.set(channel.id, channel);
        messages.set(channel.id, messages.get(channel.id) ?? []);
        return channel;
    };
    const addUser = (fields) => {
        const user = { id: snowflake(), username: 'person', global_name: 'A Person', bot: false, ...fields };
        users.set(user.id, user);
        return user;
    };
    users.set(bot.id, bot);

    const storeMessage = (channelId, fields) => {
        const message = {
            id: snowflake(),
            channel_id: channelId,
            guild_id: guild.id,
            type: 0,
            content: '',
            attachments: [],
            embeds: [],
            mentions: [],
            timestamp: new Date().toISOString(),
            ...fields,
        };
        if (!messages.has(channelId)) messages.set(channelId, []);
        messages.get(channelId).push(message);
        return message;
    };

    /** Send one DISPATCH: numbered, kept for resume replay, delivered now if a session is open. */
    const dispatch = (t, d) => {
        const session = sessions.get(gateway.sessionId);
        const s = ++gateway.seq;
        if (session) session.events.push({ s, t, d });
        if (gateway.current?.ready && gateway.current.socket.open) gateway.current.socket.sendJson({ op: 0, t, s, d });
        return s;
    };

    const json = (res, status, value) => {
        const text = value === undefined ? '' : JSON.stringify(value);
        res.writeHead(status, { 'content-type': 'application/json', ...(text ? {} : {}) });
        res.end(text);
    };

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://fake.discord');
        const path = url.pathname.replace(/^\/api\/v10/, '');
        let body;
        try {
            body = await readBody(req);
        } catch {
            body = undefined;
        }
        const record = { n: requests.length + 1, at: Date.now(), method: req.method, path, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization ?? null };
        requests.push(record);

        const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.test.test(path));
        if (failure) {
            failure.times -= 1;
            record.failed = failure.status;
            if (failure.status === 'drop') {
                req.socket.destroy();
                return;
            }
            json(res, failure.status, failure.body ?? { message: 'Fake failure', code: 0 });
            return;
        }
        const needsAuth = !path.startsWith('/interactions/') && !path.startsWith('/webhooks/');
        if (needsAuth && req.headers.authorization !== `Bot ${token}`) {
            json(res, 401, { message: '401: Unauthorized', code: 0 });
            return;
        }
        let m;
        if (req.method === 'GET' && path === '/gateway/bot') {
            json(res, 200, { url: `ws://127.0.0.1:${server.address().port}/gateway`, shards: 1, session_start_limit: { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 } });
            return;
        }
        if ((m = /^\/channels\/(\d+)$/.exec(path))) {
            const channel = channels.get(m[1]);
            if (!channel) return json(res, 404, { message: 'Unknown Channel', code: 10003 });
            if (req.method === 'GET') return json(res, 200, channel);
            if (req.method === 'PATCH') {
                if (typeof body?.name === 'string') channel.name = body.name;
                if (body?.archived === false && channel.thread_metadata) channel.thread_metadata.archived = false;
                return json(res, 200, channel);
            }
        }
        if ((m = /^\/channels\/(\d+)\/messages$/.exec(path))) {
            const channelId = m[1];
            if (!channels.has(channelId)) return json(res, 404, { message: 'Unknown Channel', code: 10003 });
            if (req.method === 'POST') {
                const fields = body?.multipart ? { ...body.payload, attachments: body.files.map((f) => ({ id: snowflake(), filename: f.filename, size: f.size })) } : body;
                const content = String(fields?.content ?? '');
                if (content.length > 2000) return json(res, 400, { message: 'Invalid Form Body', code: 50035 });
                const message = storeMessage(channelId, { ...fields, content, author: bot });
                return json(res, 200, message);
            }
            if (req.method === 'GET') {
                const after = url.searchParams.get('after');
                const limit = Number(url.searchParams.get('limit') ?? 50);
                const list = (messages.get(channelId) ?? []).filter((x) => !after || BigInt(x.id) > BigInt(after));
                return json(res, 200, list.slice(0, limit).reverse());
            }
        }
        if ((m = /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(path)) && req.method === 'POST') {
            const parent = channels.get(m[1]);
            if (!parent) return json(res, 404, { message: 'Unknown Channel', code: 10003 });
            const anchor = (messages.get(m[1]) ?? []).find((x) => x.id === m[2]);
            const thread = addChannel({ id: m[2], type: 11, parent_id: parent.id, name: body?.name, owner_id: bot.id, thread_metadata: { archived: false, auto_archive_duration: body?.auto_archive_duration ?? 1440 } });
            if (anchor) anchor.thread = thread;
            return json(res, 201, thread);
        }
        if ((m = /^\/channels\/(\d+)\/threads$/.exec(path)) && req.method === 'POST') {
            const parent = channels.get(m[1]);
            if (!parent) return json(res, 404, { message: 'Unknown Channel', code: 10003 });
            const thread = addChannel({ type: 11, parent_id: parent.id, name: body?.name, owner_id: bot.id, thread_metadata: { archived: false, auto_archive_duration: body?.auto_archive_duration ?? 1440 } });
            return json(res, 201, thread);
        }
        if ((m = /^\/channels\/(\d+)\/typing$/.exec(path)) && req.method === 'POST') {
            res.writeHead(204);
            res.end();
            return;
        }
        if ((m = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/.exec(path)) && req.method === 'PUT') {
            const message = (messages.get(m[1]) ?? []).find((x) => x.id === m[2]);
            if (!message) return json(res, 404, { message: 'Unknown Message', code: 10008 });
            message.reactions = [...(message.reactions ?? []), decodeURIComponent(m[3])];
            res.writeHead(204);
            res.end();
            return;
        }
        if ((m = /^\/users\/(\d+)$/.exec(path)) && req.method === 'GET') {
            const user = users.get(m[1]);
            return user ? json(res, 200, user) : json(res, 404, { message: 'Unknown User', code: 10013 });
        }
        if ((m = /^\/applications\/(\d+)\/commands$/.exec(path))) {
            if (req.method === 'GET') return json(res, 200, commands);
            if (req.method === 'POST') {
                const at = commands.findIndex((c) => c.name === body?.name);
                const command = { id: snowflake(), application_id: m[1], ...body };
                if (at >= 0) commands[at] = command;
                else commands.push(command);
                return json(res, at >= 0 ? 200 : 201, command);
            }
        }
        if ((m = /^\/interactions\/(\d+)\/([^/]+)\/callback$/.exec(path)) && req.method === 'POST') {
            interactions.push({ id: m[1], kind: 'callback', body, at: Date.now() });
            res.writeHead(204);
            res.end();
            return;
        }
        if ((m = /^\/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/.exec(path)) && req.method === 'PATCH') {
            const token = m[2];
            const asked = interactions.find((x) => x.token === token);
            interactions.push({ id: asked?.id ?? null, token, kind: 'edit', body, at: Date.now() });
            return json(res, 200, { id: snowflake(), content: body?.content ?? '' });
        }
        json(res, 404, { message: `the fake has no ${req.method} ${path}`, code: 0 });
    });

    server.on('upgrade', (req, socket) => {
        const key = req.headers['sec-websocket-key'];
        if (!key || !/^\/(gateway|resume)/.test(new URL(req.url, 'http://x').pathname)) {
            socket.destroy();
            return;
        }
        const accept = createHash('sha1').update(key + GUID).digest('base64');
        socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
        gateway.connects += 1;
        const conn = { ready: false, socket: null, path: new URL(req.url, 'http://x').pathname, query: Object.fromEntries(new URL(req.url, 'http://x').searchParams) };
        conn.socket = new Socket(socket, (text) => {
            let payload;
            try {
                payload = JSON.parse(text);
            } catch {
                return;
            }
            if (payload.op === 1) {
                gateway.heartbeats += 1;
                if (gateway.acking) conn.socket.sendJson({ op: 11 });
            } else if (payload.op === 2) {
                gateway.identifies.push({ token: payload.d?.token, intents: payload.d?.intents, at: Date.now(), path: conn.path });
                if (payload.d?.token !== token) {
                    conn.socket.close(4004);
                    return;
                }
                gateway.sessionId = randomUUID();
                gateway.seq = 0;
                sessions.set(gateway.sessionId, { events: [] });
                gateway.current = conn;
                conn.ready = true;
                const s = ++gateway.seq;
                conn.socket.sendJson({ op: 0, t: 'READY', s, d: { v: 10, user: bot, session_id: gateway.sessionId, resume_gateway_url: `ws://127.0.0.1:${server.address().port}/resume`, guilds: [{ id: guild.id, unavailable: true }], application: { id: bot.id } } });
            } else if (payload.op === 6) {
                gateway.resumes.push({ sessionId: payload.d?.session_id, seq: payload.d?.seq, at: Date.now(), path: conn.path });
                const session = sessions.get(payload.d?.session_id);
                if (!session || payload.d?.token !== token || session.resumable === false) {
                    conn.socket.sendJson({ op: 9, d: false });
                    return;
                }
                gateway.current = conn;
                conn.ready = true;
                for (const e of session.events.filter((x) => x.s > Number(payload.d?.seq ?? 0))) conn.socket.sendJson({ op: 0, t: e.t, s: e.s, d: e.d });
                conn.socket.sendJson({ op: 0, t: 'RESUMED', s: ++gateway.seq, d: {} });
            }
        }, () => {
            if (gateway.current === conn) gateway.current = null;
        });
        gateway.sockets.push(conn);
        conn.socket.sendJson({ op: 10, d: { heartbeat_interval: heartbeatMs } });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const fake = {
        port,
        apiBase: `http://127.0.0.1:${port}/api/v10`,
        token,
        bot,
        guild,
        users,
        channels,
        messages,
        commands,
        requests,
        interactions,
        gateway,
        snowflake,
        addChannel,
        addUser,
        dispatch,
        /** The requests that match, in order. */
        calls(method, pattern) {
            return requests.filter((r) => r.method === method && (pattern instanceof RegExp ? pattern.test(r.path) : r.path === pattern));
        },
        /** Messages the bot posted in a channel. */
        botMessages(channelId) {
            return (messages.get(channelId) ?? []).filter((x) => x.author?.id === bot.id);
        },
        /** Threads created under a parent channel. */
        threadsOf(parentId) {
            return [...channels.values()].filter((c) => c.parent_id === parentId);
        },
        /**
         * A person posts a message. offline: true keeps it out of the gateway (posted while the bot was away).
         * @returns {object} the message.
         */
        userMessage({ channelId, author, content = '', attachments = [], offline = false, ...rest }) {
            const message = storeMessage(channelId, { author, content, attachments, ...rest });
            if (!offline) dispatch('MESSAGE_CREATE', message);
            return message;
        },
        /** A person runs a slash command in a channel. */
        interaction({ channelId, user, name, value }) {
            const channel = channels.get(channelId);
            const id = snowflake();
            const itoken = `itoken-${randomUUID()}`;
            const d = {
                id, token: itoken, type: 2, application_id: bot.id, channel_id: channelId,
                channel: channel ? { id: channel.id, type: channel.type, parent_id: channel.parent_id } : { id: channelId },
                guild_id: guild.id,
                member: { user },
                data: { id: snowflake(), name, type: 1, ...(value !== undefined ? { options: [{ name: 'value', type: 3, value }] } : {}) },
            };
            interactions.push({ id, token: itoken, kind: 'asked', name, at: Date.now() });
            dispatch('INTERACTION_CREATE', d);
            return { id, token: itoken };
        },
        /** The answer (callback or edited reply) Discord got for an interaction, as text. */
        answerOf(asked) {
            const callback = interactions.find((x) => x.kind === 'callback' && x.id === asked.id);
            const edit = interactions.filter((x) => x.kind === 'edit' && x.token === asked.token).at(-1);
            if (edit) return { text: edit.body?.content ?? '', deferred: callback?.body?.type === 5, ephemeral: callback?.body?.data?.flags === 64 };
            if (callback?.body?.type === 4) return { text: callback.body.data?.content ?? '', deferred: false, ephemeral: callback.body.data?.flags === 64 };
            return null;
        },
        /** The next `times` requests that match answer `status` ('drop' cuts the connection). */
        failNext(method, test, status, times = 1, body) {
            failures.push({ method, test, status, times, body });
        },
        rateLimitNext(method, test, retryAfter = 0.2, times = 1) {
            failures.push({ method, test, status: 429, times, body: { message: 'You are being rate limited.', retry_after: retryAfter, global: false } });
        },
        /** Close the bot's gateway socket with a code. */
        closeSocket(code = 4000) {
            gateway.current?.socket.close(code);
        },
        /** Cut the bot's gateway connection with no close frame. */
        dropSocket() {
            gateway.current?.socket.drop();
        },
        /** Ask the bot to reconnect (op 7). */
        requestReconnect() {
            gateway.current?.socket.sendJson({ op: 7, d: null });
        },
        /** End the session (op 9); not resumable unless said. */
        invalidSession(resumable = false) {
            const session = sessions.get(gateway.sessionId);
            if (session && !resumable) session.resumable = false;
            gateway.current?.socket.sendJson({ op: 9, d: resumable });
        },
        /** Stop answering heartbeats (a zombie connection), or start again. */
        stopAcking(stop = true) {
            gateway.acking = !stop;
        },
        connected() {
            return Boolean(gateway.current?.ready && gateway.current.socket.open);
        },
        close: () => new Promise((resolve) => {
            for (const conn of gateway.sockets) conn.socket.drop();
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
    return fake;
}
