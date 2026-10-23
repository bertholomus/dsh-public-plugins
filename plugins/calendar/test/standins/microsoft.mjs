/**
 * A stand-in for Microsoft Graph v1.0 and the Microsoft identity platform,
 * in memory on 127.0.0.1, for the Microsoft source's tests:
 *
 * - sign-in: /{tenant}/oauth2/v2.0/devicecode and /token (the device code
 *   grant, pending for the first two polls by default; refresh_token with
 *   rotation: a refresh token works once);
 * - Graph: /me, /me/calendars (paged), the calendar view's delta query
 *   (pages, sync links, @removed entries, sparse entries on request),
 *   events (GET, POST, PATCH, DELETE), /instances, and accept, decline and
 *   tentativelyAccept; a PATCH or DELETE with If-Match goes through only
 *   while the event still has that etag, else 412 ErrorIrresolvableConflict;
 * - series (every pattern type) expanded into occurrences and exceptions
 *   with seriesMasterId, originalStart and originalStartTimeZone, as the
 *   calendar view hands them over.
 *
 * JSON follows Graph's documented shapes. Times go out in the zone the
 * Prefer header asks for (UTC when it asks for none); all-day events go
 * out midnight to midnight, as Graph sends them.
 *
 *   const graph = await start();
 *   const source = create(account, { ...env, settings: graph.settings });
 *   graph.store.addEvent(calendarId, {...});   // seed, or change behind the client's back
 *   await graph.close();
 *
 * @module dsh-plugin-calendar/test/standins/microsoft
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { addDays, daysBetween, ianaZone, isDay, normalLocal, toInstant, toLocal, wallMs, wallOf } from '../../lib/zones.js';

const DAY = 86_400_000;
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PATTERN_TYPES = ['daily', 'weekly', 'absoluteMonthly', 'relativeMonthly', 'absoluteYearly', 'relativeYearly'];
const INDEXES = ['first', 'second', 'third', 'fourth', 'last'];
const SHOW_AS = ['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown'];
const SENSITIVITIES = ['normal', 'personal', 'private', 'confidential'];
const NO_TIME = '0001-01-01T00:00:00Z';
/** Exchange's class id at the start of every global object id (iCalUId). */
const GLOBAL_ID_CLASS = '040000008200E00074C5B7101A82E008';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** What the sign-in service says for each device code answer. */
const DEVICE_ERRORS = {
    authorization_pending: [70016, 'OAuth 2.0 device flow error. Authorization is pending. Continue polling.'],
    slow_down: [70016, 'Polling too fast. Slow down.'],
    authorization_declined: [70000, 'The user declined the sign-in.'],
    access_denied: [70000, 'The user declined the sign-in.'],
    expired_token: [70019, 'Verification code expired.'],
    bad_verification_code: [70000, 'The verification code was not recognized.'],
};

/** An error answer: Graph's {error: {code, message}}, or the sign-in service's {error, error_description}. */
class StandInError extends Error {
    constructor(status, code, message, { oauth = false, headers = {} } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.oauth = oauth;
        this.headers = headers;
    }
}

const newToken = (bytes = 24) => randomBytes(bytes).toString('base64url');
const newChangeKey = () => randomBytes(12).toString('base64');
/** An IANA zone for a zone name as Graph takes them (Windows or IANA), or null. */
const zoneOf = (name) => (name === undefined || name === null || name === '' ? 'UTC' : ianaZone(name) ?? null);
const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
const dayOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoZ = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function graphError(status, code, message) {
    return new StandInError(status, code, message);
}

function oauthError(code, extra = '') {
    const [number, text] = DEVICE_ERRORS[code] ?? [70000, extra || 'The request was refused.'];
    return new StandInError(400, code, `AADSTS${number}: ${extra || text}`, { oauth: true });
}

/** A new global object id in hex, as Exchange makes them. */
function newGlobalId() {
    const filetime = (BigInt(Date.now()) * 10000n + 116444736000000000n).toString(16).toUpperCase().padStart(16, '0');
    return `${GLOBAL_ID_CLASS}00000000${filetime}${'0'.repeat(16)}10000000${randomBytes(16).toString('hex').toUpperCase()}`;
}

/** An occurrence's global object id: the series' with the occurrence's date in it. */
function occurrenceGlobalId(uid, day) {
    if (!uid.toUpperCase().startsWith(GLOBAL_ID_CLASS)) return uid;
    const [y, m, d] = day.split('-').map(Number);
    const stamp = `${y.toString(16).padStart(4, '0')}${m.toString(16).padStart(2, '0')}${d.toString(16).padStart(2, '0')}`.toUpperCase();
    return `${uid.slice(0, 32)}${stamp}${uid.slice(40)}`;
}

/** Prefer header values by name: {'outlook.timezone': 'UTC', 'odata.maxpagesize': '100'}. */
function preferences(header) {
    const out = {};
    for (const part of String(header ?? '').split(',')) {
        const m = /^\s*([\w.-]+)\s*=\s*"?([^"]*)"?\s*$/.exec(part);
        if (m !== null) out[m[1].toLowerCase()] = m[2];
    }
    return out;
}

/** A query time ('2026-10-01T00:00:00Z', or without a zone: UTC) as epoch ms. */
function queryTime(value) {
    if (typeof value !== 'string' || value === '') return NaN;
    const text = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
    return Date.parse(text.replace(/(\.\d{3})\d+/, '$1'));
}

/** Whether a pattern hits a day (YYYY-MM-DD) of a series starting on `first`. */
function patternHits(pattern, first, day) {
    const interval = pattern.interval;
    const [y, m, d] = day.split('-').map(Number);
    const [fy, fm] = first.split('-').map(Number);
    const months = (y - fy) * 12 + (m - fm);
    switch (pattern.type) {
        case 'daily':
            return daysBetween(first, day) % interval === 0;
        case 'weekly': {
            const weekStart = addDays(first, -((weekdayOf(first) - DAY_NAMES.indexOf(pattern.firstDayOfWeek) + 7) % 7));
            return pattern.daysOfWeek.includes(DAY_NAMES[weekdayOf(day)]) && Math.floor(daysBetween(weekStart, day) / 7) % interval === 0;
        }
        case 'absoluteMonthly':
            return months % interval === 0 && d === pattern.dayOfMonth;
        case 'relativeMonthly':
            return months % interval === 0 && relativeHit(pattern, y, m, d);
        case 'absoluteYearly':
            return (y - fy) % interval === 0 && m === pattern.month && d === pattern.dayOfMonth;
        case 'relativeYearly':
            return (y - fy) % interval === 0 && m === pattern.month && relativeHit(pattern, y, m, d);
        default:
            return false;
    }
}

/** Whether a day is the n-th (or last) of the pattern's days of the week in its month. */
function relativeHit(pattern, y, m, d) {
    const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const hits = [];
    for (let i = 1; i <= length; i++) {
        if (pattern.daysOfWeek.includes(DAY_NAMES[new Date(Date.UTC(y, m - 1, i)).getUTCDay()])) hits.push(i);
    }
    const index = pattern.index === 'last' ? hits.length - 1 : INDEXES.indexOf(pattern.index);
    return hits[index] === d;
}

/** The plain text of a body, for bodyPreview. */
function preview(body) {
    const text = body.contentType === 'html' ? body.content.replace(/<[^>]*>/g, ' ') : body.content;
    return text.replace(/\s+/g, ' ').trim().slice(0, 255);
}

/**
 * The stand-in's data and knobs. Tests seed it, change it behind the
 * client's back, and read what the client sent.
 */
export class Store {
    constructor() {
        this.origin = '';
        /** The app id the sign-in service knows. */
        this.clientId = 'stand-in-client-id';
        this.user = { id: '5c3e1f0a-7d2b-4c8e-9a61-3f2d8b7e0c41', displayName: 'Robin Park', mail: 'robin@example.com', userPrincipalName: 'robin@example.com' };
        /** Seconds between device code polls. Microsoft says 5; tests want speed. */
        this.deviceInterval = 0.05;
        /** What the token endpoint says to each poll of a device code, in order; the last one repeats. */
        this.devicePlan = ['authorization_pending', 'authorization_pending', 'grant'];
        this.deviceExpiresIn = 900;
        /** Seconds an access token lasts. */
        this.tokenLifetime = 3599;
        /** The most entries one page holds, whatever the client prefers. */
        this.pageSize = 50;
        /** Later delta rounds send changed events with their id and etag only, as delta may. */
        this.sparseDelta = false;
        /** What a sync link Graph no longer knows gets. */
        this.refusal = { status: 410, code: 'syncStateNotFound' };
        this.calendars = new Map();
        this.events = new Map();
        /** Every request: {method, path, query, prefer, ifMatch, body, status} (secrets in sign-in forms left out); status: what it was answered. */
        this.requests = [];
        /** Invitation answers: {id, action, sendResponse}. */
        this.responses = [];
        this.counts = { devicePolls: 0, tooFast: 0, refreshes: 0 };
        this.tenants = [];
        this.accessTokens = new Set();
        this.refreshTokens = new Set();
        this.devices = new Map();
        this.deltaTokens = new Map();
        this.rounds = new Map();
        this.failures = [];
        this.serial = 0;
    }

    // ── For tests ──────────────────────────────────────────────────────

    /** Add a calendar; returns its id. */
    addCalendar({ id, name = 'Calendar', color = 'auto', hexColor = '', canEdit = true, isDefaultCalendar = false, owner } = {}) {
        const calendarId = id ?? `AAMkAGcal${++this.serial}AAA=`;
        this.calendars.set(calendarId, {
            id: calendarId, name, color, hexColor, canEdit, isDefaultCalendar, changeKey: newChangeKey(),
            owner: owner ?? { name: this.user.displayName, address: this.user.mail },
        });
        return calendarId;
    }

    /**
     * Add an event as a client would POST it (Graph's JSON), plus what the
     * server sets: organizer, isOrganizer, responseStatus, onlineMeeting,
     * isCancelled, iCalUId, and originalStartTimeZone/originalEndTimeZone to
     * report another name than start's and end's timeZone. Returns its id.
     */
    addEvent(calendarId, fields) {
        return this.createEvent(calendarId, fields, true).id;
    }

    /** Change an event, a series, or one occurrence (it becomes an exception), as PATCH does. */
    updateEvent(id, fields) {
        this.patch(id, fields, true);
    }

    /** Delete an event or a series, or cancel one occurrence. */
    deleteEvent(id) {
        this.remove(id);
    }

    /** The id of a series' occurrence on a day ('YYYY-MM-DD'). */
    occurrenceId(seriesId, day) {
        return `${seriesId}_OCC${day.replace(/-/g, '')}`;
    }

    /** An event or occurrence as Graph's JSON (times in `zone`, UTC by default), or undefined. */
    json(id, zone = 'UTC') {
        const found = this.find(id);
        return found === undefined ? undefined : this.render(found, zone);
    }

    /** A grant as signIn gives one, for seeding an account's secret. */
    issueGrant() {
        const body = this.tokens(true);
        return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000, scope: body.scope };
    }

    /** Every access token stops working (as if they all ran out). */
    revokeAccessTokens() {
        this.accessTokens.clear();
    }

    /** Every refresh token stops working (as if the user signed out everywhere). */
    revokeRefreshTokens() {
        this.refreshTokens.clear();
    }

    /** Every sync link stops working. */
    expireDeltaTokens() {
        this.deltaTokens.clear();
        this.rounds.clear();
    }

    /**
     * Answer the next request that matches with an error instead.
     * @param {{method?: string, path: string|RegExp, status?: number, headers?: object, body?: object, times?: number, drop?: boolean}} failure
     *   path: a part of the path and query, or a pattern for it. drop: close the connection without an answer.
     */
    failNext(failure) {
        this.failures.push({ times: 1, ...failure });
    }

    /** The requests whose path and query match. */
    requestsTo(path, method) {
        return this.requests.filter((r) => (method === undefined || r.method === method) && matches(path, `${r.path}${r.search}`));
    }

    // ── Sign-in ────────────────────────────────────────────────────────

    tokens(offline) {
        const access = `eyJ0eXAi.${newToken(32)}`;
        this.accessTokens.add(access);
        const body = { token_type: 'Bearer', scope: 'Calendars.ReadWrite User.Read', expires_in: this.tokenLifetime, ext_expires_in: this.tokenLifetime, access_token: access };
        if (offline) {
            body.refresh_token = `0.AXoA${newToken(48)}`;
            this.refreshTokens.add(body.refresh_token);
        }
        return body;
    }

    deviceCode(form) {
        if (form.client_id !== this.clientId) throw oauthError('unauthorized_client', 'Application was not found in the directory.');
        if (!String(form.scope ?? '').split(' ').includes('Calendars.ReadWrite')) throw oauthError('invalid_scope', 'The scope is not valid.');
        const deviceCode = `DAQABAAEAAAD${newToken(48)}`;
        const userCode = randomBytes(6).toString('hex').toUpperCase().slice(0, 9);
        this.devices.set(deviceCode, { plan: [...this.devicePlan], last: Date.now(), offline: String(form.scope).split(' ').includes('offline_access') });
        return {
            user_code: userCode,
            device_code: deviceCode,
            verification_uri: 'https://microsoft.com/devicelogin',
            expires_in: this.deviceExpiresIn,
            interval: this.deviceInterval,
            message: `To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ${userCode} to authenticate.`,
        };
    }

    token(form) {
        if (form.grant_type === DEVICE_GRANT) {
            this.counts.devicePolls++;
            if (form.client_id !== this.clientId) throw oauthError('invalid_client', 'The client does not exist.');
            const device = this.devices.get(form.device_code);
            if (device === undefined) throw oauthError('bad_verification_code');
            const now = Date.now();
            const early = now - device.last < this.deviceInterval * 1000 - 5;
            device.last = now;
            if (early) {
                this.counts.tooFast++;
                throw oauthError('slow_down');
            }
            const step = device.plan.length > 1 ? device.plan.shift() : device.plan[0];
            if (step !== 'grant') throw oauthError(step);
            this.devices.delete(form.device_code);
            return this.tokens(device.offline);
        }
        if (form.grant_type === 'refresh_token') {
            this.counts.refreshes++;
            if (form.client_id !== this.clientId) throw oauthError('invalid_client', 'The client does not exist.');
            if (!this.refreshTokens.has(form.refresh_token)) throw oauthError('invalid_grant', 'The provided value for the \'refresh_token\' is not valid.');
            // Rotation: a refresh token works once.
            this.refreshTokens.delete(form.refresh_token);
            return this.tokens(true);
        }
        throw oauthError('unsupported_grant_type', 'The grant type is not supported.');
    }

    // ── Events ─────────────────────────────────────────────────────────

    calendar(id) {
        const cal = this.calendars.get(id);
        if (cal === undefined) throw graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
        return cal;
    }

    writable(calendarId) {
        if (!this.calendar(calendarId).canEdit) throw graphError(403, 'ErrorAccessDenied', 'Access is denied. Check credentials and try again.');
    }

    /** A dateTimeTimeZone as Graph takes it. */
    when(value, name) {
        const local = normalLocal(value?.dateTime);
        if (local === undefined) throw graphError(400, 'ErrorInvalidRequest', `The ${name} time is not valid.`);
        if (typeof value.timeZone !== 'string' || zoneOf(value.timeZone) === null) {
            throw graphError(400, 'TimeZoneNotSupportedException', `A valid TimeZone value must be specified for ${name}.`);
        }
        return { dateTime: local, timeZone: value.timeZone };
    }

    /** A patternedRecurrence as Graph takes it: each type with what it needs, nothing it can't take. */
    recurrence(value) {
        const bad = (what) => graphError(400, 'ErrorPropertyValidationFailure', `At least one property failed validation: ${what}.`);
        const p = value?.pattern ?? {};
        const r = value?.range ?? {};
        const type = PATTERN_TYPES.find((t) => t.toLowerCase() === String(p.type ?? '').toLowerCase());
        if (type === undefined) throw bad('pattern type');
        if (!Number.isInteger(p.interval) || p.interval < 1) throw bad('interval');
        const needs = {
            daily: [], weekly: ['daysOfWeek'], absoluteMonthly: ['dayOfMonth'], relativeMonthly: ['daysOfWeek'],
            absoluteYearly: ['dayOfMonth', 'month'], relativeYearly: ['daysOfWeek', 'month'],
        }[type];
        const pattern = { type, interval: p.interval };
        const days = Array.isArray(p.daysOfWeek) ? p.daysOfWeek.map((d) => String(d).toLowerCase()) : [];
        if (days.some((d) => !DAY_NAMES.includes(d))) throw bad('daysOfWeek');
        if (needs.includes('daysOfWeek')) {
            if (days.length === 0) throw bad('daysOfWeek');
            pattern.daysOfWeek = days;
        } else if (days.length > 0) throw bad('daysOfWeek on a pattern that takes none');
        if (needs.includes('dayOfMonth')) {
            if (!Number.isInteger(p.dayOfMonth) || p.dayOfMonth < 1 || p.dayOfMonth > 31) throw bad('dayOfMonth');
            pattern.dayOfMonth = p.dayOfMonth;
        } else if (p.dayOfMonth !== undefined && p.dayOfMonth !== 0) throw bad('dayOfMonth on a pattern that takes none');
        if (needs.includes('month')) {
            if (!Number.isInteger(p.month) || p.month < 1 || p.month > 12) throw bad('month');
            pattern.month = p.month;
        } else if (p.month !== undefined && p.month !== 0) throw bad('month on a pattern that takes none');
        if (type.startsWith('relative')) {
            const index = String(p.index ?? 'first').toLowerCase();
            if (!INDEXES.includes(index)) throw bad('index');
            pattern.index = index;
        }
        const first = String(p.firstDayOfWeek ?? 'sunday').toLowerCase();
        if (!DAY_NAMES.includes(first)) throw bad('firstDayOfWeek');
        if (type === 'weekly') pattern.firstDayOfWeek = first;
        const rangeType = ['endDate', 'noEnd', 'numbered'].find((t) => t.toLowerCase() === String(r.type ?? '').toLowerCase());
        if (rangeType === undefined) throw bad('range type');
        if (!isDay(r.startDate)) throw bad('range startDate');
        const range = { type: rangeType, startDate: r.startDate };
        if (rangeType === 'endDate') {
            if (!isDay(r.endDate) || r.endDate < r.startDate) throw bad('range endDate');
            range.endDate = r.endDate;
        }
        if (rangeType === 'numbered') {
            if (!Number.isInteger(r.numberOfOccurrences) || r.numberOfOccurrences < 1) throw bad('numberOfOccurrences');
            range.numberOfOccurrences = r.numberOfOccurrences;
        }
        if (typeof r.recurrenceTimeZone === 'string' && r.recurrenceTimeZone !== '') range.recurrenceTimeZone = r.recurrenceTimeZone;
        return { pattern, range };
    }

    /** Event fields from Graph's JSON, as the stand-in keeps them. */
    fields(input) {
        const out = {};
        if (input === null || typeof input !== 'object') throw graphError(400, 'UnableToDeserializePostBody', 'The body is not an event.');
        for (const key of ['subject', 'isReminderOn', 'reminderMinutesBeforeStart', 'isAllDay', 'isCancelled', 'isOrganizer', 'importance',
            'onlineMeeting', 'responseStatus', 'originalStartTimeZone', 'originalEndTimeZone', 'iCalUId', 'organizer']) {
            if (key in input) out[key] = input[key];
        }
        if ('categories' in input) out.categories = Array.isArray(input.categories) ? [...input.categories] : [];
        if ('showAs' in input) {
            if (!SHOW_AS.includes(input.showAs)) throw graphError(400, 'ErrorInvalidRequest', 'showAs is not valid.');
            out.showAs = input.showAs;
        }
        if ('sensitivity' in input) {
            if (!SENSITIVITIES.includes(input.sensitivity)) throw graphError(400, 'ErrorInvalidRequest', 'sensitivity is not valid.');
            out.sensitivity = input.sensitivity;
        }
        if ('body' in input) out.body = { contentType: String(input.body?.contentType ?? 'text').toLowerCase(), content: String(input.body?.content ?? '') };
        if ('location' in input) out.location = { displayName: String(input.location?.displayName ?? '') };
        if ('start' in input) out.start = this.when(input.start, 'start');
        if ('end' in input) out.end = this.when(input.end, 'end');
        if ('attendees' in input) {
            out.attendees = (Array.isArray(input.attendees) ? input.attendees : []).map((a) => {
                if (typeof a?.emailAddress?.address !== 'string') throw graphError(400, 'ErrorInvalidRecipients', 'An attendee has no address.');
                if (a.type !== undefined && !['required', 'optional', 'resource'].includes(a.type)) throw graphError(400, 'ErrorInvalidRequest', 'An attendee type is not valid.');
                return {
                    type: a.type ?? 'required',
                    status: a.status ?? { response: 'none', time: NO_TIME },
                    emailAddress: { name: a.emailAddress.name ?? a.emailAddress.address, address: a.emailAddress.address },
                };
            });
        }
        if ('recurrence' in input) out.recurrence = input.recurrence === null ? null : this.recurrence(input.recurrence);
        return out;
    }

    /** Check an event's times as Graph does. */
    check(ev) {
        if (ev.start === undefined || ev.end === undefined) throw graphError(400, 'ErrorInvalidRequest', 'An event needs a start and an end.');
        if (ev.isAllDay) {
            if (!ev.start.dateTime.endsWith('T00:00:00') || !ev.end.dateTime.endsWith('T00:00:00') || ev.start.timeZone !== ev.end.timeZone) {
                throw graphError(400, 'ErrorPropertyValidationFailure', 'An all-day event starts and ends at midnight in one time zone.');
            }
        }
        const start = toInstant(ev.start.dateTime, zoneOf(ev.start.timeZone), 'UTC');
        const end = toInstant(ev.end.dateTime, zoneOf(ev.end.timeZone), 'UTC');
        if (end < start || (ev.isAllDay && end === start)) throw graphError(400, 'ErrorInvalidRequest', 'The end is before the start.');
        if (ev.recurrence && ev.recurrence.range.startDate !== ev.start.dateTime.slice(0, 10)) {
            throw graphError(400, 'ErrorPropertyValidationFailure', 'At least one property failed validation: the range starts on another day than the event.');
        }
    }

    createEvent(calendarId, input, seeding = false) {
        if (!seeding) this.writable(calendarId);
        else this.calendar(calendarId);
        const now = new Date().toISOString();
        const ev = {
            id: `AAMkAGev${++this.serial}-x_AAA=`,
            calendarId,
            iCalUId: newGlobalId(),
            changeKey: newChangeKey(),
            createdDateTime: now,
            lastModifiedDateTime: now,
            subject: '',
            body: { contentType: 'text', content: '' },
            isAllDay: false,
            isCancelled: false,
            showAs: 'busy',
            sensitivity: 'normal',
            importance: 'normal',
            categories: [],
            isReminderOn: true,
            reminderMinutesBeforeStart: 15,
            location: { displayName: '' },
            attendees: [],
            organizer: { emailAddress: { name: this.user.displayName, address: this.user.mail } },
            isOrganizer: true,
            responseStatus: { response: 'organizer', time: NO_TIME },
            onlineMeeting: null,
            recurrence: null,
            exceptions: new Map(),
            cancelled: new Set(),
            ...this.fields(input),
        };
        this.check(ev);
        this.events.set(ev.id, ev);
        return ev;
    }

    /** An event, or one occurrence of a series: {ev} or {master, day}. */
    find(id) {
        const ev = this.events.get(id);
        if (ev !== undefined) return { ev };
        const m = /^(.+)_OCC(\d{4})(\d{2})(\d{2})$/.exec(id);
        if (m === null) return undefined;
        const master = this.events.get(m[1]);
        const day = `${m[2]}-${m[3]}-${m[4]}`;
        if (master?.recurrence === null || master === undefined || master.cancelled.has(day)) return undefined;
        if (!this.seriesDays(master, day).includes(day)) return undefined;
        return { master, day };
    }

    /** The days (YYYY-MM-DD) a series falls on, through `lastDay` (cancelled ones too: they count toward a numbered range). */
    seriesDays(master, lastDay) {
        const { pattern, range } = master.recurrence;
        const out = [];
        const stop = range.type === 'endDate' && range.endDate < lastDay ? range.endDate : lastDay;
        const most = range.type === 'numbered' ? range.numberOfOccurrences : Infinity;
        for (let day = range.startDate, i = 0; day <= stop && out.length < most && i < 40_000; day = addDays(day, 1), i++) {
            if (patternHits(pattern, range.startDate, day)) out.push(day);
        }
        return out;
    }

    /** One occurrence as an event the stand-in can render. */
    occurrence(master, day) {
        const override = master.exceptions.get(day);
        const time = master.start.dateTime.slice(11);
        const startLocal = `${day}T${time}`;
        const length = wallMs(master.end.dateTime) - wallMs(master.start.dateTime);
        const { exceptions, cancelled, ...base } = master;
        return {
            ...base,
            start: { dateTime: startLocal, timeZone: master.start.timeZone },
            end: { dateTime: wallOf(wallMs(startLocal) + length), timeZone: master.end.timeZone },
            ...override?.fields,
            id: this.occurrenceId(master.id, day),
            type: override === undefined ? 'occurrence' : 'exception',
            seriesMasterId: master.id,
            originalStart: isoZ(toInstant(startLocal, zoneOf(master.start.timeZone), 'UTC')),
            iCalUId: occurrenceGlobalId(master.iCalUId, day),
            changeKey: override === undefined ? master.changeKey : `${master.changeKey}${override.changeKey}`,
            recurrence: null,
        };
    }

    /** The event a find() result stands for. */
    resolve(found) {
        return found.ev ?? this.occurrence(found.master, found.day);
    }

    /** An event (or occurrence) as Graph's JSON, its times in the zone named. */
    render(found, zoneName = 'UTC') {
        const ev = found.id !== undefined ? found : this.resolve(found);
        const outZone = zoneOf(zoneName) ?? 'UTC';
        const time = (dtz) => {
            if (ev.isAllDay) return { dateTime: `${dtz.dateTime.slice(0, 10)}T00:00:00.0000000`, timeZone: zoneName };
            const ms = toInstant(dtz.dateTime, zoneOf(dtz.timeZone), 'UTC');
            return { dateTime: `${toLocal(ms, outZone)}.0000000`, timeZone: zoneName };
        };
        const type = ev.type ?? (ev.recurrence ? 'seriesMaster' : 'singleInstance');
        const json = {
            '@odata.etag': `W/"${ev.changeKey}"`,
            id: ev.id,
            createdDateTime: ev.createdDateTime,
            lastModifiedDateTime: ev.lastModifiedDateTime,
            changeKey: ev.changeKey,
            categories: ev.categories,
            transactionId: null,
            originalStartTimeZone: ev.originalStartTimeZone ?? ev.start.timeZone,
            originalEndTimeZone: ev.originalEndTimeZone ?? ev.end.timeZone,
            iCalUId: ev.iCalUId,
            reminderMinutesBeforeStart: ev.reminderMinutesBeforeStart,
            isReminderOn: ev.isReminderOn,
            hasAttachments: false,
            subject: ev.subject,
            bodyPreview: preview(ev.body),
            importance: ev.importance,
            sensitivity: ev.sensitivity,
            isAllDay: ev.isAllDay,
            isCancelled: ev.isCancelled,
            isOrganizer: ev.isOrganizer,
            responseRequested: true,
            seriesMasterId: ev.seriesMasterId ?? null,
            showAs: ev.showAs,
            type,
            webLink: `${this.origin}/owa/?itemid=${encodeURIComponent(ev.id)}&exvsurl=1&path=/calendar/item`,
            onlineMeetingUrl: null,
            isOnlineMeeting: ev.onlineMeeting !== null && ev.onlineMeeting !== undefined,
            onlineMeetingProvider: ev.onlineMeeting ? 'teamsForBusiness' : 'unknown',
            allowNewTimeProposals: true,
            isDraft: false,
            hideAttendees: false,
            responseStatus: ev.responseStatus,
            body: ev.body,
            start: time(ev.start),
            end: time(ev.end),
            location: { displayName: ev.location.displayName, locationType: 'default', uniqueIdType: 'unknown', address: {}, coordinates: {} },
            locations: ev.location.displayName === '' ? [] : [{ displayName: ev.location.displayName, locationType: 'default', uniqueIdType: 'unknown' }],
            recurrence: type === 'seriesMaster' ? this.recurrenceJson(ev) : null,
            attendees: ev.attendees,
            organizer: ev.organizer,
            onlineMeeting: ev.onlineMeeting ?? null,
        };
        if (ev.originalStart !== undefined) json.originalStart = ev.originalStart;
        return json;
    }

    /** A series' recurrence as Graph sends it: every property, the unused ones empty. */
    recurrenceJson(ev) {
        const { pattern, range } = ev.recurrence;
        return {
            pattern: { type: pattern.type, interval: pattern.interval, month: 0, dayOfMonth: 0, daysOfWeek: [], firstDayOfWeek: 'sunday', index: 'first', ...pattern },
            range: { type: range.type, startDate: range.startDate, endDate: '0001-01-01', recurrenceTimeZone: ev.start.timeZone, numberOfOccurrences: 0, ...range },
        };
    }

    /** When an event (or occurrence) starts and ends, as epoch ms; all-day ones as UTC days, as Graph's calendar view reads them. */
    span(ev) {
        if (ev.isAllDay) return [Date.parse(`${ev.start.dateTime.slice(0, 10)}T00:00:00Z`), Date.parse(`${ev.end.dateTime.slice(0, 10)}T00:00:00Z`)];
        return [toInstant(ev.start.dateTime, zoneOf(ev.start.timeZone), 'UTC'), toInstant(ev.end.dateTime, zoneOf(ev.end.timeZone), 'UTC')];
    }

    /** A series' occurrences (and exceptions) that overlap [from, to). */
    occurrencesIn(master, from, to) {
        const out = [];
        for (const day of this.seriesDays(master, dayOfMs(to + 2 * DAY))) {
            if (master.cancelled.has(day)) continue;
            const occurrence = this.occurrence(master, day);
            const [start, end] = this.span(occurrence);
            if (start < to && (end > from || (start === end && start >= from))) out.push(occurrence);
        }
        return out;
    }

    /** The calendar view of [from, to): occurrences, exceptions and single events, as Graph JSON by id. */
    view(calendarId, from, to, zoneName = 'UTC') {
        const out = new Map();
        const rows = [];
        for (const ev of this.events.values()) {
            if (ev.calendarId !== calendarId) continue;
            if (ev.recurrence) {
                rows.push(...this.occurrencesIn(ev, from, to));
                continue;
            }
            const [start, end] = this.span(ev);
            if (start < to && (end > from || (start === end && start >= from))) rows.push(ev);
        }
        rows.sort((a, b) => this.span(a)[0] - this.span(b)[0]);
        for (const ev of rows) out.set(ev.id, this.render(ev, zoneName));
        return out;
    }

    /** Start a delta round: everything (first round) or what changed since `seen` (id → etag). */
    startRound(calendarId, from, to, seen, zoneName) {
        const current = this.view(calendarId, from, to, zoneName);
        const entries = [];
        for (const [id, json] of current) {
            if (seen !== null && seen.get(id) === json['@odata.etag']) continue;
            entries.push(seen !== null && this.sparseDelta ? { '@odata.type': '#microsoft.graph.event', '@odata.etag': json['@odata.etag'], id } : json);
        }
        if (seen !== null) {
            for (const id of seen.keys()) if (!current.has(id)) entries.push({ '@odata.type': '#microsoft.graph.event', id, '@removed': { reason: 'deleted' } });
        }
        const deltaToken = newToken();
        this.deltaTokens.set(deltaToken, { calendarId, from, to, seen: new Map([...current].map(([id, json]) => [id, json['@odata.etag']])) });
        return { entries, deltaToken };
    }

    /** One page of a round, with the link to the next page or to the next round. */
    page(round, size, base) {
        const value = round.entries.splice(0, size);
        const body = { '@odata.context': `${this.origin}/v1.0/$metadata#Collection(event)`, value };
        if (round.entries.length > 0) {
            const skip = newToken();
            this.rounds.set(skip, round);
            body['@odata.nextLink'] = `${base}?$skiptoken=${skip}`;
        } else {
            body['@odata.deltaLink'] = `${base}?$deltatoken=${round.deltaToken}`;
        }
        return body;
    }

    /** PATCH: change an event or a series, or turn one occurrence into an exception. */
    patch(id, input, seeding = false) {
        const found = this.find(id);
        if (found === undefined) throw graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
        const owner = found.ev ?? found.master;
        if (!seeding) this.writable(owner.calendarId);
        const changes = this.fields(input);
        const now = new Date().toISOString();
        if (found.ev !== undefined) {
            const ev = found.ev;
            const merged = { ...ev, ...changes };
            this.check(merged);
            // Exchange drops a series' exceptions when its pattern or start changes.
            if (ev.recurrence && ('recurrence' in changes || 'start' in changes)) {
                merged.exceptions = new Map();
                merged.cancelled = new Set();
            }
            Object.assign(ev, merged, { changeKey: newChangeKey(), lastModifiedDateTime: now });
            return ev;
        }
        if ('recurrence' in changes) throw graphError(400, 'ErrorInvalidRequest', 'An occurrence can\'t have a recurrence of its own.');
        const { master, day } = found;
        const override = master.exceptions.get(day) ?? { fields: {} };
        const next = { fields: { ...override.fields, ...changes, lastModifiedDateTime: now }, changeKey: newChangeKey() };
        this.check({ ...this.occurrence(master, day), ...next.fields, recurrence: null });
        master.exceptions.set(day, next);
        return this.occurrence(master, day);
    }

    /**
     * Graph's If-Match: a PATCH or DELETE that names an etag goes through
     * only while the event (or occurrence) still has it ('*': any), else
     * 412. Weak and strong forms of a tag are the same tag.
     */
    precondition(id, ifMatch) {
        if (ifMatch === undefined) return;
        const found = this.find(id);
        if (found === undefined) throw graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
        const tags = String(ifMatch).split(',').map((tag) => tag.trim().replace(/^W\//, ''));
        if (tags.includes('*') || tags.includes(`"${this.resolve(found).changeKey}"`)) return;
        throw graphError(412, 'ErrorIrresolvableConflict', 'The send or update operation could not be performed because the change key passed in the request does not match the current change key for the item.');
    }

    /** DELETE: an event or a series goes; an occurrence is cancelled. */
    remove(id, check = false) {
        const found = this.find(id);
        if (found === undefined) throw graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
        if (check) this.writable((found.ev ?? found.master).calendarId);
        if (found.ev !== undefined) {
            this.events.delete(id);
            return;
        }
        found.master.cancelled.add(found.day);
        found.master.exceptions.delete(found.day);
    }

    /** accept, decline or tentativelyAccept. */
    answer(id, action, input) {
        const found = this.find(id);
        if (found === undefined) throw graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
        const ev = found.ev ?? found.master;
        if (ev.isOrganizer) throw graphError(400, 'ErrorInvalidRequest', 'Your request can\'t be completed. You can\'t respond to a meeting you organized.');
        const response = { accept: 'accepted', decline: 'declined', tentativelyAccept: 'tentativelyAccepted' }[action];
        this.responses.push({ id, action, sendResponse: input?.sendResponse ?? true });
        const status = { response, time: new Date().toISOString() };
        const attendees = (found.ev ?? this.occurrence(found.master, found.day)).attendees.map((a) => (
            a.emailAddress.address.toLowerCase() === this.user.mail.toLowerCase() ? { ...a, status } : a));
        if (found.ev !== undefined) Object.assign(found.ev, { responseStatus: status, attendees, changeKey: newChangeKey() });
        else this.patch(id, { responseStatus: status, attendees }, true);
    }
}

/** Whether a request (path and query) matches a test's pattern. */
function matches(pattern, text) {
    return pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
}

function reply(res, status, body, headers = {}) {
    if (body === undefined) {
        res.writeHead(status, headers);
        res.end();
        return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
}

function errorBody(error) {
    if (error.oauth) {
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
        return { error: error.code, error_description: error.message, error_codes: [Number(/AADSTS(\d+)/.exec(error.message)?.[1] ?? 0)], timestamp: now, trace_id: newToken(8), correlation_id: newToken(8) };
    }
    return { error: { code: error.code, message: error.message, innerError: { date: isoZ(Date.now()), 'request-id': newToken(8), 'client-request-id': newToken(8) } } };
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

/** The sign-in service's routes. */
function login(store, method, segments, form) {
    // {tenant}/oauth2/v2.0/{devicecode|token}
    if (method !== 'POST' || segments.length !== 4 || segments[1] !== 'oauth2' || segments[2] !== 'v2.0') return undefined;
    store.tenants.push(segments[0]);
    if (segments[3] === 'devicecode') return [200, store.deviceCode(form)];
    if (segments[3] === 'token') return [200, store.token(form)];
    return undefined;
}

/** Graph's routes. */
function graph(store, method, segments, query, input, prefer, ifMatch) {
    const zoneName = prefer['outlook.timezone'] ?? 'UTC';
    if (zoneOf(zoneName) === null) throw graphError(400, 'TimeZoneNotSupportedException', 'The time zone in the Prefer header is not supported.');
    const size = Math.max(1, Math.min(Number(prefer['odata.maxpagesize']) || 10, store.pageSize));
    const [me, collection, id, sub, leaf] = segments;
    if (me !== 'me') return undefined;
    if (collection === undefined && method === 'GET') {
        const { id: userId, displayName, mail, userPrincipalName } = store.user;
        return [200, { '@odata.context': `${store.origin}/v1.0/$metadata#users/$entity`, businessPhones: [], displayName, givenName: null, jobTitle: null, mail, mobilePhone: null, officeLocation: null, preferredLanguage: 'en-US', surname: null, userPrincipalName, id: userId }];
    }
    if (collection === 'calendars' && id === undefined && method === 'GET') {
        const all = [...store.calendars.values()];
        const skip = Number(query.$skip ?? 0) || 0;
        const value = all.slice(skip, skip + store.pageSize).map((c) => ({
            '@odata.id': `${store.origin}/v1.0/users('${store.user.id}')/calendars('${c.id}')`,
            id: c.id, name: c.name, color: c.color, hexColor: c.hexColor, isDefaultCalendar: c.isDefaultCalendar, changeKey: c.changeKey,
            canShare: c.canEdit, canViewPrivateItems: true, canEdit: c.canEdit, allowedOnlineMeetingProviders: ['teamsForBusiness'],
            defaultOnlineMeetingProvider: 'teamsForBusiness', isTallyingResponses: true, isRemovable: !c.isDefaultCalendar, owner: c.owner,
        }));
        const body = { '@odata.context': `${store.origin}/v1.0/$metadata#users('${store.user.id}')/calendars`, value };
        if (skip + store.pageSize < all.length) body['@odata.nextLink'] = `${store.origin}/v1.0/me/calendars?$skip=${skip + store.pageSize}`;
        return [200, body];
    }
    if (collection === 'calendars' && sub === 'calendarView' && leaf === 'delta' && segments.length === 5 && method === 'GET') {
        store.calendar(id);
        const base = `${store.origin}/v1.0/me/calendars/${encodeURIComponent(id)}/calendarView/delta`;
        const refuse = () => {
            throw graphError(store.refusal.status, store.refusal.code, 'The sync state is not valid any more; start a new sync.');
        };
        if (query.$skiptoken !== undefined) {
            const round = store.rounds.get(query.$skiptoken);
            if (round === undefined) refuse();
            store.rounds.delete(query.$skiptoken);
            return [200, store.page(round, size, base)];
        }
        if (query.$deltatoken !== undefined) {
            const known = store.deltaTokens.get(query.$deltatoken);
            if (known === undefined || known.calendarId !== id) refuse();
            return [200, store.page(store.startRound(id, known.from, known.to, known.seen, zoneName), size, base)];
        }
        const from = queryTime(query.startdatetime);
        const to = queryTime(query.enddatetime);
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
            throw graphError(400, 'ErrorInvalidParameter', 'This request requires a time window specified by the query string parameters StartDateTime and EndDateTime.');
        }
        return [200, store.page(store.startRound(id, from, to, null, zoneName), size, base)];
    }
    if (collection === 'calendars' && sub === 'events' && segments.length === 4 && method === 'POST') {
        return [201, store.render(store.createEvent(id, input), zoneName)];
    }
    if (collection !== 'events' || id === undefined) return undefined;
    if (sub === undefined) {
        if (method === 'GET') {
            const found = store.find(id);
            if (found === undefined) throw graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
            return [200, store.render(found, zoneName)];
        }
        if (method === 'PATCH') {
            store.precondition(id, ifMatch);
            return [200, store.render(store.patch(id, input), zoneName)];
        }
        if (method === 'DELETE') {
            store.precondition(id, ifMatch);
            store.remove(id, true);
            return [204, undefined];
        }
        return undefined;
    }
    if (sub === 'instances' && method === 'GET' && segments.length === 4) {
        const master = store.events.get(id);
        if (master === undefined) throw graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
        const from = queryTime(query.startdatetime);
        const to = queryTime(query.enddatetime);
        if (!Number.isFinite(from) || !Number.isFinite(to)) throw graphError(400, 'ErrorInvalidParameter', 'StartDateTime and EndDateTime are required.');
        const all = master.recurrence ? store.occurrencesIn(master, from, to) : [];
        // Pages as Graph's lists have them: $skip in the next page's link.
        const skip = Math.max(0, Number(query.$skip ?? 0) || 0);
        const value = all.slice(skip, skip + size).map((o) => store.render(o, zoneName));
        const body = { '@odata.context': `${store.origin}/v1.0/$metadata#Collection(event)`, value };
        if (skip + size < all.length) {
            const window = `startDateTime=${encodeURIComponent(query.startdatetime)}&endDateTime=${encodeURIComponent(query.enddatetime)}`;
            body['@odata.nextLink'] = `${store.origin}/v1.0/me/events/${encodeURIComponent(id)}/instances?${window}&$skip=${skip + size}`;
        }
        return [200, body];
    }
    if (['accept', 'decline', 'tentativelyAccept'].includes(sub) && method === 'POST' && segments.length === 4) {
        store.answer(id, sub, input);
        return [202, undefined];
    }
    return undefined;
}

/** One request: logged, then a test's failure, a route, or 404. */
async function handle(store, req, res) {
    const url = new URL(req.url, store.origin);
    const raw = await readBody(req);
    const type = String(req.headers['content-type'] ?? '');
    let input;
    if (type.includes('application/x-www-form-urlencoded')) {
        input = Object.fromEntries(new URLSearchParams(raw));
    } else if (raw !== '') {
        try {
            input = JSON.parse(raw);
        } catch {
            return reply(res, 400, errorBody(graphError(400, 'UnableToDeserializePostBody', 'The body is not JSON.')));
        }
    }
    // Lower-case query names: Graph reads startDateTime and startdatetime alike.
    const query = {};
    for (const [key, value] of url.searchParams) query[key.startsWith('$') ? key : key.toLowerCase()] = value;
    const logged = input !== null && typeof input === 'object' && !Array.isArray(input) ? { ...input } : input;
    for (const secret of ['refresh_token', 'device_code', 'client_secret']) if (logged?.[secret] !== undefined) logged[secret] = '(left out)';
    const path = decodeURIComponent(url.pathname);
    const ifMatch = req.headers['if-match'];
    const entry = { method: req.method, path, search: url.search, query, prefer: String(req.headers.prefer ?? ''), ifMatch, body: logged };
    store.requests.push(entry);
    const answer = (status, body, headers) => {
        entry.status = status;
        return reply(res, status, body, headers);
    };

    const failure = store.failures.find((f) => (f.method === undefined || f.method === req.method) && matches(f.path, `${path}${url.search}`));
    if (failure !== undefined) {
        failure.times -= 1;
        if (failure.times <= 0) store.failures.splice(store.failures.indexOf(failure), 1);
        if (failure.drop) {
            req.socket.destroy();
            return undefined;
        }
        const body = failure.body ?? errorBody(graphError(failure.status, failure.code ?? 'ErrorStandInFailure', 'A failure the test asked for.'));
        return answer(failure.status, body, failure.headers);
    }

    const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    try {
        let routed;
        if (segments[0] === 'login') {
            routed = login(store, req.method, segments.slice(1), input ?? {});
        } else if (segments[0] === 'v1.0') {
            const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
            if (token === undefined || !store.accessTokens.has(token)) {
                throw graphError(401, 'InvalidAuthenticationToken', 'Access token has expired or is not yet valid.');
            }
            routed = graph(store, req.method, segments.slice(1), query, input, preferences(req.headers.prefer), ifMatch);
        }
        if (routed === undefined) throw graphError(400, 'BadRequest', `Resource not found for the segment '${segments.at(-1) ?? ''}'.`);
        return answer(routed[0], routed[1]);
    } catch (error) {
        if (error instanceof StandInError) return answer(error.status, errorBody(error), error.headers);
        return answer(500, errorBody(graphError(500, 'InternalServerError', String(error?.message ?? error))));
    }
}

/**
 * Start the stand-in on a free port of 127.0.0.1.
 * @returns {Promise<{origin: string, graphBase: string, loginBase: string,
 *   settings: {microsoftClientId: string, microsoftGraphBase: string, microsoftLoginBase: string},
 *   store: Store, close: () => Promise<void>}>}
 */
export async function start() {
    const store = new Store();
    const server = createServer((req, res) => {
        handle(store, req, res).catch(() => {
            if (!res.headersSent) reply(res, 500, { error: { code: 'InternalServerError', message: 'The stand-in failed.' } });
            else res.destroy();
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    store.origin = `http://127.0.0.1:${server.address().port}`;
    const graphBase = `${store.origin}/v1.0`;
    const loginBase = `${store.origin}/login`;
    return {
        origin: store.origin,
        graphBase,
        loginBase,
        settings: { microsoftClientId: store.clientId, microsoftGraphBase: graphBase, microsoftLoginBase: loginBase },
        store,
        close: () => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        }),
    };
}
