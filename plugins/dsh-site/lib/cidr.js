/**
 * Address ranges for the source gate: IPv4 and IPv6 CIDRs, and the IP
 * literals a Host header may carry. Pure functions, no I/O.
 *
 * @module dsh-plugin-dsh-site/cidr
 */
import { isIP } from 'node:net';

/** An IPv4 address as a 32-bit unsigned number, or null. */
export function ipv4ToInt(ip) {
    if (typeof ip !== 'string' || isIP(ip) !== 4) return null;
    return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

/** An IPv6 address as a 128-bit BigInt, or null (an embedded IPv4 tail is read as its 32 bits). */
export function ipv6ToBigInt(ip) {
    if (typeof ip !== 'string') return null;
    const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
    const noZone = bare.split('%')[0];
    if (isIP(noZone) !== 6) return null;
    let text = noZone;
    // An IPv4 tail (::ffff:1.2.3.4) becomes two groups.
    const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (tail) {
        const v4 = ipv4ToInt(tail[1]);
        if (v4 === null) return null;
        text = `${text.slice(0, -tail[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }
    const [head, rest] = text.split('::');
    const left = head ? head.split(':') : [];
    const right = rest === undefined ? [] : rest ? rest.split(':') : [];
    const fill = rest === undefined ? 0 : 8 - left.length - right.length;
    const groups = [...left, ...Array(fill).fill('0'), ...right];
    if (groups.length !== 8) return null;
    return groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g, 16)), 0n);
}

/** An IPv4-mapped IPv6 address (::ffff:a.b.c.d) as its IPv4 text; any other address as it is. */
export function normalizeIp(ip) {
    if (typeof ip !== 'string') return '';
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4) return lower.slice(7);
    return lower;
}

/**
 * One allowed range, parsed: `{ family: 4|6, base, bits, text }`, or null
 * when `text` is not a CIDR (`a.b.c.d/n`, `x::y/n`) or a single address.
 */
export function parseCidr(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    const slash = trimmed.indexOf('/');
    const addr = slash === -1 ? trimmed : trimmed.slice(0, slash);
    const bitsText = slash === -1 ? undefined : trimmed.slice(slash + 1);
    const family = isIP(addr);
    if (family === 0) return null;
    const max = family === 4 ? 32 : 128;
    let bits = max;
    if (bitsText !== undefined) {
        if (!/^\d{1,3}$/.test(bitsText)) return null;
        bits = Number(bitsText);
        if (bits > max) return null;
    }
    if (family === 4) {
        const n = ipv4ToInt(addr);
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        return { family, base: (n & mask) >>> 0, mask, bits, text: trimmed };
    }
    const n = ipv6ToBigInt(addr);
    const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
    return { family, base: n & mask, mask, bits, text: trimmed };
}

/** True when `ip` (a socket's remote address) falls inside the parsed range. */
export function inRange(ip, range) {
    if (!range) return false;
    const addr = normalizeIp(ip);
    const family = isIP(addr);
    if (family === 4 && range.family === 4) return ((ipv4ToInt(addr) & range.mask) >>> 0) === range.base;
    if (family === 6 && range.family === 6) return (ipv6ToBigInt(addr) & range.mask) === range.base;
    return false;
}

/** True when `ip` falls inside `cidr` (text). Kept for callers of the first version. */
export function inCidr(ip, cidr) {
    return inRange(ip, parseCidr(cidr));
}

/** True when `ip` falls inside any of the parsed ranges. */
export function allowedBy(ranges, ip) {
    return ranges.some((range) => inRange(ip, range));
}

/** True for a loopback address (127/8, ::1, or a mapped form of 127/8). */
export function isLoopbackIp(ip) {
    const addr = normalizeIp(ip);
    if (isIP(addr) === 4) return addr.startsWith('127.');
    return addr === '::1';
}
