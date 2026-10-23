/**
 * The plugin's endpoints for its browser half, served by DSH's own gateway
 * on the window's connection as `/api/dsh-plugin-calendar/<method>`. The
 * Calendar page, its dialogs, the agenda pane and the chat cards all go
 * through these to the manager (manager.js).
 *
 * Times cross the wire as epoch ms (spans) or as text: a day
 * 'YYYY-MM-DD', a wall clock 'YYYY-MM-DDTHH:MM' read in `timeZone` (else
 * the user's zone). An all-day event's `end` is its last day.
 *
 * @module dsh-plugin-calendar/remote
 */
import { Remote, RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { WindowChanges } from './asked.js';
import { CalendarError } from './manager.js';
import { PRESETS } from './sources/caldav.js';

/** Wire namespace: the client calls `/api/dsh-plugin-calendar/<method>`. */
export const NAMESPACE = 'dsh-plugin-calendar';
/** Cordis service key the gateway looks the service up by. */
export const SERVICE = 'dshPluginCalendarRemote';

/**
 * The refusals the window answers in its own way, as `calendar/<code>`.
 * Three are about who a change emails or reaches, and carry details
 * {people, mail}: people, every one of them; mail, what they get
 * ({emailed?: {what, to}, reached?: {how, to}, why?}). The window names
 * them all, and makes the same change again with approved: people once the
 * user says yes; approved counts only for the change that was refused
 * (asked.js), once.
 * - 'needs-notify': the server would email them, and the change didn't say
 *   to tell them: again with notify and approved.
 * - 'needs-approval': the change didn't say who the user saw (approved),
 *   and it would email or reach someone: again with approved.
 * - 'changed': the event changed meanwhile, and nothing was done. With
 *   people, it would now email or reach someone outside approved: ask
 *   again, naming them all. With none (people empty), nobody new is
 *   reached: the user looks at it again first.
 * And 'drops-changes' (move a series anyway: dropChanges), 'choose-calendar'
 * (no default calendar), and 'half-moved': a move made the copy (and sent
 * its invitations) but couldn't take the event out of its old calendar; the
 * message says what to do, and moving it again would make a second copy.
 * Any other refusal is 'calendar/refused'.
 */
const WINDOW_CODES = new Set(['needs-notify', 'needs-approval', 'changed', 'drops-changes', 'choose-calendar', 'half-moved']);

function failure(error) {
    if (error instanceof CalendarError) {
        const details = {
            ...(Array.isArray(error.people) ? { people: error.people } : {}),
            ...(error.mail !== undefined ? { mail: error.mail } : {}),
        };
        return new RemoteError(WINDOW_CODES.has(error.code) ? `calendar/${error.code}` : 'calendar/refused', error.message, details);
    }
    return new RemoteError('calendar/failed', String(error?.message ?? error).slice(0, 300), {});
}

const text = (value) => (typeof value === 'string' ? value : '');
const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : undefined);
const object = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});

export class CalendarRemote {
    /**
     * @param {object} ctx - the plugin's context (the binding reads it).
     * @param {import('./manager.js').CalendarManager} manager
     * @param {{signInReady: () => Promise<object>, setGoogleSecret: (secret: string) => Promise<void>}} setup - whether Google's and Microsoft's sign-ins have what they need (index.js), and where the Google client secret goes.
     */
    constructor(ctx, manager, setup) {
        this.ctx = ctx;
        this.manager = manager;
        this.setup = setup;
        // The window's changes, held to what the user was asked about each.
        this.changes = new WindowChanges(manager);
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    async run(work) {
        try {
            return await work();
        } catch (error) {
            throw failure(error);
        }
    }

    /**
     * Accounts, calendars, the user's zone and choices, and what the account
     * dialog offers: {version, zone, accounts, calendars, defaultCalendar,
     * prefs, syncing, storeIssue?, presets (CalDAV), signIn: {google: {ready,
     * clientId?}, microsoft: {ready, clientId?}}, askBeforeEmails}.
     * defaultCalendar is null when no calendar is the default: a new event
     * then names its calendar ('calendar/choose-calendar'). askBeforeEmails:
     * false when the user's settings let chats' emailing changes go without
     * asking them. `version` changes whenever
     * anything the window shows changed: poll this and refetch events when it
     * moves. storeIssue {file, at, held?}: calendar.json couldn't be read at
     * this start, and is kept beside it as `file` (held: it couldn't be moved
     * and is left as it is); the plugin started without it. A calendar whose
     * events file couldn't be read has its own, naming the file in the events
     * folder.
     */
    async state() {
        return this.run(async () => ({
            ...this.manager.state(), presets: PRESETS, signIn: await this.setup.signInReady(),
            askBeforeEmails: this.setup.askBeforeEmails?.() !== false,
        }));
    }

    /**
     * {version, syncing}: what state() would say moved, cheaply. The window
     * asks this every few seconds and reads state() only when it changes.
     */
    async version() {
        return this.run(async () => ({ version: this.manager.version, syncing: this.manager.syncing.size > 0 }));
    }

    /** {occurrences, more}: the events in [from, to) (epoch ms), of the given calendars or the shown ones. */
    async events(from, to, calendars) {
        return this.run(async () => this.manager.events({ from: Number(from), to: Number(to), calendars: list(calendars) }));
    }

    /** {occurrences, more}: events with every word of `query`, between from and to (optional, epoch ms). */
    async search(query, from, to) {
        return this.run(async () => this.manager.search({ text: text(query), from: Number.isFinite(from) ? from : undefined, to: Number.isFinite(to) ? to : undefined }));
    }

    /** One occurrence by id: {occurrence}. */
    async event(id) {
        return this.run(async () => ({ occurrence: this.manager.event(text(id)) }));
    }

    /**
     * A new event: {occurrence}, with occurrence.emailed {what, to} when it emailed someone. input: {calendarId?,
     * title, start, end?, allDay?, timeZone?, location?, description?, url?, repeat?, alarms?, attendees?, busy?,
     * privacy?, notify?, approved?}. notify: invite the guests now. Where the server would email them anyway
     * (Microsoft, a CalDAV server that schedules), guests without notify are refused with 'calendar/needs-notify'.
     * approved: everyone the user was shown it emails or reaches (a refusal's details.people), for the very change
     * that was refused (asked.js). Without it, a new event that would email or reach anyone is refused
     * ('calendar/needs-approval'); with it, one that would reach anyone else is ('calendar/changed'). With
     * occurrence.reached {how, to} when Google put it on guests' calendars without emailing them.
     */
    async createEvent(input) {
        return this.run(async () => ({ occurrence: await this.changes.create(object(input)) }));
    }

    /**
     * Change an event: {occurrence}, as it is now (with emailed, as createEvent's). scope: 'one', 'following'
     * or 'all' (an occurrence's `scopes` say which it takes). Fields as createEvent's; null clears one;
     * patch.notify tells the guests (a change the server would email them about anyway is refused without
     * it: 'calendar/needs-notify'). patch.calendarId, given alone with scope 'all', moves the whole event or
     * series to that calendar; with other fields or another scope it is refused. A series that would lose
     * occurrences changed on their own (or, into Microsoft, skipped and extra dates) is refused with
     * 'calendar/drops-changes', saying what; patch.dropChanges moves it anyway. patch.approved as createEvent's.
     */
    async updateEvent(id, patch, scope) {
        return this.run(async () => ({ occurrence: await this.changes.update(text(id), object(patch), text(scope) || 'all') }));
    }

    /**
     * Delete an event, one occurrence, or this and the following ones: {emailed?: {what, to}, reached?: {how,
     * to}}. notify: tell its guests (for someone else's invitation, its organizer); a delete the server would
     * email them about anyway is refused without it ('calendar/needs-notify'). approved as createEvent's.
     */
    async deleteEvent(id, scope, notify, approved) {
        return this.run(async () => this.changes.delete(text(id), text(scope) || 'all', notify === true, list(approved)));
    }

    /** Answer an invitation ('accepted', 'declined', 'tentative') for scope 'one' or 'all': {occurrence}, with emailed when the organizer was sent it. */
    async respond(id, status, scope) {
        return this.run(async () => ({ occurrence: await this.manager.respond(text(id), text(status), text(scope) || 'all', 'window') }));
    }

    /** Add a subscription ({kind: 'ics', url, name?}) or a CalDAV account ({kind: 'caldav', url, username, password, preset?, name?}): {account}. */
    async addAccount(input) {
        return this.run(async () => ({ account: await this.manager.addAccount(object(input)) }));
    }

    /** Rename an account, or give a CalDAV account its new password: {account}. */
    async updateAccount(id, patch) {
        return this.run(async () => ({ account: await this.manager.updateAccount(text(id), object(patch)) }));
    }

    /**
     * Remove an account from this plugin (its events stay on its server):
     * {revoked?, manageUrl?}. revoked: the provider withdrew the plugin's
     * access (Google); manageUrl: the page where the user withdraws it
     * (Microsoft).
     */
    async removeAccount(id) {
        return this.run(async () => this.manager.removeAccount(text(id)));
    }

    /** Sync one account now (its calendar list too), or every account: {}. */
    async syncNow(accountId) {
        return this.run(async () => {
            if (text(accountId)) await this.manager.syncAccount(text(accountId), { calendars: true });
            else await this.manager.syncAll();
            return {};
        });
    }

    /**
     * Start signing in to Google ('google') or Microsoft ('microsoft'), for a
     * new account or again for accountId. {flow, kind, status, url? (open it
     * in the browser), userCode?, verificationUri?, message? (a code to enter
     * on Microsoft's page: method 'code')}.
     */
    async startSignIn(kind, accountId, method) {
        return this.run(async () => this.manager.startSignIn(text(kind), text(accountId) || undefined, text(method) ? { method: text(method) } : {}));
    }

    /** How a sign-in stands: status 'waiting', 'done' (with account) or 'failed' (with error). */
    async signInStatus(flow) {
        return this.run(async () => this.manager.signInStatus(text(flow)));
    }

    /** Finish with the address the browser ended on, when it couldn't come back here. */
    async finishSignIn(flow, url) {
        return this.run(async () => this.manager.finishSignIn(text(flow), text(url)));
    }

    async cancelSignIn(flow) {
        return this.run(async () => {
            this.manager.cancelSignIn(text(flow));
            return {};
        });
    }

    /** Google's sign-in needs an OAuth client of the user's own: its id (kept in the plugin's store) and secret (kept in DSH's credential store). */
    async setGoogleClient(clientId, clientSecret) {
        return this.run(async () => {
            const id = text(clientId).trim();
            if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new CalendarError('A Google client id ends in .apps.googleusercontent.com.');
            if (text(clientSecret).trim() !== '') await this.setup.setGoogleSecret(text(clientSecret).trim());
            this.manager.setPrefs({ googleClientId: id });
            return { signIn: await this.setup.signInReady() };
        });
    }

    /** Microsoft's sign-in needs an app registration of the user's own: its client id, and the tenant ('common' for any account). */
    async setMicrosoftClient(clientId, tenant) {
        return this.run(async () => {
            const id = text(clientId).trim();
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new CalendarError('A Microsoft client id looks like 00000000-0000-0000-0000-000000000000.');
            this.manager.setPrefs({ microsoftClientId: id, microsoftTenant: text(tenant).trim() || 'common' });
            return { signIn: await this.setup.signInReady() };
        });
    }

    /** A new calendar on this computer: {calendar}. */
    async createCalendar(name, color) {
        return this.run(async () => ({ calendar: await this.manager.createCalendar({ name: text(name), color: text(color) }) }));
    }

    /** Delete a calendar on this computer, with its events: {}. */
    async deleteCalendar(id) {
        return this.run(async () => {
            await this.manager.deleteCalendar(text(id));
            return {};
        });
    }

    /** The user's choices for a calendar ({name?, color?, hidden?}): {calendar}. */
    async updateCalendar(id, patch) {
        return this.run(async () => ({ calendar: this.manager.updateCalendar(text(id), object(patch)) }));
    }

    async setDefaultCalendar(id) {
        return this.run(async () => {
            this.manager.setDefaultCalendar(text(id));
            return {};
        });
    }

    /**
     * The window's choices, those given changed and the rest kept: {weekStart:
     * 0-6 (0 Sunday) or null, view, hideWeekends (Week and Month without
     * Saturday and Sunday), weekNumbers (ISO 8601 week numbers shown)}.
     * hideWeekends and weekNumbers are true for on, false for off: {prefs}.
     */
    async setPrefs(patch) {
        return this.run(async () => {
            const p = object(patch);
            this.manager.setPrefs({ weekStart: p.weekStart, view: p.view, hideWeekends: p.hideWeekends, weekNumbers: p.weekNumbers });
            return { prefs: this.manager.state().prefs };
        });
    }

    /** A calendar as an iCalendar file: {name, ics, events}. */
    async exportCalendar(id) {
        return this.run(async () => this.manager.exportCalendar(text(id)));
    }

    /** Events from an iCalendar file's text into a calendar: {added, skipped}. */
    async importIcs(calendarId, ics) {
        return this.run(async () => this.manager.importIcs(text(calendarId), text(ics)));
    }
}

/** Mark methods the way the `@Remote` decorator does in DSH's TypeScript. */
function markRemote(Class, names) {
    for (const name of names) {
        Remote(Class.prototype[name], {
            kind: 'method', name, static: false, private: false,
            addInitializer(init) { init.call(Object.create(Class.prototype)); },
        });
    }
}
markRemote(CalendarRemote, [
    'state', 'version', 'events', 'search', 'event', 'createEvent', 'updateEvent', 'deleteEvent', 'respond',
    'addAccount', 'updateAccount', 'removeAccount', 'syncNow', 'startSignIn', 'signInStatus', 'finishSignIn', 'cancelSignIn',
    'setGoogleClient', 'setMicrosoftClient', 'createCalendar', 'deleteCalendar', 'updateCalendar', 'setDefaultCalendar', 'setPrefs',
    'exportCalendar', 'importIcs',
]);
