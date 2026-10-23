/**
 * dsh-plugin-dsh-site — tailnet-only edge for the running DSH Desktop shell.
 *
 * The desktop shell's HTTP server binds 127.0.0.1 only and accepts requests only
 * when they carry its `dsh-auth-*` cookie *and* a loopback Host. This plugin
 * opens a second listener on this machine's Tailscale interface and
 * reverse-proxies to that loopback origin, so tailnet devices reach the same
 * GUI — same sessions, same tools — as if they were sitting in front of the
 * machine.
 *
 * Two upstream details make the desktop work remotely:
 *   - Host is rewritten to the loopback origin (the shell rejects other Hosts).
 *   - The shell's live auth cookie is read from the Electron cookie jar and
 *     injected when `injectAuthCookie: true`. Off by default: the shell's own
 *     `?token=` auth stays the gate unless you opt in.
 *
 * The plugin's own gate is the source address: anything outside `allowCIDRs` is
 * refused, so binding 0.0.0.0 (which survives a Tailscale IP change) stays
 * tailnet-only. The edge answers one path itself: GET /.dsh-site/health.
 *
 * @module dsh-plugin-dsh-site
 */
import z from '@deepseek-ai/schemastery';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { inCidr } from './cidr.js';

export const name = 'dsh-site';

export const Config = z.object({
    enabled: z.boolean().default(true),
    listenHost: z.string().default('0.0.0.0'),
    listenPort: z.number().default(8443),
    targetOrigin: z.string().default('http://127.0.0.1:19387'),
    allowCIDRs: z.string().default('100.64.0.0/10,127.0.0.0/8,::1/128'),
    discoverTarget: z.boolean().default(true),
    rewriteHost: z.boolean().default(true),
    rewriteOrigin: z.boolean().default(true),
    injectAuthCookie: z.boolean().default(false),
    cookieJar: z.string().default('~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies'),
    logFile: z.string().default('~/.dsh/dsh-site/site.log'),
});

const DEFAULT_COOKIE_JAR = '~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies';

const expand = (p) => (p?.startsWith('~/') ? homedir() + p.slice(1) : p);
const normalize = (ip) => (ip?.startsWith('::ffff:') ? ip.slice(7) : ip);

function parseOrigin(origin) {
    const u = new URL(origin);
    return { hostname: u.hostname, port: Number(u.port || 80) };
}

export function apply(ctx, config) {
    if (!config.enabled) return;

    const logFile = config.logFile ? expand(config.logFile) : '';
    if (logFile) { try { mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 }); } catch {} }
    const log = (line) => {
        if (!logFile) return;
        try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch {}
    };

    const cidrs = String(config.allowCIDRs).split(',').map((s) => s.trim()).filter(Boolean);
    const allowed = (ip) => cidrs.some((c) => inCidr(ip, c));

    // The shell's port is not guaranteed across restarts, so resolve it rather
    // than trusting a hardcoded value: probe the configured origin, then look
    // through this process's own loopback listeners for the shell's signature.
    const state = { origin: config.targetOrigin, discovered: false };
    const auth = { cookie: null, at: 0 };

    function isShell(port, cb) {
        let done = false;
        const finish = (v) => { if (!done) { done = true; cb(v); } };
        const req = httpRequest({ hostname: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; if (body.length > 8192) res.destroy(); });
            res.on('end', () => finish(res.statusCode === 401 && /dsh web authentication required/i.test(body)));
            res.on('close', () => finish(false));
        });
        req.setTimeout(1500, () => req.destroy());
        req.on('error', () => finish(false));
        req.end();
    }

    function resolveTarget(cb) {
        isShell(parseOrigin(config.targetOrigin).port, (ok) => {
            if (ok) {
                state.origin = config.targetOrigin;
                state.discovered = false;
                return cb(state.origin);
            }
            if (!config.discoverTarget) return cb(state.origin);
            execFile('lsof', ['-nP', '-a', '-p', String(process.pid), '-iTCP', '-sTCP:LISTEN'], { timeout: 5000 }, (err, stdout) => {
                if (err) {
                    log(`discovery failed: ${String(err.message ?? err)}`);
                    return cb(state.origin);
                }
                const ports = new Set();
                for (const line of String(stdout).split('\n')) {
                    const m = line.match(/TCP (?:\[?[0-9a-fA-F:.]+\]?):(\d+) \(LISTEN\)/);
                    if (m) ports.add(Number(m[1]));
                }
                ports.delete(config.listenPort);
                const candidates = [...ports];
                let i = 0;
                const next = () => {
                    if (i >= candidates.length) {
                        log('discovery found no DSH shell');
                        return cb(state.origin);
                    }
                    const port = candidates[i++];
                    isShell(port, (found) => {
                        if (!found) return next();
                        state.origin = `http://127.0.0.1:${port}`;
                        state.discovered = true;
                        log(`discovered shell at ${state.origin}`);
                        cb(state.origin);
                    });
                };
                next();
            });
        });
    }

    /** The shell's live auth cookie, read from the Electron jar (30s cache). */
    function ensureCookie(cb) {
        if (!config.injectAuthCookie) return cb();
        if (auth.cookie && Date.now() - auth.at < 30000) return cb();
        const query = "select name, value from cookies where host_key='127.0.0.1' limit 1;";
        try {
            execFile('sqlite3', [expand(config.cookieJar ?? DEFAULT_COOKIE_JAR), query], { timeout: 5000 }, (err, stdout) => {
                if (err) {
                    log(`cookie read failed: ${String(err.message ?? err)}`);
                    return cb();
                }
                const line = String(stdout).trim();
                const sep = line.indexOf('|');
                if (sep > 0) {
                    auth.cookie = `${line.slice(0, sep)}=${line.slice(sep + 1)}`;
                    auth.at = Date.now();
                }
                cb();
            });
        } catch (error) {
            log(`cookie read failed: ${String(error?.message ?? error)}`);
            cb();
        }
    }

    /**
     * Headers for the upstream request. Host is rewritten to the loopback origin
     * because the shell refuses any other Host; Origin/Referer likewise, so the
     * shell's local-origin checks pass.
     */
    function upstreamHeaders(req) {
        const h = { ...req.headers };
        const t = parseOrigin(state.origin);
        if (config.rewriteHost) h.host = `${t.hostname}:${t.port}`;
        if (config.injectAuthCookie && auth.cookie) h.cookie = auth.cookie;
        if (config.rewriteOrigin) {
            const base = `http://${t.hostname}:${t.port}`;
            if (h.origin) h.origin = base;
            if (h.referer) h.referer = `${base}/`;
        }
        return h;
    }

    function forward(req, res, attempt) {
        const t = parseOrigin(state.origin);
        const replayable = req.method === 'GET' || req.method === 'HEAD';
        const up = httpRequest({ hostname: t.hostname, port: t.port, path: req.url, method: req.method, headers: upstreamHeaders(req) }, (ur) => {
            // A stale injected cookie is refreshed once and the request replayed.
            if (ur.statusCode === 401 && config.injectAuthCookie && attempt === 0 && replayable) {
                ur.resume();
                auth.cookie = null;
                auth.at = 0;
                ensureCookie(() => forward(req, res, 1));
                return;
            }
            res.writeHead(ur.statusCode ?? 502, ur.headers);
            ur.pipe(res);
        });
        up.setTimeout(0);
        up.on('error', (err) => {
            if (attempt === 0 && replayable && config.discoverTarget && err.code === 'ECONNREFUSED') {
                resolveTarget(() => forward(req, res, 1));
                return;
            }
            log(`upstream ${state.origin} error ${err.code ?? err.message}`);
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(`dsh-site: upstream ${state.origin} unavailable (${err.code ?? err.message})\n`);
        });
        req.pipe(up);
    }

    function upgrade(req, socket, head, attempt) {
        const t = parseOrigin(state.origin);
        const up = connect(t.port, t.hostname, () => {
            let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
            for (const [k, v] of Object.entries(upstreamHeaders(req))) raw += `${k}: ${v}\r\n`;
            raw += '\r\n';
            up.write(raw);
            if (head?.length) up.write(head);
            up.pipe(socket);
            socket.pipe(up);
        });
        up.on('error', (err) => {
            log(`upgrade upstream ${state.origin} error ${err.code ?? err.message}`);
            if (attempt === 0 && config.discoverTarget && err.code === 'ECONNREFUSED') {
                resolveTarget(() => upgrade(req, socket, head, 1));
                return;
            }
            socket.destroy();
        });
        socket.on('error', () => up.destroy());
    }

    const server = createServer((req, res) => {
        const ip = normalize(req.socket.remoteAddress);
        if (!allowed(ip)) {
            log(`deny ${ip} ${req.method} ${req.url}`);
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-site: tailnet only\n');
            return;
        }
        if ((req.url ?? '/').split('?')[0] === '/.dsh-site/health') {
            const text = JSON.stringify({
                ok: true, plugin: 'dsh-site', pid: process.pid,
                listen: `${config.listenHost}:${config.listenPort}`,
                target: state.origin, discovered: state.discovered,
                authInjected: Boolean(config.injectAuthCookie && auth.cookie),
            });
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
            res.end(text);
            return;
        }
        ensureCookie(() => forward(req, res, 0));
    });
    server.on('upgrade', (req, socket, head) => {
        const ip = normalize(req.socket.remoteAddress);
        if (!allowed(ip)) { socket.destroy(); return; }
        ensureCookie(() => upgrade(req, socket, head, 0));
    });
    server.requestTimeout = 0; // long-lived SSE/WebSocket streams must not be cut
    server.headersTimeout = 60000;
    server.on('error', (error) => {
        log(`server error ${String(error?.message ?? error)}`);
        ctx.logger.warn('dsh-site: server error %s', error?.message ?? error);
    });

    resolveTarget(() => {});
    ensureCookie(() => {});
    server.listen(config.listenPort, config.listenHost, () => {
        log(`listening ${config.listenHost}:${config.listenPort} -> ${state.origin} pid=${process.pid}`);
        ctx.logger.info('dsh-site: listening on %s:%s -> %s', config.listenHost, config.listenPort, state.origin);
    });

    ctx.effect(() => () => new Promise((resolve) => {
        server.close(() => resolve());
        log('stopped');
    }));
}
