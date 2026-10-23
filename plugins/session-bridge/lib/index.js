/**
 * dsh-plugin-session-bridge — a loopback control surface for the running DSH Desktop Host.
 *
 * It serves a small JSON HTTP API on a Unix socket (owner-only, no TCP port) and drives the
 * Host's own `sessionController` service: the same code path the GUI uses. Sessions created or
 * prompted here appear live in the DSH window, and the user can watch and steer them there.
 *
 * Endpoints (all JSON):
 *   GET  /health
 *   GET  /workspaces
 *   GET  /models
 *   GET  /sessions
 *   POST /sessions                 {workspacePath|workspaceId, title?, provider?, model?, reasoningEffort?, text?}
 *   GET  /sessions/:id             status + last assistant text
 *   GET  /sessions/:id/events      ?after=<seq>&limit=<n>&full=1
 *   POST /sessions/:id/prompt      {text, mode?: "followup"|"steer"}
 *   POST /sessions/:id/model       {provider, model, reasoningEffort?}
 *   POST /sessions/:id/cancel
 *   POST /sessions/:id/rename      {title}
 *
 * @module dsh-plugin-session-bridge
 */
import z from '@deepseek-ai/schemastery';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const name = 'session-bridge';
export const inject = ['sessionController', 'workspaceRegistry', 'agents'];

export const Config = z.object({
    enabled: z.boolean().default(true),
    socketPath: z.string().default('~/.dsh/session-bridge/bridge.sock'),
    logFile: z.string().default('~/.dsh/session-bridge/bridge.log'),
    maxBodyBytes: z.number().default(1048576),
});

const expand = (p) => (p.startsWith('~/') ? homedir() + p.slice(1) : p);

/** Text of one message-like event, or ''. */
function textOf(event) {
    const msg = event?.data?.message ?? event?.data;
    const content = msg?.content;
    if (!Array.isArray(content)) return '';
    return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

/** Compact one durable event for the wire. */
function summarize(event, full) {
    const out = { seq: event.seq, type: event.type, time: event.time };
    const d = event.data ?? {};
    if (d.turn !== undefined) out.turn = d.turn;
    if (event.type === 'turn/end') out.reason = d.reason;
    if (event.type === 'model/selection') out.selection = d;
    if (event.type === 'session/title') out.title = d.title;
    // Who sent a user message: the user, another session or a plugin.
    if (event.type === 'user/message' && d.source !== undefined) out.source = d.source;
    if (event.type === 'agent/error' || event.type?.endsWith('/error')) out.error = JSON.stringify(d).slice(0, 2000);
    const text = textOf(event);
    if (text) out.text = full ? text : text.length > 4000 ? `${text.slice(0, 4000)}…(+${text.length - 4000})` : text;
    const msg = d.message;
    if (msg?.role) out.role = msg.role;
    if (Array.isArray(msg?.content)) {
        const calls = msg.content.filter((b) => b?.type === 'toolCall' || b?.type === 'tool-call' || b?.type === 'tool_call');
        if (calls.length) out.toolCalls = calls.map((c) => c.name ?? c.toolName).filter(Boolean);
    }
    return out;
}

function lastAssistantText(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        const role = e?.data?.message?.role;
        if ((e.type === 'assistant/message' || role === 'assistant') && textOf(e)) return { seq: e.seq, text: textOf(e) };
    }
    return null;
}

class HttpError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function apply(ctx, config) {
    if (!config.enabled) return;
    const socketPath = expand(config.socketPath);
    const logFile = config.logFile ? expand(config.logFile) : '';
    const log = (line) => {
        if (!logFile) return;
        try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch {}
    };
    const sc = () => ctx.sessionController;

    async function readBody(req) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > config.maxBodyBytes) throw new HttpError(413, 'too-large', 'request body too large');
            chunks.push(chunk);
        }
        if (size === 0) return {};
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new HttpError(400, 'bad-json', 'body is not valid JSON'); }
    }

    async function events(sessionId) {
        try {
            const r = await sc().inspect(sessionId, AbortSignal.timeout(20000));
            return { header: r.meta, events: r.events ?? [] };
        } catch (error) {
            throw new HttpError(404, 'session/not-found', String(error?.message ?? error));
        }
    }

    async function workspaceFor(body) {
        if (body.workspaceId) {
            const ws = ctx.workspaceRegistry.get(body.workspaceId);
            if (!ws) throw new HttpError(404, 'workspace/not-found', `workspace ${body.workspaceId} not found`);
            return ws;
        }
        if (body.workspacePath) return ctx.workspaceRegistry.create(expand(body.workspacePath));
        throw new HttpError(400, 'bad-request', 'workspacePath or workspaceId is required');
    }

    async function prompt(sessionId, text, mode) {
        if (typeof text !== 'string' || text.trim() === '') throw new HttpError(400, 'bad-request', 'text is required');
        const m = mode === 'steer' ? 'steer' : 'followup';
        const requestId = `bridge-${randomUUID()}`;
        await sc().prompt({ sessionId, content: [{ type: 'text', text }], mode: m, requestId }, AbortSignal.timeout(60000));
        log(`prompt ${sessionId} mode=${m} chars=${text.length}`);
        return { accepted: true, mode: m, requestId, chars: text.length };
    }

    async function selectModel(sessionId, body) {
        if (!body.provider || !body.model) throw new HttpError(400, 'bad-request', 'provider and model are required');
        const r = await sc().selectModel({
            sessionId, provider: body.provider, model: body.model,
            ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
        });
        log(`model ${sessionId} ${body.provider}/${body.model} ${body.reasoningEffort ?? ''}`);
        return r;
    }

    async function route(req, url) {
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const method = req.method;
        if (method === 'GET' && url.pathname === '/health') {
            return { ok: true, plugin: 'session-bridge', pid: process.pid, socket: socketPath };
        }
        if (method === 'GET' && url.pathname === '/workspaces') {
            return ctx.workspaceRegistry.list().map((w) => ({ id: w.id, path: w.path, title: w.title, sessions: w.sessionIds.length }));
        }
        if (method === 'GET' && url.pathname === '/models') return sc().modelCatalog();
        if (parts[0] !== 'sessions') throw new HttpError(404, 'not-found', 'unknown path');

        if (parts.length === 1) {
            if (method === 'GET') return (await sc().list({}, AbortSignal.timeout(20000))).items;
            if (method === 'POST') {
                const body = await readBody(req);
                const ws = await workspaceFor(body);
                const created = await sc().create({ workspaceId: ws.id, ...(body.agentPreset ? { agentPreset: body.agentPreset } : {}) });
                const sessionId = created.sessionId;
                log(`create ${sessionId} ws=${ws.path}`);
                const out = { sessionId, workspace: { id: ws.id, path: ws.path } };
                if (body.model) out.model = await selectModel(sessionId, body);
                if (body.title) out.title = await sc().rename({ sessionId, title: body.title });
                if (body.text) out.prompt = await prompt(sessionId, body.text, 'followup');
                return out;
            }
        }
        const sessionId = parts[1];
        const action = parts[2];
        if (!action && method === 'GET') {
            const { header, events: ev } = await events(sessionId);
            const agent = ctx.agents.get(sessionId);
            const starts = ev.filter((e) => e.type === 'turn/start').length;
            const ends = ev.filter((e) => e.type === 'turn/end');
            // The header keeps the creation-time title; renames are session/title events.
            const renamed = ev.findLast((e) => e.type === 'session/title')?.data?.title;
            return {
                sessionId, cwd: header?.cwd, title: renamed ?? header?.title,
                attached: agent !== undefined, status: agent?.status ?? 'cold',
                turns: { started: starts, ended: ends.length, lastEnd: ends.at(-1)?.data?.reason ?? null },
                lastSeq: ev.at(-1)?.seq ?? -1,
                lastAssistant: lastAssistantText(ev),
            };
        }
        if (action === 'events' && method === 'GET') {
            const after = Number(url.searchParams.get('after') ?? -1);
            const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 2000);
            const full = url.searchParams.get('full') === '1';
            const types = url.searchParams.get('types');
            const want = types ? new Set(types.split(',')) : null;
            const { events: ev } = await events(sessionId);
            let sel = ev.filter((e) => e.seq > after && (!want || want.has(e.type)));
            const more = sel.length > limit;
            sel = sel.slice(0, limit);
            return { lastSeq: ev.at(-1)?.seq ?? -1, more, events: sel.map((e) => summarize(e, full)) };
        }
        if (method !== 'POST') throw new HttpError(405, 'method', 'method not allowed');
        const body = await readBody(req);
        if (action === 'prompt') return prompt(sessionId, body.text, body.mode);
        if (action === 'model') return selectModel(sessionId, body);
        if (action === 'cancel') { log(`cancel ${sessionId}`); return sc().cancel({ sessionId }); }
        if (action === 'rename') return sc().rename({ sessionId, title: body.title });
        throw new HttpError(404, 'not-found', 'unknown action');
    }

    const server = createServer(async (req, res) => {
        let status = 200;
        let payload;
        try {
            const url = new URL(req.url ?? '/', 'http://bridge.local');
            payload = await route(req, url);
        } catch (error) {
            status = error instanceof HttpError ? error.status : 500;
            const code = error?.code ?? error?.remote?.code ?? 'internal';
            payload = { error: { code: String(code), message: String(error?.message ?? error).slice(0, 2000) } };
            if (status === 500 && typeof error?.code === 'string' && error.code.includes('/')) status = 409;
            log(`error ${req.method} ${req.url} ${status} ${code} ${String(error?.message ?? error).slice(0, 300)}`);
        }
        const text = JSON.stringify(payload ?? null);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
    });

    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(socketPath), 0o700);
    if (existsSync(socketPath)) rmSync(socketPath, { force: true });
    // The umask is process-wide, so narrow it only around listen(): Node binds
    // the socket inside that call. Restoring it later, in the callback, would
    // leave folders other plugins create in the meantime without the execute
    // bit, and nothing inside them could be opened.
    const oldUmask = process.umask(0o177);
    try {
        server.listen(socketPath, () => {
            try { chmodSync(socketPath, 0o600); } catch {}
            log(`listening ${socketPath} pid=${process.pid}`);
            ctx.logger.info('session-bridge: listening on %s', socketPath);
        });
    } finally {
        process.umask(oldUmask);
    }
    server.on('error', (error) => {
        log(`server error ${String(error?.message ?? error)}`);
        ctx.logger.warn('session-bridge: server error %s', error?.message ?? error);
    });

    ctx.effect(() => () => new Promise((resolve) => {
        server.close(() => resolve());
        try { rmSync(socketPath, { force: true }); } catch {}
        log('stopped');
    }));
}
