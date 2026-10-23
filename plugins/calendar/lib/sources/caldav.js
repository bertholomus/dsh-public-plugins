/**
 * CalDAV accounts (RFC 4791): iCloud, Fastmail, Nextcloud, Yahoo,
 * mailbox.org, Zoho and any other CalDAV server. An 'ics' source: it lists
 * the account's calendars and fetches and stores iCalendar text; reading
 * and editing that text is the manager's.
 *
 * - Discovery (RFC 6764) starts from whatever address the user gave: a
 *   server root, /.well-known/caldav, a principal or a calendar. It asks
 *   for the signed-in user's principal, the principal's calendar home(s),
 *   and lists the calendars there that hold events, the user's default
 *   calendar (RFC 6638's schedule-default-calendar-URL) marked primary.
 * - Sync prefers the sync-collection REPORT (RFC 6578). When the server has
 *   none, or no longer takes the token, it lists every resource's etag and
 *   compares them with the last sync's. New and changed resources come in
 *   calendar-multiget batches, or one GET each where multiget fails.
 * - Writes are conditional: If-None-Match: * for a new resource, If-Match
 *   with the last etag for a change or a delete; a 412 is a conflict. When
 *   the plugin holds none, the event is read from the server first: a
 *   change goes on only while it shows what the plugin's copy shows and
 *   names the same people, a delete only while it names the same people
 *   (one whose version can't be read isn't made). A new resource is named
 *   after its UID, so a create repeated after a timeout finds the one the
 *   first try made instead of adding a second.
 * - The password goes only to the host the account names (sameService;
 *   iCloud's other icloud.com hosts too, as it moves clients from
 *   caldav.icloud.com to pNN-caldav.icloud.com): an address a server hands
 *   over that leads to another host, or from a server elsewhere to this
 *   computer or its network, gets no request, an answer that a redirect
 *   brought from another host isn't used, and http.js drops the header when
 *   a redirect leaves the host.
 *
 * Multistatus answers are read with a small namespace-aware XML parser
 * (parseXml), since servers differ in prefixes, quoting, CDATA and entities.
 *
 * @module dsh-plugin-calendar/sources/caldav
 */
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, basicAuth, request as httpRequest, isLocal, safeUrl, sameService } from '../http.js';
import { parseIcs, readIcs, unescapeText } from '../ical.js';
import { addressKey, instantOf, isEmailAddress } from '../model.js';
import { parseRule, ruleText } from '../recur.js';
import { ianaZone } from '../zones.js';
import { SourceError, newPeople, peopleConflict, statusError } from './index.js';

export const kind = 'caldav';
export const style = 'ics';

/**
 * Ready-made accounts for the account dialog. `url` is where discovery
 * starts (empty: the user gives it, `needsUrl`); `urlHint` says what to
 * give; the hints say which user name and which password the service wants.
 * @type {{id: string, name: string, url: string, needsUrl?: boolean, urlHint?: string,
 *         usernameHint: string, passwordHint: string, helpUrl?: string}[]}
 */
export const PRESETS = [
    {
        id: 'icloud',
        name: 'iCloud',
        url: 'https://caldav.icloud.com',
        usernameHint: 'The email address of your Apple Account (Apple ID).',
        passwordHint: 'An app-specific password, not your Apple Account password: sign in at account.apple.com, then Sign-In and Security → App-Specific Passwords. It needs two-factor authentication on the account.',
        helpUrl: 'https://support.apple.com/en-us/102654',
    },
    {
        id: 'fastmail',
        name: 'Fastmail',
        url: 'https://caldav.fastmail.com',
        usernameHint: 'Your full Fastmail email address, domain included.',
        passwordHint: 'An app password with calendar access, not your Fastmail password: Settings → Privacy & Security → Manage app passwords and access → New app password.',
        helpUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854',
    },
    {
        id: 'nextcloud',
        name: 'Nextcloud',
        url: '',
        needsUrl: true,
        urlHint: 'The address of your Nextcloud, like https://cloud.example.com (its calendars are under /remote.php/dav).',
        usernameHint: 'Your Nextcloud user name.',
        passwordHint: 'An app password (your login password works only without two-factor authentication): Settings → Security → Devices & sessions → Create new app password.',
        helpUrl: 'https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html',
    },
    {
        id: 'yahoo',
        name: 'Yahoo',
        url: 'https://caldav.calendar.yahoo.com',
        usernameHint: 'Your Yahoo email address.',
        passwordHint: 'An app password, not your Yahoo password: Yahoo Account Security → External connections → Create app password.',
        helpUrl: 'https://help.yahoo.com/kb/SLN15241.html',
    },
    {
        id: 'mailbox.org',
        name: 'mailbox.org',
        url: 'https://dav.mailbox.org',
        usernameHint: 'Your main mailbox.org email address.',
        passwordHint: 'Your mailbox.org password, or with two-factor authentication an application password: All settings → Security → Application passwords.',
        helpUrl: 'https://kb.mailbox.org/en/private/security-and-privacy/application-passwords-for-external-programs/',
    },
    {
        id: 'zoho',
        name: 'Zoho Calendar',
        url: 'https://calendar.zoho.com',
        urlHint: 'Accounts in another Zoho data center use its domain, like https://calendar.zoho.eu.',
        usernameHint: 'Your Zoho account email address.',
        passwordHint: 'Your Zoho password, or with multi-factor authentication an application-specific password: Zoho Accounts → Security → Application Specific Passwords → Generate New Password.',
        helpUrl: 'https://www.zoho.com/calendar/help/setup-caldav-sync.html',
    },
    {
        id: 'other',
        name: 'Other CalDAV server',
        url: '',
        needsUrl: true,
        urlHint: 'The address of the server, or of one of its calendars.',
        usernameHint: 'Your user name on the server.',
        passwordHint: 'Your password, or an app password where the server has them.',
    },
];

const DAV = 'DAV:';
const CALDAV = 'urn:ietf:params:xml:ns:caldav';
const CS = 'http://calendarserver.org/ns/';
const ICAL = 'http://apple.com/ns/ical/';

/** A property's key in parsed answers: its namespace and name ("{DAV:}getetag"). */
const clark = (ns, name) => `{${ns ?? ''}}${name}`;

const RESOURCETYPE = clark(DAV, 'resourcetype');
const DISPLAYNAME = clark(DAV, 'displayname');
const GETETAG = clark(DAV, 'getetag');
const PRIVILEGES = clark(DAV, 'current-user-privilege-set');
const PRINCIPAL = clark(DAV, 'current-user-principal');
const HOME_SET = clark(CALDAV, 'calendar-home-set');
const COMPONENTS = clark(CALDAV, 'supported-calendar-component-set');
const DESCRIPTION = clark(CALDAV, 'calendar-description');
const TIMEZONE = clark(CALDAV, 'calendar-timezone');
const TIMEZONE_ID = clark(CALDAV, 'calendar-timezone-id');
const CALENDAR_DATA = clark(CALDAV, 'calendar-data');
const CTAG = clark(CS, 'getctag');
const OUTBOX = clark(CALDAV, 'schedule-outbox-URL');
const INBOX = clark(CALDAV, 'schedule-inbox-URL');
const DEFAULT_CALENDAR = clark(CALDAV, 'schedule-default-calendar-URL');
const ADDRESSES = clark(CALDAV, 'calendar-user-address-set');
const COLOR = clark(ICAL, 'calendar-color');
const ORDER = clark(ICAL, 'calendar-order');

/** Resources fetched per calendar-multiget. */
const BATCH = 50;
/** GETs at a time where a server refuses calendar-multiget. */
const PARALLEL = 4;
/** Rounds of a truncated (507) sync-collection answer followed before listing instead. */
const MAX_ROUNDS = 50;
/** How long a server that refused sync-collection is listed instead before trying it again. */
const NO_SYNC_DAYS = 7;
const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// XML

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
/** What servers mean by a prefix they forgot to declare. */
const USUAL_PREFIXES = new Map([['d', DAV], ['c', CALDAV], ['cal', CALDAV], ['caldav', CALDAV], ['cs', CS], ['ical', ICAL]]);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

/** Text with XML's character references and its five named entities replaced. */
function decodeEntities(text) {
    if (!text.includes('&')) return text;
    return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (whole, dec, hex, named) => {
        if (named !== undefined) return ENTITIES[named];
        const code = dec !== undefined ? Number(dec) : Number.parseInt(hex, 16);
        const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
        return valid ? String.fromCodePoint(code) : '\uFFFD';
    });
}

/** The index just past `end`, searching from `from` (the text's end if it never comes). */
function skipPast(src, end, from) {
    const at = src.indexOf(end, from);
    return at === -1 ? src.length : at + end.length;
}

/** The end of a <!DOCTYPE ...> or other declaration, its [internal subset] included. */
function skipDeclaration(src, from) {
    let depth = 0;
    for (let at = from; at < src.length; at++) {
        const ch = src[at];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) return at + 1;
    }
    return src.length;
}

/** The index of the '>' that ends a tag, outside quoted attribute values, or -1. */
function tagEnd(src, from) {
    let quote = '';
    for (let at = from; at < src.length; at++) {
        const ch = src[at];
        if (quote !== '') {
            if (ch === quote) quote = '';
        } else if (ch === '"' || ch === '\'') {
            quote = ch;
        } else if (ch === '>') {
            return at;
        }
    }
    return -1;
}

function openTag(open, scopes, tag) {
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const qname = /^[^\s/>]+/.exec(body)?.[0];
    if (qname === undefined) return;
    const scope = Object.create(scopes[scopes.length - 1]);
    const attrs = Object.create(null);
    for (const [, name, double, single] of body.slice(qname.length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const value = decodeEntities(double ?? single);
        attrs[name] = value;
        if (name === 'xmlns') scope[''] = value;
        else if (name.startsWith('xmlns:')) scope[name.slice(6)] = value;
    }
    const colon = qname.indexOf(':');
    const prefix = colon === -1 ? '' : qname.slice(0, colon);
    const ns = prefix in scope ? scope[prefix] || null : USUAL_PREFIXES.get(prefix.toLowerCase()) ?? null;
    const element = { ns, name: qname.slice(colon + 1), qname, attrs, children: [], text: '' };
    open[open.length - 1].children.push(element);
    if (!selfClosing) {
        open.push(element);
        scopes.push(scope);
    }
}

function closeTag(open, scopes, qname) {
    // The innermost open element of that name; a stray end tag closes nothing.
    for (let at = open.length - 1; at > 0; at--) {
        if (open[at].qname === qname) {
            open.length = at;
            scopes.length = at;
            return;
        }
    }
}

/**
 * Reads XML into a tree of elements `{ns, name, attrs, children, text}`:
 * `ns` is the namespace URI the element's prefix (or the default namespace)
 * stands for, `text` the element's own character data (entities decoded,
 * CDATA as it is, line ends as \n). It reads no DTD and expands no entity
 * but XML's own, and forgives what servers get wrong: an end tag that
 * matches nothing open is skipped, one that skips open elements closes them
 * too, and a prefix nobody declared takes its usual meaning (D:, C:, CS:) or
 * none.
 * @param {string} text
 * @returns {{ns: null, name: '#document', children: object[], text: string}}
 */
export function parseXml(text) {
    const src = String(text ?? '').replace(/\r\n?/g, '\n');
    const doc = { ns: null, name: '#document', qname: '', attrs: Object.create(null), children: [], text: '' };
    const open = [doc];
    const root = Object.create(null);
    root.xml = XML_NS;
    const scopes = [root];
    let at = 0;
    while (at < src.length) {
        const top = open[open.length - 1];
        const lt = src.indexOf('<', at);
        if (lt === -1) {
            top.text += decodeEntities(src.slice(at));
            break;
        }
        if (lt > at) top.text += decodeEntities(src.slice(at, lt));
        if (src.startsWith('<!--', lt)) {
            at = skipPast(src, '-->', lt + 4);
        } else if (src.startsWith('<![CDATA[', lt)) {
            const end = src.indexOf(']]>', lt + 9);
            top.text += src.slice(lt + 9, end === -1 ? src.length : end);
            at = end === -1 ? src.length : end + 3;
        } else if (src.startsWith('<?', lt)) {
            at = skipPast(src, '?>', lt + 2);
        } else if (src.startsWith('<!', lt)) {
            at = skipDeclaration(src, lt + 2);
        } else {
            const end = tagEnd(src, lt + 1);
            if (end === -1) break;
            const tag = src.slice(lt + 1, end);
            at = end + 1;
            if (tag.startsWith('/')) closeTag(open, scopes, tag.slice(1).trim());
            else openTag(open, scopes, tag);
        }
    }
    return doc;
}

const kids = (element, ns, name) => (element?.children ?? []).filter((c) => c.ns === ns && c.name === name);
const kid = (element, ns, name) => element?.children.find((c) => c.ns === ns && c.name === name);
const textOf = (element) => (element === undefined ? '' : element.text.trim());

/** Text for request XML: the five characters XML escapes, and none it forbids. */
function escapeXml(text) {
    return String(text ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
        .replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' })[ch]);
}

/** The code in a DAV:status line ("HTTP/1.1 404 Not Found" → 404), or undefined. */
function statusCode(line) {
    const text = String(line ?? '');
    const m = /HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(text) ?? /^\s*(\d{3})\b/.exec(text);
    return m === null ? undefined : Number(m[1]);
}

/**
 * A multistatus answer (RFC 4918), or undefined when the text isn't one.
 * Each response gives `href` as sent, `url` (hrefUrl of it against `base`,
 * the address the answer came from), its own `status` when it has one, and
 * `props`: the properties of its 200 propstats by clark key ("{DAV:}getetag");
 * propstats with any other status are left out, their codes in `failed`. A
 * response naming several hrefs is one entry per href.
 * @param {string} text
 * @param {string} base
 * @returns {{base: string, syncToken?: string, responses: {href: string, url: string,
 *            status?: number, props: Map<string, object>, failed: number[]}[]} | undefined}
 */
export function parseMultistatus(text, base) {
    const doc = parseXml(text);
    const top = doc.children.find((c) => c.ns === DAV && c.name === 'multistatus');
    if (top === undefined) return undefined;
    const responses = [];
    for (const response of kids(top, DAV, 'response')) {
        const status = statusCode(kid(response, DAV, 'status')?.text);
        const props = new Map();
        const failed = [];
        for (const propstat of kids(response, DAV, 'propstat')) {
            const code = statusCode(kid(propstat, DAV, 'status')?.text);
            if (code !== 200) {
                failed.push(code);
                continue;
            }
            for (const prop of kids(propstat, DAV, 'prop')) {
                for (const p of prop.children) props.set(clark(p.ns, p.name), p);
            }
        }
        for (const h of kids(response, DAV, 'href')) {
            const url = hrefUrl(h.text, base);
            if (url !== undefined) responses.push({ href: h.text.trim(), url, status, props, failed });
        }
    }
    const token = textOf(kid(top, DAV, 'sync-token'));
    return { base, responses, syncToken: token === '' ? undefined : token };
}

/** The precondition names in an error answer's DAV:error body ("valid-sync-token", ...). */
function preconditions(text) {
    const names = new Set();
    if (!/^\s*</.test(String(text ?? ''))) return names;
    const error = parseXml(text).children.find((c) => c.ns === DAV && c.name === 'error');
    for (const c of error?.children ?? []) names.add(c.name);
    return names;
}

// ---------------------------------------------------------------------------
// Hrefs

/** One path segment, decoded and encoded again the one way: RFC 3986's pchar as is, the rest %XX. */
function canonicalSegment(segment) {
    try {
        return encodeURIComponent(decodeURIComponent(segment))
            .replace(/%(?:24|26|2B|2C|3A|3B|3D|40)/g, (m) => String.fromCharCode(Number.parseInt(m.slice(1), 16)));
    } catch {
        // Not UTF-8 (or a stray %): kept, its escapes in capitals.
        return segment.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
    }
}

/**
 * An href as an absolute URL in one canonical spelling, so one resource
 * compares equal however a server writes it: resolved against `base`, each
 * path segment decoded and encoded again the one way ("%40" and "@" alike,
 * "%2F" kept), the default port, user info and fragment dropped.
 * undefined when it isn't an http(s) URL.
 * @param {string} href - relative or absolute, as a server sends it.
 * @param {string} [base] - the address it came from.
 */
export function hrefUrl(href, base) {
    let url;
    try {
        url = new URL(String(href ?? '').trim(), base);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.username = '';
    url.password = '';
    url.hash = '';
    url.pathname = url.pathname.split('/').map(canonicalSegment).join('/');
    return url.href;
}

/** Whether two URLs name the same collection, with or without the trailing slash. */
const sameCollection = (a, b) => a !== undefined && b !== undefined && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** A collection's URL with the trailing slash its members' names go after. */
const folderOf = (collection) => (collection.endsWith('/') ? collection : `${collection}/`);

/** The hrefs inside a property (calendar-home-set, current-user-principal), as URLs. */
const hrefsOf = (element, base) => kids(element, DAV, 'href').map((h) => hrefUrl(h.text, base)).filter((url) => url !== undefined);

/** The last path segment, decoded: a calendar's name when it has no displayname. */
function lastSegment(url) {
    const segment = new URL(url).pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

const hostOf = (url) => {
    try {
        return new URL(url).host;
    } catch {
        return '(not a URL)';
    }
};

/** Where a URL leads, for a message: its host, with its scheme when only that tells it from `from`'s. */
const placeOf = (url, from) => (hostOf(url) === hostOf(from) ? `${hostOf(url)} over ${new URL(url).protocol.slice(0, -1)}` : hostOf(url));

/** The address an account starts from: the user's, else its preset's, as an https URL. */
function startUrl(account) {
    const preset = PRESETS.find((p) => p.id === account.preset);
    let raw = String(account.url ?? '').trim() || preset?.url || '';
    if (raw === '') throw new SourceError('config', 'This account has no server address. Give the address of the CalDAV server.');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
    const url = hrefUrl(raw);
    if (url === undefined) throw new SourceError('config', 'The server address isn\'t a web address (https://…).');
    const parsed = new URL(url);
    parsed.search = '';
    if (account.preset === 'nextcloud' && !`${parsed.pathname}/`.includes('/remote.php/')) {
        // Nextcloud's DAV root, whatever page of it the user copied.
        const root = parsed.pathname.replace(/\/(?:index\.php|apps)(?:\/.*)?$/, '').replace(/\/+$/, '');
        parsed.pathname = `${root}/remote.php/dav/`;
    }
    return parsed.href;
}

// ---------------------------------------------------------------------------
// Request bodies

const NAMESPACES = `xmlns:d="${DAV}" xmlns:c="${CALDAV}" xmlns:cs="${CS}" xmlns:i="${ICAL}"`;
const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8"?>\n';
const propfind = (props) => `${XML_DECLARATION}<d:propfind ${NAMESPACES}><d:prop>${props.map((p) => `<${p}/>`).join('')}</d:prop></d:propfind>`;

const CALENDAR_PROPS = [
    'd:resourcetype', 'd:displayname', 'd:current-user-privilege-set', 'c:supported-calendar-component-set',
    'c:calendar-description', 'c:calendar-timezone', 'c:calendar-timezone-id', 'i:calendar-color', 'i:calendar-order',
];
const DISCOVER_BODY = propfind(['d:current-user-principal', 'c:calendar-home-set', ...CALENDAR_PROPS]);
const HOME_BODY = propfind(['d:current-user-principal', 'c:calendar-home-set']);
const CALENDARS_BODY = propfind(CALENDAR_PROPS);
const LIST_BODY = propfind(['d:resourcetype', 'd:getetag']);
const CTAG_BODY = propfind(['cs:getctag']);
// The default calendar is a property of the scheduling Inbox (RFC 6638 9.2); Sabre (Nextcloud) has it on the principal.
const SCHEDULING_BODY = propfind(['c:schedule-outbox-URL', 'c:calendar-user-address-set', 'c:schedule-inbox-URL', 'c:schedule-default-calendar-URL']);
const INBOX_BODY = propfind(['c:schedule-default-calendar-URL']);
const ETAG_BODY = propfind(['d:getetag']);
const QUERY_BODY = `${XML_DECLARATION}<c:calendar-query ${NAMESPACES}><d:prop><d:getetag/></d:prop>`
    + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>';

const syncBody = (token) => `${XML_DECLARATION}<d:sync-collection ${NAMESPACES}><d:sync-token>${escapeXml(token ?? '')}</d:sync-token>`
    + '<d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>';

/** A calendar-multiget for resources, each named by its path when it is on the collection's server. */
function multigetBody(collection, urls) {
    const origin = new URL(collection).origin;
    const hrefs = urls.map((url) => {
        const u = new URL(url);
        return `<d:href>${escapeXml(u.origin === origin ? u.pathname : url)}</d:href>`;
    });
    return `${XML_DECLARATION}<c:calendar-multiget ${NAMESPACES}><d:prop><d:getetag/><c:calendar-data/></d:prop>${hrefs.join('')}</c:calendar-multiget>`;
}

// ---------------------------------------------------------------------------
// Answers

/** A request's answer as a multistatus, or the SourceError it amounts to. */
function readMultistatus(res, what) {
    if (res.status !== 207 && res.status !== 200) throw statusError(res.status, what, res.headers);
    const answer = parseMultistatus(res.text, res.url);
    if (answer === undefined) throw new SourceError('server', `${what}: the server's answer isn't a CalDAV one.`, { status: res.status });
    return answer;
}

/** The response a Depth 0 answer gives about the resource asked for. */
const selfOf = (answer, url) => answer.responses.find((r) => sameCollection(r.url, url) || sameCollection(r.url, answer.base)) ?? answer.responses[0];

/** The SourceError for a failed PUT or DELETE. Only fixed precondition names reach the message. */
function writeError(res, what) {
    if (res.status === 412) return new SourceError('conflict', `${what}: it changed on the server meanwhile.`, { status: 412 });
    const names = preconditions(res.text);
    if (names.has('no-uid-conflict')) {
        return new SourceError('conflict', `${what}: the calendar already has an event with this UID.`, { status: res.status });
    }
    const refused = ['valid-calendar-data', 'valid-calendar-object-resource', 'supported-calendar-component', 'supported-calendar-data',
        'calendar-collection-location-ok', 'max-resource-size', 'min-date-time', 'max-date-time', 'max-instances', 'max-attendees-per-instance']
        .find((name) => names.has(name));
    if (refused !== undefined && res.status !== 401) {
        return new SourceError('server', `${what}: the server refused the event (${refused}).`, { status: res.status });
    }
    return statusError(res.status, what, res.headers);
}

/** An http.js failure as a SourceError. */
function requestError(error) {
    if (error instanceof SourceError) return error;
    if (error instanceof HttpError || error?.name === 'HttpError') {
        if (error.code === 'insecure') return new SourceError('config', error.message);
        if (error.code === 'too-large' || error.code === 'redirects') return new SourceError('server', error.message);
        return new SourceError('network', error.message);
    }
    return error;
}

/** iCalendar text as the plugin keeps it: trimmed, with CRLF line ends. */
const icsText = (text) => `${String(text).trim().replace(/\r\n|\r|\n/g, '\r\n')}\r\n`;

/** Whether iCalendar text holds an event (not only tasks or journal entries). */
const hasEvent = (raw) => /^BEGIN:VEVENT\r?$/im.test(raw);

/** A color as #RRGGBB: Apple's calendar-color is #RRGGBBAA. */
function colorOf(text) {
    const m = /^#?(?:([0-9a-f]{6})(?:[0-9a-f]{2})?|([0-9a-f]{3}))$/i.exec(text);
    if (m === null) return undefined;
    const hex = m[1] ?? [...m[2]].map((c) => c + c).join('');
    return `#${hex.toUpperCase()}`;
}

/** Read-only unless the user may write, write content or add members. */
function readOnlyOf(set) {
    if (set === undefined) return false;
    const granted = new Set();
    for (const privilege of kids(set, DAV, 'privilege')) {
        for (const p of privilege.children) if (p.ns === DAV) granted.add(p.name);
    }
    return !['all', 'write', 'write-content', 'bind'].some((name) => granted.has(name));
}

/** The calendar's zone: calendar-timezone-id (RFC 7809), else the TZID in calendar-timezone, as an IANA id. */
function zoneOf(props) {
    const vtimezone = (props.get(TIMEZONE)?.text ?? '').replace(/\r?\n[ \t]/g, '');
    const tzid = textOf(props.get(TIMEZONE_ID)) || /^TZID(?:;[^:\n]*)?:(.+)$/m.exec(vtimezone)?.[1]?.trim();
    return tzid ? ianaZone(tzid) : undefined;
}

/** Apple's calendar-order of each calendar calendarInfo made, only to sort by. */
const ORDERS = new WeakMap();

/** A listed collection as a calendar, or undefined when it isn't one that holds events. */
function calendarInfo(response) {
    const props = response.props;
    if (kid(props.get(RESOURCETYPE), CALDAV, 'calendar') === undefined) return undefined;
    const components = kids(props.get(COMPONENTS), CALDAV, 'comp').map((c) => String(c.attrs.name ?? '').toUpperCase());
    if (components.length > 0 && !components.includes('VEVENT')) return undefined;
    const calendar = { remoteId: response.url, name: textOf(props.get(DISPLAYNAME)) || lastSegment(response.url) };
    const color = colorOf(textOf(props.get(COLOR)));
    if (color !== undefined) calendar.color = color;
    calendar.readOnly = readOnlyOf(props.get(PRIVILEGES));
    const description = textOf(props.get(DESCRIPTION));
    if (description !== '') calendar.description = description;
    const zone = zoneOf(props);
    if (zone !== undefined) calendar.timeZone = zone;
    const order = Number.parseFloat(textOf(props.get(ORDER)));
    if (Number.isFinite(order)) ORDERS.set(calendar, order);
    return calendar;
}

/** A safe resource name for a new event: its UID when that is plain, else a readable part and a hash. */
function resourceName(uid) {
    const text = String(uid ?? '');
    if (text === '') return randomUUID();
    if (/^[A-Za-z0-9_-][A-Za-z0-9._@-]{0,99}$/.test(text)) return text;
    const readable = text.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24);
    return readable === '' ? hash : `${readable}-${hash}`;
}

/** The UIDs of the components (events, tasks) in iCalendar text, as ical.js reads them. */
function uidsOf(raw) {
    return parseIcs(raw).flatMap((root) => root.subs)
        .map((c) => c.props.find((p) => p.name === 'UID'))
        .filter((prop) => prop !== undefined)
        .map((prop) => unescapeText(prop.value).trim())
        .filter((uid) => uid !== '');
}

/**
 * What an event shows, to tell whether a server's copy changed since the
 * plugin read it: for the series and each occurrence changed on its own,
 * its organizer, title, times (all day or not), place, notes, link,
 * status, rule, and skipped and extra dates. Not who is on it (newPeople
 * looks at that) nor their answers, nor what a server stamps itself
 * (DTSTAMP, LAST-MODIFIED, CREATED, SEQUENCE). Two copies that show the
 * same give the same text.
 */
function shownOf(records, zone) {
    const time = (t) => (t === undefined ? '' : 'date' in t ? t.date : String(instantOf(t, zone)));
    const times = (list) => [...new Set((list ?? []).map(time))].sort();
    const rule = (text) => {
        try {
            return ruleText(parseRule(text));
        } catch {
            return text;
        }
    };
    return records.map((r) => JSON.stringify([
        `${r.uid} ${r.recurrenceId ? time(r.recurrenceId) : ''}${r.thisAndFuture ? ' and following' : ''}`,
        addressKey(r.organizer?.address ?? r.organizer?.email), r.title ?? '', time(r.start), time(r.end), r.allDay === true,
        r.location ?? '', r.description ?? '', r.url ?? '',
        // An event that gives no status is a confirmed one.
        r.status ?? 'confirmed', r.rrule === undefined ? '' : rule(r.rrule), times(r.exdates), times(r.rdates),
    ])).sort().join('\n');
}

/** Runs `work` on each entry, at most `limit` at a time; stops starting new ones after a failure. */
async function eachLimited(list, limit, work) {
    let next = 0;
    let failed = false;
    const worker = async () => {
        while (!failed && next < list.length) {
            const entry = list[next++];
            try {
                await work(entry);
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

// ---------------------------------------------------------------------------
// Sync state: {v, etags: {name: etag}, other?, token?, ctag?, noSync?}. Names
// are hrefs relative to the collection (absolute when elsewhere); `etags`
// holds the resources handed over as items, `other` those without events
// (tasks, journal entries), so neither is fetched again while unchanged.

const stateKey = (folder, url) => (url.startsWith(folder) ? url.slice(folder.length) : url);
const keyUrl = (folder, key) => (/^https?:\/\//i.test(key) ? key : folder + key);

function readState(state, folder) {
    if (state === null || typeof state !== 'object' || state.v !== STATE_VERSION) return undefined;
    const map = (value) => {
        const out = new Map();
        if (value !== null && typeof value === 'object') {
            for (const [key, etag] of Object.entries(value)) if (typeof etag === 'string') out.set(keyUrl(folder, key), etag);
        }
        return out;
    };
    return {
        token: typeof state.token === 'string' && state.token !== '' ? state.token : undefined,
        ctag: typeof state.ctag === 'string' && state.ctag !== '' ? state.ctag : undefined,
        noSync: Number.isFinite(state.noSync) ? state.noSync : undefined,
        etags: map(state.etags),
        other: map(state.other),
    };
}

function writeState({ token, ctag, noSync, known, other }, folder) {
    const map = (entries) => Object.fromEntries([...entries].map(([url, etag]) => [stateKey(folder, url), etag]));
    const state = { v: STATE_VERSION, etags: map(known) };
    if (other.size > 0) state.other = map(other);
    if (token !== undefined) state.token = token;
    if (ctag !== undefined) state.ctag = ctag;
    if (noSync !== undefined) state.noSync = noSync;
    return state;
}

// ---------------------------------------------------------------------------
// The source

class CalDavSource {
    constructor(account, env) {
        this.account = account ?? {};
        this.env = env ?? {};
        this.kind = kind;
        this.style = style;
        /** {homes, principal, given, scheduling?, addresses, defaultCalendar?} once discovered: kept for this object's life only. */
        this.located = undefined;
        this.base = undefined;
        this.password = undefined;
    }

    /** The account's start address (its host is the only one the password goes to, iCloud's aside: sameService). */
    start() {
        this.base ??= startUrl(this.account);
        return this.base;
    }

    /**
     * Why `url` gets no request with the password, or undefined when it is
     * the account's own server: an address on this computer or its network
     * that a server elsewhere pointed to, or another host (sameService).
     */
    refusal(url) {
        const start = this.start();
        if (!isLocal(start) && isLocal(url)) return `${hostOf(start)} pointed to an address on this computer or its network, which isn't allowed.`;
        if (!sameService(start, url)) {
            return `The server pointed to ${placeOf(url, start)}, which isn't the server this account names. The plugin doesn't send the password there; if it is your CalDAV server, give its address instead.`;
        }
        return undefined;
    }

    async secret() {
        if (this.password === undefined) {
            const stored = await this.env.secret?.get?.();
            const password = typeof stored === 'string' ? stored : stored?.password;
            if (typeof password !== 'string' || password === '') {
                throw new SourceError('auth', 'There is no password saved for this account. Sign in again.');
            }
            this.password = password;
        }
        return this.password;
    }

    /**
     * One signed-in request. Only to the account's own server (refusal): an
     * address a server hands over that leads elsewhere gets no request,
     * http.js keeps the Authorization header on redirects to the same host
     * (sameService) only, and an answer a redirect brought from another
     * host is refused rather than read.
     */
    async send(method, url, { depth, body, headers = {}, signal } = {}) {
        const refused = this.refusal(url);
        if (refused !== undefined) throw new SourceError('config', refused);
        const password = await this.secret();
        const sent = { Authorization: basicAuth(this.account.username ?? '', password), ...headers };
        if (depth !== undefined) sent.Depth = String(depth);
        if (body !== undefined && sent['Content-Type'] === undefined) sent['Content-Type'] = 'application/xml; charset=utf-8';
        const init = { method, headers: sent, body, signal, keepAuth: sameService };
        if (this.account.allowHttp === true) init.allowHttp = true;
        let res;
        try {
            res = await (this.env.request ?? httpRequest)(url, init);
        } catch (error) {
            throw requestError(error);
        }
        if (!sameService(this.start(), res.url ?? url)) {
            throw new SourceError('config', `${hostOf(url)} sent the request on to ${placeOf(res.url, url)}, which isn't the server this account names. `
                + 'The plugin doesn\'t send the password there; if it is your CalDAV server, give its address instead.');
        }
        // Read the password again next time, in case it was changed.
        if (res.status === 401) this.password = undefined;
        return res;
    }

    async multistatus(method, url, options, what) {
        return readMultistatus(await this.send(method, url, options), what);
    }

    /** PROPFIND Depth 0 at one address of the discovery; a 303 (which turns it into a GET) is asked again. */
    async probe(url) {
        let res = await this.send('PROPFIND', url, { depth: 0, body: DISCOVER_BODY });
        if (res.status !== 207 && res.url !== url) res = await this.send('PROPFIND', res.url, { depth: 0, body: DISCOVER_BODY });
        const answer = readMultistatus(res, `Looking for calendars at ${safeUrl(res.url)}`);
        return { answer, self: selfOf(answer, res.url) };
    }

    /** The calendar homes a principal names. */
    async homesOf(principal) {
        const answer = await this.multistatus('PROPFIND', principal, { depth: 0, body: HOME_BODY }, 'Reading the account');
        return hrefsOf(selfOf(answer, principal)?.props.get(HOME_SET), answer.base);
    }

    /** The calendars that hold events in one home (Depth 1). */
    async listHome(home) {
        const answer = await this.multistatus('PROPFIND', home, { depth: 1, body: CALENDARS_BODY }, 'Listing calendars');
        return answer.responses.filter((r) => r.status === undefined || r.status === 200).map(calendarInfo).filter((c) => c !== undefined);
    }

    /**
     * Finds the principal, the calendar homes and the calendars from the
     * account's address (RFC 6764): the address itself, its host's
     * /.well-known/caldav, then its host's root. The first that names a
     * principal with a calendar home wins; an address that is a calendar
     * counts too, with its home's calendars when the server names one. An
     * address the plugin can't use (it sends the request on to another
     * host, or is plain http) is passed over, and said when none works.
     * @returns {Promise<{home?: string, principal?: string, calendars: object[]}>}
     */
    async discover() {
        const start = this.start();
        const wellKnown = new URL('/.well-known/caldav', start).href;
        const tries = [...new Set([start, wellKnown, new URL('/', start).href])];
        let principal;
        let homes = [];
        let given;
        let answered;
        /** Why an address was passed over: url → SourceError ('config'). */
        const refused = new Map();
        for (const url of tries) {
            let found;
            try {
                found = await this.probe(url);
            } catch (error) {
                if (!(error instanceof SourceError) || ['auth', 'network', 'rate'].includes(error.code)) throw error;
                if (error.code === 'config') refused.set(url, error);
                else if (url === start) answered = error.status;
                continue;
            }
            const self = found.self;
            if (self === undefined) continue;
            if (url === start) given = calendarInfo(self);
            const current = self.props.get(PRINCIPAL);
            if (kid(current, DAV, 'unauthenticated') !== undefined) {
                throw new SourceError('auth', 'The server didn\'t accept the user name and password.');
            }
            const named = hrefsOf(current, found.answer.base)[0];
            homes = hrefsOf(self.props.get(HOME_SET), found.answer.base);
            if (homes.length > 0) {
                principal = named ?? self.url;
                break;
            }
            if (named !== undefined) {
                principal = named;
                try {
                    homes = await this.homesOf(named);
                } catch (error) {
                    if (!(error instanceof SourceError) || ['auth', 'network', 'config', 'rate'].includes(error.code)) throw error;
                }
                if (homes.length > 0) break;
            }
            if (given !== undefined) break;
        }
        if (homes.length === 0 && given === undefined && !refused.has(start)) {
            // A server that names no principal: the address may be a calendar home itself.
            const listed = await this.listHome(start).catch(() => []);
            if (listed.length > 0) homes = [start];
        }
        if (homes.length === 0 && given === undefined) {
            // Where /.well-known/caldav or the address itself led elsewhere, that says the most.
            const why = refused.get(wellKnown) ?? refused.get(start);
            if (why !== undefined) throw why;
            const said = answered === undefined ? '' : ` (it answered HTTP ${answered})`;
            throw new SourceError('config', `No CalDAV calendars were found at ${safeUrl(start)}${said}. Check the address, or give the address of a calendar.`);
        }
        this.located = { homes, principal, given, ...await this.schedulingOf(principal) };
        const calendars = await this.listAll();
        this.env.log?.(`caldav ${this.account.id}: found homes=${homes.length} calendars=${calendars.length}`);
        return { home: homes[0], principal, calendars };
    }

    /**
     * Whether the server schedules (RFC 6638: it emails a meeting's guests
     * itself when its organizer saves or deletes it, and tells the
     * organizer when a guest answers or takes it out), the user's own
     * addresses there (every one: emails, and the urn:uuid or principal
     * URL a server may name its own user by, as userAddress() keeps them),
     * and the user's default calendar, where new events go:
     * {scheduling?: boolean, addresses: string[], defaultCalendar?: string}.
     * scheduling is undefined when the server didn't say, defaultCalendar
     * when it names none.
     */
    async schedulingOf(principal) {
        if (principal === undefined) return { addresses: [] };
        let self;
        let base;
        try {
            const answer = await this.multistatus('PROPFIND', principal, { depth: 0, body: SCHEDULING_BODY }, 'Reading the account');
            self = selfOf(answer, principal);
            base = answer.base;
        } catch (error) {
            if (error instanceof SourceError && error.code === 'auth') throw error;
            return { addresses: [] };
        }
        if (self === undefined) return { addresses: [] };
        const addresses = kids(self.props.get(ADDRESSES), DAV, 'href').map((h) => userAddress(h.text, base)).filter((a) => a !== undefined);
        // An outbox means the server schedules; one it says isn't there (404) means it doesn't.
        const outbox = kids(self.props.get(OUTBOX), DAV, 'href').length > 0;
        const scheduling = outbox ? true : self.failed.includes(404) ? false : undefined;
        const defaultCalendar = self.props.has(DEFAULT_CALENDAR)
            ? hrefsOf(self.props.get(DEFAULT_CALENDAR), base)[0]
            : await this.defaultOf(hrefsOf(self.props.get(INBOX), base)[0]);
        return {
            ...(scheduling !== undefined ? { scheduling } : {}), addresses: [...new Set(addresses)],
            ...(defaultCalendar !== undefined ? { defaultCalendar } : {}),
        };
    }

    /**
     * The default calendar a scheduling Inbox names (RFC 6638 9.2), or
     * undefined: no inbox, no default (an empty property), or no answer.
     */
    async defaultOf(inbox) {
        if (inbox === undefined) return undefined;
        try {
            const answer = await this.multistatus('PROPFIND', inbox, { depth: 0, body: INBOX_BODY }, 'Reading the account');
            return hrefsOf(selfOf(answer, inbox)?.props.get(DEFAULT_CALENDAR), answer.base)[0];
        } catch (error) {
            if (error instanceof SourceError && error.code === 'auth') throw error;
            return undefined;
        }
    }

    /** The calendars in every home found, and the one the address named (with whether the server schedules, and the default marked primary). */
    async listAll() {
        const { homes, given, scheduling, addresses = [], defaultCalendar } = this.located;
        const found = [];
        for (const home of homes) {
            try {
                found.push(...await this.listHome(home));
            } catch (error) {
                // A calendar the user named still works when its home can't be listed.
                if (given === undefined || !(error instanceof SourceError) || ['auth', 'network', 'rate'].includes(error.code)) throw error;
            }
        }
        if (given !== undefined && !found.some((c) => sameCollection(c.remoteId, given.remoteId))) {
            let fresh;
            try {
                const { self } = await this.probe(given.remoteId);
                if (self !== undefined) fresh = calendarInfo(self);
            } catch {}
            found.unshift(fresh ?? given);
        }
        const seen = new Set();
        const calendars = found.filter((c) => {
            const key = c.remoteId.replace(/\/+$/, '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        // Apple's calendar-order where servers keep one, the rest after them; the server's own order otherwise.
        const orderOf = (c) => ORDERS.get(c) ?? Infinity;
        const about = { ...(scheduling !== undefined ? { scheduling } : {}), ...(addresses.length > 0 ? { addresses } : {}) };
        return calendars.map((c, at) => ({ c, at })).sort((a, b) => (orderOf(a.c) - orderOf(b.c)) || (a.at - b.at))
            .map(({ c }) => ({ ...c, ...(sameCollection(c.remoteId, defaultCalendar) ? { primary: true } : {}), ...about }));
    }

    /** The account's calendars that hold events (see sources/index.js). */
    async calendars() {
        if (this.located === undefined) return (await this.discover()).calendars;
        return this.listAll();
    }

    /**
     * What changed in a calendar since `state` (see sources/index.js). Items
     * are {remoteId, etag, raw, events: []}: the manager reads `raw`.
     */
    async sync(calendar, state, opts = {}) {
        const collection = collectionOf(calendar);
        const folder = folderOf(collection);
        const prev = readState(state, folder);
        const signal = opts.signal;
        const now = typeof this.env.now === 'function' ? this.env.now() : Date.now();
        let noSync = prev?.noSync !== undefined && now - prev.noSync < NO_SYNC_DAYS * 86_400_000 ? prev.noSync : undefined;
        let listing;
        let keepToken;
        if (noSync === undefined) {
            const changes = await this.changes(collection, prev?.token, signal);
            if (changes.unsupported) noSync = now;
            else if (changes.listing !== undefined) listing = changes.listing;
            // The REPORT failed this once: the old token still works after the listing (what it
            // reports again compares equal by etag).
            else keepToken = prev?.token;
        }
        listing ??= await this.listEtags(collection, prev, signal);

        const reset = prev === undefined;
        const known = new Map(reset ? [] : prev.etags);
        const other = new Map(reset ? [] : prev.other);
        const removed = new Set();
        const forget = (url) => {
            if (known.has(url)) removed.add(url);
            known.delete(url);
            other.delete(url);
        };
        const want = [];
        for (const [url, etag] of listing.members) {
            if (etag === undefined || etag !== (known.get(url) ?? other.get(url))) want.push(url);
        }
        for (const url of listing.gone) forget(url);
        if (listing.full) {
            for (const url of [...known.keys(), ...other.keys()]) if (!listing.members.has(url)) forget(url);
        }

        const fetched = await this.fetchAll(collection, want, signal);
        const items = [];
        for (const url of want) {
            const got = fetched.get(url);
            if (got === null) {
                forget(url);
                continue;
            }
            const etag = got?.etag ?? listing.members.get(url);
            if (got?.raw === undefined || !hasEvent(got.raw)) {
                // Nothing to show (tasks, a refused or empty resource): remembered so it isn't fetched again while unchanged.
                if (known.has(url)) removed.add(url);
                known.delete(url);
                other.set(url, etag ?? '');
                continue;
            }
            known.set(url, etag ?? '');
            other.delete(url);
            items.push({ remoteId: url, etag, raw: got.raw, events: [] });
        }
        this.env.log?.(`caldav ${this.account.id}: sync ${listing.how}${reset ? ' reset' : ''} fetched=${want.length} items=${items.length} removed=${removed.size}`);
        return {
            reset,
            items,
            removed: [...removed],
            state: writeState({ token: listing.token ?? keepToken, ctag: listing.ctag, noSync, known, other }, folder),
        };
    }

    /**
     * The sync-collection REPORT from `token` (none: everything), following
     * truncated (507) answers. → {listing: {full, members: Map(url → etag),
     * gone: Set(url), token, how}}, {unsupported: true} for a server without
     * it, or {} to list this time.
     */
    async changes(collection, token, signal) {
        const members = new Map();
        const gone = new Set();
        let current = token;
        let full = token === undefined;
        let restarted = false;
        for (let round = 0; round < MAX_ROUNDS; round++) {
            const res = await this.send('REPORT', collection, { depth: 0, body: syncBody(current), signal });
            if (res.status === 207) {
                const answer = parseMultistatus(res.text, res.url);
                // An answer without a token means the server doesn't keep any.
                if (answer === undefined || answer.syncToken === undefined) return { unsupported: true };
                let truncated = false;
                for (const r of answer.responses) {
                    if (sameCollection(r.url, collection) || sameCollection(r.url, res.url)) {
                        if (r.status === 507) truncated = true;
                        continue;
                    }
                    if (r.url.endsWith('/')) continue;
                    if (r.status === 404 || r.status === 410) {
                        members.delete(r.url);
                        gone.add(r.url);
                    } else if (r.status === undefined || r.status === 200) {
                        members.set(r.url, textOf(r.props.get(GETETAG)) || undefined);
                        gone.delete(r.url);
                    }
                }
                current = answer.syncToken;
                if (!truncated) return { listing: { full, members, gone, token: current, how: full ? 'token-all' : 'token' } };
                continue;
            }
            if (res.status === 401 || res.status === 429 || res.status === 503) throw statusError(res.status, 'Syncing the calendar', res.headers);
            if (current !== undefined && !restarted && res.status >= 400 && res.status < 500) {
                // The server no longer takes the token (valid-sync-token): everything again, with a new one.
                restarted = true;
                current = undefined;
                full = true;
                members.clear();
                gone.clear();
                continue;
            }
            if (current === undefined && ((res.status >= 400 && res.status < 500) || res.status === 501)) return { unsupported: true };
            return {};
        }
        return {};
    }

    /**
     * Every resource's etag, by PROPFIND Depth 1 (or calendar-query where
     * that fails), unless the ctag says nothing changed since `prev`.
     */
    async listEtags(collection, prev, signal) {
        let ctag;
        try {
            const answer = await this.multistatus('PROPFIND', collection, { depth: 0, body: CTAG_BODY, signal }, 'Reading the calendar');
            ctag = textOf(selfOf(answer, collection)?.props.get(CTAG)) || undefined;
        } catch (error) {
            if (!(error instanceof SourceError) || ['auth', 'network', 'rate', 'not-found', 'config'].includes(error.code)) throw error;
        }
        if (prev !== undefined && ctag !== undefined && ctag === prev.ctag) {
            return { full: false, members: new Map(), gone: new Set(), token: undefined, ctag, how: 'unchanged' };
        }
        let res = await this.send('PROPFIND', collection, { depth: 1, body: LIST_BODY, signal });
        if (res.status !== 207 && ![401, 404, 410, 429, 503].includes(res.status)) {
            res = await this.send('REPORT', collection, { depth: 1, body: QUERY_BODY, signal });
        }
        const answer = readMultistatus(res, 'Listing the calendar');
        const members = new Map();
        for (const r of answer.responses) {
            if (sameCollection(r.url, collection) || sameCollection(r.url, res.url) || r.url.endsWith('/')) continue;
            if (r.status !== undefined && r.status !== 200) continue;
            if (kid(r.props.get(RESOURCETYPE), DAV, 'collection') !== undefined) continue;
            members.set(r.url, textOf(r.props.get(GETETAG)) || undefined);
        }
        return { full: true, members, gone: new Set(), token: undefined, ctag, how: 'list' };
    }

    /**
     * Fetches resources: calendar-multiget in batches, GET for what a batch
     * leaves out (or for all, once multiget fails). → Map(url → {etag, raw}
     * | null when it is gone); raw undefined when it isn't calendar data.
     */
    async fetchAll(collection, urls, signal) {
        const got = new Map();
        let multiget = true;
        for (let at = 0; at < urls.length; at += BATCH) {
            const batch = urls.slice(at, at + BATCH);
            if (multiget) multiget = await this.multiget(collection, batch, got, signal);
            const rest = batch.filter((url) => !got.has(url));
            await eachLimited(rest, PARALLEL, async (url) => got.set(url, await this.getOne(url, signal)));
        }
        return got;
    }

    /** One calendar-multiget into `got`. False when the server doesn't do them. */
    async multiget(collection, urls, got, signal) {
        const res = await this.send('REPORT', collection, { depth: 1, body: multigetBody(collection, urls), signal });
        if (res.status === 401 || res.status === 429 || res.status === 503) throw statusError(res.status, 'Fetching events', res.headers);
        if (res.status !== 207) return false;
        const answer = parseMultistatus(res.text, res.url);
        if (answer === undefined) return false;
        const wanted = new Set(urls);
        let answered = 0;
        for (const r of answer.responses) {
            if (!wanted.has(r.url)) continue;
            if (r.status === 404 || r.status === 410) {
                got.set(r.url, null);
                answered++;
                continue;
            }
            const text = r.props.get(CALENDAR_DATA)?.text ?? '';
            // Without calendar data it is left to a GET.
            if (text.trim() === '') continue;
            answered++;
            got.set(r.url, { etag: textOf(r.props.get(GETETAG)) || undefined, raw: icsText(text) });
        }
        // A server that answers multiget with nothing usable: GET from now on.
        return answered > 0;
    }

    /** One resource by GET: {etag, raw}, null when it is gone. */
    async getOne(url, signal) {
        const res = await this.send('GET', url, { headers: { Accept: 'text/calendar' }, signal });
        if (res.status === 404 || res.status === 410) return null;
        if (res.ok) {
            const raw = /BEGIN:VCALENDAR/i.test(res.text) ? icsText(res.text) : undefined;
            return { etag: res.headers.get('etag') ?? undefined, raw };
        }
        if (res.status === 401 || res.status === 429 || res.status >= 500) throw statusError(res.status, 'Fetching an event', res.headers);
        // Refused (403 and the like): skipped until it changes.
        return { etag: undefined, raw: undefined };
    }

    /**
     * Stores iCalendar text: a new resource named after the UID (it must not
     * exist yet), or a change to `item` (only while its etag is item.etag).
     * A new one whose name is taken already by a resource holding the same
     * UID counts as made (madeBefore).
     * @returns {Promise<{remoteId: string, etag?: string}>}
     */
    async put(calendar, item, raw, uid) {
        const collection = collectionOf(calendar);
        const target = item ? hrefUrl(item.remoteId ?? '') : hrefUrl(`${folderOf(collection)}${resourceName(uid)}.ics`);
        if (target === undefined) throw new SourceError('config', 'This event has no address on the server.');
        const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
        if (item) {
            // A change only while the event is as it was read: without a stored etag, the server's own first.
            let etag;
            try {
                etag = await this.versionOf(item, target);
            } catch (error) {
                // Taken out meanwhile: a change to it is a conflict, which syncs.
                if (error instanceof SourceError && error.code === 'not-found') throw new SourceError('conflict', 'Saving the event: it was deleted on the server meanwhile.', { status: 404 });
                throw error;
            }
            headers['If-Match'] = etag ?? '*';
        } else {
            headers['If-None-Match'] = '*';
        }
        const res = await this.send('PUT', target, { headers, body: raw });
        if (!res.ok) {
            const made = !item && res.status === 412 ? await this.madeBefore(target, String(uid ?? '').trim()) : undefined;
            if (made !== undefined) return made;
            throw writeError(res, 'Saving the event');
        }
        const location = res.headers.get('location');
        let remoteId = hrefUrl(res.url) ?? target;
        if (location) {
            const moved = hrefUrl(location, res.url);
            if (moved !== undefined && !moved.endsWith('/') && this.refusal(moved) === undefined) remoteId = moved;
        }
        let etag = res.headers.get('etag') ?? undefined;
        // A server that changed what it stored sends no etag: ask for it.
        if (etag === undefined) etag = await this.etagOf(remoteId).catch(() => undefined);
        return { remoteId, etag };
    }

    /**
     * The resource a new event's name is taken by (a 412 to If-None-Match: *),
     * as put() returns it when it holds `uid`: the manager repeats a create
     * that timed out with the same uid, and the first try may have been
     * stored. undefined when it holds another event or can't be read (the
     * create stays a conflict).
     */
    async madeBefore(target, uid) {
        if (uid === '') return undefined;
        let res;
        try {
            res = await this.send('GET', target, { headers: { Accept: 'text/calendar' } });
        } catch {
            return undefined;
        }
        if (!res.ok || !uidsOf(res.text).includes(uid)) return undefined;
        const remoteId = hrefUrl(res.url) ?? target;
        const etag = res.headers.get('etag') ?? await this.etagOf(remoteId).catch(() => undefined);
        this.env.log?.(`caldav ${this.account.id}: put found the new event there already`);
        return { remoteId, etag };
    }

    async etagOf(url) {
        const answer = await this.multistatus('PROPFIND', url, { depth: 0, body: ETAG_BODY }, 'Reading the event');
        return textOf(selfOf(answer, url)?.props.get(GETETAG)) || undefined;
    }

    /**
     * The etag a change to `item` (at `target`) goes under: the one stored,
     * else the server's own, read now with the event; null when the server
     * keeps none for it. Read now, the event must name the same people as
     * the plugin's copy (item.raw), since the server emails them; for a
     * change (not `deleting`) it must also show what the copy shows
     * (shownOf), since the change goes in whole and would undo what was
     * changed there since. Otherwise 'conflict': with no tag, no 412 would
     * say so. A read that fails stops the change, since a write without one
     * would go over whatever is there; 'not-found' when it is gone.
     */
    async versionOf(item, target, { deleting = false } = {}) {
        if (item.etag) return item.etag;
        const unread = (error) => {
            if (error instanceof SourceError && ['auth', 'not-found', 'rate'].includes(error.code)) return error;
            const code = error instanceof SourceError && error.code === 'network' ? 'network' : 'server';
            return new SourceError(code, 'The event\'s version on the server couldn\'t be read, so nothing was changed. Try again.');
        };
        let now;
        try {
            now = await this.getOne(target);
        } catch (error) {
            throw unread(error);
        }
        if (now === null) throw new SourceError('not-found', 'The event isn\'t on the server any more.');
        if (now.raw === undefined) throw unread(undefined);
        const zone = this.env.zone;
        const mine = readIcs(item.raw ?? '', { zone }).events;
        const theirs = readIcs(now.raw, { zone }).events;
        if (newPeople(mine, theirs).length > 0 || newPeople(theirs, mine).length > 0) {
            this.env.log?.(`caldav ${this.account.id}: the event names other people since the change was worked out`);
            throw peopleConflict(deleting ? 'Deleting the event' : 'Saving the event');
        }
        // A change goes in whole, as the plugin's copy with it made: anything else changed there since would be undone.
        if (!deleting && shownOf(mine, zone) !== shownOf(theirs, zone)) {
            this.env.log?.(`caldav ${this.account.id}: the event changed on the server since the plugin read it`);
            throw new SourceError('conflict', 'Saving the event: it changed on the server since the plugin read it, so nothing was changed.');
        }
        if (now.etag !== undefined) return now.etag;
        try {
            return (await this.etagOf(target)) ?? null;
        } catch (error) {
            throw unread(error);
        }
    }

    /**
     * Deletes a resource, only while its etag is item.etag (without one, the
     * server's own, read first with the event, which must name the same
     * people; a server that keeps none for it, without a condition). Gone
     * already counts as done.
     * opts.scheduleReply false: the server doesn't tell the organizer
     * (RFC 6638's Schedule-Reply), so taking out someone else's invitation
     * doesn't decline it.
     */
    async remove(calendar, item, { scheduleReply } = {}) {
        const target = hrefUrl(item?.remoteId ?? '');
        if (target === undefined) throw new SourceError('config', 'This event has no address on the server.');
        let etag;
        try {
            etag = await this.versionOf(item, target, { deleting: true });
        } catch (error) {
            if (error instanceof SourceError && error.code === 'not-found') return;
            throw error;
        }
        const headers = { ...(etag ? { 'If-Match': etag } : {}), ...(scheduleReply === false ? { 'Schedule-Reply': 'F' } : {}) };
        const res = await this.send('DELETE', target, { headers });
        if (res.ok || res.status === 404 || res.status === 410) return;
        throw writeError(res, 'Deleting the event');
    }
}

/**
 * One of the user's calendar user addresses, as the account keeps it: a
 * mailto address as the email alone, a urn as it is, and a principal's
 * path or URL as a full URL. undefined for anything else.
 */
export function userAddress(text, base) {
    const value = String(text ?? '').trim();
    if (value === '') return undefined;
    const mail = /^mailto:(.+)$/i.exec(value);
    if (mail) {
        let email = mail[1];
        try {
            email = decodeURIComponent(email);
        } catch {}
        email = email.trim();
        return isEmailAddress(email) ? email : undefined;
    }
    if (/^urn:[a-z0-9][a-z0-9-]*:\S+$/i.test(value)) return value;
    try {
        const url = new URL(value, base);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
    } catch {
        return undefined;
    }
}

/** The calendar's collection URL (calendar.remoteId) in canonical spelling. */
function collectionOf(calendar) {
    const url = hrefUrl(calendar?.remoteId ?? '');
    if (url === undefined) throw new SourceError('config', 'This calendar has no address on the server.');
    return url;
}

/**
 * A source for one CalDAV account: calendars(), sync(), put() and remove()
 * as sources/index.js describes, and discover(). Nothing is kept between
 * objects; one object keeps what discovery found.
 * @param {{id: string, kind: 'caldav', name?: string, url?: string, username?: string, preset?: string, allowHttp?: boolean}} account
 * @param {object} env - see sources/index.js.
 */
export function create(account, env) {
    return new CalDavSource(account, env);
}

/**
 * Finds an account's calendars from the address it gives, for the account
 * dialog's check: {home, principal, calendars}, the calendars as
 * calendars() lists them. Throws a SourceError: 'auth' when the sign-in is
 * refused, 'config' when the address leads to no calendars, 'network' when
 * it can't be reached.
 */
export async function discover(account, env) {
    return new CalDavSource(account, env).discover();
}
