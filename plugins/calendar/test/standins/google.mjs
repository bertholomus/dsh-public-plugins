/**
 * A small in-memory Google Calendar API v3 and Google OAuth 2.0 stand-in for
 * tests: one node:http server on 127.0.0.1 that answers as Google's
 * documentation says.
 *
 * OAuth: the authorization endpoint (the user always consents, unless
 * `store.consent` is 'deny'), a redirect to the loopback redirect_uri with
 * code and state, the token endpoint (authorization_code with the PKCE
 * check, refresh_token; Google sends no new refresh token on a refresh), an
 * RS256 id_token when openid was asked for, and userinfo.
 *
 * Calendar: calendarList.list (paged; hidden and deleted entries only on
 * request), events.list (singleEvents, showDeleted, iCalUID, timeMin/
 * timeMax, updatedMin, q, orderBy, pageToken, syncToken and its 410),
 * events.get, events.insert, events.patch (If-Match, 412), events.delete
 * (204; a deleted occurrence becomes a cancelled exception) and
 * events.instances. Times go out in the calendar's zone, with the event's
 * own zone in timeZone. Errors have Google's shape:
 * {error: {errors: [{domain, reason, message}], code, message}}.
 *
 * Recurrence expansion covers what the tests use: FREQ DAILY, WEEKLY,
 * MONTHLY, YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH,
 * WKST, plus RDATE and EXDATE lines. Other rule parts are refused with 400.
 *
 * `store` holds everything and changes things behind the client's back
 * (seeding, edits by "someone else", dropped tokens, queued failures).
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { isDay, isZone, offsetAt, toInstant, toLocal } from '../../lib/zones.js';

const DAY = 86_400_000;
const CALENDAR = 'https://www.googleapis.com/auth/calendar';
const CALENDAR_READONLY = 'https://www.googleapis.com/auth/calendar.readonly';
const EMAIL = 'https://www.googleapis.com/auth/userinfo.email';
const PROFILE = 'https://www.googleapis.com/auth/userinfo.profile';
const ROLES = { freeBusyReader: 1, reader: 2, writerWithoutPrivateAccess: 3, writer: 4, owner: 5 };
const RESPONSES = new Set(['needsAction', 'declined', 'tentative', 'accepted']);
const SEND_UPDATES = new Set(['all', 'externalOnly', 'none']);
/** Fields of an event only Google sets. */
const READ_ONLY = new Set(['kind', 'etag', 'id', 'htmlLink', 'created', 'updated', 'iCalUID', 'creator', 'organizer',
    'recurringEventId', 'originalStartTime', 'hangoutLink', 'sequence', 'eventType', 'privateCopy', 'locked']);
/** A change of these on a series reaches the changed occurrences that still had the old value. */
const FOLLOW_MASTER = ['summary', 'description', 'location', 'visibility', 'transparency', 'colorId', 'attendees', 'reminders'];

const B32 = '0123456789abcdefghijklmnopqrstuv';

/** An event id as Google makes them: base32hex. */
function newId(length = 26) {
    let id = '';
    for (const byte of randomBytes(length)) id += B32[byte & 31];
    return id;
}

const opaque = (prefix, bytes = 32) => `${prefix}${randomBytes(bytes).toString('base64url')}`;
const pad = (n, width = 2) => String(n).padStart(width, '0');
const clone = (value) => (value === undefined ? undefined : structuredClone(value));
/** A value as JSON with its keys sorted, to compare objects whatever their key order. */
const canonical = (value) => JSON.stringify(value ?? null, (key, v) => (v !== null && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v));
const same = (a, b) => canonical(a) === canonical(b);

/** An API error answer in Google's shape. */
class Fail extends Error {
    constructor(status, reason, message, { domain = 'global', locationType, location, headers } = {}) {
        super(message);
        const detail = { domain, reason, message };
        if (locationType) Object.assign(detail, { locationType, location });
        this.status = status;
        this.body = { error: { errors: [detail], code: status, message } };
        this.headers = headers;
    }
}

const fail = (...args) => {
    throw new Fail(...args);
};

/** An instant as RFC 3339 in a zone, as Google writes dateTime. */
function rfc3339(ms, zone) {
    const offset = offsetAt(zone, ms);
    const sign = offset < 0 ? '-' : '+';
    const abs = Math.abs(offset);
    return `${toLocal(ms, zone)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** An RFC 3339 bound with its offset (timeMin, timeMax, updatedMin). */
function bound(value, name) {
    if (value === null) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
        fail(400, 'badRequest', 'Bad Request', { locationType: 'parameter', location: name });
    }
    return Date.parse(value);
}

// Days as numbers since 1970-01-01, for rule arithmetic.
const dayNumber = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY;
const dayText = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const weekday = (n) => (((n + 4) % 7) + 7) % 7;
const dayOf = (y, m, d) => Date.UTC(y, m - 1, d) / DAY;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const RULE_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);

/** An RRULE value, checked. */
function parseRule(value) {
    const raw = {};
    for (const part of String(value).split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) fail(400, 'invalid', 'Invalid recurrence rule.');
        raw[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
    }
    for (const key of Object.keys(raw)) {
        if (!RULE_PARTS.has(key)) fail(400, 'invalid', `Invalid recurrence rule: this stand-in doesn't expand ${key}.`);
    }
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(raw.FREQ)) fail(400, 'invalid', 'Invalid recurrence rule.');
    if (raw.COUNT !== undefined && raw.UNTIL !== undefined) fail(400, 'invalid', 'Invalid recurrence rule.');
    const number = (text, low, high) => {
        const n = Number(text);
        if (!Number.isInteger(n) || n < low || n > high || n === 0) fail(400, 'invalid', 'Invalid recurrence rule.');
        return n;
    };
    const rule = { freq: raw.FREQ, interval: raw.INTERVAL ? number(raw.INTERVAL, 1, 1000) : 1 };
    if (raw.COUNT) rule.count = number(raw.COUNT, 1, 100000);
    if (raw.UNTIL) {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(raw.UNTIL);
        if (!m) fail(400, 'invalid', 'Invalid recurrence rule.');
        rule.until = m[4] === undefined
            ? { date: `${m[1]}-${m[2]}-${m[3]}` }
            : { local: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, utc: m[7] === 'Z' };
    }
    if (raw.BYDAY) {
        rule.byday = raw.BYDAY.split(',').map((d) => {
            const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d);
            if (!m) fail(400, 'invalid', 'Invalid recurrence rule.');
            return { n: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS.indexOf(m[2]) };
        });
        if (rule.byday.some((d) => d.n !== 0) && (rule.freq === 'DAILY' || rule.freq === 'WEEKLY')) fail(400, 'invalid', 'Invalid recurrence rule.');
        if (rule.freq === 'YEARLY' && !raw.BYMONTH) fail(400, 'invalid', 'Invalid recurrence rule: this stand-in expands yearly BYDAY only with BYMONTH.');
    }
    if (raw.BYMONTHDAY) rule.bymonthday = raw.BYMONTHDAY.split(',').map((d) => number(d, -31, 31));
    if (raw.BYMONTH) rule.bymonth = raw.BYMONTH.split(',').map((m) => number(m, 1, 12)).sort((a, b) => a - b);
    rule.wkst = raw.WKST ? WEEKDAYS.indexOf(raw.WKST) : 1;
    if (rule.wkst < 0) fail(400, 'invalid', 'Invalid recurrence rule.');
    return rule;
}

/** The days of one month a MONTHLY or YEARLY rule picks, in order. */
function monthDays(y, m, rule, startDate) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let days;
    if (rule.byday) {
        days = [];
        for (const { n, wd } of rule.byday) {
            const all = [];
            for (let d = 1; d <= last; d++) if (weekday(dayOf(y, m, d)) === wd) all.push(d);
            if (n === 0) days.push(...all);
            else {
                const pick = n > 0 ? all[n - 1] : all[all.length + n];
                if (pick !== undefined) days.push(pick);
            }
        }
        if (rule.bymonthday) days = days.filter((d) => rule.bymonthday.some((md) => (md > 0 ? md : last + md + 1) === d));
    } else {
        days = (rule.bymonthday ?? [startDate]).map((md) => (md > 0 ? md : last + md + 1)).filter((d) => d >= 1 && d <= last);
    }
    return [...new Set(days)].sort((a, b) => a - b).map((d) => dayOf(y, m, d));
}

/** The days a rule makes from its first day on, in order (at most a few thousand periods). */
function* ruleDays(first, rule) {
    const start = new Date(first * DAY);
    const [sy, sm, sd] = [start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()];
    const monthOk = (n) => !rule.bymonth || rule.bymonth.includes(new Date(n * DAY).getUTCMonth() + 1);
    if (rule.freq === 'DAILY') {
        for (let k = 0; k < 20000; k++) {
            const n = first + k * rule.interval;
            if (monthOk(n) && (!rule.byday || rule.byday.some((d) => d.wd === weekday(n)))) yield n;
        }
    } else if (rule.freq === 'WEEKLY') {
        const weekStart = first - ((weekday(first) - rule.wkst + 7) % 7);
        const offsets = [...new Set((rule.byday ?? [{ wd: weekday(first) }]).map((d) => (d.wd - rule.wkst + 7) % 7))].sort((a, b) => a - b);
        for (let k = 0; k < 5000; k++) {
            for (const offset of offsets) {
                const n = weekStart + 7 * rule.interval * k + offset;
                if (n >= first && monthOk(n)) yield n;
            }
        }
    } else if (rule.freq === 'MONTHLY') {
        for (let k = 0; k < 5000; k++) {
            const total = sy * 12 + (sm - 1) + k * rule.interval;
            const y = Math.floor(total / 12);
            const m = (total % 12) + 1;
            if (rule.bymonth && !rule.bymonth.includes(m)) continue;
            for (const n of monthDays(y, m, rule, sd)) if (n >= first) yield n;
        }
    } else {
        for (let k = 0; k < 1000; k++) {
            const y = sy + k * rule.interval;
            for (const m of rule.bymonth ?? [sm]) for (const n of monthDays(y, m, rule, sd)) if (n >= first) yield n;
        }
    }
}

/** The dates of an RDATE or EXDATE line: {date} or {ms}. */
function lineDates(line, zone) {
    const colon = line.indexOf(':');
    const head = line.slice(0, colon).split(';');
    const params = Object.fromEntries(head.slice(1).map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), (v ?? '').replace(/^"|"$/g, '')]));
    const tz = params.TZID ?? zone;
    if (params.TZID !== undefined && !isZone(params.TZID)) fail(400, 'invalid', 'Invalid recurrence rule.');
    return line.slice(colon + 1).split(',').map((v) => {
        const value = v.trim().split('/')[0];
        let m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
        if (m) return { date: `${m[1]}-${m[2]}-${m[3]}` };
        m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
        if (!m) fail(400, 'invalid', 'Invalid recurrence rule.');
        const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
        return { ms: m[7] ? Date.parse(`${local}Z`) : toInstant(local, tz ?? 'UTC', 'UTC') };
    });
}

/** A series' recurrence lines, checked: one RRULE at most, RDATE, EXDATE (EXRULE kept, as Google does). */
function checkRecurrence(lines, zone) {
    if (!Array.isArray(lines)) fail(400, 'invalid', 'Invalid recurrence rule.');
    let rules = 0;
    for (const line of lines) {
        if (typeof line !== 'string' || !line.includes(':')) fail(400, 'invalid', 'Invalid recurrence rule.');
        const name = line.slice(0, line.indexOf(':')).split(';')[0].toUpperCase();
        if (name === 'RRULE') {
            rules++;
            parseRule(line.slice(line.indexOf(':') + 1));
        } else if (name === 'RDATE' || name === 'EXDATE') lineDates(line, zone);
        else if (name !== 'EXRULE') fail(400, 'invalid', 'Invalid recurrence rule.');
    }
    if (rules > 1) fail(400, 'invalid', 'Invalid recurrence rule.');
}

/**
 * The original starts of a series: {date} for all-day, {ms} for timed, in
 * order, after RDATE and EXDATE. Stops after `limit`, or past `untilMs`.
 */
function occurrences(master, { limit = 1000, untilMs = Infinity } = {}) {
    const allDay = 'date' in master.start;
    const zone = allDay ? undefined : master.start.timeZone ?? 'UTC';
    const wall = allDay ? undefined : toLocal(master.start.ms, zone);
    const first = dayNumber(allDay ? master.start.date : wall.slice(0, 10));
    const clock = allDay ? '' : wall.slice(10);
    const at = (n) => (allDay ? { date: dayText(n) } : { ms: toInstant(`${dayText(n)}${clock}`, zone, zone) });
    const key = (t) => (t.date ?? t.ms);
    const msOf = (t) => (t.date !== undefined ? toInstant(`${t.date}T00:00:00`, zone ?? 'UTC', 'UTC') : t.ms);
    let rule;
    const extra = [];
    const skip = new Set();
    for (const line of master.recurrence ?? []) {
        const name = line.slice(0, line.indexOf(':')).split(';')[0].toUpperCase();
        if (name === 'RRULE') rule = parseRule(line.slice(line.indexOf(':') + 1));
        else if (name === 'RDATE') extra.push(...lineDates(line, zone));
        else if (name === 'EXDATE') for (const t of lineDates(line, zone)) skip.add(key(t));
    }
    const out = [at(first)];
    if (rule) {
        const past = (n, t) => {
            if (!rule.until) return false;
            if (rule.until.date !== undefined) return dayText(n) > rule.until.date;
            if (rule.until.utc) return msOf(t) > Date.parse(`${rule.until.local}Z`);
            return `${dayText(n)}${clock}` > rule.until.local;
        };
        for (const n of ruleDays(first, rule)) {
            if (n === first) continue;
            const t = at(n);
            if (past(n, t)) break;
            if (rule.count !== undefined && out.length >= rule.count) break;
            out.push(t);
            if (out.length >= limit + skip.size || msOf(t) > untilMs) break;
        }
    }
    const all = [...out, ...extra].filter((t) => !skip.has(key(t)));
    const unique = [...new Map(all.map((t) => [key(t), t])).values()].sort((a, b) => msOf(a) - msOf(b));
    return unique.slice(0, limit);
}

/** Google's id for an occurrence: <master>_<UTC start> or <master>_<YYYYMMDD>. */
function instanceId(masterId, original) {
    if (original.date !== undefined) return `${masterId}_${original.date.replaceAll('-', '')}`;
    return `${masterId}_${new Date(original.ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')}`;
}

/** RS256 keys for id tokens, made once per process. */
let keyPair;
const keys = () => (keyPair ??= generateKeyPairSync('rsa', { modulusLength: 2048 }));

/**
 * Starts the stand-in.
 * @param {object} [options]
 * @param {{email?: string, name?: string, sub?: string}} [options.user] - the signed-in Google user.
 * @param {string} [options.timeZone] - the primary calendar's zone (America/Los_Angeles).
 * @param {() => number} [options.now] - the server's clock (token lifetimes, updated times).
 * @returns {Promise<{base: string, apiBase: string, authorizeUrl: string, tokenUrl: string, userinfoUrl: string,
 *   clientId: string, clientSecret: string, settings: object, store: object, close: () => Promise<void>}>}
 */
export async function start(options = {}) {
    const clock = options.now ?? Date.now;
    const user = { email: 'pat@example.com', name: 'Pat Example', sub: '104729387462910374652', ...options.user };
    const clientId = `${newId(12)}-${newId(20)}.apps.googleusercontent.com`;
    const clientSecret = opaque('GOCSPX-', 21);
    let stamp = 0;
    /** An etag as Google writes them: a quoted number that grows. */
    const etag = () => `"${clock()}${pad(++stamp, 6)}"`;
    const iso = (ms = clock()) => new Date(ms).toISOString();

    const store = {
        user,
        /** OAuth clients: id → {secret}. */
        clients: new Map([[clientId, { secret: clientSecret }]]),
        /** 'allow', or 'deny' to answer the consent page with access_denied. */
        consent: 'allow',
        /** Scopes the user unticks on the consent page (Google's granular consent). */
        uncheckedScopes: new Set(),
        /** At most this many entries a page, whatever maxResults says (Google may send fewer). */
        pageLimit: Infinity,
        codes: new Map(),
        accessTokens: new Map(),
        refreshTokens: new Map(),
        /** id → {entry, events: Map, seq, generation, listSeq}. */
        calendars: new Map(),
        /** Every API request: {method, path, query, ifMatch}. */
        requests: [],
        /** Every token request: {grantType}. */
        tokenRequests: [],
        failures: [],
        listSeq: 0,
        listGeneration: 0,

        /** Adds a calendar to the user's list. */
        addCalendar(entry) {
            const id = entry.id ?? `${newId(40)}@group.calendar.google.com`;
            const calendar = {
                entry: {
                    summary: id, timeZone: 'America/Los_Angeles', accessRole: 'owner', backgroundColor: '#9fe1e7',
                    foregroundColor: '#000000', colorId: '14', selected: true, defaultReminders: [], ...entry, id,
                },
                events: new Map(), seq: 0, generation: 0, etag: etag(), listSeq: ++store.listSeq,
            };
            store.calendars.set(id, calendar);
            return calendar.entry;
        },
        /** Changes a calendar list entry (hidden, deleted, summaryOverride...). */
        changeCalendar(id, changes) {
            const calendar = calendarOf(id);
            Object.assign(calendar.entry, changes);
            calendar.entry.etag = etag();
            calendar.listSeq = ++store.listSeq;
        },
        /** An event put in by someone else: read-only fields (organizer, iCalUID, id, hangoutLink...) are taken as given. */
        insert(calendarId, event) {
            const calendar = calendarOf(calendarId);
            return render(calendar, add(calendar, event, true), calendar.entry.timeZone);
        },
        /** A change by someone else (no access or organizer checks); an occurrence id makes a changed occurrence. */
        patch(calendarId, eventId, changes) {
            const calendar = calendarOf(calendarId);
            return render(calendar, change(calendar, eventId, changes, { trusted: true }), calendar.entry.timeZone);
        },
        /** A delete by someone else. */
        remove(calendarId, eventId) {
            removeEvent(calendarOf(calendarId), eventId);
        },
        /** An event as the API would send it (cancelled ones too), or undefined. */
        get(calendarId, eventId) {
            const calendar = calendarOf(calendarId);
            const event = find(calendar, eventId);
            return event === undefined ? undefined : render(calendar, event, calendar.entry.timeZone);
        },
        /** Makes every sync token of a calendar (or of the calendar list) answer 410. */
        expireSyncTokens(calendarId) {
            if (calendarId === undefined) store.listGeneration++;
            else calendarOf(calendarId).generation++;
        },
        /** Makes every access token so far answer 401. */
        expireAccessTokens() {
            for (const token of store.accessTokens.values()) token.expiresAt = 0;
        },
        /** Revokes every refresh token (a refresh then answers invalid_grant). */
        revokeRefreshTokens() {
            for (const token of store.refreshTokens.values()) token.revoked = true;
        },
        /**
         * Answers the next matching API request(s) with an error.
         * @param {{status: number, reason: string, domain?: string, message?: string, times?: number,
         *   method?: string, path?: RegExp, retryAfter?: number}} spec
         */
        failNext(spec) {
            store.failures.push({ times: 1, domain: 'global', message: spec.reason, ...spec });
        },
    };

    store.addCalendar({
        id: user.email, summary: user.email, timeZone: options.timeZone ?? 'America/Los_Angeles', primary: true,
        notificationSettings: { notifications: [{ type: 'eventCreation', method: 'email' }] },
    });

    const server = createServer((req, res) => {
        handle(req, res).catch((error) => {
            if (error instanceof Fail) send(res, error.status, error.body, error.headers);
            else send(res, 500, new Fail(500, 'backendError', `Backend Error: ${error.message}`).body);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    async function handle(req, res) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        const url = new URL(req.url, base);
        if (url.pathname === '/o/oauth2/v2/auth' && req.method === 'GET') return authorize(url.searchParams, res);
        if (url.pathname === '/token') {
            if (req.method !== 'POST') return send(res, 405, { error: 'invalid_request', error_description: 'Method not allowed' });
            return tokenEndpoint(req, body, res);
        }
        if (url.pathname === '/v1/userinfo') return userinfo(req, res);
        if (url.pathname.startsWith('/calendar/v3/')) return api(req, url, body, res);
        throw new Fail(404, 'notFound', 'Not Found');
    }

    // ---- OAuth -------------------------------------------------------

    function authorize(q, res) {
        const client = store.clients.get(q.get('client_id'));
        if (!client) return htmlPage(res, 401, 'Error 401: invalid_client. The OAuth client was not found.');
        const redirectUri = q.get('redirect_uri') ?? '';
        // Desktop clients may use any port of a loopback address, never another host.
        if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d{1,5}(?:\/[^?#]*)?$/.test(redirectUri)) {
            return htmlPage(res, 400, 'Error 400: redirect_uri_mismatch. You can\'t sign in to this app because it doesn\'t comply with Google\'s OAuth 2.0 policy.');
        }
        const back = (params) => {
            const target = new URL(redirectUri);
            for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) target.searchParams.set(key, value);
            res.writeHead(302, { Location: target.toString(), 'Content-Length': 0 });
            res.end();
        };
        const state = q.get('state') ?? undefined;
        if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type', state });
        const requested = (q.get('scope') ?? '').split(/\s+/).filter(Boolean);
        if (requested.length === 0) return htmlPage(res, 400, 'Error 400: invalid_request. Missing required parameter: scope');
        const challenge = q.get('code_challenge') ?? undefined;
        const method = q.get('code_challenge_method') ?? (challenge ? 'plain' : undefined);
        if (method !== undefined && method !== 'S256' && method !== 'plain') return htmlPage(res, 400, 'Error 400: invalid_request. Invalid code_challenge_method');
        if (store.consent === 'deny') return back({ error: 'access_denied', state });
        const named = { email: EMAIL, profile: PROFILE };
        const granted = [...new Set(requested.map((s) => named[s] ?? s))].filter((s) => !store.uncheckedScopes.has(s));
        const code = opaque('4/0A', 48);
        store.codes.set(code, {
            clientId: q.get('client_id'), redirectUri, challenge, method, scope: granted.join(' '), expiresAt: clock() + 10 * 60_000, used: false,
        });
        back({ state, iss: 'https://accounts.google.com', code, scope: granted.join(' '), authuser: '0', prompt: 'consent' });
    }

    function tokenEndpoint(req, body, res) {
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/x-www-form-urlencoded') return send(res, 400, { error: 'invalid_request', error_description: 'Invalid Content-Type.' });
        const form = new URLSearchParams(body);
        let id = form.get('client_id');
        let secret = form.get('client_secret');
        const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '');
        if (basic) [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':').map(decodeURIComponent);
        const grantType = form.get('grant_type');
        store.tokenRequests.push({ grantType });
        const client = store.clients.get(id);
        if (!client) return send(res, 401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
        if (!secret) return send(res, 400, { error: 'invalid_request', error_description: 'client_secret is missing.' });
        if (secret !== client.secret) return send(res, 401, { error: 'invalid_client', error_description: 'Unauthorized' });
        if (grantType === 'authorization_code') {
            const saved = store.codes.get(form.get('code') ?? '');
            if (!saved || saved.clientId !== id) return send(res, 400, { error: 'invalid_grant', error_description: 'Malformed auth code.' });
            if (saved.used || saved.expiresAt <= clock()) return send(res, 400, { error: 'invalid_grant', error_description: 'Bad Request' });
            saved.used = true;
            if (form.get('redirect_uri') !== saved.redirectUri) return send(res, 400, { error: 'redirect_uri_mismatch', error_description: 'Bad Request' });
            if (saved.challenge !== undefined) {
                const verifier = form.get('code_verifier');
                if (!verifier) return send(res, 400, { error: 'invalid_grant', error_description: 'Missing code verifier.' });
                const expected = saved.method === 'S256' ? createHash('sha256').update(verifier, 'ascii').digest('base64url') : verifier;
                if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || expected !== saved.challenge) {
                    return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid code verifier.' });
                }
            }
            const refresh = opaque('1//0', 72);
            store.refreshTokens.set(refresh, { clientId: id, scope: saved.scope, revoked: false });
            return send(res, 200, issue(id, saved.scope, refresh));
        }
        if (grantType === 'refresh_token') {
            const saved = store.refreshTokens.get(form.get('refresh_token') ?? '');
            if (!saved || saved.revoked || saved.clientId !== id) return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
            return send(res, 200, issue(id, saved.scope));
        }
        return send(res, 400, { error: 'unsupported_grant_type', error_description: `Invalid grant_type: ${grantType ?? ''}` });
    }

    /** A token answer: a new access token (an hour, less a second), and an id token for openid. */
    function issue(id, scope, refreshToken) {
        const accessToken = opaque('ya29.a0', 96);
        store.accessTokens.set(accessToken, { clientId: id, scope, expiresAt: clock() + 3599_000 });
        const out = { access_token: accessToken, expires_in: 3599 };
        if (refreshToken) out.refresh_token = refreshToken;
        out.scope = scope;
        out.token_type = 'Bearer';
        if (scope.split(' ').includes('openid')) out.id_token = idToken(id, scope, accessToken);
        return out;
    }

    function idToken(audience, scope, accessToken) {
        const scopes = scope.split(' ');
        const now = Math.floor(clock() / 1000);
        const hash = createHash('sha256').update(accessToken).digest();
        const claims = { iss: 'https://accounts.google.com', azp: audience, aud: audience, sub: user.sub };
        if (scopes.includes(EMAIL)) Object.assign(claims, { email: user.email, email_verified: true });
        claims.at_hash = hash.subarray(0, 16).toString('base64url');
        if (scopes.includes(PROFILE)) claims.name = user.name;
        Object.assign(claims, { iat: now, exp: now + 3600 });
        const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'standin-1', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
        const signature = sign('sha256', Buffer.from(`${head}.${payload}`), keys().privateKey).toString('base64url');
        return `${head}.${payload}.${signature}`;
    }

    function userinfo(req, res) {
        const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
        const token = match ? store.accessTokens.get(match[1]) : undefined;
        if (!token || token.expiresAt <= clock()) {
            return send(res, 401, { error: 'invalid_request', error_description: 'Invalid Credentials' }, {
                'WWW-Authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"',
            });
        }
        const scopes = token.scope.split(' ');
        const out = { sub: user.sub };
        if (scopes.includes(EMAIL)) Object.assign(out, { email: user.email, email_verified: true });
        if (scopes.includes(PROFILE)) out.name = user.name;
        return send(res, 200, out);
    }

    // ---- Calendar API ------------------------------------------------

    function api(req, url, body, res) {
        const q = url.searchParams;
        store.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(q), ifMatch: req.headers['if-match'] });
        authenticate(req, req.method === 'GET');
        const queued = store.failures.find((f) => f.times > 0 && (!f.method || f.method === req.method) && (!f.path || f.path.test(url.pathname)));
        if (queued !== undefined) {
            queued.times--;
            if (queued.times <= 0) store.failures.splice(store.failures.indexOf(queued), 1);
            fail(queued.status, queued.reason, queued.message, {
                domain: queued.domain, headers: queued.retryAfter ? { 'Retry-After': String(queued.retryAfter) } : undefined,
            });
        }
        const route = url.pathname.slice('/calendar/v3/'.length).split('/').map((part) => decodeURIComponent(part));
        const [first, second, third, fourth, fifth] = route;
        let answer;
        if (first === 'users' && second === 'me' && third === 'calendarList' && route.length === 3 && req.method === 'GET') {
            answer = listCalendars(q);
        } else if (first === 'calendars' && third === 'events' && route.length >= 3 && route.length <= 5) {
            const calendar = calendarOf(second);
            const zone = isZone(q.get('timeZone') ?? '') ? q.get('timeZone') : calendar.entry.timeZone;
            const ifMatch = req.headers['if-match'];
            if (route.length === 3 && req.method === 'GET') answer = listEvents(calendar, q, zone);
            else if (route.length === 3 && req.method === 'POST') answer = insertEvent(calendar, parseBody(body), q, zone);
            else if (route.length === 4 && req.method === 'GET') answer = getEvent(calendar, fourth, zone);
            else if (route.length === 4 && req.method === 'PATCH') answer = patchEvent(calendar, fourth, parseBody(body), q, ifMatch, zone);
            else if (route.length === 4 && req.method === 'DELETE') answer = deleteEvent(calendar, fourth, q, ifMatch);
            else if (route.length === 5 && fifth === 'instances' && req.method === 'GET') answer = listInstances(calendar, fourth, q, zone);
        }
        if (answer === undefined) fail(404, 'notFound', 'Not Found');
        send(res, answer.status, answer.body);
    }

    function authenticate(req, read) {
        const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
        if (!match) {
            fail(401, 'required', 'Login Required.', {
                locationType: 'header', location: 'Authorization', headers: { 'WWW-Authenticate': 'Bearer realm="https://accounts.google.com/"' },
            });
        }
        const token = store.accessTokens.get(match[1]);
        if (!token || token.expiresAt <= clock()) {
            fail(401, 'authError', 'Invalid Credentials', {
                locationType: 'header', location: 'Authorization',
                headers: { 'WWW-Authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"' },
            });
        }
        const scopes = token.scope.split(' ');
        if (!(scopes.includes(CALENDAR) || (read && scopes.includes(CALENDAR_READONLY)))) {
            fail(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', {
                headers: { 'WWW-Authenticate': `Bearer realm="https://accounts.google.com/", error="insufficient_scope", scope="${CALENDAR}"` },
            });
        }
        return token;
    }

    function calendarOf(id) {
        const calendar = store.calendars.get(id === 'primary' ? user.email : id);
        if (calendar === undefined) fail(404, 'notFound', 'Not Found');
        return calendar;
    }

    function writable(calendar) {
        if ((ROLES[calendar.entry.accessRole] ?? 0) < ROLES.writerWithoutPrivateAccess) {
            fail(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.', { domain: 'calendar' });
        }
    }

    function checkSendUpdates(q) {
        const value = q.get('sendUpdates');
        if (value !== null && !SEND_UPDATES.has(value)) fail(400, 'invalid', 'Invalid value for: sendUpdates', { locationType: 'parameter', location: 'sendUpdates' });
    }

    function parseBody(text) {
        try {
            return JSON.parse(text);
        } catch {
            return fail(400, 'parseError', 'Parse Error');
        }
    }

    // Sync tokens carry what they cover, the change counter they were made at, and a generation (a new one: 410).
    function makeToken(scope, seq, generation) {
        return `C${Buffer.from(JSON.stringify({ k: scope, s: seq, g: generation })).toString('base64url')}`;
    }

    function readToken(text, scope, generation) {
        let token;
        try {
            token = JSON.parse(Buffer.from(text.slice(1), 'base64url').toString('utf8'));
        } catch {
            token = undefined;
        }
        if (!text.startsWith('C') || token?.k !== scope || !Number.isInteger(token.s)) {
            fail(400, 'invalid', 'Invalid sync token value.', { locationType: 'parameter', location: 'syncToken' });
        }
        if (token.g !== generation) fail(410, 'fullSyncRequired', 'Sync token is no longer valid, a full sync is required.', { domain: 'calendar' });
        return token.s;
    }

    /** A page of a list. A pageToken must come with the very same query (maxResults aside). */
    const pages = new Map();
    function paged(name, q, all, head, { size, most }, syncToken) {
        const key = `${name}?${[...q].filter(([k]) => k !== 'pageToken' && k !== 'maxResults').map(([k, v]) => `${k}=${v}`).sort().join('&')}`;
        let rest = all;
        let token = syncToken;
        const pageToken = q.get('pageToken');
        if (pageToken !== null) {
            const saved = pages.get(pageToken);
            if (saved === undefined || saved.key !== key) fail(400, 'invalid', 'Invalid page token value.', { locationType: 'parameter', location: 'pageToken' });
            ({ rest, token } = saved);
        }
        const asked = Number(q.get('maxResults') ?? size);
        const count = Math.max(1, Math.min(Number.isFinite(asked) ? asked : size, most, store.pageLimit));
        const out = { ...head };
        if (rest.length > count) {
            const next = opaque('', 18);
            pages.set(next, { key, rest: rest.slice(count), token });
            out.nextPageToken = next;
        } else if (token !== undefined) {
            out.nextSyncToken = token;
        }
        out.items = rest.slice(0, count);
        return { status: 200, body: out };
    }

    function listCalendars(q) {
        const syncToken = q.get('syncToken');
        let calendars = [...store.calendars.values()];
        if (syncToken !== null) {
            if (q.has('minAccessRole') || q.get('showDeleted') === 'false' || q.get('showHidden') === 'false') {
                fail(400, 'invalid', 'minAccessRole, showDeleted=false and showHidden=false can\'t be used with syncToken.', { locationType: 'parameter', location: 'syncToken' });
            }
            const since = readToken(syncToken, 'calendarList', store.listGeneration);
            calendars = calendars.filter((c) => c.listSeq > since);
        } else {
            if (q.get('showDeleted') !== 'true') calendars = calendars.filter((c) => !c.entry.deleted);
            if (q.get('showHidden') !== 'true') calendars = calendars.filter((c) => !c.entry.hidden);
            const least = q.get('minAccessRole');
            if (least !== null) {
                if (!ROLES[least]) fail(400, 'invalid', 'Invalid value for: minAccessRole', { locationType: 'parameter', location: 'minAccessRole' });
                calendars = calendars.filter((c) => ROLES[c.entry.accessRole] >= ROLES[least]);
            }
        }
        const items = calendars.map(({ entry, etag: listEtag }) => {
            const out = { kind: 'calendar#calendarListEntry', etag: entry.etag ?? listEtag, id: entry.id, summary: entry.summary };
            for (const key of ['description', 'location', 'timeZone', 'summaryOverride', 'colorId', 'backgroundColor', 'foregroundColor']) {
                if (entry[key] !== undefined) out[key] = entry[key];
            }
            if (entry.hidden) out.hidden = true;
            if (entry.selected) out.selected = true;
            out.accessRole = entry.accessRole;
            out.defaultReminders = clone(entry.defaultReminders ?? []);
            if (entry.notificationSettings && entry.accessRole === 'owner') out.notificationSettings = clone(entry.notificationSettings);
            if (entry.primary) out.primary = true;
            if (entry.deleted) out.deleted = true;
            out.conferenceProperties = { allowedConferenceSolutionTypes: ['hangoutsMeet'] };
            return out;
        });
        return paged('calendarList', q, items, { kind: 'calendar#calendarList', etag: `"p${store.listSeq}"` },
            { size: 100, most: 250 }, makeToken('calendarList', store.listSeq, store.listGeneration));
    }

    function listHead(calendar) {
        const head = { kind: 'calendar#events', etag: `"p${calendar.seq}"`, summary: calendar.entry.summary };
        if (calendar.entry.description) head.description = calendar.entry.description;
        return {
            ...head, updated: iso(), timeZone: calendar.entry.timeZone, accessRole: calendar.entry.accessRole,
            defaultReminders: clone(calendar.entry.defaultReminders ?? []),
        };
    }

    function listEvents(calendar, q, zone) {
        const syncToken = q.get('syncToken');
        const single = q.get('singleEvents') === 'true';
        const orderBy = q.get('orderBy');
        if (orderBy !== null && orderBy !== 'startTime' && orderBy !== 'updated') fail(400, 'invalid', 'Invalid value for: orderBy', { locationType: 'parameter', location: 'orderBy' });
        if (orderBy === 'startTime' && !single) fail(400, 'badRequest', 'The requested ordering is not available for the particular query.');
        const scope = `events:${calendar.entry.id}`;
        let since;
        if (syncToken !== null) {
            const clash = ['iCalUID', 'orderBy', 'privateExtendedProperty', 'q', 'sharedExtendedProperty', 'timeMin', 'timeMax', 'updatedMin'].find((p) => q.has(p));
            if (clash) fail(400, 'invalid', `${clash} can't be used with syncToken.`, { locationType: 'parameter', location: clash });
            if (q.get('showDeleted') === 'false') fail(400, 'invalid', 'showDeleted can\'t be false with syncToken.', { locationType: 'parameter', location: 'showDeleted' });
            since = readToken(syncToken, scope, calendar.generation);
        }
        const updatedMin = bound(q.get('updatedMin'), 'updatedMin');
        const timeMin = bound(q.get('timeMin'), 'timeMin');
        const timeMax = bound(q.get('timeMax'), 'timeMax');
        if (timeMin !== undefined && timeMax !== undefined && timeMin >= timeMax) {
            fail(400, 'timeRangeEmpty', 'The specified time range is empty.', { domain: 'calendar', locationType: 'parameter', location: 'timeMax' });
        }
        // Deleted events come with a sync token or updatedMin whatever showDeleted says.
        const showDeleted = q.get('showDeleted') === 'true' || since !== undefined || updatedMin !== undefined;
        let events = [...calendar.events.values()];
        if (since !== undefined) events = events.filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
        if (q.has('iCalUID')) events = events.filter((e) => e.iCalUID === q.get('iCalUID'));
        if (updatedMin !== undefined) events = events.filter((e) => Date.parse(e.updated) >= updatedMin);
        if (q.get('q')) events = events.filter((e) => matches(e, q.get('q')));
        const out = [];
        for (const event of events) {
            const cancelled = event.status === 'cancelled';
            if (!single) {
                // A cancelled occurrence always comes: it hides its instance of the series.
                if (cancelled && !event.recurringEventId && !showDeleted) continue;
                if (isSeries(event) ? seriesMeets(calendar, event, timeMin, timeMax, zone) : within(event, timeMin, timeMax, zone, false)) out.push(event);
            } else if (isSeries(event)) {
                if (cancelled) continue;
                for (const instance of seriesInstances(calendar, event, timeMax)) {
                    if (!instance.virtual) continue; // a changed occurrence comes as its own event
                    if (within(instance, timeMin, timeMax, zone, false)) out.push(instance);
                }
            } else {
                if (cancelled && !showDeleted) continue;
                if (within(event, timeMin, timeMax, zone, false)) out.push(event);
            }
        }
        if (orderBy === 'startTime') out.sort((a, b) => edge(a.start, zone) - edge(b.start, zone));
        if (orderBy === 'updated') out.sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated));
        return paged(scope, q, out.map((e) => render(calendar, e, zone)), listHead(calendar), { size: 250, most: 2500 },
            makeToken(scope, calendar.seq, calendar.generation));
    }

    function matches(event, words) {
        const hay = [event.summary, event.description, event.location, event.organizer?.email, event.organizer?.displayName,
            ...(event.attendees ?? []).flatMap((a) => [a.email, a.displayName])].filter(Boolean).join('\n').toLowerCase();
        return words.toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
    }

    /** An event's start or end as an instant; a day starts at midnight in the zone the answer uses. */
    const edge = (time, zone) => (time.date !== undefined ? toInstant(`${time.date}T00:00:00`, zone, zone) : time.ms);

    /** Whether an event meets a window: it ends after timeMin (at it, for instances) and starts before timeMax. */
    function within(event, timeMin, timeMax, zone, inclusive) {
        const start = edge(event.start, zone);
        const end = edge(event.end, zone);
        if (timeMin !== undefined && (inclusive ? end < timeMin : end <= timeMin)) return false;
        return timeMax === undefined || start < timeMax;
    }

    function seriesMeets(calendar, master, timeMin, timeMax, zone) {
        if (timeMin === undefined && timeMax === undefined) return true;
        return seriesInstances(calendar, master, timeMax).some((instance) => within(instance, timeMin, timeMax, zone, false));
    }

    /** A series' occurrences: its changed ones as stored, the others made from the master. */
    function seriesInstances(calendar, master, untilMs = Infinity) {
        return occurrences(master, { untilMs: untilMs ?? Infinity }).map((original) => {
            const id = instanceId(master.id, original);
            return calendar.events.get(id) ?? virtualInstance(master, original, id);
        });
    }

    function virtualInstance(master, original, id) {
        const instance = clone(master);
        delete instance.recurrence;
        delete instance.seq;
        instance.id = id;
        instance.recurringEventId = master.id;
        instance.virtual = true;
        if (original.date !== undefined) {
            const days = dayNumber(master.end.date) - dayNumber(master.start.date);
            instance.originalStart = { date: original.date };
            instance.start = { date: original.date };
            instance.end = { date: dayText(dayNumber(original.date) + days) };
        } else {
            const zone = master.start.timeZone;
            instance.originalStart = { ms: original.ms, timeZone: zone };
            instance.start = { ms: original.ms, timeZone: zone };
            instance.end = { ms: original.ms + (master.end.ms - master.start.ms), timeZone: master.end.timeZone ?? zone };
        }
        instance.etag = `"${createHash('sha256').update(`${master.etag}${id}`).digest('hex').slice(0, 16)}"`;
        return instance;
    }

    /** An event by id: stored, or an occurrence of a series by Google's instance id. */
    function find(calendar, id) {
        const stored = calendar.events.get(id);
        if (stored !== undefined) return stored;
        const cut = id.lastIndexOf('_');
        if (cut <= 0) return undefined;
        const master = calendar.events.get(id.slice(0, cut));
        if (master === undefined || !isSeries(master) || master.status === 'cancelled') return undefined;
        const tail = id.slice(cut + 1);
        let m = /^(\d{4})(\d{2})(\d{2})$/.exec(tail);
        let wanted;
        if (m) wanted = `${m[1]}-${m[2]}-${m[3]}`;
        else if ((m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(tail))) wanted = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        else return undefined;
        const until = typeof wanted === 'number' ? wanted : Date.parse(`${wanted}T00:00:00Z`) + 2 * DAY;
        const hit = occurrences(master, { untilMs: until, limit: 100_000 }).find((o) => (o.date ?? o.ms) === wanted);
        return hit === undefined ? undefined : virtualInstance(master, hit, id);
    }

    const isSeries = (event) => Array.isArray(event.recurrence) && event.recurrence.length > 0 && !event.recurringEventId;

    /** Whether an address is the calendar's own (its owner's). */
    const own = (calendar, email) => [user.email, calendar.entry.id].some((x) => x.toLowerCase() === String(email ?? '').toLowerCase());

    const organizerOf = (calendar) => (calendar.entry.primary
        ? { email: user.email }
        : { email: calendar.entry.id, displayName: calendar.entry.summary });

    function touch(calendar, event) {
        event.etag = etag();
        event.updated = iso();
        event.seq = ++calendar.seq;
    }

    function parseTime(value, which) {
        if (value === null || typeof value !== 'object') fail(400, 'required', `Missing ${which} time.`);
        if (typeof value.date === 'string' && value.date !== '') {
            if (!isDay(value.date) || value.dateTime !== undefined) fail(400, 'invalid', `Invalid ${which} time.`);
            return { date: value.date };
        }
        if (typeof value.dateTime !== 'string') fail(400, 'required', `Missing ${which} time.`);
        if (value.timeZone !== undefined && !isZone(value.timeZone)) fail(400, 'invalid', `Invalid time zone definition for ${which} time.`);
        let ms;
        if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.dateTime)) ms = Date.parse(value.dateTime);
        else if (value.timeZone) ms = toInstant(value.dateTime, value.timeZone, value.timeZone);
        else fail(400, 'invalid', `Missing time zone definition for ${which} time.`);
        if (!Number.isFinite(ms)) fail(400, 'invalid', `Invalid ${which} time.`);
        const out = { ms: Math.floor(ms / 1000) * 1000 };
        if (value.timeZone) out.timeZone = value.timeZone;
        return out;
    }

    function renderTime(time, zone) {
        if (time.date !== undefined) return { date: time.date };
        const out = { dateTime: rfc3339(time.ms, zone) };
        if (time.timeZone) out.timeZone = time.timeZone;
        return out;
    }

    function attendeesOf(list) {
        if (!Array.isArray(list)) fail(400, 'invalid', 'Invalid attendees.');
        return list.map((guest) => {
            if (guest === null || typeof guest !== 'object' || typeof guest.email !== 'string' || !guest.email.includes('@')) {
                fail(400, 'required', 'Missing attendee email.');
            }
            const status = guest.responseStatus ?? 'needsAction';
            if (!RESPONSES.has(status)) fail(400, 'invalid', 'Invalid attendee response status.');
            const out = { email: guest.email };
            if (typeof guest.displayName === 'string') out.displayName = guest.displayName;
            if (guest.optional === true) out.optional = true;
            if (guest.resource === true) out.resource = true;
            out.responseStatus = status;
            if (typeof guest.comment === 'string') out.comment = guest.comment;
            if (Number.isInteger(guest.additionalGuests) && guest.additionalGuests > 0) out.additionalGuests = guest.additionalGuests;
            return out;
        });
    }

    function remindersOf(value) {
        if (value === null || typeof value !== 'object') fail(400, 'invalid', 'Invalid reminders.');
        const overrides = value.overrides ?? [];
        if (!Array.isArray(overrides) || overrides.length > 5) fail(400, 'invalid', 'The maximum number of override reminders is 5.');
        if (value.useDefault === true && overrides.length > 0) {
            fail(400, 'cannotUseDefaultRemindersAndSpecifyOverride', 'Cannot specify both default reminders and overrides at the same time.');
        }
        for (const o of overrides) {
            if (o?.method !== 'email' && o?.method !== 'popup') fail(400, 'invalid', 'Invalid reminder method.');
            if (!Number.isInteger(o.minutes) || o.minutes < 0 || o.minutes > 40320) fail(400, 'invalid', 'Invalid reminder minutes.');
        }
        return value.useDefault === true ? { useDefault: true } : { useDefault: false, overrides: overrides.map((o) => ({ method: o.method, minutes: o.minutes })) };
    }

    /** Applies writable fields with patch semantics: null clears, arrays replace, nested objects merge. */
    function apply(event, body, occurrence) {
        for (const [key, value] of Object.entries(body)) {
            if (READ_ONLY.has(key)) continue;
            if (value === null) {
                if (key === 'start' || key === 'end') fail(400, 'required', `Missing ${key} time.`);
                delete event[key];
                continue;
            }
            switch (key) {
            case 'start':
            case 'end':
                event[key] = parseTime(value, key);
                break;
            case 'recurrence':
                if (occurrence) fail(400, 'invalid', 'Invalid recurrence rule.');
                if (!Array.isArray(value)) fail(400, 'invalid', 'Invalid recurrence rule.');
                if (value.length === 0) delete event.recurrence;
                else event.recurrence = [...value];
                break;
            case 'attendees':
                event.attendees = attendeesOf(value);
                if (event.attendees.length === 0) delete event.attendees;
                break;
            case 'reminders': {
                const merged = { ...event.reminders, ...value };
                if (value.useDefault === true && value.overrides === undefined) delete merged.overrides;
                event.reminders = remindersOf(merged);
                break;
            }
            case 'transparency':
                if (value !== 'opaque' && value !== 'transparent') fail(400, 'invalid', 'Invalid value for: transparency');
                if (value === 'opaque') delete event.transparency;
                else event.transparency = value;
                break;
            case 'visibility':
                if (!['default', 'public', 'private', 'confidential'].includes(value)) fail(400, 'invalid', 'Invalid value for: visibility');
                if (value === 'default') delete event.visibility;
                else event.visibility = value;
                break;
            case 'status':
                if (!['confirmed', 'tentative', 'cancelled'].includes(value)) fail(400, 'invalid', 'Invalid value for: status');
                event.status = value;
                break;
            case 'summary':
            case 'description':
            case 'location':
            case 'colorId':
                if (String(value) === '') delete event[key];
                else event[key] = String(value);
                break;
            case 'guestsCanModify':
            case 'guestsCanInviteOthers':
            case 'guestsCanSeeOtherGuests':
                event[key] = value === true;
                break;
            default:
                event[key] = clone(value);
            }
        }
    }

    function check(event) {
        if (event.start === undefined) fail(400, 'required', 'Missing start time.');
        if (event.end === undefined) fail(400, 'required', 'Missing end time.');
        const allDay = event.start.date !== undefined;
        if (allDay !== (event.end.date !== undefined)) fail(400, 'invalid', 'Start and end times must either both be date or both be dateTime.');
        const empty = allDay ? event.end.date <= event.start.date : event.end.ms < event.start.ms;
        if (empty) fail(400, 'timeRangeEmpty', 'The specified time range is empty.', { domain: 'calendar' });
        if (isSeries(event)) {
            if (!allDay && !event.start.timeZone) fail(400, 'invalid', 'Missing time zone definition for start time.');
            if (!allDay && !event.end.timeZone) fail(400, 'invalid', 'Missing time zone definition for end time.');
            checkRecurrence(event.recurrence, event.start.timeZone);
        }
    }

    /** A new stored event. `trusted` (the store's own seeding) takes read-only fields as given. */
    function add(calendar, input, trusted) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(400, 'parseError', 'Parse Error');
        let id = input.id;
        if (id !== undefined) {
            const form = trusted ? /^[A-Za-z0-9_@.-]{1,1024}$/ : /^[a-v0-9]{5,1024}$/;
            if (typeof id !== 'string' || !form.test(id)) fail(400, 'invalid', 'Invalid resource id value.');
            if (calendar.events.has(id)) fail(409, 'duplicate', 'The requested identifier already exists.');
        } else {
            id = newId();
        }
        const event = {
            id,
            iCalUID: trusted && typeof input.iCalUID === 'string' ? input.iCalUID : `${id}@google.com`,
            status: 'confirmed',
            created: iso(),
            creator: trusted && input.creator ? clone(input.creator) : { email: user.email },
            organizer: trusted && input.organizer ? clone(input.organizer) : organizerOf(calendar),
            sequence: trusted && Number.isInteger(input.sequence) ? input.sequence : 0,
            eventType: trusted && typeof input.eventType === 'string' ? input.eventType : 'default',
            reminders: { useDefault: true },
        };
        if (trusted) {
            for (const key of ['hangoutLink', 'recurringEventId']) if (input[key] !== undefined) event[key] = clone(input[key]);
            if (input.originalStartTime) event.originalStart = parseTime(input.originalStartTime, 'originalStart');
        }
        if (!trusted && input.conferenceData !== undefined) delete input.conferenceData;
        apply(event, input, Boolean(event.recurringEventId));
        check(event);
        touch(calendar, event);
        calendar.events.set(id, event);
        return event;
    }

    /** A patch of an event or of one occurrence (which then becomes a changed occurrence). */
    function change(calendar, id, body, { trusted = false, ifMatch } = {}) {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) fail(400, 'parseError', 'Parse Error');
        const found = find(calendar, id);
        if (found === undefined) fail(404, 'notFound', 'Not Found');
        if (ifMatch !== undefined && ifMatch !== '*' && ifMatch !== found.etag) {
            fail(412, 'conditionNotMet', 'Precondition Failed', { locationType: 'header', location: 'If-Match' });
        }
        const before = clone(found);
        delete before.virtual;
        const next = clone(before);
        apply(next, body, Boolean(next.recurringEventId));
        check(next);
        if (!trusted && !own(calendar, before.organizer?.email) && before.guestsCanModify !== true) guardGuest(calendar, before, next);
        if (['start', 'end', 'recurrence', 'location'].some((key) => !same(before[key], next[key]))) next.sequence = (next.sequence ?? 0) + 1;
        calendar.events.set(next.id, next);
        touch(calendar, next);
        if (isSeries(before)) followMaster(calendar, before, next);
        return next;
    }

    /** A guest may change only their own answer (and reminders, colors, transparency) unless guests may modify. */
    function guardGuest(calendar, before, next) {
        const shared = (event) => ({
            ...Object.fromEntries(['summary', 'description', 'location', 'start', 'end', 'recurrence', 'status', 'visibility', 'conferenceData']
                .map((key) => [key, event[key] ?? null])),
            attendees: (event.attendees ?? []).map((a) => (own(calendar, a.email) ? { email: a.email.toLowerCase() } : a)),
        });
        if (!same(shared(before), shared(next))) {
            fail(403, 'forbiddenForNonOrganizer', 'Shared properties can only be changed by the organizer of the event.', { domain: 'calendar' });
        }
    }

    /** A series' change reaches its changed occurrences that still had the series' old value. */
    function followMaster(calendar, before, after) {
        const changed = FOLLOW_MASTER.filter((key) => !same(before[key], after[key]));
        if (changed.length === 0) return;
        for (const other of calendar.events.values()) {
            if (other.recurringEventId !== after.id || other.status === 'cancelled') continue;
            let moved = false;
            for (const key of changed) {
                if (!same(other[key], before[key])) continue;
                if (after[key] === undefined) delete other[key];
                else other[key] = clone(after[key]);
                moved = true;
            }
            if (moved) touch(calendar, other);
        }
    }

    function removeEvent(calendar, id, ifMatch) {
        const found = find(calendar, id);
        if (found === undefined) fail(404, 'notFound', 'Not Found');
        if (found.status === 'cancelled') fail(410, 'deleted', 'Resource has been deleted');
        if (ifMatch !== undefined && ifMatch !== '*' && ifMatch !== found.etag) {
            fail(412, 'conditionNotMet', 'Precondition Failed', { locationType: 'header', location: 'If-Match' });
        }
        const event = found.virtual ? clone(found) : found;
        delete event.virtual;
        event.status = 'cancelled';
        calendar.events.set(event.id, event);
        touch(calendar, event);
        if (isSeries(event)) {
            for (const other of calendar.events.values()) {
                if (other.recurringEventId !== event.id || other.status === 'cancelled') continue;
                other.status = 'cancelled';
                touch(calendar, other);
            }
        }
    }

    function insertEvent(calendar, body, q, zone) {
        writable(calendar);
        checkSendUpdates(q);
        return { status: 200, body: render(calendar, add(calendar, body, false), zone) };
    }

    function getEvent(calendar, id, zone) {
        const event = find(calendar, id);
        if (event === undefined) fail(404, 'notFound', 'Not Found');
        return { status: 200, body: render(calendar, event, zone) };
    }

    function patchEvent(calendar, id, body, q, ifMatch, zone) {
        writable(calendar);
        checkSendUpdates(q);
        return { status: 200, body: render(calendar, change(calendar, id, body, { ifMatch }), zone) };
    }

    function deleteEvent(calendar, id, q, ifMatch) {
        writable(calendar);
        checkSendUpdates(q);
        removeEvent(calendar, id, ifMatch);
        return { status: 204 };
    }

    function listInstances(calendar, id, q, zone) {
        const master = calendar.events.get(id);
        if (master === undefined) fail(404, 'notFound', 'Not Found');
        if (master.status === 'cancelled') fail(410, 'deleted', 'Resource has been deleted');
        const timeMin = bound(q.get('timeMin'), 'timeMin');
        const timeMax = bound(q.get('timeMax'), 'timeMax');
        let list = isSeries(master) ? seriesInstances(calendar, master, timeMax) : [master];
        if (q.get('showDeleted') !== 'true') list = list.filter((e) => e.status !== 'cancelled');
        // instances: timeMin is inclusive (an end at it counts).
        list = list.filter((e) => within(e, timeMin, timeMax, zone, true));
        const originalStart = q.get('originalStart');
        if (originalStart !== null) {
            const wanted = isDay(originalStart) ? originalStart : bound(originalStart, 'originalStart');
            list = list.filter((e) => (e.originalStart?.date ?? e.originalStart?.ms) === wanted);
        }
        return paged(`instances:${calendar.entry.id}:${id}`, q, list.map((e) => render(calendar, e, zone)), listHead(calendar),
            { size: 250, most: 2500 }, undefined);
    }

    /** An event as the API sends it. A cancelled one carries only what Google promises. */
    function render(calendar, event, zone) {
        const out = { kind: 'calendar#event', etag: event.etag, id: event.id, status: event.status };
        if (event.recurringEventId) {
            out.recurringEventId = event.recurringEventId;
            out.originalStartTime = renderTime(event.originalStart, zone);
        }
        if (event.status === 'cancelled') return out;
        out.htmlLink = `https://www.google.com/calendar/event?eid=${Buffer.from(`${event.id} ${calendar.entry.id}`).toString('base64url')}`;
        out.created = event.created;
        out.updated = event.updated;
        for (const key of ['summary', 'description', 'location', 'colorId']) if (event[key] !== undefined) out[key] = event[key];
        const flag = (person) => (own(calendar, person?.email) ? { ...person, self: true } : { ...person });
        out.creator = flag(event.creator);
        out.organizer = flag(event.organizer);
        out.start = renderTime(event.start, zone);
        out.end = renderTime(event.end, zone);
        if (isSeries(event)) out.recurrence = [...event.recurrence];
        if (event.transparency) out.transparency = event.transparency;
        if (event.visibility) out.visibility = event.visibility;
        out.iCalUID = event.iCalUID;
        out.sequence = event.sequence ?? 0;
        if (event.attendees?.length) {
            out.attendees = event.attendees.map((guest) => {
                const shown = { ...guest };
                if (guest.email.toLowerCase() === String(event.organizer?.email ?? '').toLowerCase()) shown.organizer = true;
                if (own(calendar, guest.email)) shown.self = true;
                return shown;
            });
        }
        if (event.hangoutLink) out.hangoutLink = event.hangoutLink;
        for (const key of Object.keys(event)) {
            if (!(key in out) && !['seq', 'virtual', 'originalStart', 'reminders', 'eventType', 'recurrence'].includes(key)) out[key] = clone(event[key]);
        }
        out.reminders = clone(event.reminders ?? { useDefault: true });
        out.eventType = event.eventType ?? 'default';
        return out;
    }

    function send(res, status, body, headers = {}) {
        if (status === 204 || body === undefined) {
            res.writeHead(status, headers);
            res.end();
            return;
        }
        const text = JSON.stringify(body, null, 2);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(text), ...headers });
        res.end(text);
    }

    function htmlPage(res, status, message) {
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body><p>${message.replace(/[<>&]/g, '')}</p></body></html>`;
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        res.end(html);
    }

    async function close() {
        await new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
    }

    return {
        base,
        apiBase: `${base}/calendar/v3`,
        authorizeUrl: `${base}/o/oauth2/v2/auth`,
        tokenUrl: `${base}/token`,
        userinfoUrl: `${base}/v1/userinfo`,
        clientId,
        clientSecret,
        /** What the calendar plugin's settings need to use this stand-in. */
        settings: {
            googleClientId: clientId,
            googleClientSecret: clientSecret,
            googleApiBase: `${base}/calendar/v3`,
            googleAuthorizeUrl: `${base}/o/oauth2/v2/auth`,
            googleTokenUrl: `${base}/token`,
            googleUserinfoUrl: `${base}/v1/userinfo`,
        },
        store,
        close,
    };
}
