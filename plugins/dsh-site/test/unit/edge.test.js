import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkConfig } from '../../lib/config.js';
import { addressesLetIn, createEdge, guardHeaders, isOwnAddress, isWebSocketUpgrade, logPath, looksLikeShell, originOf, parseListeners, probeShell, statusOf } from '../../lib/edge.js';
import { parseCidr } from '../../lib/cidr.js';
import { createLog } from '../../lib/log.js';
import { cookieNameFor, startFakeShell } from './fake-shell.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An edge on 127.0.0.1 and a free port, with a log in a temporary folder. The test's requests come from this
 * machine, so the edge lets this machine in (allowThisMac) unless a test says otherwise.
 */
async function edgeFor(rows, deps = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-site-edge-'));
    const file = join(dir, 'site.log');
    const { settings, problems } = checkConfig({ listenHost: '127.0.0.1', listenPort: deps.port ?? 1, allowCIDRs: '127.0.0.0/8', allowThisMac: true, ...rows });
    assert.deepEqual(problems, []);
    if (!deps.port) settings.listenPort = await freePort();
    const edge = createEdge({ settings, log: createLog(file), listListeners: async () => ({ ports: [] }), graceMs: 0, ...deps });
    const started = deps.noStart ? undefined : await edge.start();
    return {
        edge, settings, started, dir,
        base: `http://127.0.0.1:${settings.listenPort}`,
        logText: () => { try { return readFileSync(file, 'utf8'); } catch { return ''; } },
        done: async () => { await edge.close(); rmSync(dir, { recursive: true, force: true }); },
    };
}

async function freePort() {
    const s = createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return port;
}

function http(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = request(url, { method, headers: { connection: 'close', ...headers } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

/** Open a WebSocket: resolves { socket, opened } once it opens or fails. */
function openWs(url, headers = {}) {
    return new Promise((resolve) => {
        const socket = new WebSocket(url, { headers });
        const messages = [];
        socket.addEventListener('message', ({ data }) => messages.push(String(data)));
        socket.addEventListener('open', () => resolve({ socket, opened: true, messages }));
        socket.addEventListener('error', () => resolve({ socket, opened: false, messages }));
    });
}

const found = (cookie) => async () => ({ status: 'found', cookie });

test('a device with no cookie gets DSH\'s window: Host, Origin and Referer rewritten, the window\'s cookie added', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({ injectAuthCookie: true }, { selfOrigin: () => shell.origin, readCookie: found(shell.cookie) });
    try {
        const res = await http(`${e.base}/`, { headers: { accept: 'text/html' } });
        assert.equal(res.status, 200);
        assert.match(res.text, /__DSH_BOOT__/);
        const post = await http(`${e.base}/api/thing`, { method: 'POST', headers: { origin: e.base, referer: `${e.base}/x`, 'content-type': 'application/json', cookie: 'mine=1' }, body: JSON.stringify({ a: 'x'.repeat(200000) }) });
        assert.equal(post.status, 200, post.text);
        const upstream = shell.seen.at(-1);
        assert.equal(upstream.headers.host, shell.authority);
        assert.equal(upstream.headers.origin, shell.origin);
        assert.equal(upstream.headers.referer, `${shell.origin}/`);
        assert.equal(upstream.headers.cookie, shell.cookie, 'the device\'s own cookies are replaced, not mixed in');
        assert.equal(JSON.parse(post.text).echo, upstream.body.length);
        assert.equal(upstream.body.length, JSON.stringify({ a: 'x'.repeat(200000) }).length, 'the body passes whole');
        assert.match(e.logText(), /listening on 127\.0\.0\.1:\d+ for 127\.0\.0\.0\/8; devices are signed in with the desktop window's cookie/);
        assert.match(e.logText(), /serving DSH at http:\/\/127\.0\.0\.1:\d+ \(found by DSH's own window server\)/);
        assert.match(e.logText(), /client 127\.0\.0\.1 first request this start \(this machine\)/);
        assert.doesNotMatch(e.logText(), /good-cookie-value/, 'the cookie value is never logged');
        assert.equal((e.logText().match(/first request/g) ?? []).length, 1, 'once per address');
    } finally {
        await e.done();
        await shell.close();
    }
});

/** A bare TCP connection: resolves with what the edge sent and how long it stayed open. */
function bareSocket(port, send = '') {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let got = '';
        const s = connect(port, '127.0.0.1');
        s.on('connect', () => { if (send) s.write(send); });
        s.on('data', (d) => { got += d; });
        s.on('error', () => {});
        s.on('close', () => resolve({ got, ms: Date.now() - t0 }));
        setTimeout(() => s.destroy(), 5000);
    });
}

test('the source gate: a connection from outside allowCIDRs is closed at once, unanswered, and logged once a minute', async () => {
    const shell = await startFakeShell();
    // 127.0.0.1 stands in for a device here (not this machine), outside the tailnet range.
    const e = await edgeFor({ allowCIDRs: '100.64.0.0/10' }, { selfOrigin: () => shell.origin, thisMac: () => false });
    try {
        for (let i = 0; i < 100 && !/serving DSH at/.test(e.logText()); i++) await sleep(20);
        const before = shell.seen.length; // the edge's own probe at start
        await assert.rejects(http(`${e.base}/?token=secret-launch-token`, { headers: { accept: 'text/html' } }), /ECONNRESET|socket hang up/, 'a browser gets no answer');
        await assert.rejects(http(`${e.base}/.dsh-site/health`), /ECONNRESET|socket hang up/, 'health is behind the gate too');
        const ws = await openWs(`${e.base.replace('http', 'ws')}/api/remote.mux`, { origin: e.base });
        assert.equal(ws.opened, false);
        const bare = await Promise.all(Array.from({ length: 20 }, () => bareSocket(e.settings.listenPort)));
        assert.ok(bare.every((b) => b.got === '' && b.ms < 2000), `bare sockets are closed at once: ${bare.map((b) => b.ms).join(',')} ms`);
        const half = await bareSocket(e.settings.listenPort, 'GET / HTTP/1.1\r\nHost: x');
        assert.equal(half.got, '', 'half a request gets nothing either');
        assert.equal(e.edge.connections, 0, 'the edge holds no connection from that source');
        assert.equal(shell.seen.length, before, 'nothing from the device reached DSH');
        const lines = e.logText().split('\n').filter((l) => /deny 127\.0\.0\.1/.test(l));
        assert.equal(lines.length, 1, e.logText());
        assert.match(lines[0], /deny 127\.0\.0\.1: not in allowCIDRs; connection closed$/);
        assert.doesNotMatch(e.logText(), /secret-launch-token/);
    } finally {
        await e.done();
        await shell.close();
    }
});

test('DNS rebinding and cross-site requests are refused before DSH sees them, for HTTP and WebSocket', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({ injectAuthCookie: true, allowHosts: 'mymac.example.ts.net' }, { selfOrigin: () => shell.origin, readCookie: found(shell.cookie) });
    const port = e.settings.listenPort;
    try {
        const rebound = await http(`${e.base}/`, { headers: { host: `rebind.attacker.example:${port}`, accept: 'text/html' } });
        assert.equal(rebound.status, 421);
        assert.match(rebound.text, /add the name to allowHosts/);
        const listed = await http(`${e.base}/`, { headers: { host: `mymac.example.ts.net:${port}` } });
        assert.equal(listed.status, 200, 'a listed name passes');
        const cross = await http(`${e.base}/api/x`, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'text/plain' }, body: '{}' });
        assert.equal(cross.status, 403);
        assert.equal(cross.text, 'dsh-site: refused cross-site request from http://evil.example\n');
        const marked = await http(`${e.base}/`, { headers: { 'sec-fetch-site': 'cross-site' } });
        assert.equal(marked.status, 403);
        const before = shell.seen.length;
        const evilWs = await openWs(`ws://127.0.0.1:${port}/api/remote.mux`, { origin: 'http://evil.example' });
        assert.equal(evilWs.opened, false, 'a page on another site cannot open DSH\'s socket');
        const rebindWs = await openWs(`ws://127.0.0.1:${port}/api/remote.mux`, { host: `rebind.attacker.example:${port}`, origin: `http://rebind.attacker.example:${port}` });
        assert.equal(rebindWs.opened, false);
        assert.equal(shell.seen.length, before, 'no refused request reached DSH');
        const good = await openWs(`ws://127.0.0.1:${port}/api/remote.mux`, { origin: `http://127.0.0.1:${port}` });
        assert.equal(good.opened, true, 'DSH\'s own page opens its socket');
        good.socket.send('hello');
        for (let i = 0; i < 50 && good.messages.length === 0; i++) await sleep(20);
        assert.deepEqual(good.messages, ['echo:hello']);
        const up = shell.seen.at(-1);
        assert.equal(up.method, 'UPGRADE');
        assert.equal(up.headers.origin, shell.origin);
        assert.equal(up.headers.cookie, shell.cookie);
        good.socket.close();
        const log = e.logText();
        assert.match(log, /refused 127\.0\.0\.1 GET \/: Host rebind\.attacker\.example:\d+ is not an IP address and not in allowHosts/);
        assert.match(log, /cross-site request from http:\/\/evil\.example/);
        assert.match(log, /websocket 127\.0\.0\.1 \/api\/remote\.mux opened/);
    } finally {
        await e.done();
        await shell.close();
    }
});

test('before the desktop window has signed in: a browser gets a page that retries, a program gets DSH\'s own answer', async () => {
    const shell = await startFakeShell();
    let jar = { status: 'missing', others: 0 };
    const e = await edgeFor({ injectAuthCookie: true }, { selfOrigin: () => shell.origin, readCookie: async () => jar });
    try {
        const page = await http(`${e.base}/`, { headers: { accept: 'text/html' } });
        assert.equal(page.status, 503);
        assert.match(page.text, /Waiting for DSH on this Mac to sign in/);
        assert.equal(page.headers['retry-after'], '5');
        const api = await http(`${e.base}/api/x`, { headers: { accept: 'application/json' } });
        assert.equal(api.status, 401, 'passed on without a cookie');
        assert.match(e.logText(), /no sign-in cookie for 127\.0\.0\.1:\d+ in the cookie jar yet/);
        jar = { status: 'found', cookie: shell.cookie };
        await sleep(3100); // a miss is kept 3 s
        const after = await http(`${e.base}/`, { headers: { accept: 'text/html' } });
        assert.equal(after.status, 200);
        assert.match(e.logText(), /sign-in cookie found for 127\.0\.0\.1:\d+ \(dsh-auth-/);
        const health = JSON.parse((await http(`${e.base}/.dsh-site/health`)).text);
        assert.equal(health.authInjected, true);
        assert.equal(health.cookie, 'found');
    } finally {
        await e.done();
        await shell.close();
    }
});

test('a stale cookie: DSH answers 401, the edge reads the jar again and replays the read once', async () => {
    const shell = await startFakeShell();
    let reads = 0;
    const e = await edgeFor({ injectAuthCookie: true }, {
        selfOrigin: () => shell.origin,
        readCookie: async () => {
            reads += 1;
            return { status: 'found', cookie: reads === 1 ? `${shell.cookie.split('=')[0]}=stale` : shell.cookie };
        },
    });
    try {
        const res = await http(`${e.base}/`);
        assert.equal(res.status, 200);
        assert.equal(reads, 2);
        assert.equal(shell.seen.filter((s) => s.url === '/' && s.headers.cookie).length, 2, 'one 401, one replay (besides the probe, which sends no cookie)');
        // A POST is never replayed: DSH's 401 goes back as it is.
        shell.value = 'rotated';
        const post = await http(`${e.base}/api/x`, { method: 'POST', body: 'x' });
        assert.equal(post.status, 401);
    } finally {
        await e.done();
        await shell.close();
    }
});

test('the cookie jar keeps cookies encrypted, or cannot be read: said in words, in health, and on the page a browser gets', async () => {
    const shell = await startFakeShell();
    let jar = { status: 'encrypted', others: 0 };
    const e = await edgeFor({ injectAuthCookie: true }, { selfOrigin: () => shell.origin, readCookie: async () => jar });
    try {
        const health = JSON.parse((await http(`${e.base}/.dsh-site/health`)).text);
        assert.equal(health.cookie, 'encrypted');
        assert.equal(health.authInjected, false);
        assert.match(e.logText(), /keeps its cookies encrypted, so dsh-site cannot read the sign-in cookie: set injectAuthCookie to false/);
        let page = await http(`${e.base}/`, { headers: { accept: 'text/html' } });
        assert.equal(page.status, 503);
        assert.match(page.text, /The edge cannot sign this device in/);
        assert.match(page.text, /keeps its sign-in cookie encrypted/);
        assert.equal(page.headers['retry-after'], '30');

        jar = { status: 'error', reason: 'the cookie jar file (cookieJar) does not exist' };
        await sleep(3100); // a miss is kept 3 s
        page = await http(`${e.base}/`, { headers: { accept: 'text/html' } });
        assert.equal(page.status, 503);
        assert.match(page.text, /could not read the sign-in cookie of DSH&#39;s window|could not read the sign-in cookie of DSH's window/);
        assert.match(page.text, /does not exist/);
        assert.match(e.logText(), /cannot read the sign-in cookie: the cookie jar file \(cookieJar\) does not exist/);
        const program = await http(`${e.base}/api/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(program.status, 401, 'a program gets DSH\'s own answer, not a page');
    } finally {
        await e.done();
        await shell.close();
    }
});

test('at a DSH start the edge looks quietly while DSH starts its window server, then names where it found it, once', async () => {
    let shell;
    let self;
    const e = await edgeFor({}, { selfOrigin: () => self, graceMs: 4000 });
    try {
        await sleep(700);
        assert.doesNotMatch(e.logText(), /not found/, 'nothing said while DSH may still be starting');
        const early = await http(`${e.base}/`, { headers: { accept: 'text/html' } });
        assert.equal(early.status, 503, 'a browser gets the page that retries meanwhile');
        shell = await startFakeShell();
        self = shell.origin;
        await e.edge.refreshTarget(); // DSH's webServer service came up
        assert.equal((await http(`${e.base}/`)).status, 401);
        const text = e.logText();
        assert.doesNotMatch(text, /not found/);
        assert.equal((text.match(/serving DSH at /g) ?? []).length, 1);
        assert.match(text, /serving DSH at http:\/\/127\.0\.0\.1:\d+ \(found by DSH's own window server\)/);
    } finally {
        await e.done();
        await shell?.close();
    }
});

test('found among its own ports first, then DSH says where it is: health says so, the log does not repeat', async () => {
    const shell = await startFakeShell();
    let self;
    const e = await edgeFor({}, { selfOrigin: () => self, listListeners: async () => ({ ports: [shell.port] }) });
    try {
        let health = await e.edge.health();
        assert.equal(health.foundBy, 'listeners');
        self = shell.origin;
        await e.edge.refreshTarget();
        health = await e.edge.health();
        assert.equal(health.foundBy, 'dsh');
        assert.equal((e.logText().match(/serving DSH at /g) ?? []).length, 1, 'the same server is named once');
    } finally {
        await e.done();
        await shell.close();
    }
});

test('no DSH at all: after the grace time it says so once, and a found DSH later is named', async () => {
    let shell;
    let self;
    const e = await edgeFor({}, { selfOrigin: () => self, graceMs: 600 });
    try {
        for (let i = 0; i < 100 && !/not found yet/.test(e.logText()); i++) await sleep(30);
        assert.equal((e.logText().match(/not found yet/g) ?? []).length, 1);
        await sleep(800);
        assert.equal((e.logText().match(/not found yet/g) ?? []).length, 1, 'not repeated');
        shell = await startFakeShell();
        self = shell.origin;
        await e.edge.refreshTarget();
        assert.match(e.logText(), /serving DSH at /);
    } finally {
        await e.done();
        await shell?.close();
    }
});

test('where DSH is: its own window server first; targetOrigin only when DSH does not say; then its own ports', async () => {
    const own = await startFakeShell();
    const other = await startFakeShell();
    try {
        // targetOrigin names another DSH: the edge still serves the one it runs in, and says so.
        const a = await edgeFor({ targetOrigin: other.origin }, { selfOrigin: () => own.origin });
        assert.equal((await http(`${a.base}/`)).status, 401);
        assert.equal(own.seen.length > 0 && other.seen.length === 0, true, 'nothing went to the other DSH');
        assert.match(a.logText(), new RegExp(`targetOrigin ${other.origin.replace(/[.:/]/g, '\\$&')} is not this DSH's window server, so it is not used`));
        let health = await a.edge.health();
        assert.equal(health.foundBy, 'dsh');
        assert.equal(health.target, own.origin);
        await a.done();

        // DSH does not say (an older composition): targetOrigin.
        const b = await edgeFor({ targetOrigin: other.origin }, { selfOrigin: () => undefined });
        health = await b.edge.health();
        assert.equal(health.foundBy, 'targetOrigin');
        await b.done();

        // Neither: this process's own listening ports (lsof), skipping the edge's own port.
        const c = await edgeFor({}, { selfOrigin: () => undefined, listListeners: async () => ({ ports: [1, own.port] }) });
        health = await c.edge.health();
        assert.equal(health.foundBy, 'listeners');
        assert.equal(health.discovered, true);
        assert.equal(health.ok, true);
        await c.done();

        // Nothing answers as DSH: a page that retries, and ok false in health.
        const d = await edgeFor({}, { selfOrigin: () => undefined, listListeners: async () => ({ ports: [], error: 'the lsof program is missing' }) });
        const page = await http(`${d.base}/`, { headers: { accept: 'text/html' } });
        assert.equal(page.status, 503);
        assert.match(page.text, /DSH's window server was not found/);
        health = await d.edge.health();
        assert.equal(health.ok, false);
        assert.equal(health.target, null);
        assert.match(d.logText(), /DSH's window server not found yet/);
        assert.match(d.logText(), /lsof program is missing/);
        await d.done();
    } finally {
        await own.close();
        await other.close();
    }
});

test('DSH goes away and comes back on another port: the edge finds it again; while it is gone, a page that retries', async () => {
    let shell = await startFakeShell();
    let current = shell.origin;
    const e = await edgeFor({}, { selfOrigin: () => current });
    try {
        assert.equal((await http(`${e.base}/`)).status, 401);
        await shell.close();
        const gone = await http(`${e.base}/`, { headers: { accept: 'text/html' } });
        assert.equal(gone.status, 503, 'found again and not there: not found');
        shell = await startFakeShell();
        current = shell.origin;
        assert.equal((await http(`${e.base}/`)).status, 401, 'the new port is used');
        assert.equal(shell.seen.length, 2, 'the probe and the request');
        assert.match(e.logText(), new RegExp(`serving DSH at ${shell.origin.replace(/[.:/]/g, '\\$&')}`));
    } finally {
        await e.done();
        await shell.close();
    }
});

test('a streamed reply passes as it comes, not when it ends', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({ injectAuthCookie: true }, { selfOrigin: () => shell.origin, readCookie: found(shell.cookie) });
    try {
        const first = await new Promise((resolve, reject) => {
            const req = request(`${e.base}/events`, (res) => {
                res.setEncoding('utf8');
                res.once('data', (c) => {
                    resolve({ status: res.statusCode, chunk: c });
                    req.destroy();
                });
            });
            req.on('error', reject);
            req.end();
        });
        assert.equal(first.status, 200);
        assert.equal(first.chunk, 'data: one\n\n');
    } finally {
        await e.done();
        await shell.close();
    }
});

test('off: closing the edge cuts every connection through it at once, WebSockets and streams included', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({ injectAuthCookie: true }, { selfOrigin: () => shell.origin, readCookie: found(shell.cookie) });
    const ws = await openWs(`${e.base.replace('http', 'ws')}/api/remote.mux`, { origin: e.base });
    assert.equal(ws.opened, true);
    let wsClosed = false;
    ws.socket.addEventListener('close', () => { wsClosed = true; });
    let streamEnded = false;
    await new Promise((resolve) => {
        const req = request(`${e.base}/events`, (res) => {
            res.once('data', resolve);
            res.on('close', () => { streamEnded = true; });
        });
        req.on('error', () => { streamEnded = true; });
        req.end();
    });
    for (let i = 0; i < 50 && shell.streams.size < 2; i++) await sleep(20);
    assert.equal(shell.streams.size, 2, 'both are open through to DSH');
    const t0 = Date.now();
    await e.edge.close();
    assert.ok(Date.now() - t0 < 2500, 'closing does not wait for devices');
    for (let i = 0; i < 100 && !(wsClosed && streamEnded && shell.streams.size === 0); i++) await sleep(20);
    assert.equal(wsClosed, true, 'the device\'s WebSocket is closed');
    assert.equal(streamEnded, true, 'the device\'s stream is ended');
    assert.equal(shell.streams.size, 0, 'DSH\'s side is closed too');
    await assert.rejects(http(`${e.base}/`), /ECONNREFUSED/, 'the port is closed');
    assert.match(e.logText(), /stopped; closed the port and \d+ connections?/);
    await e.done();
    await shell.close();
});

test('a port in use: retried, said in words, and served as soon as it is free', async () => {
    const holder = createServer();
    const port = await freePort();
    await new Promise((r) => holder.listen(port, '127.0.0.1', r));
    const shell = await startFakeShell();
    const e = await edgeFor({}, { port, noStart: true, selfOrigin: () => shell.origin });
    try {
        const pending = e.edge.start();
        await sleep(1200);
        await new Promise((r) => holder.close(r));
        const got = await pending;
        assert.deepEqual(got, { ok: true }, 'listening once the other program let go');
        assert.equal((await http(`http://127.0.0.1:${port}/`)).status, 401);
    } finally {
        await e.done();
        await shell.close();
    }
    // Held for good: the words, and no crash.
    const holder2 = createServer();
    const port2 = await freePort();
    await new Promise((r) => holder2.listen(port2, '127.0.0.1', r));
    const e2 = await edgeFor({}, { port: port2, noStart: true });
    try {
        const got = await e2.edge.start();
        assert.equal(got.ok, false);
        assert.equal(got.retrying, true);
        assert.match(got.reason, new RegExp(`port ${port2} is already in use on 127\\.0\\.0\\.1 \\(another program, or another DSH, holds it\\), so dsh-site is not serving yet; it tries again every 30 seconds`));
        assert.match(e2.logText(), /already in use/);
    } finally {
        await e2.done();
        await new Promise((r) => holder2.close(r));
    }
});

test('health tells the truth: listening, where DSH is, how devices sign in, how many are connected', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({ allowHosts: 'mymac.example.ts.net' }, { selfOrigin: () => shell.origin, version: '9.9.9' });
    const idle = connect(e.settings.listenPort, '127.0.0.1');
    await new Promise((r) => idle.once('connect', r));
    for (let i = 0; i < 50 && e.edge.connections === 0; i++) await sleep(10);
    try {
        const health = await e.edge.health();
        assert.equal(health.ok, true);
        assert.equal(health.plugin, 'dsh-site');
        assert.equal(health.version, '9.9.9');
        assert.equal(health.pid, process.pid);
        assert.equal(health.listen, `127.0.0.1:${e.settings.listenPort}`);
        assert.equal(health.target, shell.origin);
        assert.equal(health.auth, 'shell');
        assert.equal(health.cookie, 'off');
        assert.equal(health.authInjected, false);
        assert.deepEqual(health.allowCIDRs, ['127.0.0.0/8']);
        assert.deepEqual(health.allowHosts, ['mymac.example.ts.net']);
        assert.equal(health.allowThisMac, true);
        assert.ok(health.connections >= 1, 'the open connection is counted');
        assert.match(health.since, /^\d{4}-\d\d-\d\dT/);
    } finally {
        idle.destroy();
        await e.done();
        await shell.close();
    }
});

test('helpers: the shell signature, lsof output, DSH\'s webServer service', async () => {
    assert.equal(looksLikeShell(401, 'dsh web authentication required; reopen the URL printed by dsh web.\n'), true);
    assert.equal(looksLikeShell(401, 'Unauthorized'), false);
    assert.equal(looksLikeShell(200, '<script>__DSH_BOOT__</script>'), true);
    assert.equal(looksLikeShell(200, 'hello'), false);
    assert.equal(await probeShell('not a url'), false);
    assert.equal(await probeShell(`http://127.0.0.1:${await freePort()}`), false);
    const out = [
        'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
        'node    29905 me   21u  IPv4 0x1      0t0  TCP 127.0.0.1:56261 (LISTEN)',
        'node    29905 me   22u  IPv6 0x2      0t0  TCP [::1]:56263 (LISTEN)',
        'node    29905 me   23u  IPv4 0x3      0t0  TCP *:8443 (LISTEN)',
        'node    29905 me   24u  IPv4 0x4      0t0  TCP 192.168.1.5:7000 (LISTEN)',
        'node    29905 me   25u  IPv4 0x5      0t0  TCP 127.0.0.1:56261 (LISTEN)',
    ].join('\n');
    assert.deepEqual(parseListeners(out), [56261, 56263, 8443], 'loopback and wildcard listeners only, once each');
    assert.equal(originOf(undefined), undefined);
    assert.equal(originOf({ port: undefined, host: '127.0.0.1' }), undefined, 'not listening yet');
    assert.equal(originOf({ port: 52817, host: '127.0.0.1' }), 'http://127.0.0.1:52817');
    assert.equal(originOf({ port: 52817, host: '0.0.0.0' }), 'http://127.0.0.1:52817');
    assert.equal(originOf({ port: 52817, host: '::1' }), 'http://[::1]:52817');
    let said = '';
    assert.equal(originOf({ port: 52817, host: '127.0.0.1', protocol: 'https:' }, (line) => { said = line; }), undefined);
    assert.match(said, /over HTTPS/);
    assert.equal(originOf({ get port() { throw new Error('gone'); } }), undefined, 'a service that throws is no answer, never a crash');
});

test('every answer the edge passes on tells the browser that no other site may frame it or load it', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({ injectAuthCookie: true }, { selfOrigin: () => shell.origin, readCookie: found(shell.cookie) });
    try {
        const res = await http(`${e.base}/`, { headers: { accept: 'text/html' } });
        assert.equal(res.status, 200);
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(res.headers['content-security-policy'], "frame-ancestors 'self'");
        assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
        const own = await new Promise((resolve, reject) => {
            const req = request(`${e.base}/csp`, (r) => { r.resume(); r.on('end', () => resolve(r.rawHeaders)); });
            req.on('error', reject);
            req.end();
        });
        const policies = own.filter((_, i) => i % 2 === 0 && /^content-security-policy$/i.test(own[i])).map((_, i, all) => all[i]);
        const values = own.flatMap((v, i) => (i % 2 === 0 && /^content-security-policy$/i.test(v) ? [own[i + 1]] : []));
        assert.deepEqual(values, ["script-src 'self'", "frame-ancestors 'self'"], `DSH's own policy is kept and ours is added beside it (${policies.length})`);
        const page = await http(`${e.base}/`, { headers: { accept: 'text/html', host: `rebind.attacker.example:${e.settings.listenPort}` } });
        assert.equal(page.status, 421);
        assert.equal(page.headers['x-frame-options'], 'DENY', 'the edge\'s own pages cannot be framed either');
        assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
        assert.match(page.headers['content-security-policy'], /default-src 'none'/);
        assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin');
        assert.deepEqual(guardHeaders({ 'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-site' }), { 'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-site', 'content-security-policy': ["frame-ancestors 'self'"] }, 'DSH\'s own stricter answers are kept');
    } finally {
        await e.done();
        await shell.close();
    }
});

test('a frame or embed marked as coming from another page is refused before DSH sees it', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({ injectAuthCookie: true }, { selfOrigin: () => shell.origin, readCookie: found(shell.cookie) });
    try {
        await http(`${e.base}/`);
        const before = shell.seen.length;
        for (const [site, dest] of [['same-site', 'iframe'], ['cross-site', 'iframe'], ['same-site', 'embed'], ['same-site', 'object'], ['same-site', 'frame']]) {
            const res = await http(`${e.base}/`, { headers: { accept: 'text/html', 'sec-fetch-site': site, 'sec-fetch-dest': dest } });
            assert.equal(res.status, 403, `${site} ${dest}`);
            assert.match(res.text, /DSH cannot be shown inside another page/);
        }
        assert.equal(shell.seen.length, before, 'none reached DSH');
        assert.equal((await http(`${e.base}/`, { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' } })).status, 200, 'DSH may frame its own pages');
        assert.equal((await http(`${e.base}/`, { headers: { 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' } })).status, 200, 'a typed address passes');
        assert.match(e.logText(), /refused 127\.0\.0\.1 GET \/: a frame or embed from another page \(iframe\)/);
    } finally {
        await e.done();
        await shell.close();
    }
});

test('the log never holds a query: a refused sign-in link leaves no launch token in it, for any refusal', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({}, { selfOrigin: () => shell.origin });
    const port = e.settings.listenPort;
    const token = 'tok-3f9a1c7e5b2d';
    try {
        // Each refusal below has its own kind or Host, so each writes its own line (repeats of one are said once).
        await http(`${e.base}/?token=${token}`, { headers: { host: `mymac.example.ts.net:${port}`, accept: 'text/html' } });
        await openWs(`ws://127.0.0.1:${port}/api/remote.mux?token=${token}`, { origin: 'http://evil.example' });
        await http(`${e.base}/?token=${token}`, { headers: { host: `127.0.0.2:${port}`, 'sec-fetch-site': 'cross-site' } });
        await http(`${e.base}/?token=${token}`, { headers: { host: `127.0.0.3:${port}`, origin: 'http://evil.example' } });
        await http(`${e.base}/?token=${token}`, { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'iframe' } });
        await http(`${e.base}/x?token=${token}#frag`, { headers: { host: `other.example:${port}` } });
        const log = e.logText();
        assert.doesNotMatch(log, new RegExp(token), log);
        assert.match(log, /refused 127\.0\.0\.1 GET \/\?…: Host mymac\.example\.ts\.net:\d+ is not an IP address and not in allowHosts/);
        assert.match(log, /refused 127\.0\.0\.1 GET \(WebSocket\) \/api\/remote\.mux\?…: cross-site request from http:\/\/evil\.example/);
        assert.match(log, /refused 127\.0\.0\.1 GET \/\?…: cross-site request from another site/);
        assert.match(log, /refused 127\.0\.0\.1 GET \/\?…: cross-site request from http:\/\/evil\.example/);
        assert.match(log, /refused 127\.0\.0\.1 GET \/\?…: a frame or embed from another page \(iframe\)/);
        assert.match(log, /refused 127\.0\.0\.1 GET \/x\?…: Host other\.example:\d+ is not an IP address and not in allowHosts/);
        assert.equal(logPath('/a/b?token=x#y'), '/a/b?…');
        assert.equal(logPath('/a#y'), '/a?…');
        assert.equal(logPath('/plain'), '/plain');
        assert.equal(logPath(undefined), '');
    } finally {
        await e.done();
        await shell.close();
    }
});

test('own sign-in: a device signed in through the edge stays signed in when DSH restarts on another port', async () => {
    const secret = 'kept-in-dsh-home';
    let shell = await startFakeShell({ secret });
    let current = shell.origin;
    const e = await edgeFor({}, { selfOrigin: () => current });
    const authority = `127.0.0.1:${e.settings.listenPort}`;
    try {
        const signIn = await http(`${e.base}/?token=${shell.token}`, { headers: { accept: 'text/html' } });
        assert.equal(signIn.status, 303, 'DSH\'s sign-in link works through the edge');
        assert.equal(signIn.headers.location, './');
        const cookie = String(signIn.headers['set-cookie']?.[0] ?? '').split(';')[0];
        assert.ok(cookie.startsWith(`${cookieNameFor(authority)}=`), 'DSH names the device\'s cookie after the edge\'s fixed loopback authority, not after its own port');
        const up = shell.seen.at(-1);
        assert.equal(up.headers.host, authority);
        const post = await http(`${e.base}/api/x`, { method: 'POST', headers: { cookie, origin: e.base, referer: `${e.base}/a`, 'content-type': 'application/json' }, body: '{}' });
        assert.equal(post.status, 200);
        assert.equal(shell.seen.at(-1).headers.origin, `http://${authority}`, 'Origin and Referer name the same authority');
        assert.equal(shell.seen.at(-1).headers.referer, `http://${authority}/`);
        assert.equal((await http(`${e.base}/`, { headers: { cookie, accept: 'text/html' } })).status, 200);

        const oldPort = shell.port;
        await shell.close();
        shell = await startFakeShell({ secret });
        current = shell.origin;
        assert.notEqual(shell.port, oldPort, 'DSH came back on another port');
        const after = await http(`${e.base}/`, { headers: { cookie, accept: 'text/html' } });
        assert.equal(after.status, 200, 'the same cookie still signs the device in: no new sign-in link');
        assert.match(after.text, /__DSH_BOOT__/);
    } finally {
        await e.done();
        await shell.close();
    }
});

test('own sign-in: a browser that is not signed in gets a page that says how; a program gets DSH\'s answer', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({}, { selfOrigin: () => shell.origin });
    const port = e.settings.listenPort;
    try {
        const page = await http(`${e.base}/`, { headers: { accept: 'text/html', host: `100.101.102.103:${port}` } });
        assert.equal(page.status, 401);
        assert.match(page.text, /Sign in to DSH on this device/);
        assert.match(page.text, /with its start changed to http:\/\/100\.101\.102\.103:\d+\//);
        assert.match(page.text, /set injectAuthCookie to true/);
        assert.doesNotMatch(page.text, /earlier start/);
        assert.equal(page.headers['x-frame-options'], 'DENY');
        const stale = await http(`${e.base}/?token=from-yesterday`, { headers: { accept: 'text/html' } });
        assert.equal(stale.status, 401);
        assert.match(stale.text, /This sign-in link is from an earlier start of DSH/);
        const program = await http(`${e.base}/api/x`, { headers: { accept: 'application/json' } });
        assert.equal(program.status, 401);
        assert.match(program.text, /dsh web authentication required/, 'a program gets DSH\'s own 401');
    } finally {
        await e.done();
        await shell.close();
    }
});

test('an address that is not on this machine yet (a tailnet still connecting) is tried again, said once, and stops when off', async () => {
    const e = await edgeFor({ listenHost: '192.0.2.10' }, { noStart: true, retryMs: 1000, port: await freePort() });
    try {
        const got = await e.edge.start();
        assert.equal(got.ok, false);
        assert.equal(got.retrying, true);
        assert.match(got.reason, /192\.0\.2\.10 is not an address of this machine right now \(listenHost\), so dsh-site is not serving yet; it tries again every 1 second /);
        await sleep(2300);
        assert.equal((e.logText().match(/is not an address of this machine/g) ?? []).length, 1, 'said once, not at every try');
    } finally {
        await e.done();
    }
});

/** Raw bytes to the edge: what came back, and whether the edge closed the connection within `ms`. */
function rawExchange(port, text, ms = 2000) {
    return new Promise((resolve) => {
        let got = '';
        const s = connect(port, '127.0.0.1', () => s.write(text));
        s.on('data', (d) => { got += d; });
        s.on('error', () => {});
        const timer = setTimeout(() => { s.destroy(); resolve({ text: got, closed: false }); }, ms);
        s.on('close', () => { clearTimeout(timer); resolve({ text: got, closed: true }); });
    });
}

/** A request whose answer may be cut: whether it ended, whether complete, what came, within `ms`. */
function readAnswer(url, ms = 3000) {
    return new Promise((resolve) => {
        let body = '';
        const timer = setTimeout(() => resolve({ open: true, body }), ms);
        const req = request(url, (res) => {
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('error', () => {});
            res.on('close', () => { clearTimeout(timer); resolve({ open: false, complete: res.complete, status: res.statusCode, body }); });
        });
        req.on('error', () => { clearTimeout(timer); resolve({ open: false, complete: false, body }); });
        req.end();
    });
}

test('DSH ends its answer part-way: the device\'s answer is ended there too, never left open, and the log says so', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({ injectAuthCookie: true }, { selfOrigin: () => shell.origin, readCookie: found(shell.cookie) });
    try {
        for (const path of ['/cut', '/cut-length']) {
            const got = await readAnswer(`${e.base}${path}`);
            assert.equal(got.open, false, `${path}: the device's answer is still open 3 s after DSH dropped it`);
            assert.equal(got.complete, false, `${path}: the device sees the answer cut, not complete`);
            assert.equal(got.status, 200);
            assert.ok(got.body.length > 0, `${path}: what DSH sent before it stopped reached the device`);
        }
        for (let i = 0; i < 100 && e.edge.connections > 0; i++) await sleep(20);
        assert.equal(e.edge.connections, 0, 'the edge holds no connection for the cut answers');
        const log = e.logText();
        assert.match(log, /DSH's window server ended its answer to 127\.0\.0\.1 GET \/cut part-way; the device's answer was ended there too/);
        assert.match(log, /ended its answer to 127\.0\.0\.1 GET \/cut-length part-way/);
        // A whole answer is still whole.
        const whole = await readAnswer(`${e.base}/`);
        assert.equal(whole.complete, true);
        assert.match(whole.body, /__DSH_BOOT__/);
        // The device going away is not DSH cutting its answer: nothing said.
        const before = (e.logText().match(/part-way/g) ?? []).length;
        await new Promise((resolve) => {
            const req = request(`${e.base}/events`, (res) => res.once('data', () => { req.destroy(); resolve(); }));
            req.on('error', () => {});
            req.end();
        });
        for (let i = 0; i < 50 && shell.streams.size > 0; i++) await sleep(20);
        assert.equal(shell.streams.size, 0, 'DSH\'s side of the stream is closed when the device leaves');
        assert.equal((e.logText().match(/part-way/g) ?? []).length, before);
    } finally {
        await e.done();
        await shell.close();
    }
});

test('this Mac\'s own addresses: loopback and every address on its interfaces (its tailnet address too), read at each call', () => {
    let list = { lo0: [{ address: '127.0.0.1' }, { address: '::1' }], en0: [{ address: '192.168.1.5' }, { address: 'fe80::1' }] };
    const ifs = () => list;
    assert.equal(isOwnAddress('127.0.0.1', ifs), true);
    assert.equal(isOwnAddress('127.0.0.2', ifs), true, 'all of 127/8');
    assert.equal(isOwnAddress('::1', ifs), true);
    assert.equal(isOwnAddress('::ffff:127.0.0.1', ifs), true);
    assert.equal(isOwnAddress('192.168.1.5', ifs), true);
    assert.equal(isOwnAddress('::ffff:192.168.1.5', ifs), true);
    assert.equal(isOwnAddress('fe80::1%en0', ifs), true);
    assert.equal(isOwnAddress('100.101.102.103', ifs), false, 'not one of its addresses yet');
    list = { ...list, utun4: [{ address: '100.101.102.103' }, { address: 'fd7a:115c:a1e0::53' }] };
    assert.equal(isOwnAddress('100.101.102.103', ifs), true, 'its tailnet address, once the tailnet is up');
    assert.equal(isOwnAddress('fd7a:115c:a1e0::53', ifs), true);
    assert.equal(isOwnAddress('100.101.102.104', ifs), false, 'another device on the tailnet');
    assert.equal(isOwnAddress('100.101.102.104', () => { throw new Error('no'); }), true, 'interfaces unreadable: counted as this Mac (refused), never let in by a guess');
    assert.equal(isOwnAddress('', ifs), false);
});

test('this Mac\'s own programs get a page, never DSH, unless allowThisMac is true', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({ injectAuthCookie: true, allowThisMac: false, allowCIDRs: '100.64.0.0/10' }, { selfOrigin: () => shell.origin, readCookie: found(shell.cookie) });
    try {
        for (let i = 0; i < 100 && !/serving DSH at/.test(e.logText()); i++) await sleep(20);
        const before = shell.seen.length; // the edge's own probe at start
        const page = await http(`${e.base}/`, { headers: { accept: 'text/html' } });
        assert.equal(page.status, 403);
        assert.match(page.text, /This is the Mac DSH runs on/);
        assert.match(page.text, /set allowThisMac to true/);
        assert.equal(page.headers['x-frame-options'], 'DENY');
        const program = await http(`${e.base}/api/x`, { method: 'POST', headers: { origin: e.base, 'content-type': 'application/json' }, body: '{}' });
        assert.equal(program.status, 403);
        assert.equal(program.text, 'dsh-site: refused: this is the Mac DSH runs on (allowThisMac is false); the edge serves other devices\n');
        assert.equal((await http(`${e.base}/.dsh-site/health`)).status, 403, 'health is refused too');
        const ws = await openWs(`${e.base.replace('http', 'ws')}/api/remote.mux`, { origin: e.base });
        assert.equal(ws.opened, false, 'no events socket either');
        assert.equal(shell.seen.length, before, 'nothing from this Mac reached DSH');
        const log = e.logText();
        const lines = log.split('\n').filter((l) => /this machine's own address/.test(l));
        assert.equal(lines.length, 1, `said once a minute: ${lines.join(' | ')}`);
        assert.match(lines[0], /refused 127\.0\.0\.1 GET \/: this machine's own address \(allowThisMac is false\); the edge serves other devices/);
        assert.match(log, /this machine's own programs refused/);
        assert.match(log, /127\.0\.0\.1 is reached only by this machine's own programs, and allowThisMac is false/);
    } finally {
        await e.done();
    }
    const e2 = await edgeFor({ injectAuthCookie: true, allowThisMac: true, allowCIDRs: '100.64.0.0/10' }, { selfOrigin: () => shell.origin, readCookie: found(shell.cookie) });
    try {
        const res = await http(`${e2.base}/`, { headers: { accept: 'text/html' } });
        assert.equal(res.status, 200, 'allowThisMac: true lets this Mac in, whatever allowCIDRs says');
        assert.equal(JSON.parse((await http(`${e2.base}/.dsh-site/health`)).text).allowThisMac, true);
        assert.match(e2.logText(), /this machine's own programs let in \(allowThisMac\)/);
        assert.doesNotMatch(e2.logText(), /is reached only by this machine's own programs/);
    } finally {
        await e2.done();
        await shell.close();
    }
});

test('only WebSocket upgrades pass, and nothing a device sends behind its upgrade request reaches DSH before DSH takes it', async () => {
    assert.equal(isWebSocketUpgrade({ upgrade: 'WebSocket' }), true);
    assert.equal(isWebSocketUpgrade({ upgrade: 'h2c' }), false);
    assert.equal(statusOf('HTTP/1.1 101 Switching Protocols\r\n'), 101);
    assert.equal(statusOf('garbage'), 0);
    const shell = await startFakeShell({ upgradeDelayMs: 300 });
    const e = await edgeFor({ injectAuthCookie: true }, { selfOrigin: () => shell.origin, readCookie: found(shell.cookie) });
    const port = e.settings.listenPort;
    try {
        await http(`${e.base}/`);
        const before = shell.seen.length;
        const h2c = await rawExchange(port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n`);
        assert.match(h2c.text, /^HTTP\/1\.1 400 /, h2c.text.slice(0, 60));
        assert.match(h2c.text, /the edge passes WebSocket upgrades only/);
        assert.equal(shell.seen.length, before, 'DSH never saw the other protocol');
        assert.match(e.logText(), /an upgrade to "h2c"; the edge passes WebSockets only/);
        const key = randomBytes(16).toString('base64');
        const behind = 'GET /api/secret HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n';
        const ws = await rawExchange(port, `GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n${behind}`, 1500);
        assert.match(ws.text, /^HTTP\/1\.1 101 /, ws.text.slice(0, 60));
        const up = shell.seen.at(-1);
        assert.equal(up.method, 'UPGRADE');
        assert.equal(up.early, 0, 'DSH got not one byte from the device before it took the upgrade');
    } finally {
        await e.done();
        await shell.close();
    }
    // DSH does not take it (own sign-in mode, no cookie): its answer reaches the device, and the connection ends there.
    const shell2 = await startFakeShell({ upgradeDelayMs: 200 });
    const e2 = await edgeFor({}, { selfOrigin: () => shell2.origin });
    try {
        const key = randomBytes(16).toString('base64');
        const port2 = e2.settings.listenPort;
        const got = await rawExchange(port2, `GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:${port2}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\nGET /api/secret HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`, 6000);
        assert.match(got.text, /^HTTP\/1\.1 401 /, got.text.slice(0, 60));
        assert.equal(got.closed, true, 'the connection ends with DSH\'s answer');
        assert.equal(shell2.seen.filter((x) => x.url === '/api/secret').length, 0, 'the bytes behind the request never reached DSH as a request');
        assert.equal(shell2.seen.at(-1).early, 0);
        assert.match(e2.logText(), /DSH answered a WebSocket from 127\.0\.0\.1 \/api\/remote\.mux with 401, not an upgrade/);
        assert.doesNotMatch(e2.logText(), /websocket 127\.0\.0\.1 \/api\/remote\.mux opened/);
    } finally {
        await e2.done();
        await shell2.close();
    }
});

test('health tells a device that DSH has not signed in only whether the edge serves (own sign-in mode); a signed-in one gets the rest', async () => {
    const shell = await startFakeShell();
    const e = await edgeFor({}, { selfOrigin: () => shell.origin, version: '9.9.9' });
    try {
        const bare = JSON.parse((await http(`${e.base}/.dsh-site/health`)).text);
        assert.deepEqual(bare, { ok: true, plugin: 'dsh-site', version: '9.9.9', signedIn: false });
        const forged = JSON.parse((await http(`${e.base}/.dsh-site/health`, { headers: { cookie: 'dsh-auth-x=forged' } })).text);
        assert.deepEqual(forged, { ok: true, plugin: 'dsh-site', version: '9.9.9', signedIn: false }, 'a cookie DSH does not take gets no more');
        const signIn = await http(`${e.base}/?token=${shell.token}`, { headers: { accept: 'text/html' } });
        const cookie = String(signIn.headers['set-cookie']?.[0] ?? '').split(';')[0];
        const full = JSON.parse((await http(`${e.base}/.dsh-site/health`, { headers: { cookie } })).text);
        assert.equal(full.target, shell.origin, 'signed in: where DSH is');
        assert.equal(full.auth, 'shell');
        assert.deepEqual(full.allowCIDRs, ['127.0.0.0/8']);
    } finally {
        await e.done();
        await shell.close();
    }
});

test('who reaches a listener on every interface: this machine\'s addresses inside allowCIDRs, loopback left out', () => {
    const ranges = ['100.64.0.0/10', '127.0.0.0/8', 'fd7a:115c:a1e0::/48'].map(parseCidr);
    const interfaces = () => ({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
        en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }, { address: '100.80.1.2', family: 'IPv4', internal: false }],
        utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }, { address: 'fd7a:115c:a1e0::53', family: 'IPv6', internal: false }],
    });
    assert.deepEqual(addressesLetIn(ranges, interfaces), ['100.80.1.2 (en0)', '100.101.102.103 (utun4)', 'fd7a:115c:a1e0::53 (utun4)'], 'a carrier network on en0 in 100.64.0.0/10 shows up');
    assert.deepEqual(addressesLetIn(ranges, () => { throw new Error('no'); }), []);
});
