/**
 * Google Calendar (API v3) as an 'events' source: the account's calendar
 * list, an incremental sync per calendar with Google's sync tokens, and
 * changes through events.insert / patch / delete.
 *
 * - Sign-in is OAuth 2.0 for desktop apps (lib/oauth.js) with a Desktop
 *   OAuth client the user makes in Google Cloud; its id and secret come
 *   from the settings (googleClientId, googleClientSecret), never from here.
 *   It asks for the events and the list of calendars only (SCOPES); a grant
 *   from an earlier sign-in, with Google's broad calendar scope, works too.
 *   The grant lives in the account's secret; each request takes a fresh
 *   access token from it, and a 401 renews it once and tries again.
 *   Removing the account ends the grant at Google as well (revoke).
 * - Sync lists events with singleEvents=false and showDeleted=true, so a
 *   series comes as its master (RRULE, RDATE, EXDATE lines) plus its
 *   changed occurrences (recurringEventId + originalStartTime), and a
 *   cancelled occurrence comes as a cancelled exception. A 410 means Google
 *   dropped the sync token: the calendar is read whole again.
 * - Times: Google sends dateTime in the calendar's zone and names the
 *   event's own zone in timeZone; records keep the wall clock in the event's
 *   zone (the calendar's when the event has none). Written back, a time is
 *   that wall clock with its offset, plus the zone.
 * - One occurrence of a series is found with events.instances around its
 *   original start, else by Google's id convention: <master id>_<UTC
 *   start, YYYYMMDDTHHMMSSZ>, or <master id>_<YYYYMMDD> for all-day series.
 * - Every change to an event is conditional (If-Match): on the etag held
 *   here, else on the one read just before (an occurrence found with
 *   events.instances or by Google's id convention, a series found from its
 *   occurrence), and then only while the event names nobody the change
 *   wasn't worked out with (newPeople). 412 is a conflict.
 * - A new event asks for an id made from its uid, so a create sent again
 *   (its answer never came) finds the event the first one made.
 *
 * Nothing here logs or puts in a message a token, a code, the client
 * secret, event text or a URL with its query.
 *
 * @module dsh-plugin-calendar/sources/google
 */
import { createHash } from 'node:crypto';
import { HttpError, formBody } from '../http.js';
import { cleanRecord, instantOf } from '../model.js';
import { SIGN_IN_ENDED, accessToken, idTokenClaims, loopbackSignIn, retryAfter } from '../oauth.js';
import { addDays, daysBetween, ianaZone, isDay, normalLocal, offsetAt, toInstant, toLocal } from '../zones.js';
import { SourceError, otherPeople, peopleConflict, statusError } from './index.js';

export const kind = 'google';
export const style = 'events';

/** Google's own addresses; tests point the settings of the same names at a stand-in. */
export const DEFAULTS = {
    googleApiBase: 'https://www.googleapis.com/calendar/v3',
    googleAuthorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    googleTokenUrl: 'https://oauth2.googleapis.com/token',
    googleUserinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    googleRevokeUrl: 'https://oauth2.googleapis.com/revoke',
};

/** The Google Account page where the user sees which apps can reach their account, and removes one (Linked apps). */
export const MANAGE_URL = 'https://myaccount.google.com/linkedapps';

const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
/** What sign-in asked for before: it also allows sharing and deleting calendars. */
const BROAD_SCOPE = 'https://www.googleapis.com/auth/calendar';

/**
 * What a sign-in asks for: the events on every calendar (list, read, add,
 * change, delete), the list of calendars (read only), and which address
 * signed in. Not the broad calendar scope, which also allows sharing and
 * deleting calendars: the plugin does neither.
 */
export const SCOPES = [EVENTS_SCOPE, LIST_SCOPE, 'openid', 'email'];

/**
 * What the plugin needs of a grant, and the scopes that allow each (Google's
 * API reference). The broad scope allows both, so a grant from an earlier
 * sign-in still works. `what` and `permission` say it to the user.
 */
const NEEDS = [
    { what: 'your events', permission: 'to view and edit events', scopes: [EVENTS_SCOPE, BROAD_SCOPE] },
    {
        what: 'your list of calendars', permission: 'to see your list of calendars',
        scopes: [LIST_SCOPE, 'https://www.googleapis.com/auth/calendar.calendarlist', 'https://www.googleapis.com/auth/calendar.readonly', BROAD_SCOPE],
    },
];

/** How long revoking may take: removing the account waits for it. */
const REVOKE_TIMEOUT_MS = 15_000;

/** How many ids made from one uid a new event tries (a deleted event keeps its id) before Google picks one. */
const ID_TRIES = 5;

const DAY_MS = 86_400_000;
/** events.list page size (Google's most). */
const EVENTS_PAGE = 2500;
/** A stop for a server that never stops paging. */
const MAX_PAGES = 1000;

const RESPONSE_IN = { needsAction: 'needs-action', accepted: 'accepted', declined: 'declined', tentative: 'tentative' };
const RESPONSE_OUT = { 'needs-action': 'needsAction', accepted: 'accepted', declined: 'declined', tentative: 'tentative' };
const PRIVACY = { public: 'public', private: 'private', confidential: 'confidential' };
const STATUSES = new Set(['confirmed', 'tentative', 'cancelled']);
/** Error reasons that mean "slow down" (403 or 429), and ones that mean the grant lacks calendar access. */
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded', 'RATE_LIMIT_EXCEEDED']);
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);
/** Event types that aren't events to show: a working location is a status line in Google's own app. */
const SKIPPED_TYPES = new Set(['workingLocation']);

/** The API and OAuth addresses, from the settings or Google's own. */
function endpoints(settings = {}) {
    const pick = (key) => (typeof settings?.[key] === 'string' && settings[key].trim() !== '' ? settings[key].trim() : DEFAULTS[key]);
    return {
        api: pick('googleApiBase').replace(/\/+$/, ''),
        authorize: pick('googleAuthorizeUrl'),
        token: pick('googleTokenUrl'),
        userinfo: pick('googleUserinfoUrl'),
        revoke: pick('googleRevokeUrl'),
    };
}

/** The OAuth client from the settings, or what to set. */
function clientOf(settings = {}) {
    const clientId = typeof settings?.googleClientId === 'string' ? settings.googleClientId.trim() : '';
    const clientSecret = typeof settings?.googleClientSecret === 'string' ? settings.googleClientSecret.trim() : '';
    if (clientId === '' || clientSecret === '') {
        throw new SourceError('config', 'Google Calendar needs an OAuth client: make a "Desktop app" OAuth client in Google Cloud Console and set googleClientId and googleClientSecret in the calendar plugin\'s settings to its client id and secret.');
    }
    return { clientId, clientSecret };
}

/**
 * Signs in to Google in the browser. Open `url` (or show it); `done`
 * settles when the browser comes back to this computer. When it can't
 * (DSH used from another device), the user pastes the address the browser
 * ended on into `finish`. The grant isn't saved here: the caller stores it
 * as the new account's secret.
 * @param {object} env - a source env (request, settings, now).
 * @param {{loginHint?: string, timeoutMs?: number}} [options] - loginHint: the address to sign in as.
 * @returns {Promise<{url: string, redirectUri: string,
 *   done: Promise<{grant: object, email?: string, name?: string}>,
 *   finish: (pastedUrl: string) => Promise<{grant: object, email?: string, name?: string}>,
 *   cancel: () => void}>}
 */
export async function signIn(env, options = {}) {
    const { clientId, clientSecret } = clientOf(env.settings);
    const urls = endpoints(env.settings);
    const extraParams = { access_type: 'offline', prompt: 'consent' };
    if (typeof options.loginHint === 'string' && options.loginHint !== '') extraParams.login_hint = options.loginHint;
    const flow = await loopbackSignIn({
        authorizeUrl: urls.authorize, tokenUrl: urls.token, clientId, clientSecret, scopes: SCOPES, extraParams,
        request: env.request, timeoutMs: options.timeoutMs, now: env.now ?? Date.now,
    });
    const done = flow.done.then(async (grant) => {
        // Google lets the user untick each permission on the consent page.
        const missing = missingNeeds(grant.scope);
        if (missing.length > 0) throw new SourceError('auth', missingText(missing));
        return { grant, ...(await whoSignedIn(env, grant, clientId, urls.userinfo)) };
    });
    done.catch(() => {});
    return {
        url: flow.url,
        redirectUri: flow.redirectUri,
        done,
        finish: async (pastedUrl) => {
            await flow.finish(pastedUrl);
            return done;
        },
        cancel: flow.cancel,
    };
}

/** The needs (NEEDS) a grant's scopes don't meet; none when Google didn't say which it gave. */
function missingNeeds(scope) {
    if (typeof scope !== 'string') return [];
    const granted = new Set(scope.split(/\s+/));
    return NEEDS.filter((need) => !need.scopes.some((s) => granted.has(s)));
}

/** In words, what a sign-in didn't give, and what to do about it. */
function missingText(missing) {
    const what = missing.map((need) => need.what).join(' or ');
    const tick = missing.length > 1 ? 'both calendar permissions are' : `the permission ${missing[0].permission} is`;
    return `Google didn't give access to ${what}. Sign in again and make sure ${tick} ticked.`;
}

/**
 * Ends the grant at Google, for an account being removed, so it stops
 * working there too and not only here. The refresh token (else the access
 * token) goes to Google's revoke endpoint, which ends the whole grant.
 * @param {object} env - a source env (request, settings, log).
 * @param {object} secret - the account's grant ({refreshToken, accessToken, ...}), or the secret that holds it (get()).
 * @returns {Promise<{revoked: boolean, manageUrl?: string}>} revoked: Google
 *   ended the grant, or says it had ended already. Otherwise `manageUrl` is
 *   the Google Account page where the user removes the access.
 * @throws {SourceError} 'network' when Google can't be reached.
 */
export async function revoke(env, secret) {
    const grant = typeof secret?.get === 'function' ? await secret.get() : secret;
    const token = text(grant?.refreshToken) ?? text(grant?.accessToken);
    const note = (line) => {
        try {
            env.log?.(`google revoke ${line}`);
        } catch {
            // Logging never stops a removal.
        }
    };
    if (token === undefined) {
        note('no token');
        return { revoked: false, manageUrl: MANAGE_URL };
    }
    let res;
    try {
        res = await env.request(endpoints(env.settings).revoke, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: formBody({ token }),
            timeoutMs: REVOKE_TIMEOUT_MS,
        });
    } catch (error) {
        const failure = fromHttp(error);
        if (!(failure instanceof SourceError) || failure.code === 'network') throw failure;
        note(failure.code);
        return { revoked: false, manageUrl: MANAGE_URL };
    }
    if (res.ok) {
        note('done');
        return { revoked: true };
    }
    // invalid_token: Google no longer knows the token (revoked already, or the user removed the access).
    if (res.status === 400 && oauthError(res.text) === 'invalid_token') {
        note('ended already');
        return { revoked: true };
    }
    note(`refused HTTP ${res.status}`);
    return { revoked: false, manageUrl: MANAGE_URL };
}

/** An OAuth error answer's code, like invalid_token, when it has a well-formed one. */
function oauthError(body) {
    try {
        const code = JSON.parse(body)?.error;
        return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
    } catch {
        return undefined;
    }
}

/** The signed-in address (and name, if Google says it): from the id token, else from userinfo. */
async function whoSignedIn(env, grant, clientId, userinfoUrl) {
    const claims = idTokenClaims(grant.idToken);
    const audience = claims?.aud;
    const forUs = audience === clientId || (Array.isArray(audience) && audience.includes(clientId));
    if (forUs && typeof claims.email === 'string' && claims.email !== '') return person(claims);
    try {
        const res = await env.request(userinfoUrl, { headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: 'application/json' } });
        if (res.ok) return person(JSON.parse(res.text));
    } catch {
        // The sign-in itself worked; the account just has no address to show.
    }
    return {};
}

function person(info) {
    const out = {};
    if (typeof info?.email === 'string' && info.email !== '') out.email = info.email;
    if (typeof info?.name === 'string' && info.name !== '') out.name = info.name;
    return out;
}

/**
 * A source for one Google account.
 * @param {object} account - {id, kind, name, email?}.
 * @param {object} env - see sources/index.js; env.secret holds the grant.
 */
export function create(account, env) {
    return new GoogleCalendar(account, env);
}

class GoogleCalendar {
    constructor(account, env) {
        this.account = account;
        this.env = env;
        /** Series uids by calendar and master id: a cancelled occurrence may come without one. */
        this.uids = new Map();
    }

    get now() {
        return this.env.now ?? Date.now;
    }

    log(line) {
        try {
            this.env.log?.(`google ${this.account?.id ?? ''} ${line}`);
        } catch {
            // Logging never breaks a sync.
        }
    }

    /** The zone for times that name none: the calendar's, else the user's. */
    zoneOf(calendar) {
        return ianaZone(calendar?.timeZone) ?? ianaZone(this.env.zone) ?? 'UTC';
    }

    /**
     * One API request with a fresh access token; a 401 renews the token once
     * and tries again. Answers that aren't a success become SourceErrors.
     */
    async call(method, path, { query, body, etag, what, signal } = {}) {
        const { clientId, clientSecret } = clientOf(this.env.settings);
        const urls = endpoints(this.env.settings);
        const url = new URL(`${urls.api}${path}`);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
        let rejected;
        for (let attempt = 0; ; attempt++) {
            let token;
            try {
                token = await accessToken(this.env.secret, {
                    tokenUrl: urls.token, clientId, clientSecret, request: this.env.request, now: this.now, rejected,
                });
            } catch (error) {
                throw endedSignIn(error);
            }
            const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
            if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
            if (etag) headers['If-Match'] = etag;
            let res;
            try {
                res = await this.env.request(url.toString(), {
                    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal,
                });
            } catch (error) {
                throw fromHttp(error);
            }
            if (res.status === 401 && attempt === 0) {
                rejected = token;
                continue;
            }
            if (res.ok) return res;
            throw googleError(res, what);
        }
    }

    /** A GET that answers JSON. */
    async getJson(path, query, what, signal) {
        return json(await this.call('GET', path, { query, what, signal }), what);
    }

    /** Every page of a list; `onPage` sees each. Returns the last page (it holds nextSyncToken). */
    async pages(path, query, what, signal, onPage) {
        let pageToken;
        const seen = new Set();
        for (let n = 0; n < MAX_PAGES; n++) {
            const page = await this.getJson(path, { ...query, pageToken }, what, signal);
            await onPage(page);
            const next = page?.nextPageToken;
            if (typeof next !== 'string' || next === '') return page;
            if (seen.has(next)) throw new SourceError('server', `${what}: Google sent the same page twice.`);
            seen.add(next);
            pageToken = next;
        }
        throw new SourceError('server', `${what}: Google sent too many pages.`);
    }

    /** The account's calendars, without hidden and deleted ones. The account's own main calendar is `primary`. */
    async calendars() {
        const out = [];
        await this.pages('/users/me/calendarList', { maxResults: 250 }, 'Listing your Google calendars', undefined, (page) => {
            for (const entry of Array.isArray(page?.items) ? page.items : []) {
                if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
                if (entry.hidden === true || entry.deleted === true) continue;
                const calendar = {
                    remoteId: entry.id,
                    name: text(entry.summaryOverride) ?? text(entry.summary) ?? entry.id,
                    readOnly: !(entry.accessRole === 'owner' || entry.accessRole === 'writer'),
                };
                if (entry.primary === true) calendar.primary = true;
                if (text(entry.backgroundColor)) calendar.color = entry.backgroundColor;
                const zone = ianaZone(entry.timeZone);
                if (zone) calendar.timeZone = zone;
                if (text(entry.description)) calendar.description = entry.description;
                out.push(calendar);
            }
        });
        this.log(`calendars ${out.length}`);
        return out;
    }

    /**
     * What changed in a calendar since `state` ({syncToken}). The first sync,
     * and any after Google dropped the token (410), reads it whole.
     */
    async sync(calendar, state, { signal } = {}) {
        const token = typeof state?.syncToken === 'string' && state.syncToken !== '' ? state.syncToken : undefined;
        if (token !== undefined) {
            try {
                return await this.pull(calendar, token, signal);
            } catch (error) {
                if (!(error instanceof SourceError && error.status === 410)) throw error;
                this.log('sync token gone, reading the calendar whole');
            }
        }
        return this.pull(calendar, undefined, signal);
    }

    async pull(calendar, syncToken, signal) {
        const what = 'Syncing a Google calendar';
        const events = [];
        let zone = this.zoneOf(calendar);
        const last = await this.pages(`${calendarPath(calendar)}/events`, {
            singleEvents: false, showDeleted: true, maxResults: EVENTS_PAGE, syncToken,
        }, what, signal, (page) => {
            if (Array.isArray(page?.items)) for (const event of page.items) events.push(event);
            // The calendar's own zone, as Google says it now.
            zone = ianaZone(page?.timeZone) ?? zone;
        });
        const { items, removed } = await this.itemsOf(calendar, events, zone, signal);
        const full = syncToken === undefined;
        this.log(`sync ${full ? 'full' : 'delta'} items=${items.length} removed=${removed.length}`);
        return {
            reset: full,
            items,
            removed: full ? [] : removed,
            state: typeof last?.nextSyncToken === 'string' ? { syncToken: last.nextSyncToken } : {},
        };
    }

    /** Google events as Items, and the ids of those gone. */
    async itemsOf(calendar, events, zone, signal) {
        const byId = new Map();
        for (const event of events) if (event !== null && typeof event === 'object' && typeof event.id === 'string') byId.set(event.id, event);
        // Each live series' uid first: its cancelled occurrences may come without one.
        for (const event of byId.values()) {
            if (event.status === 'cancelled' || typeof event.iCalUID !== 'string') continue;
            if (isMaster(event)) this.uids.set(uidKey(calendar, event.id), event.iCalUID);
            else if (typeof event.recurringEventId === 'string') this.uids.set(uidKey(calendar, event.recurringEventId), event.iCalUID);
        }
        const items = [];
        const removed = [];
        for (const event of byId.values()) {
            if (SKIPPED_TYPES.has(event.eventType)) {
                removed.push(event.id);
            } else if (event.status !== 'cancelled') {
                const item = itemOf(event, zone);
                if (item) items.push(item);
                else this.log('skipped an event without a start');
            } else if (typeof event.recurringEventId !== 'string') {
                // A deleted event or series.
                removed.push(event.id);
                this.uids.delete(uidKey(calendar, event.id));
            } else {
                // A cancelled occurrence stays, so its series skips it; gone with its series.
                const master = byId.get(event.recurringEventId);
                const uid = await this.seriesUid(calendar, event, master, signal);
                const item = uid === undefined ? undefined : cancelledItem(event, uid, zone, master);
                if (item) items.push(item);
                else removed.push(event.id);
            }
        }
        return { items, removed };
    }

    /** The uid of a cancelled occurrence's series, or undefined when the series is gone. */
    async seriesUid(calendar, event, master, signal) {
        if (master !== undefined) return master.status === 'cancelled' ? undefined : text(master.iCalUID) ?? text(event.iCalUID);
        if (text(event.iCalUID)) return event.iCalUID;
        const known = this.uids.get(uidKey(calendar, event.recurringEventId));
        if (known !== undefined) return known;
        try {
            const found = await this.getEvent(calendar, event.recurringEventId, signal);
            if (found?.status === 'cancelled' || !text(found?.iCalUID)) return undefined;
            this.uids.set(uidKey(calendar, event.recurringEventId), found.iCalUID);
            return found.iCalUID;
        } catch (error) {
            if (error instanceof SourceError && error.code === 'not-found') return undefined;
            throw error;
        }
    }

    async getEvent(calendar, id, signal, what = 'Reading an event from Google Calendar') {
        return this.getJson(`${calendarPath(calendar)}/events/${encodeURIComponent(id)}`, undefined, what, signal);
    }

    /**
     * A new event (events.insert). Guests get Google's invitation only when
     * the record says `notify: true`. Google gives the event its own uid.
     * The event asks for an id made from the record's uid (eventIdFor): sent
     * again because its answer never came, the insert gets 409, and the
     * event the first one made is the result, with no second invitation.
     */
    async create(calendar, record) {
        const zone = this.zoneOf(calendar);
        const notify = record?.notify === true && Array.isArray(record.attendees) && record.attendees.length > 0;
        const what = 'Adding the event to Google Calendar';
        const body = eventBody(record, zone);
        const uid = text(record?.uid);
        let event;
        for (let n = 0; event === undefined; n++) {
            // A deleted event keeps its id: the uid's next id is tried, and after a few Google picks one.
            if (uid !== undefined && n < ID_TRIES) body.id = eventIdFor(uid, n);
            else delete body.id;
            try {
                const res = await this.call('POST', `${calendarPath(calendar)}/events`, {
                    query: { sendUpdates: notify ? 'all' : 'none' }, body, what,
                });
                event = json(res, what);
            } catch (error) {
                if (body.id === undefined || !(error instanceof SourceError) || error.status !== 409) throw error;
                event = await this.madeAlready(calendar, body.id, what);
            }
        }
        if (isMaster(event) && text(event.iCalUID)) this.uids.set(uidKey(calendar, event.id), event.iCalUID);
        this.log(`created ${event.id}`);
        const item = itemOf(event, zone);
        return item ? [item] : [];
    }

    /** The event that holds an id a new event asked for (an earlier try made it), or undefined when a deleted one holds it. */
    async madeAlready(calendar, id, what) {
        let event;
        try {
            event = await this.getEvent(calendar, id, undefined, what);
        } catch (error) {
            if (error instanceof SourceError && (error.status === 404 || error.status === 410)) return undefined;
            throw error;
        }
        if (typeof event?.id !== 'string' || event.status === 'cancelled') return undefined;
        this.log(`create found ${event.id} made already`);
        return event;
    }

    /**
     * Changes an event. 'all' patches a single event or a series' master
     * (If-Match: its etag) and reads the series back; 'one' patches one
     * occurrence, which Google keeps as a changed occurrence.
     */
    async update(calendar, target, patch, scope) {
        const { item, record, occurrence } = unpack(target);
        const planned = target.planned ?? record;
        const zone = this.zoneOf(calendar);
        const what = 'Changing the event in Google Calendar';
        const notify = (patch?.notify === true || record?.notify === true) && hasGuests(record, patch);
        const sendUpdates = notify ? 'all' : 'none';
        if (scope === 'one' && (isSeriesRecord(record) || isOccurrence(record))) {
            const one = isOccurrence(record)
                ? { id: item.remoteId, etag: item.etag }
                : await this.findInstance(calendar, item.remoteId, occurrence, zone, what);
            const event = await this.patchEvent(calendar, one, patchBody(patch, record, zone, false), sendUpdates, what, planned);
            this.log(`changed one occurrence ${event.id}`);
            const changed = itemOf(event, zone);
            return changed ? [changed] : [];
        }
        const master = isOccurrence(record) ? await this.masterOf(calendar, item, what) : { id: item.remoteId, etag: item.etag };
        // A change to a whole series reaches its changed occurrences too: who they name is read with it.
        if (isSeriesRecord(record) || isOccurrence(record)) master.series = await this.seriesNow(calendar, record.uid, target.from, zone);
        const event = await this.patchEvent(calendar, master, patchBody(patch, record, zone, !isOccurrence(record)), sendUpdates, what, planned);
        this.log(`changed ${event.id}`);
        if (isMaster(event)) return this.seriesItems(calendar, event, zone);
        const changed = itemOf(event, zone);
        return changed ? [changed] : [];
    }

    /**
     * Deletes an event. 'all' deletes a single event or a whole series; 'one'
     * deletes one occurrence, which Google keeps as a cancelled exception.
     */
    async remove(calendar, target, scope) {
        const { item, record, occurrence } = unpack(target);
        const planned = target.planned ?? record;
        const zone = this.zoneOf(calendar);
        const what = 'Deleting the event from Google Calendar';
        const sendUpdates = target?.notify === true || record?.notify === true ? 'all' : 'none';
        if (scope === 'one' && (isSeriesRecord(record) || isOccurrence(record))) {
            const one = isOccurrence(record)
                ? { id: item.remoteId, etag: item.etag }
                : await this.findInstance(calendar, item.remoteId, occurrence, zone, what);
            await this.deleteEvent(calendar, one, sendUpdates, what, planned);
            this.log(`deleted one occurrence ${one.id}`);
            let event;
            try {
                event = await this.getEvent(calendar, one.id);
            } catch {
                event = undefined;
            }
            const recurrenceId = isOccurrence(record) ? record.recurrenceId : occurrence;
            const gone = event?.status === 'cancelled' ? cancelledItem(event, record.uid, zone) : undefined;
            return { removed: [], items: [gone ?? cancelledFallback(one.id, record.uid, recurrenceId)] };
        }
        const master = isOccurrence(record) ? await this.masterOf(calendar, item, what) : { id: item.remoteId, etag: item.etag };
        // A whole series takes its changed occurrences with it: who they name is read with it.
        if (isSeriesRecord(record) || isOccurrence(record)) master.series = await this.seriesNow(calendar, record.uid, target.from, zone);
        await this.deleteEvent(calendar, master, sendUpdates, what, planned);
        this.log(`deleted ${master.id}`);
        const removed = new Set([master.id, item.remoteId]);
        if ((isSeriesRecord(record) || isOccurrence(record)) && text(record?.uid)) {
            // The series' changed occurrences went with it.
            try {
                for (const event of await this.byUid(calendar, record.uid)) removed.add(event.id);
            } catch {
                // The next sync reports them.
            }
        }
        return { removed: [...removed], items: [] };
    }

    /** Answers an invitation: the account's own guest entry gets the status. */
    async respond(calendar, target, status, scope) {
        const answer = RESPONSE_OUT[status];
        if (answer === undefined || status === 'needs-action') throw new SourceError('config', `"${status}" isn't an answer to an invitation.`);
        const { item, record, occurrence } = unpack(target);
        const zone = this.zoneOf(calendar);
        const what = 'Answering the invitation in Google Calendar';
        const one = scope === 'one' && (isSeriesRecord(record) || isOccurrence(record));
        let ref;
        if (one) ref = isOccurrence(record) ? { id: item.remoteId } : await this.findInstance(calendar, item.remoteId, occurrence, zone, what);
        else ref = isOccurrence(record) ? await this.masterOf(calendar, item, what) : { id: item.remoteId };
        // The whole guest list goes back (a patch replaces it), so it is read fresh.
        const event = ref.event?.attendees ? ref.event : await this.getEvent(calendar, ref.id);
        const guests = Array.isArray(event.attendees) ? event.attendees : [];
        const own = new Set([this.account?.email, calendar?.remoteId].filter((v) => typeof v === 'string').map((v) => v.toLowerCase()));
        let mine = guests.findIndex((guest) => guest?.self === true);
        if (mine < 0) mine = guests.findIndex((guest) => typeof guest?.email === 'string' && own.has(guest.email.toLowerCase()));
        if (mine < 0) throw new SourceError('forbidden', `${what}: you aren't on this event's guest list.`);
        const attendees = guests.map((guest, i) => {
            const { self, organizer, ...rest } = guest;
            return i === mine ? { ...rest, responseStatus: answer } : rest;
        });
        // The organizer hears the answer, as with Google's own buttons. The list sent is the one just read.
        const saved = await this.patchEvent(calendar, { id: event.id ?? ref.id, etag: event.etag, event }, { attendees }, 'all', what, recordOf(event, zone));
        this.log(`answered ${saved.id}`);
        if (!one && isMaster(saved)) return this.seriesItems(calendar, saved, zone);
        const changed = itemOf(saved, zone);
        return changed ? [changed] : [];
    }

    /** events.patch of `ref` ({id, etag?, event?}), only on the condition versionOf() gives. */
    async patchEvent(calendar, ref, body, sendUpdates, what, planned) {
        const condition = await this.versionOf(calendar, ref, planned, what);
        const res = await this.call('PATCH', `${calendarPath(calendar)}/events/${encodeURIComponent(ref.id)}`, {
            query: { sendUpdates }, body, etag: condition, what,
        });
        return json(res, what);
    }

    /** events.delete, on the same condition; an event already gone (404, 410) counts as deleted. */
    async deleteEvent(calendar, ref, sendUpdates, what, planned) {
        try {
            const condition = await this.versionOf(calendar, ref, planned, what);
            await this.call('DELETE', `${calendarPath(calendar)}/events/${encodeURIComponent(ref.id)}`, { query: { sendUpdates }, etag: condition, what });
        } catch (error) {
            if (error instanceof SourceError && (error.status === 404 || error.status === 410)) return;
            throw error;
        }
    }

    /**
     * The etag a change to `ref` ({id, etag?, event?, series?}) goes with:
     * the one held here, else the one Google has now, of the event just
     * read with it (`event`: an occurrence found with events.instances) or
     * read here (an occurrence by Google's id convention, a series found
     * from its occurrence), so a change never goes unconditionally. An
     * event read now must name the people the change was worked out with
     * (`planned`), no one more and no one less (otherPeople): Google would
     * put the change on their calendars, and no 412 would say the event
     * changed since the plugin read it. A whole series is compared with its
     * changed occurrences as Google has them now (`series`, seriesNow),
     * etag held or not: changing one of them doesn't change the series'.
     */
    async versionOf(calendar, ref, planned, what) {
        const held = text(ref.etag);
        if (held && ref.series === undefined) return held;
        const zone = this.zoneOf(calendar);
        let event;
        if (!held) {
            const listed = ref.series?.master?.id === ref.id ? ref.series.master : undefined;
            event = ref.event ?? listed ?? await this.getEvent(calendar, ref.id, undefined, what);
        }
        const now = [...(held ? [] : [recordOf(event ?? {}, zone) ?? {}]), ...(ref.series?.records ?? [])];
        const other = otherPeople(planned, now);
        if (other.length > 0) {
            this.log(`the event names ${other.length} other people since the change was worked out`);
            throw peopleConflict(what);
        }
        return held ?? text(event?.etag);
    }

    /**
     * A series as Google has it now: its own event (`master`) and its
     * changed occurrences, as records (byUid), the cancelled ones left out.
     * With `from` (a change from that occurrence on), only the
     * occurrences changed from it on. {master, records}, or undefined when
     * the series isn't there (gone: a delete is done already, and a change
     * is answered 404).
     */
    async seriesNow(calendar, uid, from, zone) {
        const events = text(uid) ? await this.byUid(calendar, uid) : [];
        const reached = (time) => !isTime(from) || !isTime(time) || !(timeOrder(time, zone) < timeOrder(from, zone));
        let master;
        const records = [];
        for (const event of events) {
            if (event === null || typeof event !== 'object' || event.status === 'cancelled') continue;
            if (isMaster(event)) master = event;
            const record = recordOf(event, zone);
            if (record !== undefined && reached(record.recurrenceId)) records.push(record);
        }
        return master === undefined ? undefined : { master, records };
    }

    /** The series a changed occurrence (an exception item) belongs to. No etag of the series is held: a change reads it first. */
    async masterOf(calendar, item, what) {
        const event = await this.getEvent(calendar, item.remoteId);
        if (typeof event?.recurringEventId !== 'string') return { id: item.remoteId, ...(text(item.etag) ? { etag: item.etag } : { event }) };
        if (event.recurringEventId === item.remoteId) throw new SourceError('server', `${what}: Google's answer names the event as its own series.`);
        return { id: event.recurringEventId };
    }

    /**
     * One occurrence of a series, by its original start: events.instances
     * in a window around it, else Google's id convention for instances.
     */
    async findInstance(calendar, masterId, occurrence, zone, what) {
        const timed = occurrence !== null && typeof occurrence === 'object' && typeof occurrence.local === 'string';
        const day = occurrence !== null && typeof occurrence === 'object' && isDay(occurrence.date);
        if (!timed && !day) throw new SourceError('not-found', `${what}: which occurrence wasn't said.`);
        const at = timed ? instantOf(occurrence, zone) : undefined;
        if (timed && !Number.isFinite(at)) throw new SourceError('not-found', `${what}: the occurrence's time can't be read.`);
        const from = timed ? at - DAY_MS : toInstant(`${addDays(occurrence.date, -1)}T00:00:00`, zone, zone);
        const to = timed ? at + DAY_MS : toInstant(`${addDays(occurrence.date, 2)}T00:00:00`, zone, zone);
        let found;
        await this.pages(`${calendarPath(calendar)}/events/${encodeURIComponent(masterId)}/instances`, {
            timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), showDeleted: true, maxResults: 250,
        }, what, undefined, (page) => {
            for (const event of Array.isArray(page?.items) ? page.items : []) {
                if (found === undefined && sameStart(event?.originalStartTime, occurrence, at, zone)) found = event;
            }
        });
        if (found !== undefined && typeof found.id === 'string') return { id: found.id, event: found };
        // No etag of it is held: a change reads it first.
        return { id: instanceId(masterId, occurrence, at) };
    }

    /** Every event with a uid (a series and its changed occurrences), deleted ones too. */
    async byUid(calendar, uid) {
        const events = [];
        await this.pages(`${calendarPath(calendar)}/events`, {
            iCalUID: uid, singleEvents: false, showDeleted: true, maxResults: EVENTS_PAGE,
        }, 'Reading a series from Google Calendar', undefined, (page) => {
            if (Array.isArray(page?.items)) for (const event of page.items) events.push(event);
        });
        return events;
    }

    /** A series after a change: its master and changed occurrences as Google has them now. */
    async seriesItems(calendar, master, zone) {
        try {
            const events = text(master.iCalUID) ? await this.byUid(calendar, master.iCalUID) : [];
            if (!events.some((event) => event?.id === master.id)) events.unshift(master);
            const { items } = await this.itemsOf(calendar, events, zone);
            if (items.some((item) => item.remoteId === master.id)) return items;
        } catch (error) {
            if (!(error instanceof SourceError)) throw error;
        }
        const item = itemOf(master, zone);
        return item ? [item] : [];
    }
}

/** target as the manager passes it, with the record from the item when it gives none. */
function unpack(target) {
    const item = target?.item;
    if (typeof item?.remoteId !== 'string' || item.remoteId === '') throw new SourceError('not-found', 'This event has no Google id.');
    const record = target.record ?? item.events?.[0] ?? {};
    return { item, record, occurrence: target.occurrence };
}

/** A record of a series' master: it repeats. */
const isSeriesRecord = (record) => Boolean(record?.rrule) || (Array.isArray(record?.rdates) && record.rdates.length > 0);

/** A record of one changed (or cancelled) occurrence of a series. */
const isOccurrence = (record) => record?.recurrenceId !== undefined && record?.recurrenceId !== null;

/** A Google event that is a series' master. */
const isMaster = (event) => Array.isArray(event?.recurrence) && event.recurrence.length > 0 && typeof event.recurringEventId !== 'string';

const hasGuests = (record, patch) => (Array.isArray(patch?.attendees) ? patch.attendees : record?.attendees ?? []).length > 0;

const uidKey = (calendar, id) => `${calendar?.remoteId}\n${id}`;

const calendarPath = (calendar) => `/calendars/${encodeURIComponent(calendar.remoteId)}`;

/** A Time ({date} or {local, tz}). */
const isTime = (time) => time !== null && typeof time === 'object' && (isDay(time.date) || typeof time.local === 'string');

/** A Time as a number to order occurrences by: a day as its midnight in `zone`. */
const timeOrder = (time, zone) => ('date' in time ? toInstant(`${time.date}T00:00:00`, zone, zone) : instantOf(time, zone));

/** Whether an instance's originalStartTime is the occurrence's start. */
function sameStart(original, occurrence, at, zone) {
    if (original === null || typeof original !== 'object') return false;
    if ('date' in occurrence) return original.date === occurrence.date;
    const time = timeOf(original, zone);
    return time !== undefined && !('date' in time) && instantOf(time, zone) === at;
}

/** Google's id for an occurrence that hasn't changed yet. */
function instanceId(masterId, occurrence, at) {
    if ('date' in occurrence) return `${masterId}_${occurrence.date.replaceAll('-', '')}`;
    return `${masterId}_${new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')}`;
}

/**
 * The id a new event asks Google for, the same every time for the same uid:
 * the uid's SHA-256 in hex, which is base32hex as Google wants (0-9 and
 * a-v, 5 to 1024 characters). `n` above 0 gives the uid's next ids, for
 * when a deleted event holds the first.
 */
function eventIdFor(uid, n) {
    return createHash('sha256').update(n === 0 ? uid : `${uid}\n${n}`, 'utf8').digest('hex');
}

/** A request that never got an answer, as a SourceError (an abort stays as it is). */
function fromHttp(error) {
    if (!(error instanceof HttpError)) return error;
    if (error.code === 'aborted') return error;
    if (error.code === 'insecure') return new SourceError('config', error.message);
    if (error.code === 'too-large' || error.code === 'redirects') return new SourceError('server', error.message);
    return new SourceError('network', error.message);
}

/** An answer's JSON body. */
function json(res, what) {
    try {
        return JSON.parse(res.text);
    } catch {
        throw new SourceError('server', `${what}: Google's answer isn't JSON.`, { status: res.status });
    }
}

/**
 * A SourceError for an answer that wasn't a success. Google says why in
 * error.errors[].reason: a 403 can mean "slow down" as well as "not allowed".
 */
function googleError(res, what) {
    let reason;
    try {
        const error = JSON.parse(res.text)?.error;
        reason = error?.errors?.find?.((e) => typeof e?.reason === 'string')?.reason
            ?? error?.details?.find?.((d) => typeof d?.reason === 'string')?.reason;
    } catch {
        reason = undefined;
    }
    if ((res.status === 403 && RATE_REASONS.has(reason)) || res.status === 429 || res.status === 503) {
        return new SourceError('rate', `${what}: Google asked to slow down.`, { status: res.status, retryAfter: retryAfter(res.headers) });
    }
    if (res.status === 403 && SCOPE_REASONS.has(reason)) {
        return new SourceError('auth', `${what}: the sign-in doesn't allow this. Sign in again and make sure both calendar permissions are ticked.`, { status: 403 });
    }
    return statusError(res.status, what, res.headers);
}

/** One Google event as an Item, or undefined when it has no start to place it by. */
function itemOf(event, zone) {
    const record = recordOf(event, zone);
    if (record === undefined) return undefined;
    const item = { remoteId: event.id };
    if (text(event.etag)) item.etag = event.etag;
    item.events = [record];
    return item;
}

/** A Google event as a record. `calendarZone` reads times of events that name no zone. */
function recordOf(event, calendarZone) {
    const zone = ianaZone(event.start?.timeZone) ?? calendarZone;
    const start = timeOf(event.start, zone);
    if (start === undefined) return undefined;
    const end = timeOf(event.end, zone) ?? defaultEnd(start);
    const record = {
        uid: text(event.iCalUID) ?? `${event.id}@google.com`,
        title: typeof event.summary === 'string' ? event.summary : '',
        description: plainText(event.description),
        location: text(event.location),
        start,
        end,
        status: STATUSES.has(event.status) ? event.status : undefined,
        busy: event.transparency === 'transparent' ? false : undefined,
        privacy: PRIVACY[event.visibility],
        organizer: personOf(event.organizer),
        attendees: Array.isArray(event.attendees) ? event.attendees.map(attendeeOf).filter(Boolean) : undefined,
        alarms: alarmsOf(event.reminders),
        conference: conferenceOf(event),
        guestsMayChange: event.guestsCanModify === true ? true : undefined,
        created: text(event.created),
        updated: text(event.updated),
        sequence: Number.isInteger(event.sequence) ? event.sequence : undefined,
    };
    if (isMaster(event)) Object.assign(record, recurrenceOf(event.recurrence, zone));
    if (typeof event.recurringEventId === 'string') {
        const original = timeOf(event.originalStartTime, zone);
        if (original !== undefined) record.recurrenceId = original;
    }
    return cleanRecord(record);
}

/**
 * A cancelled occurrence as an Item: a record with only its uid, its
 * recurrenceId and status 'cancelled' (Google promises nothing else).
 */
function cancelledItem(event, uid, zone, master) {
    const recurrenceId = timeOf(event.originalStartTime, zone);
    if (recurrenceId === undefined || !text(uid)) return undefined;
    const item = { remoteId: event.id };
    if (text(event.etag)) item.etag = event.etag;
    item.events = [cancelledRecord(uid, recurrenceId, master, zone)];
    return item;
}

/** The cancelled occurrence when Google couldn't be asked how it looks now. */
function cancelledFallback(id, uid, recurrenceId) {
    return { remoteId: id, events: [cancelledRecord(uid, recurrenceId)] };
}

function cancelledRecord(uid, recurrenceId, master, zone) {
    let end;
    const start = master ? timeOf(master.start, ianaZone(master.start?.timeZone) ?? zone) : undefined;
    const last = master ? timeOf(master.end, ianaZone(master.start?.timeZone) ?? zone) : undefined;
    if ('date' in recurrenceId) {
        const days = start && last && 'date' in start && 'date' in last ? Math.max(1, daysBetween(start.date, last.date)) : 1;
        end = { date: addDays(recurrenceId.date, days) };
    } else {
        const length = start && last && !('date' in start) && !('date' in last) ? instantOf(last, zone) - instantOf(start, zone) : 0;
        const tz = recurrenceId.tz ?? zone;
        end = Number.isFinite(length) && length > 0
            ? { local: toLocal(instantOf(recurrenceId, zone) + length, tz), tz }
            : recurrenceId;
    }
    return cleanRecord({ uid, title: '', status: 'cancelled', start: recurrenceId, end, recurrenceId });
}

/**
 * A Google time ({date} or {dateTime, timeZone}) as a Time: the wall clock
 * in the time's own zone, else in `zone`.
 */
function timeOf(value, zone) {
    if (value === null || typeof value !== 'object') return undefined;
    if (isDay(value.date)) return { date: value.date };
    if (typeof value.dateTime !== 'string') return undefined;
    const tz = ianaZone(value.timeZone) ?? zone ?? 'UTC';
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.dateTime)) {
        const ms = Date.parse(value.dateTime);
        if (Number.isFinite(ms)) return { local: toLocal(ms, tz), tz };
    }
    // No offset: the wall clock is already in the zone.
    const local = normalLocal(value.dateTime);
    return local === undefined ? undefined : { local, tz };
}

/** An end for an event that has none: the same instant, or the next day. */
function defaultEnd(start) {
    return 'date' in start ? { date: addDays(start.date, 1) } : { ...start };
}

/**
 * Google ended the sign-in. It does that every 7 days for an OAuth app left
 * in Testing, so the user is told how to stop it.
 */
function endedSignIn(error) {
    if (!(error instanceof SourceError) || error.message !== SIGN_IN_ENDED) return error;
    return new SourceError('auth', `${SIGN_IN_ENDED} If Google asks every week, your Google app is still in Testing, where Google ends sign-ins after 7 days: publish it (Google Auth Platform, Audience, Publish app).`, { status: error.status });
}

function personOf(value) {
    if (!text(value?.email)) return undefined;
    const out = { email: value.email };
    if (text(value.displayName)) out.name = value.displayName;
    if (value.self === true) out.self = true;
    return out;
}

function attendeeOf(value) {
    if (!text(value?.email)) return undefined;
    const out = { email: value.email };
    if (text(value.displayName)) out.name = value.displayName;
    if (RESPONSE_IN[value.responseStatus]) out.status = RESPONSE_IN[value.responseStatus];
    if (value.optional === true) out.role = 'optional';
    if (value.organizer === true) out.organizer = true;
    if (value.self === true) out.self = true;
    return out;
}

/** Popup reminders as minutes before the start; the calendar's defaults as none. */
function alarmsOf(reminders) {
    if (reminders === null || typeof reminders !== 'object' || reminders.useDefault !== false) return undefined;
    const overrides = Array.isArray(reminders.overrides) ? reminders.overrides : [];
    return overrides.filter((o) => o?.method === 'popup' && Number.isFinite(o.minutes)).map((o) => o.minutes);
}

/** The meeting link: Meet's own, else the video entry of the conference data. */
function conferenceOf(event) {
    if (text(event.hangoutLink)) return event.hangoutLink;
    const points = event.conferenceData?.entryPoints;
    if (!Array.isArray(points)) return undefined;
    return text(points.find((p) => p?.entryPointType === 'video' && text(p.uri))?.uri);
}

/** RRULE, RDATE and EXDATE lines of a master as rrule, rdates and exdates. */
function recurrenceOf(lines, zone) {
    const out = { rdates: [], exdates: [] };
    for (const line of lines) {
        const parts = splitLine(line);
        if (parts === undefined) continue;
        if (parts.name === 'RRULE' && out.rrule === undefined) out.rrule = parts.value;
        else if (parts.name === 'RDATE') out.rdates.push(...dateValues(parts, zone));
        else if (parts.name === 'EXDATE') out.exdates.push(...dateValues(parts, zone));
    }
    return out;
}

/** 'NAME;PARAM=V:VALUE' → {name, params, value}. A quoted parameter may hold ':' or ';'. */
function splitLine(line) {
    const raw = String(line ?? '').trim();
    let quoted = false;
    let colon = -1;
    const cuts = [];
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '"') quoted = !quoted;
        else if (!quoted && c === ';') cuts.push(i);
        else if (!quoted && c === ':') {
            colon = i;
            break;
        }
    }
    if (colon <= 0) return undefined;
    const bounds = [...cuts, colon];
    const name = raw.slice(0, bounds[0]).toUpperCase();
    const params = {};
    for (let i = 0; i < bounds.length - 1; i++) {
        const param = raw.slice(bounds[i] + 1, bounds[i + 1]);
        const eq = param.indexOf('=');
        if (eq > 0) params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, '');
    }
    return { name, params, value: raw.slice(colon + 1).trim() };
}

/** The dates of an RDATE or EXDATE line as Times. A PERIOD counts by its start. */
function dateValues({ params, value }, zone) {
    const tz = params.TZID ? ianaZone(params.TZID) ?? zone : zone;
    const out = [];
    for (const piece of value.split(',')) {
        const v = piece.trim().split('/')[0];
        let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
        if (m) {
            const date = `${m[1]}-${m[2]}-${m[3]}`;
            if (isDay(date)) out.push({ date });
            continue;
        }
        m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(v);
        if (m) {
            const local = normalLocal(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
            if (local !== undefined) out.push(m[7] ? { local, tz: 'UTC' } : { local, tz });
        }
    }
    return out;
}

/** rrule, rdates and exdates as Google's recurrence lines. */
function recurrenceLines(record, zone) {
    const lines = [];
    if (text(record.rrule)) lines.push(`RRULE:${record.rrule.replace(/^RRULE:/i, '')}`);
    lines.push(...dateLines('RDATE', record.rdates, zone), ...dateLines('EXDATE', record.exdates, zone));
    return lines;
}

/** One line per kind of value: dates, UTC times, and wall clocks per zone. */
function dateLines(name, times, zone) {
    const groups = new Map();
    for (const time of Array.isArray(times) ? times : []) {
        let head;
        let value;
        if (time !== null && typeof time === 'object' && isDay(time.date)) {
            head = `${name};VALUE=DATE`;
            value = time.date.replaceAll('-', '');
        } else if (typeof time?.local === 'string' && normalLocal(time.local) !== undefined) {
            const local = normalLocal(time.local).replace(/[-:]/g, '');
            if (time.tz === 'UTC') {
                head = name;
                value = `${local}Z`;
            } else {
                head = `${name};TZID=${ianaZone(time.tz) ?? zone}`;
                value = local;
            }
        } else {
            continue;
        }
        if (!groups.has(head)) groups.set(head, []);
        groups.get(head).push(value);
    }
    return [...groups].map(([head, values]) => `${head}:${values.join(',')}`);
}

/** The zone a Time is written in: its own when Google knows it, else `zone`. */
function zoneFor(time, zone) {
    if (time === null || typeof time !== 'object' || 'date' in time) return zone;
    if (time.tz === 'UTC') return 'UTC';
    return ianaZone(time.tz) ?? zone;
}

/** A Time as Google's {date} or {dateTime: wall clock + offset, timeZone}. */
function googleTime(time, zone) {
    if (time !== null && typeof time === 'object' && isDay(time.date)) return { date: time.date };
    const local = normalLocal(time?.local);
    if (local === undefined) throw new SourceError('config', 'The event has a time Google can\'t take.');
    const tz = zoneFor(time, zone);
    const ms = toInstant(local, tz, tz);
    return { dateTime: rfc3339(ms, tz), timeZone: tz };
}

/** An instant as RFC 3339 in a zone: '2026-10-12T09:00:00+02:00'. */
function rfc3339(ms, zone) {
    const offset = offsetAt(zone, ms);
    const local = toLocal(ms, zone);
    if (offset === 0) return `${local}Z`;
    const sign = offset < 0 ? '-' : '+';
    const abs = Math.abs(offset);
    return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function attendeeOut(value) {
    if (!text(value?.email)) return undefined;
    const out = { email: value.email };
    if (text(value.name)) out.displayName = value.name;
    if (value.role === 'optional') out.optional = true;
    if (RESPONSE_OUT[value.status]) out.responseStatus = RESPONSE_OUT[value.status];
    return out;
}

/** Alarms as Google's popup overrides (at most 5, 0 to 40320 minutes). */
function remindersOut(alarms) {
    const overrides = alarms
        .filter((m) => Number.isFinite(m) && m >= 0)
        .map((m) => Math.min(40320, Math.round(m)))
        .slice(0, 5)
        .map((minutes) => ({ method: 'popup', minutes }));
    return { useDefault: false, overrides };
}

/** A record as the body of events.insert. */
function eventBody(record, zone) {
    if (record === null || typeof record !== 'object' || record.start === undefined) {
        throw new SourceError('config', 'The event has no start.');
    }
    const startZone = zoneFor(record.start, zone);
    const body = { summary: typeof record.title === 'string' ? record.title : '' };
    if (text(record.description)) body.description = record.description;
    if (text(record.location)) body.location = record.location;
    body.start = googleTime(record.start, zone);
    body.end = googleTime(record.end ?? defaultEnd(record.start), zone);
    const recurrence = recurrenceLines(record, startZone);
    if (recurrence.length > 0) body.recurrence = recurrence;
    if (Array.isArray(record.attendees) && record.attendees.length > 0) body.attendees = record.attendees.map(attendeeOut).filter(Boolean);
    if (Array.isArray(record.alarms)) body.reminders = remindersOut(record.alarms);
    if (record.busy === false) body.transparency = 'transparent';
    if (PRIVACY[record.privacy]) body.visibility = record.privacy;
    if (record.status === 'tentative') body.status = 'tentative';
    return body;
}

/**
 * A patch of record fields as the body of events.patch: only the fields
 * given, an emptied one cleared. Recurrence goes only to a series' master
 * (an occurrence has none), as whole lines from the record and the patch.
 */
function patchBody(patch, record, zone, recurring) {
    const given = patch !== null && typeof patch === 'object' ? patch : {};
    const has = (key) => Object.prototype.hasOwnProperty.call(given, key);
    const body = {};
    if (has('title')) body.summary = typeof given.title === 'string' ? given.title : '';
    if (has('description')) body.description = typeof given.description === 'string' ? given.description : '';
    if (has('location')) body.location = typeof given.location === 'string' ? given.location : '';
    if (has('start') && given.start) body.start = googleTime(given.start, zone);
    if (has('end') && given.end) body.end = googleTime(given.end, zone);
    if (has('status') && STATUSES.has(given.status)) body.status = given.status;
    if (has('busy')) body.transparency = given.busy === false ? 'transparent' : 'opaque';
    if (has('privacy')) body.visibility = PRIVACY[given.privacy] ?? 'default';
    if (has('attendees')) body.attendees = (Array.isArray(given.attendees) ? given.attendees : []).map(attendeeOut).filter(Boolean);
    if (has('alarms')) body.reminders = Array.isArray(given.alarms) ? remindersOut(given.alarms) : { useDefault: true };
    if (recurring && (has('rrule') || has('rdates') || has('exdates'))) {
        const merged = { ...record, ...given };
        body.recurrence = recurrenceLines(merged, zoneFor(merged.start, zone));
    }
    return body;
}

/** Tags Google's own editor writes into descriptions. */
const HTML_TAGS = /<\/?(?:a|b|br|div|em|h[1-6]|i|li|ol|p|span|strong|u|ul)\b[^>]*>/i;

/** A description as plain text: Google's app writes HTML (links, lists, line breaks). */
function plainText(value) {
    if (typeof value !== 'string' || value === '') return undefined;
    if (!HTML_TAGS.test(value)) return value;
    let out = value.replace(/\r\n?/g, '\n');
    out = out.replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (whole, dq, sq, inner) => {
        const href = decodeEntities(dq ?? sq ?? '');
        const label = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim();
        if (label === '' || label === href) return href;
        return `${label} (${href})`;
    });
    out = out.replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n• ')
        .replace(/<\/(?:p|div|h[1-6]|ul|ol)>/gi, '\n')
        .replace(/<[^>]*>/g, '');
    out = decodeEntities(out).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return out === '' ? undefined : out;
}

function decodeEntities(value) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'' };
    return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, name) => {
        const key = name.toLowerCase();
        if (named[key] !== undefined) return named[key];
        if (key.startsWith('#x')) return codePoint(Number.parseInt(key.slice(2), 16), whole);
        if (key.startsWith('#')) return codePoint(Number.parseInt(key.slice(1), 10), whole);
        return whole;
    });
}

function codePoint(n, fallback) {
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

const text = (value) => (typeof value === 'string' && value !== '' ? value : undefined);
