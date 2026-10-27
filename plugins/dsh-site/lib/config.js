/**
 * dsh-site's settings, checked in words.
 *
 * DSH checks a plugin's row against its schema before the plugin starts, and
 * a value of the wrong type there would stop the plugin with only "Problem"
 * in DSH's Plugins page. So the schema (lib/index.js) takes any value and
 * fills in nothing, and this module says what each must be. A wrong value
 * never stops the plugin from loading, and never makes the edge guess: the
 * edge does not open its port until every setting is right, and its log
 * (logFile) says which setting to change and to what; the same line goes to
 * DSH's plugin logger.
 *
 * It fails closed: a row with no settings at all (DSH loads a plugin listed
 * in the profile's bundles even with no row), a key that is not a setting
 * (a misspelt `enable: false`), no `listenHost`, a loopback range in
 * `allowCIDRs` without `allowThisMac`, or a range in `allowCIDRs` while
 * `injectAuthCookie` signs in every device let in, keeps the port closed.
 *
 * Pure functions, no I/O.
 *
 * @module dsh-plugin-dsh-site/config
 */
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseCidr } from './cidr.js';
import { isLoopbackHostname, parseAllowedHost, parseAuthority } from './fence.js';

/** Every setting with its default; the README's config table lists the same. `listenHost` has none: it must be set. */
export const DEFAULTS = Object.freeze({
    enabled: true,
    listenHost: '',
    listenPort: 8443,
    allowCIDRs: '100.64.0.0/10',
    allowHosts: '',
    allowThisMac: false,
    targetOrigin: '',
    discoverTarget: true,
    rewriteHost: true,
    rewriteOrigin: true,
    injectAuthCookie: false,
    cookieJar: '~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies',
    logFile: 'dsh-site/site.log',
});

/** Settings with no default: the edge does not serve until the row sets them. */
export const REQUIRED = Object.freeze(['listenHost']);

/**
 * The only networks `allowCIDRs` may let in: loopback, the private ranges
 * (RFC 1918), the shared range tailnets use (100.64.0.0/10), link-local, and
 * IPv6 unique-local (Tailscale's fd7a:115c:a1e0::/48 is inside it).
 */
export const PRIVATE_RANGES = Object.freeze(['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'].map(parseCidr));

const inside = (range, outer) => {
    if (outer.family !== range.family || range.bits < outer.bits) return false;
    return outer.family === 4 ? ((range.base & outer.mask) >>> 0) === outer.base : (range.base & outer.mask) === outer.base;
};

/** True when a parsed range lies wholly inside one of PRIVATE_RANGES. */
export function isPrivateRange(range) {
    return PRIVATE_RANGES.some((p) => inside(range, p));
}

const LOOPBACK_RANGES = Object.freeze(['127.0.0.0/8', '::1/128'].map(parseCidr));

/** True when a parsed range is this machine itself (inside 127.0.0.0/8 or ::1). */
export const isLoopbackRange = (range) => LOOPBACK_RANGES.some((p) => inside(range, p));

/** DSH's own home, decided as DSH decides it: DSH_HOME when it is set and not blank, else ~/.dsh. */
export function dshHomeOf(env = process.env, home = homedir()) {
    const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
    if (!fromEnv) return join(home, '.dsh');
    return resolve(fromEnv === '~' ? home : fromEnv.startsWith('~/') ? join(home, fromEnv.slice(2)) : fromEnv);
}

/** A path setting on disk: `~/` is the home folder, a relative path is inside DSH's home, an absolute one stays. */
export function settingPath(path, { env = process.env, home = homedir() } = {}) {
    if (typeof path !== 'string' || path === '') return path;
    if (path === '~') return home;
    if (path.startsWith('~/')) return join(home, path.slice(2));
    if (isAbsolute(path)) return path;
    return join(dshHomeOf(env, home), path);
}

const shown = (value) => {
    if (value === undefined) return 'empty';
    try {
        return JSON.stringify(value).slice(0, 120);
    } catch {
        return String(value).slice(0, 120);
    }
};

/** Edit distance (insert, delete, change), for "did you mean". */
function distance(a, b) {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        row = next;
    }
    return row[b.length];
}

/** The setting a misspelt key most likely means, or undefined. */
export function didYouMean(key) {
    const known = Object.keys(DEFAULTS);
    const lower = String(key).toLowerCase().replace(/[-_\s]/g, '');
    const same = known.find((k) => k.toLowerCase() === lower);
    if (same) return same;
    const close = known.map((k) => [k, distance(lower, k.toLowerCase())]).filter(([, d]) => d <= 2).sort((x, y) => x[1] - y[1]);
    if (close.length > 0) return close[0][0];
    const inside = lower.length >= 4 ? known.filter((k) => k.toLowerCase().includes(lower)) : [];
    return inside.length === 1 ? inside[0] : undefined;
}

/** A switch: true or false (the words "true" and "false" too, as YAML users type them). */
function onOff(raw, key, problems) {
    const value = raw[key];
    if (value === undefined || value === null) return DEFAULTS[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
    problems.push({ key, text: `${key} must be true or false (it is ${shown(value)})` });
    return DEFAULTS[key];
}

/** A list given as a YAML list or as one comma-separated text. */
function listOf(value) {
    if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim() : v)).filter((v) => v !== '');
    if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
    return undefined;
}

/** A path: text, `~/` meaning the home folder, a relative path inside DSH's home (settingPath). */
function pathOf(raw, key, problems, { optional = false } = {}) {
    const value = raw[key];
    if (value === undefined || value === null) return DEFAULTS[key];
    if (typeof value === 'string' && (value.trim() !== '' || optional)) return value.trim();
    problems.push({ key, text: `${key} must be a path such as ${shown(DEFAULTS[key])}${optional ? ', or "" for none' : ''} (it is ${shown(value)})` });
    return DEFAULTS[key];
}

/** The sentence for a row with no settings at all. */
export const NO_SETTINGS = 'dsh-site has no settings in this profile (its row has no config), so it does not serve. To serve, give its row at least listenHost (this Mac\'s tailnet address); to switch it off for good, switch DSH Site off on DSH\'s Plugins page, which takes dsh-plugin-dsh-site out of the profile\'s bundles';

/**
 * Check a row's config.
 * @param {Record<string, unknown>} raw - the config DSH passed (any values; the schema fills in nothing).
 * @returns {{ settings: object, problems: { key: string, text: string }[] }}
 *   settings with every value checked (a default stands in for a wrong one,
 *   but the edge serves only while `problems` is empty).
 */
export function checkConfig(raw) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const problems = [];
    const settings = {};
    const empty = Object.keys(input).length === 0;

    if (empty) problems.push({ key: 'config', text: NO_SETTINGS });

    for (const key of Object.keys(input)) {
        if (Object.hasOwn(DEFAULTS, key)) continue;
        const meant = didYouMean(key);
        problems.push({ key, text: `${shown(key)} is not a dsh-site setting${meant ? `: did you mean ${meant}?` : ' (the README lists every setting)'}` });
    }

    settings.enabled = onOff(input, 'enabled', problems);
    settings.allowThisMac = onOff(input, 'allowThisMac', problems);

    const host = input.listenHost;
    if (typeof host === 'string' && (isIP(host.trim()) !== 0 || host.trim() === 'localhost')) settings.listenHost = host.trim();
    else {
        settings.listenHost = DEFAULTS.listenHost;
        const missing = host === undefined || host === null || host === '';
        // A row that says only `enabled: false` needs no address: nothing is served. An empty row is said once, above.
        if (!empty && !(missing && settings.enabled === false)) {
            problems.push({
                key: 'listenHost',
                text: missing
                    ? 'listenHost is not set: set it to this Mac\'s tailnet address, such as "100.101.102.103" (only that network reaches the edge), "127.0.0.1", or "0.0.0.0" (every interface, still gated by allowCIDRs)'
                    : `listenHost must be an IP address of this machine, such as its tailnet address "100.101.102.103", "127.0.0.1" or "0.0.0.0" (every interface, still gated by allowCIDRs) (it is ${shown(host)})`,
            });
        }
    }

    const port = input.listenPort ?? DEFAULTS.listenPort;
    const portNumber = typeof port === 'string' && /^\s*\d+\s*$/.test(port) ? Number(port) : port;
    if (Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535) settings.listenPort = portNumber;
    else {
        problems.push({ key: 'listenPort', text: `listenPort must be a whole number from 1 to 65535, such as 8443 (it is ${shown(port)})` });
        settings.listenPort = DEFAULTS.listenPort;
    }

    const cidrs = listOf(input.allowCIDRs ?? DEFAULTS.allowCIDRs);
    if (cidrs === undefined) {
        problems.push({ key: 'allowCIDRs', text: `allowCIDRs must list addresses or ranges, such as "100.101.102.104,100.64.0.0/10" (it is ${shown(input.allowCIDRs)})` });
        settings.allowCIDRs = [];
    } else {
        const ranges = [];
        for (const entry of cidrs) {
            const range = parseCidr(typeof entry === 'string' ? entry : '');
            if (!range) problems.push({ key: 'allowCIDRs', text: `allowCIDRs has ${shown(entry)}, which is not an address range such as 100.64.0.0/10 or fd7a:115c:a1e0::/48` });
            else if (range.bits === 0) problems.push({ key: 'allowCIDRs', text: `allowCIDRs has ${shown(range.text)}, which lets in every address: list your private network's range instead` });
            else if (!isPrivateRange(range)) problems.push({ key: 'allowCIDRs', text: `allowCIDRs has ${shown(range.text)}, which is not inside a private network: dsh-site lets in only loopback, 100.64.0.0/10 (tailnets), 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, link-local and fc00::/7 ranges` });
            else if (isLoopbackRange(range) && !settings.allowThisMac) problems.push({ key: 'allowCIDRs', text: `allowCIDRs has ${shown(range.text)}, which is this Mac itself: through the edge every program and every account on this Mac would reach DSH, with no sign-in when injectAuthCookie is true. Take it out (devices on your network do not need it), or set allowThisMac to true if a proxy on this Mac (such as tailscale serve) sends devices to the edge` });
            else ranges.push(range);
        }
        if (cidrs.length === 0) problems.push({ key: 'allowCIDRs', text: 'allowCIDRs is empty, so no device could reach the edge: list your devices\' addresses, such as "100.101.102.104,100.101.102.105", or a range such as "100.64.0.0/10"' });
        settings.allowCIDRs = ranges;
    }

    const hosts = listOf(input.allowHosts ?? DEFAULTS.allowHosts);
    if (hosts === undefined) {
        problems.push({ key: 'allowHosts', text: `allowHosts must list host names, such as "mymac.example.ts.net,dsh.example.com" (it is ${shown(input.allowHosts)})` });
        settings.allowHosts = [];
    } else {
        settings.allowHosts = [];
        for (const entry of hosts) {
            const parsed = parseAllowedHost(entry);
            if (parsed.error) problems.push({ key: 'allowHosts', text: `allowHosts has ${parsed.error}: list names such as mymac.example.ts.net or dsh.example.com:8443` });
            else settings.allowHosts.push(parsed);
        }
    }

    const target = input.targetOrigin ?? DEFAULTS.targetOrigin;
    if (target === '' || target === null) settings.targetOrigin = '';
    else {
        let url;
        try {
            url = typeof target === 'string' ? new URL(target.trim()) : undefined;
        } catch {}
        const ok = url && url.protocol === 'http:' && (url.pathname === '/' || url.pathname === '') && !url.search && !url.username && isLoopbackHostname(url.hostname) && url.port !== '';
        if (ok) settings.targetOrigin = `http://${url.host}`;
        else {
            problems.push({ key: 'targetOrigin', text: `targetOrigin must be empty (the DSH this plugin runs in) or a loopback address with its port, such as "http://127.0.0.1:52817" (it is ${shown(target)})` });
            settings.targetOrigin = '';
        }
    }

    settings.discoverTarget = onOff(input, 'discoverTarget', problems);
    settings.rewriteHost = onOff(input, 'rewriteHost', problems);
    settings.rewriteOrigin = onOff(input, 'rewriteOrigin', problems);
    settings.injectAuthCookie = onOff(input, 'injectAuthCookie', problems);
    settings.cookieJar = pathOf(input, 'cookieJar', problems);
    settings.logFile = pathOf(input, 'logFile', problems, { optional: true });

    // With the desktop window's cookie the edge signs in every device it lets in, so devices that can reach the
    // port are listed one by one: a range would sign in every device in it. A listener on loopback is reached by
    // this Mac only (allowThisMac decides), and a loopback entry is this Mac, so neither needs it.
    if (settings.enabled && settings.injectAuthCookie && settings.listenHost && !listensOnLoopback(settings.listenHost)) {
        for (const range of settings.allowCIDRs) {
            if (isSingleAddress(range) || isLoopbackRange(range)) continue;
            problems.push({
                key: 'allowCIDRs',
                text: `allowCIDRs has ${shown(range.text)}${input.allowCIDRs === undefined ? ' (its default)' : ''}, a range: with injectAuthCookie true the edge signs in every device it lets in, so every device in that range would get DSH with no sign-in. List your own devices one by one, such as "100.101.102.104,100.101.102.105" (tailscale status lists them), or set injectAuthCookie to false so that each device signs in with DSH's own link`,
            });
        }
    }

    return { settings, problems };
}

/** True when a parsed range is one address (a /32, or a /128 for IPv6): on a tailnet, one device. */
export const isSingleAddress = (range) => range.bits === (range.family === 4 ? 32 : 128);

/** True when listenHost is reached by this machine only (127.x, ::1, localhost). */
export function listensOnLoopback(host) {
    if (host === 'localhost') return true;
    const range = parseCidr(host);
    return Boolean(range) && isLoopbackRange(range);
}

/** The edge's own address as `host:port` (IPv6 in brackets). */
export function listenLabel(settings) {
    const host = settings.listenHost;
    const shownHost = host.includes(':') ? `[${host}]` : host;
    return `${shownHost}:${settings.listenPort}`;
}

/** True when listenHost means every interface. */
export const listensEverywhere = (settings) => settings.listenHost === '0.0.0.0' || settings.listenHost === '::';

/** True when `authority` (host[:port]) parses; used by tests and the health page. */
export const validAuthority = (authority) => parseAuthority(authority) !== undefined;
