/** CIDR matching for the dsh-site source gate. */

export function ipv4ToInt(ip) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** True when `ip` falls inside `cidr` (IPv4 CIDRs, plus the IPv6 loopback). */
export function inCidr(ip, cidr) {
    if (!ip) return false;
    if (cidr === '::1/128') return ip === '::1';
    const [net, bitsRaw] = cidr.split('/');
    const bits = Number(bitsRaw);
    if (!net || !Number.isFinite(bits) || bits < 0 || bits > 32) return false;
    if (ip.includes(':')) return false;
    const a = ipv4ToInt(ip);
    const b = ipv4ToInt(net);
    if (a === null || b === null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}
