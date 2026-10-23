/**
 * Where calendars come from. Each kind of account is a source module in
 * this folder; the manager (lib/manager.js) stores what they return,
 * expands recurring events, schedules syncs and routes changes to them.
 *
 * A source module exports:
 *
 *   kind   - the account kind it serves ('caldav', 'google', ...).
 *   style  - 'ics': it reads and writes iCalendar text (CalDAV, the local
 *            calendar, subscriptions); the manager edits the text, the
 *            source only stores and fetches it. 'events': it maps events
 *            to and from the server's own JSON (Google, Microsoft, EventKit).
 *   create(account, env) → a source for one account (below).
 *   revoke(env, secret) → {revoked, manageUrl?}   (optional)
 *            Withdraw the plugin's access when the user removes the
 *            account, before its secret is cleared. revoked: the provider
 *            took it back; otherwise manageUrl is the page where the user
 *            does it. MANAGE_URL (optional): that page, for when revoke
 *            fails.
 *
 * `account` is what the plugin stores about an account, never a secret:
 *   {id, kind, name, url?, host?, username?, email?, preset?, allowHttp?}.
 *   A subscription has its host only: its address is its secret.
 *
 * `env` is what a source may use:
 *   request(url, init) - lib/http.js `request`, with the account's allowHttp
 *                        and the test fetch already applied. All network goes
 *                        through it.
 *   secret             - the account's secret in DSH's credential store:
 *                        `get()` → payload or undefined, `set(payload)`, `clear()`.
 *                        A password, an OAuth grant {refreshToken, accessToken,
 *                        expiresAt, scope}, or a subscription's address {url}
 *                        (a private feed's key is in its path). Never logged,
 *                        never returned.
 *   log(line)          - the plugin's log: ids and counts, never secrets,
 *                        event text or URLs with queries.
 *   now()              - epoch ms (tests move it).
 *   zone               - the user's zone (IANA id).
 *   settings           - the plugin's settings (OAuth client ids and the like).
 *
 * Every source has:
 *
 *   calendars() → [{remoteId, name, color?, readOnly?, timeZone?, description?,
 *                   mode?: 'masters' | 'instances', primary?}]
 *       The account's calendars that hold events. 'instances': the source
 *       hands each occurrence of a series over on its own (see model.js).
 *       primary: the account's main calendar, as its server says (new
 *       events go there unless the user chose another).
 *
 *   sync(calendar, state, {from, to, signal}) → {reset, items, removed, state}
 *       What changed in one calendar since `state` (opaque JSON this source
 *       returned last time; undefined the first time). `reset` true: `items`
 *       is the whole calendar. Otherwise `items` are new or changed and
 *       `removed` the remote ids gone. `from`/`to` (epoch ms) bound the
 *       window a source that syncs a window (Microsoft's calendar view) keeps.
 *       `calendar` is {remoteId, ...what calendars() said}.
 *
 * An 'ics' source also has:
 *
 *   put(calendar, item | null, raw, uid) → {remoteId, etag}
 *       Store iCalendar text: a new resource (item null; it must not exist
 *       yet, and one already there with this uid is this create made
 *       before), or a changed one (only if its etag is still item.etag;
 *       without one, only while the server's copy shows what item.raw
 *       shows and names the same people: see newPeople).
 *   remove(calendar, item) → undefined
 *       Delete a resource (only if its etag is still item.etag; without
 *       one, only while the server's copy names the same people as item.raw).
 *
 * An 'events' source also has:
 *
 *   create(calendar, record) → Item[]
 *       record.uid is new, and the same when the manager asks again after
 *       an answer was lost: the server must make the event once.
 *   update(calendar, target, patch, scope) → Item[]
 *       target: {item, record, occurrence?, planned?, from?, synced?}: the
 *       item and record changed, and for one occurrence of a series its
 *       original start (a Time). planned: the record (or records) the
 *       change was worked out on, record when not given: who it was told it
 *       reaches. from: for a series ended before an occurrence ("this and
 *       following"), that occurrence's original start. synced: the
 *       calendar's sync state as kept with its events. patch: the record
 *       fields to change. scope: 'all' (the series or a single event) or
 *       'one' (that occurrence only). A change goes with the etag the
 *       plugin holds; where it holds none (a series kept as its
 *       occurrences, an occurrence found by its start), the source reads
 *       the event just before writing, and goes on only while the event
 *       names the people `planned` does, no one more and no one less
 *       (otherPeople): no 412 would say it changed meanwhile. A change to a
 *       whole series reads its occurrences changed on their own too (from
 *       `from` on), etag held or not: a change to one of them doesn't
 *       change the series' etag.
 *   remove(calendar, target, scope) → {removed: string[], items: Item[]}
 *   respond(calendar, target, status, scope) → Item[]   (optional)
 *       Answer an invitation: 'accepted', 'declined' or 'tentative'.
 *
 * Errors: throw a SourceError with a code the manager acts on: 'auth'
 * (sign in again), 'conflict' (changed on the server meanwhile: the manager
 * syncs and tries once more, or works the change out again and says who it
 * would now reach), 'not-found', 'forbidden' (read-only), 'rate' (with
 * retryAfter in seconds), 'server', 'network', 'config'.
 * Messages are for the user: plain, without secrets. Agents get a fixed
 * category by the code instead (PROBLEMS), never a message.
 *
 * @module dsh-plugin-calendar/sources
 */
import { addressKey } from '../model.js';

export class SourceError extends Error {
    /**
     * @param {'auth'|'conflict'|'not-found'|'forbidden'|'rate'|'server'|'network'|'config'} code
     * @param {string} message - for the user.
     * @param {{status?: number, retryAfter?: number}} [extra]
     */
    constructor(code, message, extra = {}) {
        super(message);
        this.name = 'SourceError';
        this.code = code;
        if (extra.status !== undefined) this.status = extra.status;
        if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
    }
}

/** A SourceError for an HTTP answer that wasn't a success. */
export function statusError(status, what, headers) {
    if (status === 401) return new SourceError('auth', `${what}: the server didn't accept the sign-in.`, { status });
    if (status === 403) return new SourceError('forbidden', `${what}: the server doesn't allow this.`, { status });
    if (status === 404 || status === 410) return new SourceError('not-found', `${what}: the server has no such thing (any more).`, { status });
    if (status === 409 || status === 412) return new SourceError('conflict', `${what}: it changed on the server meanwhile.`, { status });
    if (status === 429 || status === 503) {
        const header = headers?.get?.('retry-after');
        const after = header === null || header === undefined || String(header).trim() === '' ? NaN : Number(header);
        return new SourceError('rate', `${what}: the server asked to wait.`, { status, retryAfter: Number.isFinite(after) && after >= 0 ? after : 60 });
    }
    return new SourceError('server', `${what}: the server answered HTTP ${status}.`, { status });
}

/** The people on a record: its organizer and its guests. */
const peopleOn = (record) => [record?.organizer, ...(Array.isArray(record?.attendees) ? record.attendees : [])]
    .filter((p) => p !== null && typeof p === 'object');

/**
 * The people an event names now that the record a change was worked out on
 * didn't: its organizer and guests as the server has them (`now`) against
 * `planned`, by addressKey(). Either is a record or several (a series and
 * its changed occurrences): anyone on any of them counts. The account
 * itself (self) isn't one.
 * @returns {string[]} their addresses, as the server names them.
 */
export function newPeople(planned, now) {
    const named = new Set();
    for (const person of [planned].flat().flatMap(peopleOn)) named.add(addressKey(person.address ?? person.email));
    const out = new Map();
    for (const person of [now].flat().flatMap(peopleOn)) {
        const key = addressKey(person.address ?? person.email);
        if (person.self === true || key === '' || named.has(key) || out.has(key)) continue;
        out.set(key, String(person.email ?? person.address));
    }
    return [...out.values()];
}

/**
 * newPeople() both ways: the people an event names now that the change
 * wasn't worked out with, and those it was worked out with that it no
 * longer names. Either way the change was worked out on the event as it
 * isn't any more: written, it would email someone unnamed, or put back
 * someone another app took off (and say they were told).
 * @returns {string[]} their addresses.
 */
export function otherPeople(planned, now) {
    return [...newPeople(planned, now), ...newPeople(now, planned)];
}

/**
 * The 'conflict' a change stops with when the event, read just before it,
 * names other people than it was worked out with (newPeople, otherPeople):
 * nothing is written, and the manager syncs and works the change out
 * again, naming them.
 */
export function peopleConflict(what) {
    return new SourceError('conflict', `${what}: on the server it names other people than when the change was worked out, so nothing was changed.`);
}

/**
 * A calendar's or an account's problem as agents see it: a fixed category
 * by its code. The message stays for the window: it can hold a server's
 * own words.
 */
export const PROBLEMS = {
    auth: 'sign-in needed', network: 'can\'t reach the server', forbidden: 'the server refused', 'not-found': 'not found',
    rate: 'rate limited', server: 'server error', config: 'setup problem',
};

/** The category for an error's code; any other code is a server error. */
export const problemOf = (code) => (Object.hasOwn(PROBLEMS, code) ? PROBLEMS[code] : PROBLEMS.server);

/** The source modules by account kind, loaded when first needed. */
const LOADERS = {
    local: () => import('./local.js'),
    ics: () => import('./subscription.js'),
    caldav: () => import('./caldav.js'),
    google: () => import('./google.js'),
    microsoft: () => import('./microsoft.js'),
};

/** The kinds of account the plugin knows. */
export const KINDS = Object.keys(LOADERS);

/** The source module for an account kind. */
export async function sourceModule(kind) {
    const load = LOADERS[kind];
    if (load === undefined) throw new SourceError('config', `There is no "${kind}" kind of calendar account.`);
    return load();
}
