/**
 * A stand-in for DSH's window server, with the same gate DSH has: a loopback
 * Host (any port, as DSH's fence takes it), a same-authority Origin, and its
 * sign-in cookie for anything but the 401. As in DSH, the cookie is named
 * after the Host (`dsh-auth-` + base64url(sha256(host:port))) and its value is
 * signed with a key that outlives a restart (pass the same `secret`), bound
 * to that Host; `/?token=<launch token>` signs a browser in (303, Set-Cookie).
 * It serves an index with `__DSH_BOOT__`, echoes POST bodies, streams an
 * event stream, echoes WebSocket text frames, and sends a policy of its own
 * on /csp. `/cut` and `/cut-length` start an answer and then drop the
 * connection part-way (as a DSH route torn down mid-answer would). An upgrade
 * is answered after `upgradeDelayMs`, and the bytes it got from the edge
 * before it answered are counted (`early` on its `seen` entry).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const SIGNATURE = 'dsh web authentication required; reopen the URL printed by dsh web.\n';

export function cookieNameFor(authority) {
    return `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`;
}

/** One unmasked WebSocket text frame from the server. */
function frame(text) {
    const data = Buffer.from(text);
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
    return Buffer.concat([head, data]);
}

/** Read one masked client text frame (small frames only). */
function readFrame(buf) {
    if (buf.length < 6) return undefined;
    const len = buf[1] & 0x7f;
    if (len > 125 || buf.length < 6 + len) return undefined;
    const mask = buf.subarray(2, 6);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = buf[6 + i] ^ mask[i % 4];
    return { text: out.toString('utf8'), rest: buf.subarray(6 + len) };
}

const loopbackHost = (host) => /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/.test(String(host ?? ''));

/**
 * @param {{ value?: string, secret?: string, port?: number }} [options] - value: the cookie value the shell takes for
 *   its own authority (the desktop window's cookie); secret: its signing key (the same one after a restart);
 *   port: listen there (0: any free one).
 * @returns {Promise<{ port, origin, authority, cookie, token, secret, seen, close, streams }>}
 */
export async function startFakeShell({ value = 'good-cookie-value', secret = randomBytes(16).toString('hex'), port = 0, upgradeDelayMs = 0 } = {}) {
    const seen = [];
    const streams = new Set();
    const shell = {};
    /** The cookie value the shell takes for one Host: its own authority's fixed value, else one signed for that Host. */
    const valueFor = (host) => (host === shell.authority ? shell.value : createHmac('sha256', shell.secret).update(host).digest('base64url'));
    const authorized = (headers) => {
        const host = headers.host;
        if (!loopbackHost(host)) return 'host';
        if (headers.origin !== undefined && headers.origin !== `http://${host}`) return 'origin';
        const want = `${cookieNameFor(host)}=${valueFor(host)}`;
        return String(headers.cookie ?? '').split(';').map((s) => s.trim()).includes(want) ? undefined : 'cookie';
    };
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        const why = authorized(req.headers);
        if (why === 'host' || why === 'origin') {
            res.writeHead(403, { 'content-type': 'text/plain' });
            res.end(`forbidden ${why}\n`);
            return;
        }
        const url = new URL(req.url, 'http://x');
        if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === shell.token) {
            const host = req.headers.host;
            res.writeHead(303, { location: './', 'set-cookie': `${cookieNameFor(host)}=${valueFor(host)}; Path=/; HttpOnly; SameSite=Strict` });
            res.end();
            return;
        }
        if (why === 'cookie') {
            res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(req.method === 'HEAD' ? undefined : SIGNATURE);
            return;
        }
        if (req.url === '/events') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            res.write('data: one\n\n');
            streams.add(res);
            res.on('close', () => streams.delete(res));
            return;
        }
        if (url.pathname === '/cut' || url.pathname === '/cut-length') {
            res.writeHead(200, url.pathname === '/cut' ? { 'content-type': 'text/event-stream' } : { 'content-type': 'application/octet-stream', 'content-length': '1000' });
            res.write(url.pathname === '/cut' ? 'data: one\n\n' : 'x'.repeat(100));
            setTimeout(() => res.socket?.destroy(), 150);
            return;
        }
        if (url.pathname === '/csp') {
            res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'self'" });
            res.end('<!doctype html><p>csp</p>');
            return;
        }
        if (req.method === 'POST') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ echo: body.length, sha: createHash('sha256').update(body).digest('hex') }));
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><script>window.__DSH_BOOT__={}</script>');
    });
    server.on('upgrade', async (req, socket, head) => {
        const entry = { method: 'UPGRADE', url: req.url, headers: req.headers, early: head.length };
        seen.push(entry);
        let answered = false;
        let buf = Buffer.alloc(0);
        const early = (d) => {
            if (!answered) entry.early += d.length;
            buf = Buffer.concat([buf, d]);
        };
        socket.on('data', early);
        socket.on('error', () => {});
        if (upgradeDelayMs) await new Promise((r) => setTimeout(r, upgradeDelayMs));
        answered = true;
        const why = authorized(req.headers);
        if (why) {
            socket.end(`HTTP/1.1 ${why === 'cookie' ? 401 : 403} No\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            return;
        }
        const key = req.headers['sec-websocket-key'];
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        streams.add(socket);
        if (head.length) buf = Buffer.concat([head, buf]);
        const echo = () => {
            for (;;) {
                const got = readFrame(buf);
                if (!got) break;
                buf = got.rest;
                socket.write(frame(`echo:${got.text}`));
            }
        };
        socket.off('data', early);
        socket.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            echo();
        });
        echo();
        // A WebSocket server closes its side when the peer goes (the upgrade socket of an HTTP server is half-open by default).
        socket.on('end', () => socket.destroy());
        socket.on('close', () => streams.delete(socket));
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    shell.port = server.address().port;
    shell.authority = `127.0.0.1:${shell.port}`;
    shell.origin = `http://${shell.authority}`;
    shell.value = value;
    shell.secret = secret;
    shell.token = randomBytes(12).toString('base64url');
    shell.cookie = `${cookieNameFor(shell.authority)}=${value}`;
    shell.seen = seen;
    shell.streams = streams;
    shell.server = server;
    shell.close = () => new Promise((resolve) => {
        for (const s of streams) s.destroy?.();
        server.closeAllConnections?.();
        server.close(() => resolve());
    });
    return shell;
}
