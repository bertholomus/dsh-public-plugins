/**
 * The edge: a second front door to the DSH window server this plugin runs
 * in. It listens on `listenHost:listenPort`, closes every connection from a
 * device outside `allowCIDRs` at once, answers this machine's own programs
 * with a page instead of DSH (unless `allowThisMac`), applies DSH's own
 * browser-trust fence (lib/fence.js) to the address the device used, then
 * passes the request to DSH's loopback server with Host, Origin and Referer
 * rewritten to a loopback authority and, when `injectAuthCookie` is on, the
 * desktop window's sign-in cookie added. HTTP, streamed responses and
 * WebSocket upgrades all pass; an answer DSH ends part-way is ended part-way
 * on the device too, and nothing a device sends after an upgrade request
 * reaches DSH until DSH has accepted the upgrade.
 *
 * The loopback authority it presents: with `injectAuthCookie`, DSH's own
 * (the desktop window's cookie is bound to it); without, a fixed one,
 * `127.0.0.1:<listenPort>`, so the cookie DSH gives a device that signs in
 * through the edge stays valid when DSH restarts on another port (DSH signs
 * its cookies with a key kept in its home and binds each to the Host).
 *
 * Every answer it passes on tells the browser that no other site may frame
 * it or load it (X-Frame-Options, a frame-ancestors policy beside any policy
 * DSH sends, Cross-Origin-Resource-Policy): over plain HTTP to a tailnet
 * address a browser marks frames and images with nothing the fence can see.
 *
 * It answers one path itself: GET /.dsh-site/health.
 *
 * Everything that touches the outside world is passed in (where DSH's
 * server is, how to read the cookie), so the tests drive this module with
 * real sockets and stand-ins for DSH.
 *
 * @module dsh-plugin-dsh-site/edge
 */
import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { allowedBy, isLoopbackIp, normalizeIp } from './cidr.js';
import { cookieName } from './cookie.js';
import { fenceCheck, isLoopbackHostname } from './fence.js';
import { sendPage, upgradeRefusal, wantsHtml } from './pages.js';
import { listenLabel, listensEverywhere } from './config.js';

export const HEALTH_PATH = '/.dsh-site/health';

/** True when DSH's server answered a probe as DSH's window server. */
export function looksLikeShell(status, body) {
    if (status === 401 && /dsh web authentication required/i.test(body)) return true;
    return (status === 200 || status === 303) && /__DSH_BOOT__/.test(body);
}

/** Ask `origin` for `/` (no cookie): true when DSH's window server answers. */
export function probeShell(origin, timeout = 1500) {
    return new Promise((resolve) => {
        let url;
        try {
            url = new URL(origin);
        } catch {
            resolve(false);
            return;
        }
        let done = false;
        const finish = (value) => {
            if (!done) {
                done = true;
                resolve(value);
            }
        };
        const req = httpRequest({ hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80), path: '/', method: 'GET', headers: { host: url.host, accept: 'text/html' } }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => {
                body += c;
                if (body.length > 65536) res.destroy();
            });
            res.on('end', () => finish(looksLikeShell(res.statusCode, body)));
            res.on('close', () => finish(looksLikeShell(res.statusCode, body)));
        });
        req.setTimeout(timeout, () => req.destroy());
        req.on('error', () => finish(false));
        req.end();
    });
}

/** The loopback and wildcard TCP ports in `lsof -nP -iTCP -sTCP:LISTEN` output, in order. */
export function parseListeners(stdout) {
    const ports = [];
    for (const line of String(stdout).split('\n')) {
        const m = /TCP (\*|localhost|127\.\d+\.\d+\.\d+|\[::1\]|\[::\]|\[::ffff:127\.\d+\.\d+\.\d+\]):(\d+) \(LISTEN\)/.exec(line);
        if (m && !ports.includes(Number(m[2]))) ports.push(Number(m[2]));
    }
    return ports;
}

/** This process's listening ports, from lsof (macOS and most Linux systems have it). */
export function lsofListeners(pid = process.pid, run = execFile) {
    return new Promise((resolve) => {
        try {
            run('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { timeout: 5000 }, (error, stdout) => {
                resolve(error && !stdout ? { ports: [], error: error.code === 'ENOENT' ? 'the lsof program is missing' : 'lsof did not answer' } : { ports: parseListeners(stdout) });
            });
        } catch {
            resolve({ ports: [], error: 'the lsof program could not run' });
        }
    });
}

/** DSH's window server address from its webServer service: `http://127.0.0.1:<port>`, or undefined. */
export function originOf(webServer, note = () => {}) {
    if (!webServer) return undefined;
    let port;
    let host;
    let protocol;
    try {
        port = webServer.port;
        host = webServer.host;
        protocol = webServer.protocol ?? 'http:';
    } catch {
        return undefined;
    }
    if (!Number.isInteger(port) || port <= 0) return undefined;
    if (protocol !== 'http:') {
        note("DSH serves its window over HTTPS here; dsh-site passes plain HTTP only, so it cannot use DSH's own window server");
        return undefined;
    }
    const h = typeof host === 'string' ? host : '127.0.0.1';
    if (h === '0.0.0.0' || h === '' || h === '::' || h.startsWith('127.')) return `http://${h.startsWith('127.') ? h : '127.0.0.1'}:${port}`;
    if (h === '::1') return `http://[::1]:${port}`;
    return `http://${h.includes(':') ? `[${h}]` : h}:${port}`;
}

const HOP_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'];

/** A request target for the log: its path only, never its query (a sign-in link carries DSH's launch token there). */
export function logPath(url) {
    const text = String(url ?? '');
    const at = text.search(/[?#]/);
    const path = (at === -1 ? text : text.slice(0, at)).slice(0, 120);
    return at === -1 ? path : `${path}?…`;
}

/**
 * The answer headers the edge passes on, with the browser told that no other site may frame the page or load it:
 * X-Frame-Options SAMEORIGIN unless DSH sent one, a `frame-ancestors 'self'` policy added beside any policy DSH
 * sent (a browser applies every policy it gets), and Cross-Origin-Resource-Policy same-origin unless DSH sent one.
 */
export function guardHeaders(headers) {
    const out = { ...headers };
    if (out['x-frame-options'] === undefined) out['x-frame-options'] = 'SAMEORIGIN';
    const csp = out['content-security-policy'];
    out['content-security-policy'] = [...(csp === undefined ? [] : Array.isArray(csp) ? csp : [csp]), "frame-ancestors 'self'"];
    if (out['cross-origin-resource-policy'] === undefined) out['cross-origin-resource-policy'] = 'same-origin';
    return out;
}

/** This machine's addresses inside `ranges`, with their interface names (loopback left out): who reaches a wildcard listener. */
export function addressesLetIn(ranges, interfaces = networkInterfaces) {
    const found = [];
    let all = {};
    try {
        all = interfaces() ?? {};
    } catch {}
    for (const [name, list] of Object.entries(all)) {
        for (const info of list ?? []) {
            if (!info || info.internal || isLoopbackIp(info.address)) continue;
            if (allowedBy(ranges, info.address)) found.push(`${info.address} (${name})`);
        }
    }
    return found;
}

/**
 * True when `ip` (a connection's source) is this machine itself: loopback, or an address on one of its network
 * interfaces (its tailnet address included), read again at every call so an address that appears later counts.
 * When the interfaces cannot be read, every address counts as this machine's (the edge then refuses, never guesses).
 */
export function isOwnAddress(ip, interfaces = networkInterfaces) {
    const addr = normalizeIp(String(ip ?? '').split('%')[0]);
    if (!addr) return false;
    if (isLoopbackIp(addr)) return true;
    let all;
    try {
        all = interfaces() ?? {};
    } catch {
        return true;
    }
    for (const list of Object.values(all)) {
        for (const info of list ?? []) {
            if (info?.address && normalizeIp(String(info.address).split('%')[0]) === addr) return true;
        }
    }
    return false;
}

/** The Upgrade header asks for a WebSocket (the only upgrade DSH's window uses). */
export const isWebSocketUpgrade = (headers) => String(headers?.upgrade ?? '').trim().toLowerCase() === 'websocket';

/** The status code of a raw HTTP answer head (`HTTP/1.1 101 ...`), or 0. */
export function statusOf(head) {
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(String(head).slice(0, 32));
    return m ? Number(m[1]) : 0;
}

/**
 * @param {object} options
 * @param {object} options.settings - checked settings (lib/config.js).
 * @param {{ write: Function, often: Function }} options.log - dsh-site's own log (lib/log.js).
 * @param {{ info?: Function, warn?: Function }} [options.logger] - DSH's log.
 * @param {() => string | undefined} [options.selfOrigin] - the window server of the DSH this runs in, when known.
 * @param {() => Promise<{ ports: number[], error?: string }>} [options.listListeners] - this process's listening ports.
 * @param {(authority: string) => Promise<object>} [options.readCookie] - the sign-in cookie for an authority (lib/cookie.js readJar).
 * @param {(origin: string) => Promise<boolean>} [options.probe]
 * @param {string} [options.version]
 * @param {number} [options.graceMs] - after it starts listening, how long the edge looks for DSH's window server
 *   quietly (DSH may still be starting it) before it says it is not there.
 * @param {() => object} [options.interfaces] - this machine's network interfaces (os.networkInterfaces), for the
 *   note that names who reaches a listener on every interface.
 * @param {number} [options.retryMs] - how often a port in use or an address not here yet is tried again.
 * @param {(ip: string) => boolean} [options.thisMac] - whether a source address is this machine itself (isOwnAddress).
 */
export function createEdge({ settings, log, logger, selfOrigin = () => undefined, listListeners = () => lsofListeners(), readCookie = async () => ({ status: 'missing', others: 0 }), probe = probeShell, version = '', graceMs = 20000, interfaces = networkInterfaces, retryMs = 30000, thisMac = (ip) => isOwnAddress(ip, interfaces) }) {
    const sockets = new Set();
    // Connections from this machine's own programs, while allowThisMac is false: answered with a page, never DSH.
    const fromThisMac = new WeakSet();
    const upstreams = new Set();
    const seen = new Set();
    let closing = false;
    let listening = false;
    let startedAt;
    let target; // { origin, how }
    let targetFinding;
    let loggedOrigin; // the window server the log last named
    let missingTold = false;
    let targetOriginTold = false;
    let graceUntil = 0;
    let findTimer;
    let cookie = { status: settings.injectAuthCookie ? 'unread' : 'off', at: 0, authority: '' };
    let cookieReading;
    let retryTimer;

    const say = (line, level = 'info') => {
        log.write(line);
        try {
            logger?.[level]?.(`dsh-site: ${line}`);
        } catch {}
    };

    // ── Where DSH's window server is ──────────────────────────────────

    async function findTarget() {
        const tried = new Set();
        const candidates = [];
        let self;
        try {
            self = selfOrigin();
        } catch {}
        if (self) candidates.push({ origin: self, how: 'dsh' });
        if (settings.targetOrigin) candidates.push({ origin: settings.targetOrigin, how: 'targetOrigin' });
        for (const c of candidates) {
            if (tried.has(c.origin)) continue;
            tried.add(c.origin);
            if (await probe(c.origin)) return { ...c, self };
        }
        if (settings.discoverTarget) {
            const { ports, error } = await listListeners();
            if (error) log.often('lsof', `looking for DSH's window server among this process's ports failed: ${error}`);
            for (const port of ports) {
                if (port === settings.listenPort) continue;
                const origin = `http://127.0.0.1:${port}`;
                if (tried.has(origin)) continue;
                tried.add(origin);
                if (await probe(origin)) return { origin, how: 'listeners', self };
            }
        }
        return { self };
    }

    const HOW = { dsh: "DSH's own window server", targetOrigin: 'targetOrigin', listeners: "this process's own ports" };

    /** Say where DSH is once per change; while DSH may still be starting (the grace time), look again quietly. */
    function report(found) {
        if (target) {
            clearTimeout(findTimer);
            findTimer = undefined;
            missingTold = false;
            if (target.origin !== loggedOrigin) {
                loggedOrigin = target.origin;
                say(`serving DSH at ${target.origin} (found by ${HOW[target.how]})`);
            }
            if (found.how === 'dsh' && settings.targetOrigin && settings.targetOrigin !== target.origin && !targetOriginTold) {
                targetOriginTold = true;
                say(`targetOrigin ${settings.targetOrigin} is not this DSH's window server, so it is not used`, 'warn');
            }
            return;
        }
        if (Date.now() < graceUntil) {
            if (!findTimer && !closing) {
                findTimer = setTimeout(() => {
                    findTimer = undefined;
                    if (!closing && !target) ensureTarget(true).catch(() => {});
                }, 500);
            }
            return;
        }
        if (!missingTold) {
            missingTold = true;
            loggedOrigin = undefined;
            say("DSH's window server not found yet; devices get a page that retries every few seconds", 'warn');
        }
    }

    /** DSH's window server: cached until a request to it fails, found again when `force`. */
    function ensureTarget(force = false) {
        if (target && !force) return Promise.resolve(target);
        if (!targetFinding) {
            targetFinding = findTarget().then((found) => {
                const before = target?.origin;
                target = found.origin ? { origin: found.origin, how: found.how } : undefined;
                if (before !== target?.origin) cookie = { ...cookie, at: 0 };
                report(found);
                return target;
            }).finally(() => {
                targetFinding = undefined;
            });
        }
        return targetFinding;
    }

    /** DSH has just said where its window server is (its webServer service came up): look again unless DSH already said. */
    function refreshTarget() {
        if (closing || target?.how === 'dsh') return Promise.resolve(target);
        return ensureTarget(true).catch(() => undefined);
    }

    const authorityOf = (origin) => {
        try {
            return new URL(origin).host;
        } catch {
            return '';
        }
    };

    // ── The sign-in cookie ────────────────────────────────────────────

    /** The cookie for the current target: found ones are kept 30 s, misses 3 s; `force` reads again. */
    function ensureCookie(origin, force = false) {
        if (!settings.injectAuthCookie) return Promise.resolve(cookie);
        const authority = authorityOf(origin);
        const age = Date.now() - cookie.at;
        if (!force && cookie.authority === authority && age < (cookie.status === 'found' ? 30000 : 3000)) return Promise.resolve(cookie);
        if (!cookieReading) {
            cookieReading = Promise.resolve()
                .then(() => readCookie(authority))
                .catch(() => ({ status: 'error', reason: 'the cookie jar could not be read' }))
                .then((got) => {
                    const was = cookie;
                    cookie = { ...got, authority, at: Date.now() };
                    const changed = was.status !== cookie.status || was.authority !== authority || was.reason !== cookie.reason || (cookie.status === 'found' && was.cookie !== cookie.cookie);
                    if (changed) {
                        const name = cookieName(authority).slice(0, 18);
                        const line = {
                            found: `sign-in cookie found for ${authority} (${name}…); devices are signed in with it`,
                            missing: `no sign-in cookie for ${authority} in the cookie jar yet (DSH's window on this Mac has not signed in); browsers get a page that retries`,
                            encrypted: `the cookie jar keeps its cookies encrypted, so dsh-site cannot read the sign-in cookie: set injectAuthCookie to false and open DSH's sign-in link on each device`,
                            error: `cannot read the sign-in cookie: ${cookie.reason}`,
                        }[cookie.status];
                        if (line) say(line, cookie.status === 'found' ? 'info' : 'warn');
                    }
                    return cookie;
                })
                .finally(() => {
                    cookieReading = undefined;
                });
        }
        return cookieReading;
    }

    // ── Passing requests on ───────────────────────────────────────────

    /**
     * The loopback authority DSH is shown: DSH's own when the edge signs devices in with the desktop window's cookie
     * (bound to it); else 127.0.0.1:<listenPort>, the same at every DSH start, so a device's own sign-in lasts.
     */
    const presented = (origin) => (settings.injectAuthCookie ? new URL(origin).host : `127.0.0.1:${settings.listenPort}`);

    function upstreamHeaders(req, origin, withCookie) {
        const h = { ...req.headers };
        for (const name of HOP_HEADERS) delete h[name];
        const authority = presented(origin);
        if (settings.rewriteHost) h.host = authority;
        if (withCookie) h.cookie = withCookie;
        if (settings.rewriteOrigin) {
            if (h.origin) h.origin = `http://${authority}`;
            if (h.referer) h.referer = `http://${authority}/`;
        }
        return h;
    }

    const isNavigation = (req) => (req.method === 'GET' || req.method === 'HEAD') && wantsHtml(req.headers);

    /** The page for a browser the edge cannot sign in yet: waiting for the window, or a cookie it cannot read. */
    const signInPage = (got) => (got.status === 'encrypted' || got.status === 'error'
        ? ['cookie-problem', { encrypted: got.status === 'encrypted', reason: got.reason }]
        : ['signing-in', {}]);

    function forward(req, res, ip, attempt, origin) {
        if (!origin) {
            sendPage(req, res, 'no-shell');
            return;
        }
        const t = new URL(origin);
        const replayable = req.method === 'GET' || req.method === 'HEAD';
        const withCookie = settings.injectAuthCookie && cookie.status === 'found' && cookie.authority === t.host ? cookie.cookie : undefined;
        let up;
        try {
            up = httpRequest({ hostname: t.hostname.replace(/^\[|\]$/g, ''), port: Number(t.port || 80), path: req.url, method: req.method, headers: upstreamHeaders(req, origin, withCookie) });
        } catch (error) {
            log.often('upstream-bad', `could not pass a request on: ${String(error?.code ?? error?.message ?? error).slice(0, 80)}`);
            sendPage(req, res, 'upstream');
            return;
        }
        upstreams.add(up);
        up.on('close', () => upstreams.delete(up));
        let deviceLeft = false;
        res.on('close', () => {
            if (!res.writableFinished) {
                deviceLeft = true;
                up.destroy();
            }
        });
        up.on('response', (ur) => {
            // A stale cookie: read the jar again and replay a read once.
            if (ur.statusCode === 401 && settings.injectAuthCookie && attempt === 0 && replayable) {
                ur.resume();
                ensureCookie(origin, true).then((now) => {
                    if (closing) return res.destroy();
                    if (now.status !== 'found' && isNavigation(req)) {
                        sendPage(req, res, ...signInPage(now));
                        return;
                    }
                    forward(req, res, ip, 1, origin);
                });
                return;
            }
            if (ur.statusCode === 401 && settings.injectAuthCookie && isNavigation(req)) {
                ur.resume();
                sendPage(req, res, ...signInPage(cookie));
                return;
            }
            // DSH's own sign-in is the gate and this browser is not signed in: say how to sign in, in words.
            if (ur.statusCode === 401 && !settings.injectAuthCookie && isNavigation(req)) {
                ur.resume();
                sendPage(req, res, 'sign-in', { host: String(req.headers.host ?? '').slice(0, 200), stale: /[?&]token=/.test(String(req.url ?? '')) });
                return;
            }
            res.writeHead(ur.statusCode ?? 502, guardHeaders(ur.headers));
            ur.on('error', () => {}); // a cut answer ends below; it never throws
            // DSH ended its answer part-way (its connection closed before the answer was complete): end the device's
            // answer the same way, so the device sees it cut instead of waiting on it for good.
            ur.on('close', () => {
                if (ur.complete || res.writableFinished) return;
                if (!deviceLeft && !closing) log.often(`cut-${req.method}-${logPath(req.url)}`, `DSH's window server ended its answer to ${ip} ${req.method} ${logPath(req.url)} part-way; the device's answer was ended there too`);
                res.destroy();
            });
            ur.pipe(res);
        });
        up.setTimeout(0);
        up.on('error', (error) => {
            const code = error?.code ?? 'error';
            if (closing) return;
            if (attempt === 0 && replayable && (code === 'ECONNREFUSED' || code === 'ECONNRESET')) {
                target = undefined;
                ensureTarget(true).then((found) => {
                    if (!found) return sendPage(req, res, 'no-shell');
                    return ensureCookie(found.origin).then(() => forward(req, res, ip, 1, found.origin));
                });
                return;
            }
            log.often(`upstream-${code}`, `DSH's window server at ${origin} did not answer (${code})`);
            if (code === 'ECONNREFUSED') target = undefined;
            if (!res.headersSent) sendPage(req, res, 'upstream');
            else res.destroy();
        });
        if (req.readableEnded) up.end();
        else req.pipe(up);
    }

    /** The fence for one request from a source already let in: undefined, or the refusal. Logged without the query. */
    function admit(ip, headers, method, url) {
        const fenced = fenceCheck(headers, settings.allowHosts);
        if (fenced) {
            const what = {
                host: `Host ${fenced.host} is not an IP address and not in allowHosts`,
                framed: `a frame or embed from another page (${fenced.dest}${fenced.origin ? ` from ${fenced.origin}` : ''})`,
                'cross-site': `cross-site request from ${fenced.origin || 'another site'}`,
                'bad-host': 'missing or malformed Host',
            }[fenced.kind];
            log.often(`${fenced.kind}-${ip}-${fenced.host}`, `refused ${ip} ${method} ${logPath(url)}: ${what}`);
            return { kind: fenced.kind, facts: fenced };
        }
        if (!seen.has(ip)) {
            seen.add(ip);
            if (seen.size > 5000) seen.delete(seen.values().next().value);
            log.write(`client ${ip} first request this start${isLoopbackIp(ip) ? ' (this machine)' : ''}`);
        }
        return undefined;
    }

    /** In DSH's own sign-in mode: whether DSH takes this request's cookie (it answers its window, not its 401). */
    function signedInAtDsh(req, origin) {
        if (!req.headers.cookie) return Promise.resolve(false);
        return new Promise((resolve) => {
            let t;
            try {
                t = new URL(origin);
            } catch {
                resolve(false);
                return;
            }
            const ask = httpRequest({ hostname: t.hostname.replace(/^\[|\]$/g, ''), port: Number(t.port || 80), path: '/', method: 'GET', headers: { host: presented(origin), accept: 'text/html', cookie: req.headers.cookie } }, (r) => {
                r.resume();
                resolve(r.statusCode >= 200 && r.statusCode < 400);
            });
            ask.setTimeout(5000, () => ask.destroy());
            ask.on('error', () => resolve(false));
            ask.end();
        });
    }

    /**
     * What the edge is doing now. Asked by a device (`req`) that DSH has not signed in (DSH's own sign-in mode, no
     * valid cookie), only whether the edge serves and its version: the rest (DSH's port, the ranges, the names) is for
     * signed-in devices. In cookie mode every device let in is signed in by the edge, so it gets all of it.
     */
    async function health(req) {
        const found = await ensureTarget(true);
        if (found) await ensureCookie(found.origin);
        if (req && !settings.injectAuthCookie && !(found && (await signedInAtDsh(req, found.origin)))) {
            return { ok: listening && Boolean(found), plugin: 'dsh-site', version, signedIn: false };
        }
        return {
            ok: listening && Boolean(found),
            plugin: 'dsh-site',
            version,
            pid: process.pid,
            listen: listenLabel(settings),
            target: found?.origin ?? null,
            foundBy: found?.how ?? null,
            discovered: found?.how === 'listeners',
            auth: settings.injectAuthCookie ? 'cookie' : 'shell',
            authInjected: Boolean(settings.injectAuthCookie && found && cookie.status === 'found' && cookie.authority === authorityOf(found.origin)),
            cookie: settings.injectAuthCookie ? cookie.status : 'off',
            ...(cookie.reason ? { cookieProblem: cookie.reason } : {}),
            allowCIDRs: settings.allowCIDRs.map((r) => r.text),
            allowHosts: settings.allowHosts.map((h) => h.host),
            allowThisMac: settings.allowThisMac,
            connections: sockets.size,
            since: startedAt ?? null,
        };
    }

    /** A request from this machine's own programs while allowThisMac is false: logged once a minute, never passed on. */
    function refuseThisMac(ip, method, url) {
        log.often(`this-mac-${ip}`, `refused ${ip} ${method} ${logPath(url)}: this machine's own address (allowThisMac is false); the edge serves other devices`);
    }

    const server = createServer((req, res) => {
        const ip = normalizeIp(req.socket.remoteAddress);
        if (fromThisMac.has(req.socket)) {
            req.resume();
            refuseThisMac(ip, req.method, req.url);
            sendPage(req, res, 'this-mac');
            return;
        }
        const refused = admit(ip, req.headers, req.method, req.url);
        if (refused) {
            req.resume();
            sendPage(req, res, refused.kind, refused.facts);
            return;
        }
        if ((req.url ?? '/').split('?')[0] === HEALTH_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
            req.resume();
            health(req).then((body) => {
                const text = JSON.stringify(body);
                res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
                res.end(req.method === 'HEAD' ? undefined : text);
            }, () => {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end('{"ok":false}');
            });
            return;
        }
        ensureTarget().then(async (found) => {
            if (!found) {
                req.resume();
                sendPage(req, res, 'no-shell');
                return;
            }
            if (settings.injectAuthCookie) {
                const got = await ensureCookie(found.origin);
                if (got.status !== 'found' && isNavigation(req)) {
                    req.resume();
                    sendPage(req, res, ...signInPage(got));
                    return;
                }
            }
            forward(req, res, ip, 0, found.origin);
        }).catch(() => {
            if (!res.headersSent) sendPage(req, res, 'upstream');
        });
    });

    server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => socket.destroy());
        const ip = normalizeIp(req.socket.remoteAddress);
        if (fromThisMac.has(req.socket)) {
            refuseThisMac(ip, `${req.method} (WebSocket)`, req.url);
            socket.end(upgradeRefusal('this-mac'));
            return;
        }
        const refused = admit(ip, req.headers, `${req.method} (WebSocket)`, req.url);
        if (refused) {
            socket.end(upgradeRefusal(refused.kind, refused.facts));
            return;
        }
        if (!isWebSocketUpgrade(req.headers)) {
            log.often(`upgrade-${ip}`, `refused ${ip} ${req.method} ${logPath(req.url)}: an upgrade to ${JSON.stringify(String(req.headers.upgrade ?? '').slice(0, 40))}; the edge passes WebSockets only`);
            socket.end(upgradeRefusal('not-websocket'));
            return;
        }
        const path = String(req.url).split('?')[0].slice(0, 80);
        const open = (attempt) => {
            if (closing) {
                socket.destroy();
                return;
            }
            const origin = target?.origin;
            if (!origin) {
                socket.end(upgradeRefusal('no-shell'));
                return;
            }
            const t = new URL(origin);
            const withCookie = settings.injectAuthCookie && cookie.status === 'found' && cookie.authority === t.host ? cookie.cookie : undefined;
            const up = connect(Number(t.port || 80), t.hostname.replace(/^\[|\]$/g, ''));
            upstreams.add(up);
            let connected = false;
            let switched = false;
            up.on('connect', () => {
                connected = true;
                let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
                for (const [k, v] of Object.entries(upstreamHeaders(req, origin, withCookie))) {
                    for (const one of Array.isArray(v) ? v : [v]) raw += `${k}: ${one}\r\n`;
                }
                up.write(`${raw}\r\n`);
                // Nothing from the device goes on to DSH until DSH has taken the upgrade (101): bytes a device sends
                // after its upgrade request wait here, and are never read as a request of their own.
                let answer = Buffer.alloc(0);
                const onAnswer = (chunk) => {
                    answer = Buffer.concat([answer, chunk]);
                    if (answer.indexOf('\r\n\r\n') === -1) {
                        if (answer.length > 65536) {
                            up.destroy();
                            socket.destroy();
                        }
                        return;
                    }
                    up.off('data', onAnswer);
                    socket.write(answer);
                    if (statusOf(answer) === 101) {
                        switched = true;
                        if (head?.length) up.write(head);
                        up.pipe(socket);
                        socket.pipe(up);
                        log.write(`websocket ${ip} ${path} opened`);
                        return;
                    }
                    // DSH did not take it (its sign-in, its gate): its answer goes to the device, and the connection ends.
                    log.often(`ws-refused-${ip}-${statusOf(answer)}`, `DSH answered a WebSocket from ${ip} ${path} with ${statusOf(answer) || 'something that is not HTTP'}, not an upgrade; passed on, and the connection closed`);
                    up.pipe(socket);
                    const stop = setTimeout(() => {
                        up.destroy();
                        socket.destroy();
                    }, 5000);
                    up.once('close', () => clearTimeout(stop));
                };
                up.on('data', onAnswer);
            });
            up.on('error', (error) => {
                const code = error?.code ?? 'error';
                if (!connected && attempt === 0 && code === 'ECONNREFUSED' && !closing) {
                    target = undefined;
                    ensureTarget(true).then((found) => (found ? ensureCookie(found.origin) : undefined)).then(() => open(1));
                    return;
                }
                log.often(`ws-upstream-${code}`, `DSH's window server at ${origin} did not take a WebSocket (${code})`);
                if (!connected) socket.end(upgradeRefusal('upstream'));
                else socket.destroy();
            });
            up.on('close', () => {
                upstreams.delete(up);
                if (connected) {
                    socket.destroy();
                    if (switched) log.write(`websocket ${ip} closed`);
                }
            });
            socket.on('close', () => up.destroy());
        };
        ensureTarget()
            .then((found) => (found && settings.injectAuthCookie ? ensureCookie(found.origin) : undefined))
            .then(() => open(0), () => socket.end(upgradeRefusal('upstream')));
    });

    // The source gate. This machine's own programs (loopback, or any of its addresses: its tailnet address is inside
    // the tailnet range) are let in only with allowThisMac, and otherwise get a page that says so: through the edge,
    // with the desktop window's cookie, any program or account on this machine would get DSH with no sign-in. Any
    // other device is let in only from allowCIDRs; a connection from outside is closed at once, before it can send a
    // byte (nothing is answered, so nothing tells a stranger what listens here), and logged once a minute per address.
    server.on('connection', (socket) => {
        if (closing) {
            socket.destroy();
            return;
        }
        const ip = normalizeIp(socket.remoteAddress);
        if (thisMac(ip)) {
            if (!settings.allowThisMac) fromThisMac.add(socket);
        } else if (!allowedBy(settings.allowCIDRs, ip)) {
            log.often(`deny-${ip}`, `deny ${ip || 'an unknown address'}: not in allowCIDRs; connection closed`);
            socket.destroy();
            return;
        }
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.requestTimeout = 0; // a streamed reply (SSE) can run for hours
    server.headersTimeout = 60000;
    server.keepAliveTimeout = 5000;

    const every = `every ${Math.round(retryMs / 1000)} second${Math.round(retryMs / 1000) === 1 ? '' : 's'}`;
    const listenWords = (error) => {
        const code = error?.code;
        const label = listenLabel(settings);
        if (code === 'EADDRINUSE') return `port ${settings.listenPort} is already in use on ${settings.listenHost} (another program, or another DSH, holds it), so dsh-site is not serving yet; it tries again ${every}. Change listenPort or stop the other program`;
        if (code === 'EADDRNOTAVAIL') return `${settings.listenHost} is not an address of this machine right now (listenHost), so dsh-site is not serving yet; it tries again ${every} (a tailnet address appears when the tailnet connects). If the address is wrong, set listenHost to this machine's tailnet address, 127.0.0.1 or 0.0.0.0`;
        if (code === 'EACCES') return `port ${settings.listenPort} needs administrator rights (listenPort), so dsh-site is not serving: use a port above 1023, such as 8443`;
        return `could not listen on ${label} (${code ?? String(error?.message ?? error).slice(0, 60)}), so dsh-site is not serving`;
    };

    /** Listen. Resolves `{ ok: true }`, or `{ ok: false, reason }` once it gives up (a port in use is tried again every 30 s). */
    function start() {
        startedAt = new Date().toISOString();
        return new Promise((resolve) => {
            let fast = 0;
            let told = false;
            const attempt = () => {
                if (closing) return resolve({ ok: false, reason: 'closed' });
                const onError = (error) => {
                    server.off('listening', onListening);
                    if (closing) return resolve({ ok: false, reason: 'closed' });
                    // A port in use (a DSH that is quitting may still hold it) or an address that is not here yet (a
                    // tailnet that connects after DSH starts) is tried again until the edge is switched off.
                    if (error?.code === 'EADDRINUSE' || error?.code === 'EADDRNOTAVAIL') {
                        if (error.code === 'EADDRINUSE' && fast < 6) {
                            fast += 1;
                            retryTimer = setTimeout(attempt, 500);
                            return;
                        }
                        if (!told) {
                            told = true;
                            say(listenWords(error), 'warn');
                            resolve({ ok: false, reason: listenWords(error), retrying: true });
                        }
                        retryTimer = setTimeout(attempt, retryMs);
                        return;
                    }
                    const words = listenWords(error);
                    say(words, 'warn');
                    resolve({ ok: false, reason: words });
                };
                const onListening = () => {
                    server.off('error', onError);
                    listening = true;
                    server.on('error', (error) => say(`server error: ${String(error?.code ?? error?.message ?? error).slice(0, 80)}`, 'warn'));
                    const auth = settings.injectAuthCookie ? "devices are signed in with the desktop window's cookie" : "devices sign in with DSH's own link";
                    say(`listening on ${listenLabel(settings)} for ${settings.allowCIDRs.map((r) => r.text).join(', ')}${settings.allowHosts.length ? ` (names: ${settings.allowHosts.map((h) => h.host).join(', ')})` : ''}; ${auth}; this machine's own programs ${settings.allowThisMac ? 'let in (allowThisMac)' : 'refused'}; pid ${process.pid}`);
                    if (listensEverywhere(settings)) {
                        const reach = addressesLetIn(settings.allowCIDRs, interfaces);
                        say(`listening on every interface: ${reach.length ? `devices reach it through this machine's addresses ${reach.join(', ')}` : "none of this machine's network addresses is inside allowCIDRs yet"}; set listenHost to the tailnet address to serve that network only`);
                    }
                    if (isLoopbackHostname(settings.listenHost === '::1' ? '[::1]' : settings.listenHost) && !settings.allowThisMac) {
                        say(`${settings.listenHost} is reached only by this machine's own programs, and allowThisMac is false, so every request gets a page that says so: listen on the tailnet address, or set allowThisMac to true if a proxy on this machine (such as tailscale serve) sends devices here`, 'warn');
                    }
                    graceUntil = Date.now() + graceMs;
                    ensureTarget(true).catch(() => {});
                    if (!told) resolve({ ok: true });
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen({ port: settings.listenPort, host: settings.listenHost });
            };
            attempt();
        });
    }

    /** Stop: close the port and every connection through it (devices are cut off at once). */
    function close() {
        if (closing) return Promise.resolve();
        closing = true;
        clearTimeout(retryTimer);
        clearTimeout(findTimer);
        const open = sockets.size;
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (listening || open) log.write(`stopped; closed the port and ${open} connection${open === 1 ? '' : 's'}`);
                listening = false;
                resolve();
            };
            const timer = setTimeout(finish, 3000);
            try {
                server.close(() => finish());
            } catch {
                finish();
            }
            for (const s of sockets) s.destroy();
            for (const u of upstreams) u.destroy();
            if (!listening) finish();
        });
    }

    return {
        server,
        start,
        close,
        health,
        ensureTarget,
        refreshTarget,
        get listening() {
            return listening;
        },
        get connections() {
            return sockets.size;
        },
        address: () => server.address(),
    };
}
