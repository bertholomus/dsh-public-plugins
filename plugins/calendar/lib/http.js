/**
 * The plugin's one way out to the network. Every call to a calendar server
 * goes through `request`, which:
 *
 * - refuses plain http except to this computer (a stand-in server, a
 *   CalDAV server on localhost) unless the account allows it;
 * - follows redirects itself (at most 5), never from https to http, and
 *   drops the Authorization header when a redirect leaves the origin unless
 *   the caller's `keepAuth` says the new host is the same service (iCloud
 *   sends CalDAV clients from caldav.icloud.com to a pNN-caldav.icloud.com);
 * - refuses a redirect to this computer or its network (isLocal, or a name
 *   that resolves to such an address) unless the request started there, so
 *   a server or a feed can't make the plugin call the user's own services;
 * - stops after `timeoutMs` and after `maxBytes` of body;
 * - never puts a header value, a URL's path or query or a body in an error
 *   message, only its host, so a password, a token or a private feed's
 *   address (its key is in the path) can't reach a log or a model.
 *
 * @module dsh-plugin-calendar/http
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * A failed request. `code`: timeout, network, too-large, insecure (plain
 * http, or a redirect to this computer or its network), redirects, aborted.
 */
export class HttpError extends Error {
    constructor(code, message, status) {
        super(message);
        this.name = 'HttpError';
        this.code = code;
        if (status !== undefined) this.status = status;
    }
}

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

/** Whether a URL points at this computer. */
export function isLoopback(url) {
    try {
        return LOOPBACK.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

/**
 * The addresses of this computer and its network: loopback, "this network",
 * private, shared (carrier-grade NAT, Tailscale), link-local, unique-local
 * and site-local, and IPv4 ones written as IPv6 (::ffff:10.0.0.1).
 */
const LOCAL_NETS = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]]) {
    LOCAL_NETS.addSubnet(net, bits, 'ipv4');
    LOCAL_NETS.addSubnet(`::ffff:${net}`, 96 + bits, 'ipv6');
}
LOCAL_NETS.addAddress('::', 'ipv6');
LOCAL_NETS.addAddress('::1', 'ipv6');
for (const [net, bits] of [['fc00::', 7], ['fe80::', 10], ['fec0::', 10]]) LOCAL_NETS.addSubnet(net, bits, 'ipv6');

/** Whether an IP address (text, IPv6 with or without brackets) is one of LOCAL_NETS. Anything else: false. */
function isLocalAddress(address) {
    const bare = String(address ?? '').replace(/^\[|\]$/g, '');
    const family = isIP(bare);
    return family !== 0 && LOCAL_NETS.check(bare, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Whether a URL's host is this computer or its network by how it is
 * written: one of their addresses, or a localhost or .local name. A name
 * that only resolves to one is caught where a redirect is followed.
 */
export function isLocal(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
        return false;
    }
    return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isLocalAddress(host);
}

/** The system's resolver: every address a name has. */
const systemLookup = async (hostname) => (await dnsLookup(hostname, { all: true })).map((a) => a.address);

/**
 * Whether a URL leads to this computer or its network: by how it is
 * written (isLocal), or by an address its name resolves to. A name that
 * doesn't resolve counts as not local (the request then fails on its own).
 * Resolving a name here doesn't bind the connection to that address, so
 * this catches names that point home, not a name server that answers one
 * way here and another to the connection.
 */
async function leadsHome(url, lookup, signal) {
    if (isLocal(url)) return true;
    const { hostname, protocol } = new URL(url);
    if ((protocol !== 'https:' && protocol !== 'http:') || hostname === '' || isIP(hostname.replace(/^\[|\]$/g, '')) !== 0) return false;
    let addresses;
    try {
        addresses = await untilAborted(lookup(hostname), signal);
    } catch (error) {
        if (signal.aborted) throw error;
        return false;
    }
    return Array.isArray(addresses) && addresses.some((a) => isLocalAddress(typeof a === 'string' ? a : a?.address));
}

/** `promise`, or its rejection when `signal` aborts first. */
function untilAborted(promise, signal) {
    return new Promise((resolve, reject) => {
        const stop = () => reject(signal.reason);
        if (signal.aborted) return stop();
        signal.addEventListener('abort', stop, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
}

/** A URL for messages: scheme, host and path only (no user, password or query). Never a feed's: its path can be its key (safeHost). */
export function safeUrl(url) {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return '(not a URL)';
    }
}

/** A URL's host (with its port) for messages: a path or a query can be a secret, like a private feed's address. */
export function safeHost(url) {
    try {
        return new URL(url).host;
    } catch {
        return '(not a URL)';
    }
}

/**
 * Services known to move their clients between their own hosts, each by
 * the domain all those hosts are under: Apple's iCloud sends CalDAV clients
 * from caldav.icloud.com to a pNN-caldav.icloud.com.
 */
const SERVICES = ['icloud.com'];

/** The SERVICES domain a host name is under, or undefined. */
const serviceOf = (hostname) => SERVICES.find((domain) => hostname === domain || hostname.endsWith(`.${domain}`));

/**
 * keepAuth for an account's password, and what it may be sent to: the same
 * host (with its port) and scheme, or, over https, from one host of a
 * SERVICES domain to another of the same one. Not other hosts of the same
 * site: on a shared domain (example.co.uk, a hosting provider's) they can
 * be anyone's.
 */
export function sameService(from, to) {
    let a;
    let b;
    try {
        a = new URL(from);
        b = new URL(to);
    } catch {
        return false;
    }
    if (a.protocol !== 'https:' && a.protocol !== 'http:') return false;
    if (a.origin === b.origin) return true;
    const service = serviceOf(a.hostname);
    return service !== undefined && service === serviceOf(b.hostname) && a.protocol === 'https:' && b.protocol === 'https:' && a.port === b.port;
}

/** keepAuth by default: the same origin only. */
const sameOrigin = (from, to) => new URL(from).origin === new URL(to).origin;

/**
 * One HTTP exchange.
 * @param {string} url
 * @param {object} [init]
 * @param {string} [init.method] - GET by default.
 * @param {Record<string,string>} [init.headers]
 * @param {string|Uint8Array} [init.body]
 * @param {number} [init.timeoutMs] - the whole exchange, redirects included (30 s).
 * @param {number} [init.maxBytes] - the most body read (20 MB).
 * @param {AbortSignal} [init.signal]
 * @param {boolean} [init.allowHttp] - plain http to other computers too.
 * @param {(from: string, to: string) => boolean} [init.keepAuth] - whether a redirect keeps Authorization.
 * @param {typeof fetch} [init.fetch] - for tests.
 * @param {(hostname: string) => Promise<string[]>} [init.lookup] - the addresses a name resolves to, for
 *   the redirect check (the system's resolver; tests give their own).
 * @returns {Promise<{status: number, ok: boolean, url: string, headers: Headers, text: string, json: () => any}>}
 */
export async function request(url, init = {}) {
    const {
        method = 'GET', headers = {}, body, timeoutMs = 30_000, maxBytes = 20 * 1024 * 1024,
        signal, allowHttp = false, keepAuth = sameOrigin, fetch: fetchImpl = globalThis.fetch, lookup = systemLookup,
    } = init;
    const timer = AbortSignal.timeout(timeoutMs);
    const abort = signal ? AbortSignal.any([signal, timer]) : timer;
    let current = String(url);
    let sent = { ...headers };
    let verb = method;
    let payload = body;
    // Whether the request started on this computer or its network: worked out when a redirect leads there.
    let home;
    /** The HttpError for a step that failed or was stopped while talking to `current`. */
    const failed = (error) => {
        if (timer.aborted) return new HttpError('timeout', `${safeHost(current)} didn't answer within ${Math.round(timeoutMs / 1000)} s.`);
        if (signal?.aborted) return new HttpError('aborted', 'Stopped.');
        return new HttpError('network', `Couldn't reach ${safeHost(current)}: ${networkReason(error)}`);
    };
    for (let hop = 0; ; hop++) {
        let target;
        try {
            target = new URL(current);
        } catch {
            throw new HttpError('network', 'The address is not a valid URL.');
        }
        if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new HttpError('insecure', `Only https addresses work here, not ${target.protocol}`);
        if (target.protocol === 'http:' && !allowHttp && !isLoopback(current)) {
            throw new HttpError('insecure', `${safeHost(current)} is plain http; calendars on another computer need https.`);
        }
        let response;
        try {
            response = await fetchImpl(current, { method: verb, headers: sent, body: payload, redirect: 'manual', signal: abort });
        } catch (error) {
            throw failed(error);
        }
        if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
            if (hop >= 5) throw new HttpError('redirects', `${safeHost(url)} redirected too many times.`);
            const next = new URL(response.headers.get('location'), current).toString();
            try { await response.body?.cancel(); } catch {}
            // From a server elsewhere to this computer or its network: only for a request that started there.
            if (new URL(next).hostname !== target.hostname) {
                let local;
                try {
                    local = await leadsHome(next, lookup, abort);
                    if (local) home ??= await leadsHome(String(url), lookup, abort);
                } catch (error) {
                    throw failed(error);
                }
                if (local && !home) {
                    throw new HttpError('insecure', `${safeHost(current)} sent the request on to an address on this computer or its network, which isn't allowed.`);
                }
            }
            if (target.protocol === 'https:' && next.startsWith('http:') && !isLoopback(next)) {
                throw new HttpError('insecure', `${safeHost(current)} redirected to plain http.`);
            }
            if (!keepAuth(current, next)) {
                sent = Object.fromEntries(Object.entries(sent).filter(([k]) => k.toLowerCase() !== 'authorization'));
            }
            // 303, and 301/302 after a POST, become a GET without a body, as browsers do.
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && verb === 'POST')) {
                verb = 'GET';
                payload = undefined;
            }
            current = next;
            continue;
        }
        const text = await readText(response, maxBytes, current);
        return {
            status: response.status,
            ok: response.status >= 200 && response.status < 300,
            url: current,
            headers: response.headers,
            text,
            json() {
                try {
                    return JSON.parse(text);
                } catch {
                    throw new HttpError('network', `${safeHost(current)} sent something that isn't JSON (HTTP ${response.status}).`, response.status);
                }
            },
        };
    }
}

/** The body as text, at most maxBytes of it. */
async function readText(response, maxBytes, url) {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
        try { await response.body?.cancel(); } catch {}
        throw new HttpError('too-large', `${safeHost(url)} sent more than ${Math.round(maxBytes / 1048576)} MB.`, response.status);
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
            try { await reader.cancel(); } catch {}
            throw new HttpError('too-large', `${safeHost(url)} sent more than ${Math.round(maxBytes / 1048576)} MB.`, response.status);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

/** Why a fetch failed, in words, without the URL (the caller names it). */
function networkReason(error) {
    const cause = error?.cause;
    const code = cause?.code ?? error?.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the name doesn\'t resolve';
    if (code === 'ECONNREFUSED') return 'the connection was refused';
    if (code === 'ECONNRESET') return 'the connection was reset';
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'the connection timed out';
    if (typeof code === 'string' && /CERT|SSL|TLS/i.test(code)) return 'its certificate isn\'t trusted';
    return typeof code === 'string' ? code : 'the request failed';
}

/** Basic auth header value. */
export function basicAuth(user, password) {
    return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

/** A form body (application/x-www-form-urlencoded). */
export function formBody(fields) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) params.set(k, String(v));
    return params.toString();
}
