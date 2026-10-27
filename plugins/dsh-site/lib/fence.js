/**
 * The browser-trust fence at the edge.
 *
 * DSH's own server refuses a request whose Host is not loopback (DNS
 * rebinding) and one a browser marks as cross-site or sends with a foreign
 * Origin (a page on another site driving DSH). The edge must rewrite Host and
 * Origin to the loopback origin for DSH to answer at all, which would switch
 * those checks off. So the edge makes the same checks first, against the
 * address the device actually used:
 *
 *   1. Host is loopback, an IP literal, or a name listed in `allowHosts`
 *      (a name a device can be tricked into sending only if it is listed).
 *   2. A frame, embed or object load marked as coming from any other origin
 *      (`Sec-Fetch-Dest` iframe/frame/embed/object/fencedframe with
 *      `Sec-Fetch-Site` same-site or cross-site) is refused: no other page
 *      may show DSH inside itself.
 *   3. `Sec-Fetch-Site: cross-site` is refused.
 *   4. An Origin, when there is one, must be this same address (scheme
 *      http or https, same host and port).
 *
 * Browsers send Fetch Metadata (`Sec-Fetch-*`) only to trustworthy
 * destinations (loopback, HTTPS). Over plain HTTP to a tailnet address or
 * name they send neither it nor an Origin on navigations, frames and images,
 * so checks 2 and 3 cannot see those; the edge's answers carry
 * X-Frame-Options, a frame-ancestors policy and Cross-Origin-Resource-Policy
 * for them (lib/edge.js). Posts and WebSockets always carry an Origin.
 *
 * Pure functions, no I/O.
 *
 * @module dsh-plugin-dsh-site/fence
 */
import { isIP } from 'node:net';

/** A Host or authority text as a URL (hostname lowercased, default port dropped), or undefined. */
export function parseAuthority(authority, scheme = 'http:') {
    if (typeof authority !== 'string' || authority === '' || /[\s/?#@\\]/.test(authority)) return undefined;
    try {
        return new URL(`${scheme}//${authority}`);
    } catch {
        return undefined;
    }
}

/** True for localhost, an address in 127/8 or [::1]. */
export function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]') return true;
    const parts = hostname.split('.');
    return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** True when a URL hostname is an IP literal (IPv4, or bracketed IPv6). */
export function isIpHostname(hostname) {
    if (hostname.startsWith('[') && hostname.endsWith(']')) return isIP(hostname.slice(1, -1)) === 6;
    return isIP(hostname) === 4;
}

/**
 * One `allowHosts` entry, checked: `{ hostname, host, port }` (port '' when
 * the entry has none, so it matches any port), or an error sentence.
 */
export function parseAllowedHost(entry) {
    const text = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!text) return { error: 'an empty name' };
    if (text.includes('*')) return { error: `"${text}" has a wildcard; list each name` };
    const url = parseAuthority(text);
    if (!url || url.username || url.password) return { error: `"${text}" is not a host name or host:port` };
    const port = /:(\d+)$/.test(text) && !text.endsWith(']') ? text.slice(text.lastIndexOf(':') + 1) : '';
    return { hostname: url.hostname, host: port ? `${url.hostname}:${Number(port)}` : url.hostname, port };
}

/** True when the request's parsed Host matches one checked `allowHosts` entry. */
function hostListed(hostUrl, allowHosts) {
    return allowHosts.some((entry) => (entry.port ? entry.host === `${hostUrl.hostname}:${hostUrl.port || '80'}` || entry.host === hostUrl.host : entry.hostname === hostUrl.hostname));
}

/** True when `origin` names the same http(s) authority as `host`. */
export function sameAuthority(origin, host) {
    let originUrl;
    try {
        originUrl = new URL(origin);
    } catch {
        return false;
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
    const hostUrl = parseAuthority(host, originUrl.protocol);
    return hostUrl !== undefined && originUrl.host === hostUrl.host;
}

const one = (value) => (Array.isArray(value) ? value[0] : value);

/** The Sec-Fetch-Dest values of a load that shows a page inside another page. */
export const FRAME_DESTS = Object.freeze(['iframe', 'frame', 'embed', 'object', 'fencedframe']);

/**
 * Check one request's headers.
 * @param {Record<string, string|string[]|undefined>} headers - Node's lowercased request headers.
 * @param {{ hostname: string, host: string, port: string }[]} allowHosts - checked entries.
 * @returns {undefined | { kind: 'host' | 'framed' | 'cross-site' | 'bad-host', host?: string, origin?: string, dest?: string }}
 *   undefined when the request may pass; else why it may not.
 */
export function fenceCheck(headers, allowHosts = []) {
    const host = one(headers.host);
    const hostUrl = parseAuthority(host);
    if (!hostUrl) return { kind: 'bad-host', host: typeof host === 'string' ? host.slice(0, 200) : '' };
    const { hostname } = hostUrl;
    if (!isLoopbackHostname(hostname) && !isIpHostname(hostname) && !hostListed(hostUrl, allowHosts)) {
        return { kind: 'host', host: hostUrl.host };
    }
    const site = one(headers['sec-fetch-site']);
    const dest = one(headers['sec-fetch-dest']);
    if (FRAME_DESTS.includes(dest) && (site === 'same-site' || site === 'cross-site')) return { kind: 'framed', host: hostUrl.host, dest, origin: String(one(headers.origin) ?? '').slice(0, 200) };
    if (site === 'cross-site') return { kind: 'cross-site', host: hostUrl.host, origin: String(one(headers.origin) ?? '').slice(0, 200) };
    const origin = one(headers.origin);
    if (origin !== undefined && !sameAuthority(origin, host)) return { kind: 'cross-site', host: hostUrl.host, origin: String(origin).slice(0, 200) };
    return undefined;
}
