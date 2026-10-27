/**
 * The calendar manager: accounts and their calendars, syncing, the events
 * in a span of time, and changes routed to the server that holds each
 * event. The window (remote.js) and the agent tools (tools.js) both go
 * through it, so the user and agents see and change the same calendars.
 *
 * Ids it hands out:
 *   account     'local', or 'acct-' + 8 hex (also the credential record's id)
 *   calendar    'cal-' + 12 hex, from its account and its server id
 *   event       'ev-' + 12 hex, from its calendar and uid; the same across syncs (a
 *               series and its changed occurrences share it, whichever items hold them)
 *   occurrence  the event id, plus '.' and the original start of that
 *               occurrence ('ev-…​.20261012T093000', '.20261012' for a day) when
 *               the event repeats
 *
 * @module dsh-plugin-calendar/manager
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync } from 'node:fs';
import { occurrences, rangeRecord } from './expand.js';
import { request, safeHost } from './http.js';
import { editIcs, newUid, readIcs } from './ical.js';
import { addressKey, cleanRecord, instantOf, isEmailAddress, sameTime } from './model.js';
import { describeRule, expandWall, parseRule, ruleText, WEEKDAYS } from './recur.js';
import { dataPath } from './config.js';
import { CalendarStore, ensurePrivateDir } from './store.js';
import { SourceError, problemOf, sourceModule } from './sources/index.js';
import { addDays, dayIn, daysBetween, isDay, isZone, localZone, normalLocal, toInstant, toLocal, wallMs, wallOf } from './zones.js';
import { dirname } from 'node:path';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const CONFLICT = Symbol('conflict');

/** A refusal the user (or the agent) can act on: its message says what to do. */
export class CalendarError extends Error {
    /**
     * @param {string} message
     * @param {string} [code] - 'needs-notify': the change would email people, and it didn't say to tell them;
     *   'drops-changes', 'choose-calendar' and 'changed' as remote.js says.
     * @param {{people?: string[], mail?: object}} [details] - for a refusal over who a change emails or reaches
     *   ('needs-notify', 'needs-approval', 'changed'): people, every one of them, for the window to name and to
     *   hold the change to when the user says yes (approved); mail, what they get (mailDetails()). 'changed'
     *   naming no one (people empty): the event changed meanwhile, with nobody new to ask about.
     */
    constructor(message, code, details) {
        super(message);
        this.name = 'CalendarError';
        if (code !== undefined) this.code = code;
        if (Array.isArray(details?.people)) this.people = details.people;
        if (details?.mail !== undefined) this.mail = details.mail;
    }
}

const hex = (text, n) => createHash('sha256').update(text).digest('hex').slice(0, n);
export const calendarIdOf = (accountId, remoteId) => `cal-${hex(`${accountId}\n${remoteId}`, 12)}`;
export const eventIdOf = (calendarId, uid) => `ev-${hex(`${calendarId}\n${uid}`, 12)}`;

/** A Time as the part of an occurrence id after the dot. */
export function compactTime(time) {
    if ('date' in time) return time.date.replaceAll('-', '');
    return `${time.local.replace(/[-:]/g, '')}${time.tz === 'UTC' ? 'Z' : ''}`;
}

/** That part back to a Time, in the series' zone. */
function timeOfCompact(text, tz) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(text);
    if (m === null) return undefined;
    if (m[4] === undefined) return { date: `${m[1]}-${m[2]}-${m[3]}` };
    return { local: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, tz: m[7] ? 'UTC' : (tz ?? null) };
}

/** Colors for calendars that come without one. */
export const PALETTE = ['#4f7cff', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#e54666', '#0090ff', '#ad7f58', '#6e56cf'];

/** How a change reaches guests' calendars without emailing them (Google), as an instruction. */
const REACH_WORDS = { add: 'put it on', remove: 'take it off', change: 'change it on' };

const KIND_NAMES = { local: 'Kept in DSH', ics: 'Subscription', caldav: 'CalDAV', google: 'Google', microsoft: 'Microsoft' };

/** What the user may change on someone else's invitation: their own reminders, busy or free, and privacy. */
const OWN_FIELDS = new Set(['alarms', 'busy', 'privacy']);

/** Fields a change may set, as the window and the tools give them. */
const INPUT_FIELDS = ['title', 'start', 'end', 'allDay', 'timeZone', 'location', 'description', 'url', 'repeat', 'alarms', 'attendees', 'busy', 'privacy', 'status', 'conference'];

export class CalendarManager {
    /**
     * @param {object} opts
     * @param {object} opts.config - the plugin's settings (index.js Config).
     * @param {{get(id): Promise<any>, set(id, payload): Promise<void>, clear(id): Promise<void>}} opts.secrets -
     *   the accounts' secrets, by account id (DSH's credential store).
     * @param {() => Promise<object>} [opts.clientSettings] - OAuth client ids and the like, read when a source needs them.
     * @param {typeof fetch} [opts.fetch] - for tests.
     * @param {() => number} [opts.now] - for tests.
     * @param {object} [opts.logger] - DSH's logger, for warnings.
     */
    constructor({ config, secrets, clientSettings, fetch, now, logger }) {
        this.config = config;
        this.secrets = secrets;
        this.clientSettings = clientSettings ?? (async () => ({}));
        this.fetch = fetch;
        this.now = now ?? Date.now;
        this.logger = logger;
        this.logFile = config.logFile ? dataPath(config.logFile) : '';
        this.store = new CalendarStore(config.storeFile, { now: this.now, log: (line) => this.log(`store ${line}`) });
        /** Bumped on every change the window should redraw for. */
        this.version = 1;
        this.sources = new Map();
        this.locks = new Map();
        this.flows = new Map();
        this.timers = new Set();
        this.syncing = new Set();
        this.disposed = false;
        this.indexVersion = 0;
        this.eventIndex = new Map();
        /** Creates whose answer was lost, by what they asked for: a repeat reuses the uid, so the server makes it once. */
        this.lostCreates = new Map();
        /** Moves that made their copy but stopped before taking the event out, by event and calendar: {uid of the copy, at}. */
        this.halfMoves = new Map();
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    async start() {
        // A feed's address kept in calendar.json by an older version moves to the credential store, once.
        await this.moveFeedAddresses();
        if (!Object.values(this.store.accounts).some((a) => a.kind === 'local')) {
            this.store.accounts.local = {
                id: 'local', kind: 'local', name: KIND_NAMES.local, createdAt: this.now(),
                calendars: [{ remoteId: 'personal', name: 'Personal', color: PALETTE[0] }],
            };
            this.log('account added local');
        }
        // The calendars kept here were once named "On this computer", which read as the Mac's own.
        for (const account of Object.values(this.store.accounts)) if (account.kind === 'local' && account.name === 'On this computer') account.name = KIND_NAMES.local;
        await this.refreshCalendars('local');
        // Once Personal is known: leftover temporary files go, other calendars' events files stay.
        this.store.sweep();
        this.saveState();
        // 5 minutes to a day: a longer interval than a timer can hold would fire at once, again and again.
        const minutes = Math.min(1440, Math.max(5, Number(this.config.syncMinutes) || 15));
        this.later(() => this.syncAll(), 3000);
        const every = setInterval(() => { void this.syncAll(); }, minutes * MINUTE);
        every.unref?.();
        this.timers.add({ clear: () => clearInterval(every) });
    }

    /**
     * A subscription's address lives in its credential record. A store from
     * before kept it in calendar.json, as the account's url and its
     * calendar's remoteId: moved to the record once, and out of the file
     * (with the old errors, whose messages named it). The calendar takes the
     * feed's id with the user's choices for it; its events come again with
     * the next sync.
     */
    async moveFeedAddresses() {
        const { FEED, feedUrl } = await sourceModule('ics');
        let moved = 0;
        for (const account of Object.values(this.store.accounts)) {
            if (account.kind !== 'ics' || typeof account.url !== 'string') continue;
            try {
                await this.secrets.set(account.id, { url: account.url });
            } catch {
                // It stays in the file until the record can be written: the next start tries again.
                this.log(`error move ${account.id}`);
                continue;
            }
            account.host = safeHost(feedUrl(account.url));
            delete account.url;
            delete account.error;
            for (const calendar of Object.values(this.store.calendars)) {
                if (calendar.accountId !== account.id || calendar.remoteId === FEED) continue;
                const id = calendarIdOf(account.id, FEED);
                const kept = { ...calendar, id, remoteId: FEED };
                delete kept.sync;
                delete kept.syncedAt;
                delete kept.error;
                this.store.dropCalendar(calendar.id);
                this.store.calendars[id] = kept;
            }
            moved++;
            this.log(`address moved ${account.id} to the credential store`);
        }
        if (moved > 0) this.saveState();
    }

    dispose() {
        this.disposed = true;
        for (const t of this.timers) t.clear();
        this.timers.clear();
        for (const flow of this.flows.values()) {
            try { flow.handle?.cancel?.(); } catch {}
        }
        this.flows.clear();
        this.store.flush();
    }

    /** Run something once after a delay, unless the plugin stops first. */
    later(run, ms) {
        const entry = {};
        const timer = setTimeout(() => {
            this.timers.delete(entry);
            if (!this.disposed) void Promise.resolve().then(run).catch((error) => this.log(`error later ${short(error)}`));
        }, ms);
        timer.unref?.();
        entry.clear = () => clearTimeout(timer);
        this.timers.add(entry);
    }

    /** One line in the plugin's log: ids, kinds and counts, never secrets or event text. */
    log(line) {
        if (!this.logFile) return;
        try {
            const fresh = !existsSync(this.logFile);
            if (fresh) ensurePrivateDir(dirname(this.logFile));
            appendFileSync(this.logFile, `${new Date(this.now()).toISOString()} ${line}\n`, { mode: 0o600 });
            if (fresh) chmodSync(this.logFile, 0o600);
        } catch {
            // The log is for diagnosis; never let it break a change.
        }
    }

    saveState() {
        try {
            this.store.save();
        } catch (error) {
            this.log(`error save ${short(error)}`);
        }
    }

    changed() {
        this.version++;
    }

    /** The user's zone: the plugin setting, else this computer's. */
    zone() {
        const own = typeof this.config.timeZone === 'string' ? this.config.timeZone.trim() : '';
        return own !== '' && isZone(own) ? own : localZone();
    }

    // ── Sources ────────────────────────────────────────────────────────

    async envFor(account) {
        const settings = await this.clientSettings();
        return {
            request: (url, init = {}) => request(url, { ...init, allowHttp: account.allowHttp === true || init.allowHttp === true, fetch: this.fetch ?? init.fetch }),
            secret: {
                get: () => this.secrets.get(account.id),
                set: (payload) => this.secrets.set(account.id, payload),
                clear: () => this.secrets.clear(account.id),
            },
            log: (line) => this.log(`${account.id} ${line}`),
            now: this.now,
            zone: this.zone(),
            settings,
        };
    }

    /** The source for an account, made once per account (and again after the account changes). */
    async source(account) {
        const key = `${account.id}\n${account.kind}\n${account.url ?? ''}\n${account.username ?? ''}\n${JSON.stringify(account.calendars ?? [])}`;
        const had = this.sources.get(account.id);
        if (had?.key === key) return had;
        const module = await sourceModule(account.kind);
        const made = { key, module, style: module.style, source: module.create(account, await this.envFor(account)) };
        this.sources.set(account.id, made);
        return made;
    }

    // ── Accounts and calendars ─────────────────────────────────────────

    account(id) {
        const account = this.store.accounts[id];
        if (account === undefined) throw new CalendarError(`There is no calendar account "${id}".`);
        return account;
    }

    calendar(id) {
        const calendar = this.store.calendars[id];
        if (calendar === undefined) throw new CalendarError(`There is no calendar "${id}". The calendars are: ${this.calendarList().map((c) => `${c.name} (${c.id})`).join(', ') || 'none'}.`);
        return calendar;
    }

    /** A calendar's name and color: the user's own choice over the server's. */
    calendarName(calendar) {
        return calendar.own?.name || calendar.name || 'Calendar';
    }

    calendarColor(calendar) {
        return calendar.own?.color || calendar.color || PALETTE[0];
    }

    calendarView(calendar) {
        const account = this.store.accounts[calendar.accountId];
        const synced = this.store.syncOf(calendar.id);
        const issue = this.store.issues.get(calendar.id);
        return {
            id: calendar.id,
            accountId: calendar.accountId,
            account: account?.name ?? '',
            kind: account?.kind ?? '',
            name: this.calendarName(calendar),
            color: this.calendarColor(calendar),
            readOnly: calendar.readOnly === true,
            hidden: calendar.hidden === true,
            isDefault: this.defaultCalendarId() === calendar.id,
            // Whether its server can email guests (invitations, updates, cancellations).
            canEmail: this.mailerOf(calendar) !== 'never',
            ...(calendar.timeZone ? { timeZone: calendar.timeZone } : {}),
            ...(calendar.description ? { description: calendar.description } : {}),
            ...(calendar.error ? { error: calendar.error.message, problem: problemOf(calendar.error.code) } : {}),
            ...(synced?.at ? { syncedAt: synced.at } : {}),
            // Its events file couldn't be read at this start: the name it is kept under in the events folder.
            ...(issue ? { storeIssue: { ...issue } } : {}),
        };
    }

    /** Every calendar, in account order then name. */
    calendarList() {
        const accounts = Object.values(this.store.accounts);
        const order = new Map(accounts.map((a, i) => [a.id, a.kind === 'local' ? -1 : i]));
        return Object.values(this.store.calendars)
            .sort((a, b) => (order.get(a.accountId) ?? 0) - (order.get(b.accountId) ?? 0) || this.calendarName(a).localeCompare(this.calendarName(b)))
            .map((c) => this.calendarView(c));
    }

    /**
     * An account as the window sees it. A subscription shows its `host`, never
     * its address (a secret); a CalDAV account its server's `url`. `error` is
     * for the user; `problem`, its fixed category, is all agents are told.
     */
    accountView(account) {
        // A calendar of it that failed (its server couldn't be reached, or refused it) is the account's trouble too:
        // its row says so, with the calendar's name when the account has more than one.
        const own = account.error;
        const mine = Object.values(this.store.calendars).filter((c) => c.accountId === account.id);
        const failing = own ? undefined : mine.find((c) => c.error);
        const error = own ?? failing?.error;
        const words = error ? (failing && mine.length > 1 ? `${this.calendarName(failing)}: ${error.message}` : error.message) : '';
        return {
            id: account.id,
            kind: account.kind,
            kindName: KIND_NAMES[account.kind] ?? account.kind,
            name: account.name,
            ...(account.email ? { email: account.email } : {}),
            ...(account.username ? { username: account.username } : {}),
            ...(account.url && account.kind !== 'ics' ? { url: safeAddress(account.url) } : {}),
            ...(account.host ? { host: account.host } : {}),
            ...(account.preset ? { preset: account.preset } : {}),
            status: this.syncing.has(account.id) ? 'syncing' : own?.code === 'auth' ? 'signin' : error ? 'error' : 'ok',
            ...(error ? { error: words, problem: problemOf(error.code) } : {}),
            // When every calendar of it last synced (a failed try leaves it), and when it last tried.
            ...(account.syncedAt ? { syncedAt: account.syncedAt } : {}),
            ...(account.triedAt ? { triedAt: account.triedAt } : {}),
        };
    }

    /**
     * The calendar new events go to: the user's choice; else the main
     * calendar of the first account added that names one (Google's primary,
     * Microsoft's default, a CalDAV server's default); else the accounts'
     * only writable calendar; else the first one kept in DSH. Never a pick
     * among an account's calendars, where one can be shared with a team or a
     * family: with none of these, undefined, and a new event asks which.
     */
    defaultCalendarId() {
        const chosen = this.store.prefs.defaultCalendar;
        if (chosen && this.store.calendars[chosen] && !this.store.calendars[chosen].readOnly) return chosen;
        const writable = Object.values(this.store.calendars).filter((c) => !c.readOnly && !c.hidden);
        const remote = writable.filter((c) => c.accountId !== 'local');
        const added = (c) => this.store.accounts[c.accountId]?.createdAt ?? 0;
        const main = remote.filter((c) => c.primary === true).sort((a, b) => added(a) - added(b))[0];
        if (main) return main.id;
        if (remote.length === 1) return remote[0].id;
        return writable.find((c) => c.accountId === 'local')?.id;
    }

    /**
     * Before a new account brings its calendars: with no default chosen, a
     * calendar that new events have been going to and that holds events
     * stays the default, kept as the choice. So adding an account never
     * moves new events, a chat's too, to a server calendar (where guests can
     * be emailed) once the user has used another; a store with no events yet
     * takes the account's main calendar, and the window says so.
     */
    holdDefault() {
        if (this.store.prefs.defaultCalendar) return;
        const now = this.defaultCalendarId();
        if (now && Object.keys(this.store.itemsOf(now)).length > 0) {
            this.store.prefs.defaultCalendar = now;
            this.log(`default kept ${now}`);
        }
    }

    /** Read the account's calendars from its server; add new ones, drop gone ones. */
    async refreshCalendars(accountId) {
        const account = this.account(accountId);
        const { source } = await this.source(account);
        const found = await source.calendars();
        const seen = new Set();
        let added = 0;
        for (const [i, c] of found.entries()) {
            const id = calendarIdOf(account.id, c.remoteId);
            seen.add(id);
            const had = this.store.calendars[id];
            const color = c.color || had?.color || PALETTE[(Object.keys(this.store.calendars).length + i) % PALETTE.length];
            const next = {
                ...had, id, accountId: account.id, remoteId: c.remoteId, name: c.name || had?.name || 'Calendar', color,
                readOnly: c.readOnly === true, mode: c.mode ?? 'masters',
                ...(c.timeZone ? { timeZone: c.timeZone } : {}), ...(c.description ? { description: c.description } : {}),
                ...(typeof c.scheduling === 'boolean' ? { scheduling: c.scheduling } : {}),
            };
            // The account's main calendar, while its server says so.
            if (c.primary === true) next.primary = true;
            else delete next.primary;
            this.store.calendars[id] = next;
            if (had === undefined) {
                added++;
                this.store.itemsOf(id);
            }
        }
        let dropped = 0;
        for (const c of Object.values(this.store.calendars)) {
            if (c.accountId === account.id && !seen.has(c.id)) {
                this.store.dropCalendar(c.id);
                dropped++;
            }
        }
        // The user's own addresses, where the server names them (CalDAV): who the user is on a guest list.
        const addresses = [...new Set(found.flatMap((c) => (Array.isArray(c.addresses) ? c.addresses : [])))];
        if (addresses.length > 0) account.addresses = addresses;
        account.calendarsAt = this.now();
        if (added || dropped) this.log(`calendars ${account.id} added=${added} dropped=${dropped} total=${seen.size}`);
        this.saveState();
        this.changed();
    }

    /**
     * Add an account: a subscription ({kind: 'ics', url, name?}), or a CalDAV
     * account ({kind: 'caldav', url, username, password, preset?, name?,
     * allowHttp?}), checked before it's kept. Google and Microsoft accounts
     * come from startSignIn.
     */
    async addAccount(input) {
        const kind = input?.kind;
        if (kind === 'ics') return this.addSubscription(input);
        if (kind === 'caldav') return this.addCalDav(input);
        if (kind === 'google' || kind === 'microsoft') throw new CalendarError(`${KIND_NAMES[kind]} accounts are added by signing in.`);
        throw new CalendarError('Say which kind of account: a subscription (ics) or CalDAV.');
    }

    newAccountId() {
        for (;;) {
            const id = `acct-${randomBytes(4).toString('hex')}`;
            if (!this.store.accounts[id]) return id;
        }
    }

    async addSubscription(input) {
        const raw = String(input.url ?? '').trim();
        let url;
        try {
            url = new URL(raw.replace(/^webcals?:\/\//i, 'https://'));
        } catch {
            throw new CalendarError('Give the calendar\'s address, like https://example.com/calendar.ics or webcal://….');
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CalendarError('A subscribed calendar\'s address starts with https:// or webcal://.');
        const id = this.newAccountId();
        // The address is a secret (a private feed's key is in its path): kept like a password, and the file has its host.
        const account = { id, kind: 'ics', name: String(input.name ?? '').trim() || url.hostname, host: url.host, createdAt: this.now(), ...(input.allowHttp === true ? { allowHttp: true } : {}) };
        await this.secrets.set(id, { url: raw });
        this.store.accounts[id] = account;
        try {
            await this.refreshCalendars(id);
            const [calendar] = Object.values(this.store.calendars).filter((c) => c.accountId === id);
            await this.syncCalendar(calendar.id, { throwErrors: true });
            account.syncedAt = account.triedAt = this.now();
            if (!input.name && calendar.name) account.name = calendar.name;
        } catch (error) {
            this.forgetAccount(id);
            await this.secrets.clear(id).catch(() => {});
            this.saveState();
            throw asCalendarError(error);
        }
        this.log(`account added ${id} ics`);
        this.saveState();
        return this.accountView(account);
    }

    async addCalDav(input) {
        const username = String(input.username ?? '').trim();
        const password = String(input.password ?? '');
        const url = String(input.url ?? '').trim();
        if (url === '') throw new CalendarError('Give the server\'s address.');
        if (username === '' || password === '') throw new CalendarError('Give the user name and the password (an app password for iCloud, Fastmail and Yahoo).');
        const id = this.newAccountId();
        const account = {
            id, kind: 'caldav', name: String(input.name ?? '').trim() || username, url, username,
            ...(input.preset ? { preset: String(input.preset) } : {}), ...(input.allowHttp === true ? { allowHttp: true } : {}),
            createdAt: this.now(),
        };
        if (/^[^@\s]+@[^@\s]+$/.test(username)) account.email = username;
        await this.secrets.set(id, { password });
        try {
            const module = await sourceModule('caldav');
            const found = await module.discover(account, await this.envFor(account));
            if (!found?.calendars?.length) throw new CalendarError('The server has no calendars for this account.');
            this.holdDefault();
            this.store.accounts[id] = account;
            await this.refreshCalendars(id);
        } catch (error) {
            delete this.store.accounts[id];
            await this.secrets.clear(id).catch(() => {});
            this.sources.delete(id);
            throw asCalendarError(error);
        }
        this.log(`account added ${id} caldav${account.preset ? ` ${account.preset}` : ''}`);
        this.saveState();
        void this.syncAccount(id);
        return this.accountView(account);
    }

    /** Change an account's name, or its password (CalDAV), then sync it. */
    async updateAccount(id, patch = {}) {
        const account = this.account(id);
        if (typeof patch.name === 'string' && patch.name.trim() !== '') account.name = patch.name.trim();
        if (typeof patch.password === 'string' && patch.password !== '') {
            if (account.kind !== 'caldav') throw new CalendarError('Only CalDAV accounts have a password here; sign in again for Google and Microsoft.');
            await this.secrets.set(id, { password: patch.password });
            delete account.error;
            this.sources.delete(id);
            void this.syncAccount(id);
        }
        this.saveState();
        this.changed();
        return this.accountView(account);
    }

    /**
     * Remove an account: its calendars and their events leave this plugin
     * (the events on the server stay). The plugin's access is withdrawn where
     * the provider lets it (Google): {revoked: true}; else manageUrl is the
     * page where the user withdraws it (Microsoft).
     */
    async removeAccount(id) {
        const account = this.account(id);
        if (account.kind === 'local') throw new CalendarError('The calendars kept in DSH stay; delete a calendar instead.');
        const withdrawn = await this.withdraw(account);
        this.forgetAccount(id);
        await this.secrets.clear(id).catch(() => {});
        this.log(`account removed ${id} ${account.kind}${withdrawn.revoked ? ' revoked' : ''}`);
        this.saveState();
        this.changed();
        return withdrawn;
    }

    /** Withdraw the plugin's access at the provider, where its source can. Never stops a removal. */
    async withdraw(account) {
        let module;
        try {
            module = (await this.source(account)).module ?? await sourceModule(account.kind);
            if (typeof module.revoke !== 'function') return {};
            const secret = await this.secrets.get(account.id);
            if (secret === undefined) return {};
            let timer;
            const late = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), 10_000); });
            const out = await Promise.race([module.revoke(await this.envFor(account), secret), late]).finally(() => clearTimeout(timer));
            return withdrawal(out?.revoked === true, out?.manageUrl ?? module.MANAGE_URL);
        } catch (error) {
            this.log(`revoke failed ${account.kind} ${error?.code ?? ''}`);
            return withdrawal(false, module?.MANAGE_URL);
        }
    }

    forgetAccount(id) {
        for (const c of Object.values(this.store.calendars)) if (c.accountId === id) this.store.dropCalendar(c.id);
        delete this.store.accounts[id];
        this.sources.delete(id);
    }

    /** A new calendar kept in DSH. */
    async createCalendar({ name, color } = {}) {
        const account = this.account('local');
        const title = String(name ?? '').trim();
        if (title === '') throw new CalendarError('Give the calendar a name.');
        const remoteId = `cal-${randomBytes(4).toString('hex')}`;
        account.calendars = [...(account.calendars ?? []), { remoteId, name: title, color: validColor(color) ?? PALETTE[(account.calendars?.length ?? 0) % PALETTE.length] }];
        this.sources.delete('local');
        await this.refreshCalendars('local');
        this.log('calendar added local');
        return this.calendarView(this.calendar(calendarIdOf('local', remoteId)));
    }

    /** Delete a calendar kept in DSH, with its events. */
    async deleteCalendar(id) {
        const calendar = this.calendar(id);
        if (calendar.accountId !== 'local') throw new CalendarError('Only calendars kept in DSH are deleted here; hide a synced one, or delete it in its own app.');
        const account = this.account('local');
        if ((account.calendars ?? []).length <= 1) throw new CalendarError('This is the last calendar kept in DSH; it stays.');
        account.calendars = account.calendars.filter((c) => c.remoteId !== calendar.remoteId);
        this.sources.delete('local');
        await this.refreshCalendars('local');
        this.log('calendar deleted local');
    }

    /** The user's choices for a calendar: name, color, hidden. */
    updateCalendar(id, patch = {}) {
        const calendar = this.calendar(id);
        const own = { ...calendar.own };
        if (typeof patch.name === 'string') {
            const name = patch.name.trim();
            if (calendar.accountId === 'local' && name !== '') {
                const account = this.account('local');
                account.calendars = (account.calendars ?? []).map((c) => (c.remoteId === calendar.remoteId ? { ...c, name } : c));
                calendar.name = name;
                this.sources.delete('local');
            } else if (name === '') {
                delete own.name;
            } else {
                own.name = name;
            }
        }
        if (typeof patch.color === 'string') {
            const color = validColor(patch.color);
            if (color) own.color = color;
        }
        calendar.own = own;
        if (typeof patch.hidden === 'boolean') calendar.hidden = patch.hidden;
        this.saveState();
        this.changed();
        return this.calendarView(calendar);
    }

    setDefaultCalendar(id) {
        const calendar = this.calendar(id);
        if (calendar.readOnly) throw new CalendarError(`"${this.calendarName(calendar)}" can't be written, so new events can't go there.`);
        this.store.prefs.defaultCalendar = id;
        this.saveState();
        this.changed();
    }

    setPrefs(patch = {}) {
        const prefs = this.store.prefs;
        if (patch.weekStart === null || (Number.isInteger(patch.weekStart) && patch.weekStart >= 0 && patch.weekStart <= 6)) {
            if (patch.weekStart === null) delete prefs.weekStart;
            else prefs.weekStart = patch.weekStart;
        }
        if (typeof patch.view === 'string' && ['month', 'week', 'day', 'agenda'].includes(patch.view)) prefs.view = patch.view;
        // What Week and Month show: on with true, off (not kept) with false; anything else leaves it as it is.
        for (const key of ['hideWeekends', 'weekNumbers']) {
            if (patch[key] === true) prefs[key] = true;
            else if (patch[key] === false) delete prefs[key];
        }
        if (typeof patch.googleClientId === 'string') prefs.googleClientId = patch.googleClientId.trim();
        if (typeof patch.microsoftClientId === 'string') prefs.microsoftClientId = patch.microsoftClientId.trim();
        if (typeof patch.microsoftTenant === 'string') prefs.microsoftTenant = patch.microsoftTenant.trim();
        this.saveState();
        this.changed();
        return { ...prefs };
    }

    // ── Signing in (Google, Microsoft) ─────────────────────────────────

    /**
     * Start signing in to Google or Microsoft, for a new account or again for
     * one whose sign-in ran out. Google: open `url` in a browser on this
     * computer (or paste where it ends with finishSignIn). Microsoft: open
     * `verificationUri` anywhere and enter `userCode`.
     */
    /**
     * Start signing in to Google or Microsoft, for a new account or again
     * for accountId. method 'code' (Microsoft only): a code to enter on
     * Microsoft's page, from any device, instead of its page in the browser.
     */
    async startSignIn(kind, accountId, { method } = {}) {
        if (kind !== 'google' && kind !== 'microsoft') throw new CalendarError('Signing in is for Google and Microsoft accounts.');
        if (method !== undefined && method !== 'browser' && !(method === 'code' && kind === 'microsoft')) throw new CalendarError('Only a Microsoft account signs in with a code.');
        const existing = accountId ? this.account(accountId) : undefined;
        if (existing && existing.kind !== kind) throw new CalendarError('That account is of another kind.');
        for (const [id, flow] of this.flows) {
            if (flow.status === 'waiting') {
                try { flow.handle?.cancel?.(); } catch {}
                this.flows.delete(id);
            }
        }
        const module = await sourceModule(kind);
        const env = await this.envFor(existing ?? { id: 'new', kind });
        let handle;
        try {
            handle = await module.signIn(env, { ...(existing?.email ? { loginHint: existing.email } : {}), ...(method === 'code' ? { method } : {}) });
        } catch (error) {
            throw asCalendarError(error);
        }
        const id = `flow-${randomBytes(6).toString('hex')}`;
        const flow = { id, kind, status: 'waiting', handle, accountId, created: this.now() };
        this.flows.set(id, flow);
        handle.done.then((result) => this.finishFlow(flow, result), (error) => {
            flow.status = 'failed';
            flow.error = asCalendarError(error).message;
            this.log(`signin failed ${kind} ${error?.code ?? ''}`);
        });
        this.later(() => {
            if (flow.status === 'waiting') {
                try { handle.cancel?.(); } catch {}
                flow.status = 'failed';
                flow.error = 'The sign-in took too long. Start it again.';
            }
            this.later(() => this.flows.delete(id), 10 * MINUTE);
        }, 15 * MINUTE);
        this.log(`signin started ${kind}`);
        return this.flowView(flow);
    }

    flowView(flow) {
        const h = flow.handle ?? {};
        return {
            flow: flow.id, kind: flow.kind, status: flow.status,
            ...(h.url ? { url: h.url } : {}),
            ...(h.userCode ? { userCode: h.userCode, verificationUri: h.verificationUri, message: h.message, expiresAt: h.expiresAt } : {}),
            ...(flow.error ? { error: flow.error } : {}),
            ...(flow.account ? { account: this.accountView(this.store.accounts[flow.account] ?? { id: flow.account, kind: flow.kind, name: '' }) } : {}),
        };
    }

    async finishFlow(flow, result) {
        try {
            const email = typeof result?.email === 'string' ? result.email : '';
            let account = flow.accountId ? this.store.accounts[flow.accountId] : undefined;
            if (account === undefined) {
                // Signing in again to an account already here keeps it.
                account = Object.values(this.store.accounts).find((a) => a.kind === flow.kind && email && a.email?.toLowerCase() === email.toLowerCase());
            }
            if (account === undefined) {
                const id = this.newAccountId();
                account = { id, kind: flow.kind, name: email || KIND_NAMES[flow.kind], ...(email ? { email } : {}), createdAt: this.now() };
            }
            await this.secrets.set(account.id, result.grant);
            delete account.error;
            if (this.store.accounts[account.id] === undefined) this.holdDefault();
            this.store.accounts[account.id] = account;
            this.sources.delete(account.id);
            await this.refreshCalendars(account.id);
            flow.status = 'done';
            flow.account = account.id;
            this.log(`signin done ${flow.kind} ${account.id}`);
            this.saveState();
            void this.syncAccount(account.id);
        } catch (error) {
            flow.status = 'failed';
            flow.error = asCalendarError(error).message;
            this.log(`signin failed ${flow.kind} ${short(error)}`);
        }
    }

    signInStatus(flowId) {
        const flow = this.flows.get(flowId);
        if (flow === undefined) throw new CalendarError('That sign-in is over. Start it again.');
        return this.flowView(flow);
    }

    /** Google, when the browser can't come back to this computer: the address it ended on, pasted. */
    async finishSignIn(flowId, pastedUrl) {
        const flow = this.flows.get(flowId);
        if (flow === undefined) throw new CalendarError('That sign-in is over. Start it again.');
        if (typeof flow.handle?.finish !== 'function') throw new CalendarError('This sign-in finishes on its own once the code is entered.');
        try {
            await flow.handle.finish(String(pastedUrl ?? '').trim());
        } catch (error) {
            throw asCalendarError(error);
        }
        for (let i = 0; i < 50 && flow.status === 'waiting'; i++) await new Promise((r) => setTimeout(r, 100));
        return this.flowView(flow);
    }

    cancelSignIn(flowId) {
        const flow = this.flows.get(flowId);
        if (flow === undefined) return;
        try { flow.handle?.cancel?.(); } catch {}
        this.flows.delete(flowId);
    }

    // ── Syncing ────────────────────────────────────────────────────────

    /** The span of time sources that sync a window keep: three months back, thirteen ahead, by whole months. */
    syncWindow() {
        const d = new Date(this.now());
        return { from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1), to: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 13, 1) };
    }

    /** One thing at a time per key; the rest wait their turn. */
    async locked(key, run) {
        const before = this.locks.get(key) ?? Promise.resolve();
        let release;
        const mine = new Promise((resolve) => { release = resolve; });
        const chain = before.then(() => mine);
        this.locks.set(key, chain);
        await before.catch(() => {});
        try {
            return await run();
        } finally {
            release();
            if (this.locks.get(key) === chain) this.locks.delete(key);
        }
    }

    async syncAll() {
        for (const account of Object.values(this.store.accounts)) {
            if (this.disposed) return;
            if (account.kind === 'local') continue;
            if (account.error?.code === 'auth') continue;
            if (account.error?.code === 'rate' && account.error.until > this.now()) continue;
            await this.syncAccount(account.id).catch(() => {});
        }
    }

    /** Sync an account's calendars (and its calendar list, at most hourly or when asked). */
    async syncAccount(accountId, { calendars: listToo = false } = {}) {
        const account = this.store.accounts[accountId];
        if (account === undefined || account.kind === 'local') return;
        if (this.syncing.has(accountId)) return;
        this.syncing.add(accountId);
        this.changed();
        try {
            if (listToo || !account.calendarsAt || this.now() - account.calendarsAt > HOUR) {
                try {
                    await this.refreshCalendars(accountId);
                } catch (error) {
                    this.noteError(account, undefined, error);
                    return;
                }
            }
            let failed = false;
            for (const calendar of Object.values(this.store.calendars).filter((c) => c.accountId === accountId)) {
                if (this.disposed) return;
                const ok = await this.syncCalendar(calendar.id).catch(() => false);
                if (!ok) failed = true;
                if (account.error?.code === 'auth') break;
            }
            // Synced means every calendar of it synced: a try with one failing keeps the last good time.
            account.triedAt = this.now();
            if (!failed) {
                delete account.error;
                account.syncedAt = account.triedAt;
            }
            this.saveState();
        } finally {
            this.syncing.delete(accountId);
            this.changed();
        }
    }

    /** Sync one calendar. @returns whether it worked. */
    async syncCalendar(calendarId, { throwErrors = false } = {}) {
        return this.locked(`sync:${calendarId}`, async () => {
            const calendar = this.store.calendars[calendarId];
            if (calendar === undefined) return false;
            const account = this.store.accounts[calendar.accountId];
            if (account === undefined) return false;
            try {
                const { source, style } = await this.source(account);
                const items = this.store.itemsOf(calendar.id);
                const result = await source.sync({ ...calendar, remoteId: calendar.remoteId }, this.store.syncOf(calendar.id)?.state, this.syncWindow());
                // The calendar went meanwhile (its account removed, or gone from its server): what came is for nothing.
                if (this.store.items.get(calendar.id) !== items) return false;
                this.applySync(calendar, style, result);
                // The new state goes into the events file with the items it describes, never ahead of them.
                this.store.setSync(calendar.id, result.state, this.now());
                delete calendar.error;
                if (result.calendar) {
                    if (result.calendar.name && !calendar.own?.name && account.kind === 'ics') calendar.name = result.calendar.name;
                    if (result.calendar.color && account.kind === 'ics') calendar.color = result.calendar.color;
                    if (result.calendar.timeZone) calendar.timeZone = result.calendar.timeZone;
                }
                this.saveState();
                return true;
            } catch (error) {
                this.noteError(account, calendar, error);
                this.saveState();
                if (throwErrors) throw error;
                return false;
            } finally {
                this.changed();
            }
        });
    }

    noteError(account, calendar, error) {
        const code = error instanceof SourceError ? error.code : error?.code === 'timeout' || error?.name === 'HttpError' ? 'network' : 'server';
        const message = error instanceof SourceError || error instanceof CalendarError ? error.message : `Syncing failed: ${short(error)}`;
        const note = { code, message, at: this.now() };
        if (code === 'rate') note.until = this.now() + (Number(error.retryAfter) || 60) * 1000;
        if (calendar) calendar.error = note;
        if (code === 'auth' || code === 'rate' || calendar === undefined) account.error = note;
        this.log(`error sync ${account.id}${calendar ? ` ${calendar.id}` : ''} ${code}`);
    }

    /** What a sync brought, into the calendar's items. */
    applySync(calendar, style, result) {
        const zone = this.zone();
        const prepare = (item) => {
            let events = Array.isArray(item.events) ? item.events : [];
            if (style === 'ics' && typeof item.raw === 'string' && events.length === 0) events = readIcs(item.raw, { zone }).events;
            const out = { remoteId: item.remoteId, events: events.map(cleanRecord) };
            if (item.etag !== undefined) out.etag = item.etag;
            if (style === 'ics' && typeof item.raw === 'string' && !calendar.readOnly) out.raw = item.raw;
            return out;
        };
        if (result.reset) {
            const next = {};
            for (const item of result.items ?? []) next[item.remoteId] = prepare(item);
            this.store.items.set(calendar.id, next);
        } else {
            const items = this.store.itemsOf(calendar.id);
            for (const item of result.items ?? []) items[item.remoteId] = prepare(item);
            for (const remoteId of result.removed ?? []) delete items[remoteId];
        }
        const count = (result.items?.length ?? 0) + (result.removed?.length ?? 0);
        if (result.reset || count > 0) {
            this.store.touch(calendar.id);
            this.changed();
            this.log(`synced ${calendar.id} ${result.reset ? 'reset' : 'delta'} items=${result.items?.length ?? 0} removed=${result.removed?.length ?? 0}`);
        }
    }

    // ── Reading ────────────────────────────────────────────────────────

    /** event id → where it lives; rebuilt when the data changed. */
    index() {
        if (this.indexVersion === this.version) return this.eventIndex;
        const map = new Map();
        for (const calendar of Object.values(this.store.calendars)) {
            for (const item of Object.values(this.store.itemsOf(calendar.id))) {
                for (const record of item.events ?? []) {
                    const id = eventIdOf(calendar.id, record.uid);
                    if (!map.has(id)) map.set(id, { calendarId: calendar.id, uid: record.uid });
                }
            }
        }
        this.eventIndex = map;
        this.indexVersion = this.version;
        return map;
    }

    /**
     * The account's own addresses as addressKey() gives them, to tell which
     * person on an event is the user: its email and user name where they are
     * emails, and every address its server names the user by (CalDAV).
     */
    selfKeys(account) {
        const out = new Set();
        for (const value of [account?.email, account?.username]) if (isEmailAddress(value)) out.add(addressKey(value));
        for (const value of Array.isArray(account?.addresses) ? account.addresses : []) {
            const key = addressKey(value);
            if (key !== '') out.add(key);
        }
        return out;
    }

    /** Whether a person on an event is the user: marked so by the server, or named by one of the user's addresses. */
    isSelf(person, keys) {
        if (person?.self === true) return true;
        return [person?.address, person?.email].some((value) => {
            const key = addressKey(value);
            return key !== '' && keys.has(key);
        });
    }

    selfOf(record, account) {
        const mine = this.selfKeys(account);
        return (record.attendees ?? []).find((p) => this.isSelf(p, mine));
    }

    /**
     * The occurrences in [from, to), each with its calendar, item and ids.
     * @param {{from: number, to: number, calendars?: string[], all?: boolean}} q - calendars: these
     *   only (hidden ones too); all: hidden calendars too.
     */
    find({ from, to, calendars, all = false }) {
        const zone = this.zone();
        const out = [];
        const wanted = calendars?.length ? new Set(calendars) : undefined;
        for (const calendar of Object.values(this.store.calendars)) {
            if (wanted ? !wanted.has(calendar.id) : (calendar.hidden && !all)) continue;
            // A series and its changed occurrences can sit in different items (Google keeps each as its own event).
            const groups = new Map();
            for (const item of Object.values(this.store.itemsOf(calendar.id))) {
                for (const record of item.events ?? []) {
                    let group = groups.get(record.uid);
                    if (group === undefined) {
                        group = { records: [], items: new Map() };
                        groups.set(record.uid, group);
                    }
                    group.records.push(record);
                    group.items.set(record, item);
                }
            }
            for (const group of groups.values()) {
                for (const o of occurrences(group.records, { from, to, zone, mode: calendar.mode })) {
                    out.push({ o, calendar, item: group.items.get(o.record) });
                }
            }
        }
        return out.sort((a, b) => a.o.start - b.o.start || Number(b.o.allDay) - Number(a.o.allDay) || a.o.end - b.o.end);
    }

    /** An occurrence as the window and the tools see it. */
    view({ o, calendar, item }) {
        const record = o.record;
        const series = o.series;
        const account = this.store.accounts[calendar.accountId];
        const eventId = eventIdOf(calendar.id, record.uid);
        const repeats = series !== undefined || record.seriesRemoteId !== undefined;
        const zone = this.zone();
        // An event in its own zone shows on that zone's clock; a floating or UTC one on the user's.
        const own = record.allDay ? null : (record.start.tz ?? null);
        const tz = own === 'UTC' ? null : own;
        const self = this.selfOf(record, account);
        const out = {
            id: o.recurrenceId ? `${eventId}.${compactTime(o.recurrenceId)}` : eventId,
            eventId,
            calendarId: calendar.id,
            calendar: this.calendarName(calendar),
            color: this.calendarColor(calendar),
            title: record.title || '(No title)',
            start: o.start,
            end: o.end,
            allDay: o.allDay,
        };
        if (o.allDay) {
            out.startDay = o.startDay;
            out.lastDay = addDays(o.endDay, -1);
        } else {
            out.timeZone = tz ?? zone;
            out.startLocal = toLocal(o.start, tz ?? zone).slice(0, 16);
            out.endLocal = toLocal(o.end, tz ?? zone).slice(0, 16);
        }
        for (const key of ['location', 'description', 'url', 'conference', 'privacy', 'organizer', 'categories']) {
            if (record[key] !== undefined) out[key] = record[key];
        }
        if (record.attendees?.length) out.attendees = record.attendees.map((p) => ({ ...p, ...(p === self ? { self: true } : {}) }));
        if (record.alarms?.length) out.alarms = record.alarms;
        out.status = record.status ?? 'confirmed';
        out.busy = record.busy !== false;
        if (repeats) {
            out.recurring = true;
            // What a change to one occurrence can reach: Google and CalDAV split a series; Microsoft's can't be.
            out.scopes = calendar.mode === 'instances' ? ['one', 'all'] : ['one', 'following', 'all'];
            const rule = series?.rrule;
            if (rule) {
                out.repeat = rule;
                out.repeats = describeRule(rule, untilWords(rule, tz ?? zone));
            } else {
                out.repeats = 'Repeats';
            }
            if (series !== undefined && record !== series) out.changed = true;
        }
        if (self) out.myStatus = self.status ?? 'needs-action';
        out.readOnly = calendar.readOnly === true;
        const role = this.roleOf(record, account);
        // Someone else's invitation: answered, or deleted, but its time and guests are its organizer's.
        if (role === 'guest') out.invitation = true;
        if (self && role !== 'organizer') out.canRespond = !out.readOnly;
        return out;
    }

    /**
     * The names of the calendars hidden on the page, which a list that names
     * no calendars leaves out (busy and free time count them all the same).
     */
    hiddenNames(calendars) {
        if (calendars?.length) return [];
        return Object.values(this.store.calendars).filter((c) => c.hidden === true).map((c) => this.calendarName(c));
    }

    /** The occurrences in [from, to) as views; `hidden`: the calendars left out, when it named none. */
    events({ from, to, calendars, limit = 3000 }) {
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new CalendarError('Give a start and an end, the end after the start.');
        if (to - from > 3 * 366 * DAY) throw new CalendarError('Ask for at most three years at a time.');
        const found = this.find({ from, to, calendars });
        const hidden = this.hiddenNames(calendars);
        return { occurrences: found.slice(0, limit).map((f) => this.view(f)), more: found.length > limit, ...(hidden.length ? { hidden } : {}) };
    }

    /**
     * Events whose text has every word of `text` (title, place, notes,
     * people), between from and to (default: a year back to a year ahead),
     * upcoming ones first.
     */
    search({ text, from, to, calendars, limit = 50 }) {
        const words = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length === 0) throw new CalendarError('Say what to look for.');
        const now = this.now();
        const start = Number.isFinite(from) ? from : now - 366 * DAY;
        const end = Number.isFinite(to) ? to : now + 366 * DAY;
        const hits = this.find({ from: start, to: end, calendars }).filter(({ o, calendar }) => {
            const r = o.record;
            const hay = [r.title, r.location, r.description, this.calendarName(calendar), ...(r.attendees ?? []).flatMap((p) => [p.name, p.email]), r.organizer?.name, r.organizer?.email]
                .filter(Boolean).join('\n').toLowerCase();
            return words.every((w) => hay.includes(w));
        });
        const upcoming = hits.filter(({ o }) => o.end >= now);
        const past = hits.filter(({ o }) => o.end < now).reverse();
        const ordered = [...upcoming, ...past];
        const hidden = this.hiddenNames(calendars);
        return { occurrences: ordered.slice(0, limit).map((f) => this.view(f)), more: ordered.length > limit, ...(hidden.length ? { hidden } : {}) };
    }

    /** One occurrence by id. */
    event(id) {
        const at = this.locate(id);
        const zone = this.zone();
        const from = at.originalStart - DAY * 2;
        const to = at.originalStart + DAY * 2 + Math.max(0, at.length);
        const found = this.find({ from, to, calendars: [at.calendar.id] })
            .filter(({ o }) => o.record.uid === at.uid
                && (at.recurrenceId ? o.recurrenceId && sameTime(o.recurrenceId, at.recurrenceId) : true));
        if (found.length === 0) {
            // A changed occurrence moved far, or an occurrence taken out: show the record as it stands.
            const record = at.override ?? at.master;
            if (!record) throw new CalendarError(`There is no event "${id}" any more.`);
            const start = instantOf(record.start, zone);
            const view = this.view({ o: { record, series: at.master && at.master.rrule ? at.master : undefined, recurrenceId: at.recurrenceId, start, end: instantOf(record.end, zone), allDay: record.allDay, startDay: record.start.date, endDay: record.end.date }, calendar: at.calendar, item: at.overrideItem ?? at.item });
            return view;
        }
        return this.view(found[0]);
    }

    /**
     * Busy times in [from, to): merged spans when the user is taken (events
     * that show as busy, not declined, not cancelled), and the free gaps.
     * Every calendar counts, or the ones given: one hidden on the page to
     * calm it is still time the user is taken.
     */
    busy({ from, to, calendars }) {
        const spans = [];
        for (const f of this.find({ from, to, calendars, all: true })) {
            const { o, calendar } = f;
            if (o.record.busy === false || o.record.status === 'cancelled') continue;
            const self = this.selfOf(o.record, this.store.accounts[calendar.accountId]);
            if (self?.status === 'declined') continue;
            spans.push([Math.max(o.start, from), Math.min(o.end, to)]);
        }
        spans.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const s of spans) {
            const last = merged[merged.length - 1];
            if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
            else merged.push([...s]);
        }
        const free = [];
        let cursor = from;
        for (const [s, e] of merged) {
            if (s > cursor) free.push([cursor, s]);
            cursor = Math.max(cursor, e);
        }
        if (cursor < to) free.push([cursor, to]);
        return { busy: merged.map(([s, e]) => ({ start: s, end: e })), free: free.map(([s, e]) => ({ start: s, end: e })) };
    }

    /**
     * Free slots of at least `minutes` in [from, to), within the hours of the
     * day given (wall clock in the user's zone), on the weekdays given.
     */
    freeSlots({ from, to, minutes = 30, dayStart = '09:00', dayEnd = '17:00', days = [1, 2, 3, 4, 5], calendars, limit = 20 }) {
        const zone = this.zone();
        const { busy } = this.busy({ from, to, calendars });
        const need = Math.max(5, Number(minutes) || 30) * MINUTE;
        const slots = [];
        for (let day = dayIn(from, zone); slots.length < limit; day = addDays(day, 1)) {
            const dayMs = toInstant(`${day}T00:00:00`, zone, zone);
            if (dayMs >= to) break;
            const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
            if (Array.isArray(days) && days.length > 0 && !days.includes(weekday)) continue;
            let s = Math.max(from, toInstant(`${day}T${hhmm(dayStart)}:00`, zone, zone));
            const e = Math.min(to, toInstant(`${day}T${hhmm(dayEnd)}:00`, zone, zone));
            for (const b of busy) {
                if (b.end <= s || b.start >= e) continue;
                if (b.start - s >= need) slots.push({ start: s, end: b.start });
                s = Math.max(s, b.end);
            }
            if (e - s >= need) slots.push({ start: s, end: e });
        }
        return { slots: slots.slice(0, limit), zone };
    }

    // ── Reminders ──────────────────────────────────────────────────────

    /**
     * The reminders due now that no window has shown yet, each an event's
     * view with `reminder` {key, minutes, at (when it was due)}, the
     * earliest first. A reminder is due from its time (the start, less its
     * minutes) until ten minutes after the later of that and the start,
     * while the event is on (so a window opened late still shows one about
     * to start, never one long over). Calendars the user hid keep theirs;
     * subscriptions' are their publisher's, so none; a cancelled event or an
     * invitation the user declined has none. With `claim`, each is marked
     * shown and kept so in calendar.json for two days, so one window shows
     * it, once, across windows and restarts. None while `reminders` is off.
     */
    dueReminders({ claim = false } = {}) {
        if (this.config.reminders === false) return [];
        const now = this.now();
        const reminded = this.store.reminded ?? {};
        const due = this.alarmsNear(now).filter((a) => a.at <= now && now < a.until && reminded[a.key] === undefined);
        if (claim && due.length > 0) {
            for (const a of due) reminded[a.key] = now;
            for (const [key, at] of Object.entries(reminded)) if (at < now - 2 * DAY) delete reminded[key];
            this.store.reminded = reminded;
            this.saveState();
            this.log(`reminders shown ${due.length}`);
        }
        return due.map(({ f, key, minutes, at }) => ({ ...this.view(f), reminder: { key, minutes, at } }));
    }

    /**
     * Every reminder from a day back to four weeks ahead (the longest a
     * reminder is set), {f, at, until, minutes, key}: kept until the events
     * change or an hour has passed.
     */
    alarmsNear(now) {
        const cache = this.alarmCache;
        if (cache && cache.version === this.version && now >= cache.from && now < cache.from + HOUR) return cache.list;
        const calendars = Object.values(this.store.calendars).filter((c) => this.store.accounts[c.accountId]?.kind !== 'ics').map((c) => c.id);
        const list = [];
        if (calendars.length > 0) {
            for (const f of this.find({ from: now - DAY, to: now + 40320 * MINUTE + 2 * HOUR, calendars })) {
                const { o, calendar } = f;
                const record = o.record;
                if (!record.alarms?.length || record.status === 'cancelled') continue;
                if (this.selfOf(record, this.store.accounts[calendar.accountId])?.status === 'declined') continue;
                for (const minutes of record.alarms) {
                    const at = o.start - minutes * MINUTE;
                    const until = Math.min(Math.max(at, o.start) + 10 * MINUTE, Math.max(o.end, o.start + 10 * MINUTE));
                    // The key names the occurrence and the reminder, not the event's text: a moved event is due again at its new time.
                    list.push({ f, at, until, minutes, key: hex(`${calendar.id}|${record.uid}|${o.start}|${minutes}`, 20) });
                }
            }
        }
        list.sort((a, b) => a.at - b.at);
        this.alarmCache = { version: this.version, from: now, list };
        return list;
    }

    // ── Finding what a change is about ─────────────────────────────────

    /**
     * Where an occurrence id points: its calendar, item, records, and for an
     * occurrence of a series which one (its original start).
     */
    locate(id) {
        const text = String(id ?? '').trim();
        const dot = text.indexOf('.');
        const eventId = dot < 0 ? text : text.slice(0, dot);
        const part = dot < 0 ? '' : text.slice(dot + 1);
        const ref = this.index().get(eventId);
        if (ref === undefined) throw new CalendarError(`There is no event "${text}". Look it up again: ids come from calendar_events and calendar_search.`);
        const calendar = this.calendar(ref.calendarId);
        const records = [];
        const itemOf = new Map();
        for (const item of Object.values(this.store.itemsOf(calendar.id))) {
            for (const record of item.events ?? []) {
                if (record.uid !== ref.uid) continue;
                records.push(record);
                itemOf.set(record, item);
            }
        }
        if (records.length === 0) throw new CalendarError(`There is no event "${text}" any more.`);
        const master = records.find((r) => r.recurrenceId === undefined);
        let override;
        let recurrenceId;
        if (part !== '') {
            override = records.find((r) => r.recurrenceId && compactTime(r.recurrenceId) === part);
            recurrenceId = override?.recurrenceId ?? timeOfCompact(part, (master ?? records[0])?.start?.tz);
            if (recurrenceId === undefined) throw new CalendarError(`"${text}" isn't an event id.`);
            override ??= records.find((r) => r.recurrenceId && sameTime(r.recurrenceId, recurrenceId));
        } else if (master === undefined) {
            // Instances mode: the item is one occurrence.
            override = records[0];
            recurrenceId = override?.recurrenceId;
        }
        const zone = this.zone();
        const base = override ?? master;
        if (base === undefined) throw new CalendarError(`There is no event "${text}" any more.`);
        const originalStart = recurrenceId ? startOfTime(recurrenceId, zone) : startOfTime(base.start, zone);
        const length = master ? spanLength(master, zone) : spanLength(base, zone);
        return {
            id: text, eventId, calendar, account: this.store.accounts[calendar.accountId], uid: ref.uid, records, master, override,
            // The item a series lives in (CalDAV keeps its changed occurrences there too), and the changed occurrence's own.
            item: itemOf.get(master ?? base), overrideItem: override ? itemOf.get(override) : undefined, itemOf,
            recurrenceId, originalStart, length,
            series: master !== undefined && (master.rrule !== undefined || master.rdates?.length > 0),
            instance: master === undefined && base.seriesRemoteId !== undefined,
        };
    }

    writable(calendar) {
        if (calendar.readOnly) throw new CalendarError(`"${this.calendarName(calendar)}" is read only${this.store.accounts[calendar.accountId]?.kind === 'ics' ? ' (a subscription)' : ''}; change it where it's published.`);
        const account = this.store.accounts[calendar.accountId];
        if (account?.error?.code === 'auth') throw new CalendarError(`The ${account.name} account needs signing in again first (Calendar page → Accounts).`);
    }

    // ── Who a change emails ────────────────────────────────────────────

    /**
     * Whether a calendar's server emails guests: 'asked' (Google: only when a
     * change says to tell them), 'always' (Microsoft, and CalDAV servers that
     * schedule: a meeting's guests hear of every change its organizer makes),
     * or 'never' (calendars kept here, subscriptions, CalDAV servers that
     * don't schedule).
     */
    mailerOf(calendar) {
        const kind = this.store.accounts[calendar?.accountId]?.kind;
        if (kind === 'google') return 'asked';
        if (kind === 'microsoft') return 'always';
        // A CalDAV server that didn't say whether it schedules counts as one that does.
        if (kind === 'caldav') return calendar.scheduling === false ? 'never' : 'always';
        return 'never';
    }

    /**
     * The user's part in an event: 'organizer', 'guest' (someone else's
     * invitation), 'own' (no organizer named), or 'unplaced': a CalDAV
     * event whose organizer can't be told apart from the user (the server
     * named none of the user's addresses, or names the organizer only by a
     * kind of address it didn't name the user by). An unplaced event counts
     * as the user's for what a change to it emails (the server may well
     * schedule it as theirs), and as an invitation for answering it.
     */
    roleOf(record, account) {
        const organizer = record?.organizer;
        if (!organizer?.email && !organizer?.address) return 'own';
        if (this.isSelf(organizer, this.selfKeys(account))) return 'organizer';
        if (account?.kind === 'caldav' && !this.placed(organizer, account)) return 'unplaced';
        return 'guest';
    }

    /**
     * Whether an organizer who isn't the user by any address the account
     * knows is surely someone else: the server named the user's addresses,
     * among them one of the kind the organizer is named by (an email, a urn,
     * a principal's URL).
     */
    placed(person, account) {
        const known = (Array.isArray(account?.addresses) ? account.addresses : []).map(addressKey).filter((k) => k !== '');
        if (known.length === 0) return false;
        const kindOf = (key) => (key.startsWith('path:') ? 'path' : key.startsWith('urn:') ? 'urn' : isEmailAddress(key) ? 'email' : 'other');
        const kinds = new Set(known.map(kindOf));
        if (isEmailAddress(person.email)) return kinds.has('email');
        const kind = kindOf(addressKey(person.address ?? person.email));
        return kind !== 'other' && kinds.has(kind);
    }

    /** The other people on an event (the user aside), by address. */
    guestsOf(record, account) {
        const mine = this.selfKeys(account);
        const out = new Map();
        for (const p of record?.attendees ?? []) {
            const email = String(p?.email ?? '').trim();
            if (email === '' || this.isSelf(p, mine) || out.has(email.toLowerCase())) continue;
            out.set(email.toLowerCase(), email);
        }
        return [...out.values()];
    }

    /** The user's own email on an account, to name as a meeting's organizer. */
    selfAddress(account) {
        const addresses = Array.isArray(account?.addresses) ? account.addresses : [];
        return [...addresses, account?.email, account?.username].find(isEmailAddress);
    }

    /**
     * Who a change emails: {to: their addresses, what: what they get, forced:
     * true when the server emails them whatever the change says, why: the
     * reason it's forced, cannot: why a change that says to tell the guests
     * can't}. Google puts an event on its guests' calendars and takes it off
     * them without emailing anyone: those guests are `reaches`, and `reach`
     * says how ('add', 'remove', 'change'). Nothing here changes anything.
     * @param {{kind: 'create'|'update'|'delete'|'move'|'respond', calendar: object, target?: object,
     *          before?: object, after?: object, patch?: object, scope?: string, notify?: boolean}} change -
     *   before: the event as it is (the occurrence, for one); after: as the change leaves its guests;
     *   target: the calendar a move goes to.
     */
    mailOf({ kind, calendar, target, before, after, patch = {}, scope = 'all', notify = false }) {
        const account = this.store.accounts[calendar.accountId];
        const mailer = this.mailerOf(calendar);
        const record = before ?? after;
        const role = this.roleOf(record, account);
        const nobody = { to: [], what: '', forced: false };
        const organizer = record?.organizer?.email;
        if (kind === 'respond') {
            // An answer goes to the organizer wherever the server tells them.
            return (role === 'guest' || role === 'unplaced') && mailer !== 'never' ? { to: [organizer], what: 'the answer', forced: true, why: 'an answer is sent to the organizer' } : nobody;
        }
        if (role === 'guest') {
            // Someone else's Google meeting that lets its guests change it: Google makes a change to it for everyone
            // on it (the user's own reminders aside), so it reaches its organizer and the other guests.
            if (kind === 'update' && record?.guestsMayChange === true && Object.keys(patch).some((k) => k !== 'alarms' && k !== 'notify' && patch[k] !== undefined)) {
                const reaches = peopleOf({ reaches: [organizer, ...this.guestsOf(record, account)].filter((p) => typeof p === 'string' && p !== '') });
                if (reaches.length > 0) return { ...nobody, reaches, reach: 'change' };
            }
            // Someone else's invitation: only taking it out of the calendar can tell its organizer (a decline).
            if (kind !== 'delete' || mailer === 'never' || account.kind === 'microsoft') return nobody;
            // A CalDAV server can be told not to decline a whole invitation, but declines one occurrence taken out.
            if (account.kind === 'caldav' && scope !== 'all') return { to: [organizer], what: 'a decline', forced: true, why: 'the server tells the organizer when an occurrence is taken out' };
            return notify ? { to: [organizer], what: 'a decline', forced: false } : nobody;
        }
        const seen = new Map();
        for (const email of [...this.guestsOf(before, account), ...this.guestsOf(after, account)]) if (!seen.has(email.toLowerCase())) seen.set(email.toLowerCase(), email);
        const people = [...seen.values()];
        if (people.length === 0) return nobody;
        if (kind === 'move') {
            // A meeting moved to another calendar is a new meeting for its guests: taken out here, made there.
            const leaving = this.mailOf({ kind: 'delete', calendar, before, notify });
            const targetMailer = this.mailerOf(target);
            const targetAccount = this.store.accounts[target.accountId];
            const canInvite = targetMailer !== 'never' && (targetAccount?.kind !== 'caldav' || this.selfAddress(targetAccount) !== undefined);
            const cancels = leaving.to.length > 0;
            const invites = canInvite && (targetMailer === 'always' || notify);
            if (!cancels && !invites) {
                // Google takes it off its guests' calendars here, or puts it on theirs there, without emailing them.
                const off = leaving.reaches ?? [];
                const on = targetMailer === 'asked' ? people : [];
                const reaches = peopleOf({ reaches: [...off, ...on] });
                if (reaches.length > 0) return { ...nobody, reaches, reach: off.length > 0 && on.length > 0 ? 'change' : off.length > 0 ? 'remove' : 'add' };
                return notify && targetMailer === 'never' && mailer === 'never' ? { ...nobody, cannot: this.cannotMail(target) } : nobody;
            }
            const what = cancels && invites ? 'a cancellation and a new invitation' : cancels ? 'a cancellation' : 'invitations';
            const forced = (cancels && leaving.forced) || (invites && targetMailer === 'always');
            return { to: people, what, forced, why: 'a meeting moved to another calendar is a new meeting for its guests', cancels, invites };
        }
        const what = kind === 'create' ? 'invitations' : kind === 'delete' ? 'a cancellation' : scope === 'following' ? 'updates' : 'an update';
        if (mailer === 'never') return notify ? { ...nobody, cannot: this.cannotMail(calendar) } : nobody;
        // The user's own reminders change nothing for anyone else.
        if (kind === 'update' && Object.keys(patch).every((k) => k === 'alarms' || k === 'notify' || patch[k] === undefined)) return nobody;
        if (mailer === 'asked') {
            if (notify) return { to: people, what, forced: false };
            // Google puts the event on its guests' calendars, changes it there and takes it off them, without
            // emailing them: what a change says shows on theirs too (their guest list, the notes).
            if (kind === 'create') return { ...nobody, reaches: people, reach: 'add' };
            if (kind === 'delete') return { ...nobody, reaches: people, reach: 'remove' };
            const had = this.guestsOf(before, account).length > 0;
            const has = this.guestsOf(after, account).length > 0;
            return { ...nobody, reaches: people, reach: !had ? 'add' : !has ? 'remove' : 'change' };
        }
        if (account.kind === 'caldav' && role === 'own') {
            // A CalDAV server schedules only an event that names its organizer, and one saved without telling its
            // guests names none: telling them names the user, which invites them; there is nothing to cancel yet.
            if (!notify || kind === 'delete') return nobody;
            if (!this.selfAddress(account)) return { ...nobody, cannot: 'The server didn\'t say which address is yours, so it can\'t send invitations from this account.' };
            // Every part of a meeting names the same organizer: one occurrence can't become one on its own.
            if (scope === 'one') return { ...nobody, cannot: 'Only the whole event or series can invite its guests from here. Change it without telling them, or tell them about the whole series.' };
            return { to: people, what: 'invitations', forced: false };
        }
        const why = role === 'unplaced' ? 'its organizer may be you under another address, and then the server emails its guests itself'
            : account.kind !== 'microsoft' ? 'this calendar\'s server emails a meeting\'s guests itself'
            : kind === 'create' ? 'Microsoft invites the guests as soon as an event with them is saved'
            : kind === 'delete' ? 'Microsoft emails a meeting\'s guests when it is cancelled' : 'Microsoft emails a meeting\'s guests about each change to it';
        if (role === 'unplaced' && kind === 'delete' && organizer && !people.some((p) => p.toLowerCase() === organizer.toLowerCase())) {
            // Someone else's after all, it is declined: told, the server sends its organizer the answer.
            return {
                to: [...people, organizer], what: 'a cancellation or a decline', forced: true,
                why: 'its organizer may be you under another address, and then the server emails its guests; or someone else, who then gets your decline',
            };
        }
        return { to: people, what, forced: true, why };
    }

    /** Why a calendar can't email guests. */
    cannotMail(calendar) {
        if (this.store.accounts[calendar.accountId]?.kind === 'local') return 'Calendars kept in DSH can\'t email anyone. Save it without telling the guests, and tell them another way.';
        return 'This calendar\'s server doesn\'t email guests. Save it without telling them, and tell them another way.';
    }

    /**
     * Why a change can't be made as asked, as far as email goes: it would
     * email people without saying to tell them ('needs-notify', with the
     * people it would email or reach), or it says to and can't. {message,
     * code?, people?} or undefined.
     */
    mailProblem(mail, notify) {
        if (mail === undefined) return undefined;
        if (notify === true && mail.cannot) return { message: mail.cannot };
        if (mail.forced && notify !== true) {
            return { message: `This would email ${mail.what} to ${peopleWords(mail.to)} (${mail.why}), so it's made only when they are to be told.`, code: 'needs-notify', people: peopleOf(mail), mail: mailDetails(mail) };
        }
        return undefined;
    }

    /** Refuse a change mailProblem() finds a problem with. */
    checkMail(mail, notify) {
        const problem = this.mailProblem(mail, notify);
        if (problem) throw new CalendarError(problem.message, problem.code, problem);
    }

    /**
     * Refuse a change that would email or reach someone the user wasn't told
     * of: `known` is who they were told of (the approval prompt's list, or
     * the change's own first look). The event can change on its server while
     * a prompt waits, or between that look and the write.
     */
    checkKnown(mail, known) {
        if (!Array.isArray(known)) return;
        const told = new Set(known.map((p) => String(p).toLowerCase()));
        const fresh = (list) => (list ?? []).filter((p) => !told.has(String(p).toLowerCase()));
        const emailed = fresh(mail?.to);
        const reached = fresh(mail?.reaches);
        if (emailed.length === 0 && reached.length === 0) return;
        const what = emailed.length > 0 ? `email ${mail.what} to ${peopleWords(emailed)}` : `${REACH_WORDS[mail.reach] ?? 'reach'} the calendars of ${peopleWords(reached)}`;
        throw new CalendarError(`The event changed since this change was looked at (on its server, or in another app): it would now also ${what}, so nothing was done. Look at it again first.`, 'changed',
            { people: peopleOf(mail), mail: mailDetails(mail) });
    }

    /**
     * Who a change may email or reach: `approved`, who the user was shown
     * (the approval prompt's list, or the window's question); else, for a
     * caller that shows them first (confirm: the window), nobody yet, so a
     * change that would email or reach someone is refused naming every one
     * of them ('needs-approval'); else who the change's own first look found.
     */
    knownFor(mail, approved, confirm = false) {
        if (Array.isArray(approved)) return approved;
        const people = peopleOf(mail);
        if (!confirm) return people;
        if (people.length > 0) throw new CalendarError(approvalText(mail), 'needs-approval', { people, mail: mailDetails(mail) });
        return [];
    }

    // ── Plans: what a change does, worked out before it's asked about and again just before it's made ──

    /**
     * What a change would do, worked out as the change itself works it out,
     * without making it: {mail} (who it emails or reaches: mailOf), and
     * move: true for an update that moves the event. It throws the change's
     * own refusal, so nobody is asked about a change that would then be
     * refused, and the refusal is in the change's own words.
     * @param {'create'|'update'|'delete'|'respond'} kind
     * @param {{id?: string, input?: object, scope?: string, notify?: boolean, status?: string}} change - input as the manager takes it.
     */
    planChange(kind, { id, input = {}, scope, notify = false, status } = {}) {
        const plan = kind === 'create' ? this.planCreate({ ...input, notify })
            : kind === 'update' ? this.planUpdate(id, { ...input, notify }, scope ?? 'all')
            : kind === 'delete' ? this.planDelete(id, scope ?? 'all', { notify })
            : kind === 'respond' ? this.planRespond(id, status, scope ?? 'all')
            : undefined;
        if (plan === undefined) throw new CalendarError(`"${kind}" isn't a change.`);
        if (plan.move) this.checkHalfMove(plan.at, plan.target);
        const shape = this.shapeOf(kind, plan);
        return { mail: plan.mail, ...(plan.move ? { move: true } : {}), ...(shape ? { shape } : {}) };
    }

    /**
     * What a planned change does, for the approval prompt's words, worked
     * out as the change itself is: the calendar (and, for a move, the one it
     * goes to); the event's time as it is (`before`: the occurrence the call
     * names, or the event) and, for a new time or a new event, as it will be
     * (`after`: recordFrom on that occurrence, as the write does); the new
     * title, the repeat rule in words, and whether a series is reached.
     * Undefined when it can't be told (the prompt then goes by the call).
     * Never throws.
     */
    shapeOf(kind, plan) {
        try {
            const zone = this.zone();
            const repeats = (rule) => describeRule(rule, untilWords(rule, zone));
            if (kind === 'create') {
                return { calendar: this.calendarName(plan.calendar), after: this.spanOf(plan.record), ...(plan.record.rrule ? { repeats: repeats(plan.record.rrule) } : {}) };
            }
            const at = plan.at;
            const seen = at.recurrenceId ? this.occurrenceRecord(at) : (at.override ?? at.master);
            const shape = { calendar: this.calendarName(at.calendar), title: seen.title || '(No title)', before: this.spanOf(seen), series: at.series || at.instance };
            if (plan.move) return { ...shape, target: this.calendarName(plan.target) };
            if (kind === 'update') {
                const f = plan.fields;
                if (['start', 'end', 'allDay', 'timeZone'].some((k) => f[k] !== undefined)) {
                    shape.after = this.spanOf(this.recordFrom({ start: f.start, end: f.end, allDay: f.allDay, timeZone: f.timeZone }, seen));
                }
                if (f.title !== undefined && f.title !== null) shape.newTitle = String(f.title).trim();
                if (typeof f.repeat === 'string' && f.repeat.trim() !== '') shape.repeats = repeats(f.repeat.trim().replace(/^RRULE:/i, '').toUpperCase());
            }
            return shape;
        } catch {
            return undefined;
        }
    }

    /**
     * A record's time as the prompt says it: {allDay: true, startDay,
     * lastDay}, or {start, end} in epoch ms with `tz`, the event's own zone
     * (null for a floating or UTC event, which shows on the user's clock).
     */
    spanOf(record) {
        if (record.allDay) return { allDay: true, startDay: record.start.date, lastDay: addDays(record.end.date, -1) };
        const zone = this.zone();
        const own = record.start.tz;
        return { allDay: false, start: instantOf(record.start, zone), end: instantOf(record.end, zone), tz: own && own !== 'UTC' && isZone(own) ? own : null };
    }

    /** A new event: its calendar, its record, and who it emails or reaches. */
    planCreate(input = {}) {
        const calendarId = input.calendarId || this.defaultCalendarId();
        if (!calendarId) {
            if (!Object.values(this.store.calendars).some((c) => !c.readOnly)) throw new CalendarError('There is no calendar that can be written.');
            throw new CalendarError('Say which calendar it goes in: no default calendar is chosen, and more than one could be meant.', 'choose-calendar');
        }
        const calendar = this.calendar(calendarId);
        this.writable(calendar);
        const account = this.store.accounts[calendar.accountId];
        // The organizer is the user, never a caller's word.
        const { organizer: _organizer, notify: notifyIn, dropChanges: _drop, ...fields } = input;
        const notify = notifyIn === true;
        const record = this.recordFrom(fields);
        const mail = this.mailOf({ kind: 'create', calendar, after: record, notify });
        this.checkMail(mail, notify);
        return { calendar, account, record, notify, mail };
    }

    /**
     * A change to an event: the event as it is (`at`), the scope, the
     * fields, the record it starts from, and who it emails or reaches. For
     * a move to another calendar, the move's plan, with move: true.
     */
    planUpdate(id, patchIn = {}, scope = 'all') {
        const at = this.locate(id);
        this.writable(at.calendar);
        // The organizer is never a caller's word; notify is a choice, not a field.
        const { organizer: _organizer, notify: notifyIn, calendarId, dropChanges, ...fields } = patchIn;
        const notify = notifyIn === true;
        if (calendarId && calendarId !== at.calendar.id) {
            // A move takes the whole event or series to the other calendar, and nothing else changes on the way.
            if (this.scopeOf(at, scope) !== 'all') {
                throw new CalendarError('Only a whole event or series moves to another calendar. To move one occurrence, delete only it here, then add it to the other calendar as an event of its own.');
            }
            if (Object.values(fields).some((v) => v !== undefined)) throw new CalendarError('Move the event to the other calendar on its own first, then change it there.');
            return { ...this.planMove(id, calendarId, { notify, dropChanges: dropChanges === true }), move: true, dropChanges: dropChanges === true };
        }
        const which = this.scopeOf(at, scope);
        const before = this.recordOf(at, which);
        if (this.roleOf(before, at.account) === 'guest' && this.mailerOf(at.calendar) !== 'never') {
            if (fields.attendees !== undefined) throw new CalendarError('This is someone else\'s invitation: only its organizer changes who is invited.');
            // Its title, time, place and notes are its organizer's; the user's own reminders, busy or free and privacy are theirs.
            if (Object.keys(fields).some((k) => fields[k] !== undefined && !OWN_FIELDS.has(k))) {
                throw new CalendarError('This is someone else\'s invitation: its organizer sets its title, time, place, link and notes. Answer it, or change your own reminders, whether it shows you as busy, or whether it\'s private.');
            }
        }
        const mail = this.mailOf({ kind: 'update', calendar: at.calendar, before, after: this.guestsAfter(before, fields), patch: fields, scope: which, notify });
        this.checkMail(mail, notify);
        return { at, which, fields, notify, before, mail };
    }

    /** A move of a whole event or series to another calendar: the event as it is, where it goes, and who it emails or reaches. */
    planMove(id, calendarId, { notify = false, dropChanges = false } = {}) {
        const at = this.locate(id);
        const target = this.calendar(calendarId);
        this.writable(target);
        this.writable(at.calendar);
        if (at.instance || (at.recurrenceId && !at.series)) throw new CalendarError('Move the whole series, from its own event.');
        const master = at.master ?? at.records[0];
        if (this.roleOf(master, at.account) === 'guest') {
            throw new CalendarError('This is someone else\'s invitation, so it stays in the calendar it was sent to. Answer it there, or delete it.');
        }
        const dropped = this.droppedByMove(at, target);
        if (dropped !== undefined && !dropChanges) throw new CalendarError(dropped, 'drops-changes');
        // Taken out here, the series is cancelled for everyone on any of its occurrences.
        const mail = this.mailOf({ kind: 'move', calendar: at.calendar, target, before: this.recordOf({ ...at, master }, 'all'), notify });
        this.checkMail(mail, notify);
        return { at, target, master, notify, mail };
    }

    /**
     * What a series would lose moving to `target`, in words, or undefined:
     * Google and Microsoft take a new series as its rule alone, so the
     * occurrences changed on their own stay behind, and Microsoft keeps no
     * skipped or extra dates (the skipped ones come back).
     */
    droppedByMove(at, target) {
        if (!at.series || !at.master) return undefined;
        const kind = this.store.accounts[target.accountId]?.kind;
        if (kind !== 'google' && kind !== 'microsoft') return undefined;
        const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
        const own = at.records.filter((r) => r !== at.master && r.recurrenceId);
        const cancelled = own.filter((r) => r.status === 'cancelled').length;
        const changed = own.length - cancelled;
        const parts = [];
        if (changed > 0) parts.push(count(changed, 'occurrence changed on its own', 'occurrences changed on their own'));
        if (cancelled > 0) parts.push(`the cancellation of ${count(cancelled, 'occurrence', 'occurrences')} (${cancelled === 1 ? 'it comes' : 'they come'} back)`);
        if (kind === 'microsoft') {
            const skipped = at.master.exdates?.length ?? 0;
            const extra = at.master.rdates?.length ?? 0;
            if (skipped > 0) parts.push(`${count(skipped, 'skipped date', 'skipped dates')} (${skipped === 1 ? 'it comes' : 'they come'} back)`);
            if (extra > 0) parts.push(count(extra, 'extra date', 'extra dates'));
        }
        if (parts.length === 0) return undefined;
        const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
        return `Moving this series to ${this.calendarName(target)} would drop ${list}: ${KIND_NAMES[kind]} takes a new repeating event as its rule alone.`;
    }

    /** A delete: the event as it is, the scope, the record it is worked out on, and who it emails or reaches. */
    planDelete(id, scope = 'all', { notify = false } = {}) {
        const at = this.locate(id);
        this.writable(at.calendar);
        const which = this.scopeOf(at, scope);
        const before = this.recordOf(at, which);
        const mail = this.mailOf({ kind: 'delete', calendar: at.calendar, before, scope: which, notify });
        this.checkMail(mail, notify);
        return { at, which, notify, before, mail };
    }

    /** An answer to an invitation: the event as it is, the scope, and who hears it. */
    planRespond(id, status, scope = 'all') {
        if (status !== undefined && !['accepted', 'declined', 'tentative'].includes(status)) throw new CalendarError('The answer is accepted, declined or tentative.');
        if (scope === 'following') throw new CalendarError('An answer is for one occurrence (one) or the whole series (all).');
        const at = this.locate(id);
        this.writable(at.calendar);
        const which = this.scopeOf(at, scope);
        const before = this.recordOf(at, which);
        if (!this.selfOf(before, at.account)) throw new CalendarError('You aren\'t on this event\'s guest list, so there is nothing to answer.');
        // The organizer hears the answer where the server tells them.
        return { at, which, mail: this.mailOf({ kind: 'respond', calendar: at.calendar, before }) };
    }

    /**
     * The record a change with this scope is worked out on: the occurrence
     * for 'one', else the series' (or the event's), with everyone on any
     * part of the series the change reaches as its guests: a change to all
     * of it reaches the occurrences changed on their own too (partsReached).
     * A series kept as its occurrences (Microsoft) has no record of its own
     * here: it is worked out on the occurrence it was asked on.
     */
    recordOf(at, which) {
        if (which === 'one') return this.occurrenceRecord(at);
        const base = at.master ?? at.override;
        const parts = this.partsReached(at, which);
        if (parts.length < 2) return base;
        return { ...base, attendees: everyoneOn([base, ...parts]) };
    }

    /**
     * The records of a series that a change to all of it ('all'), or to an
     * occurrence and the ones after it ('following'), reaches: for
     * 'following', the series' own and the occurrences changed from that
     * one on, and every "this and following" change before it (it may
     * reach past it).
     */
    partsReached(at, which) {
        if (which !== 'following' || !at.master) return at.records;
        const zone = this.zone();
        return at.records.filter((r) => r.recurrenceId === undefined || r.thisAndFuture === true || startOfTime(r.recurrenceId, zone) >= at.originalStart);
    }

    /** A record as an update's guest list leaves it (the record itself when the update doesn't give one). */
    guestsAfter(before, input) {
        if (input?.attendees === undefined) return before;
        return { ...before, attendees: this.recordFrom({ attendees: input.attendees }, before).attendees };
    }

    // ── Changing ───────────────────────────────────────────────────────

    /**
     * A record from what the window or a tool gives (see INPUT_FIELDS),
     * over `base` when changing one.
     */
    recordFrom(input, base) {
        const zone = this.zone();
        const record = base ? structuredClone(base) : { title: '' };
        const has = (key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
        if (has('title')) record.title = String(input.title ?? '').trim();
        for (const key of ['location', 'description', 'url', 'conference']) {
            if (has(key)) {
                const value = input[key] === null ? '' : String(input[key]).trim();
                if (value === '') delete record[key];
                else record[key] = value;
            }
        }
        if (has('url') && record.url && !/^https?:\/\//i.test(record.url)) throw new CalendarError('A link starts with https:// or http://.');
        if (has('busy')) record.busy = input.busy !== false;
        if (has('organizer')) {
            const email = String(input.organizer?.email ?? '').trim();
            if (email === '') delete record.organizer;
            else record.organizer = { email, ...(typeof input.organizer?.name === 'string' && input.organizer.name.trim() ? { name: input.organizer.name.trim() } : {}) };
        }
        if (has('privacy')) {
            if (input.privacy === null || input.privacy === 'public' || input.privacy === '') delete record.privacy;
            else if (input.privacy === 'private' || input.privacy === 'confidential') record.privacy = input.privacy;
            else throw new CalendarError('privacy is public, private or confidential.');
        }
        if (has('status')) {
            if (!['confirmed', 'tentative', 'cancelled'].includes(input.status)) throw new CalendarError('status is confirmed, tentative or cancelled.');
            record.status = input.status;
        }
        if (has('alarms')) {
            const list = input.alarms === null ? [] : Array.isArray(input.alarms) ? input.alarms : [input.alarms];
            const minutes = [...new Set(list.map(Number))];
            if (minutes.some((m) => !Number.isInteger(m) || m < 0 || m > 40320)) throw new CalendarError('Reminders are whole minutes before the start, 0 to 40320 (four weeks).');
            if (minutes.length > 0) record.alarms = minutes.sort((a, b) => a - b);
            else delete record.alarms;
        }
        if (has('attendees')) {
            const list = input.attendees === null ? [] : input.attendees;
            if (!Array.isArray(list)) throw new CalendarError('attendees is a list of people: [{email, name?}].');
            const had = new Map((base?.attendees ?? []).map((p) => [String(p.email).toLowerCase(), p]));
            const people = [];
            for (const p of list) {
                const email = String(typeof p === 'string' ? p : p?.email ?? '').trim();
                const old = had.get(email.toLowerCase());
                // Someone already on the event may be named by another kind of address (a CalDAV server's urn:uuid).
                if (old === undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new CalendarError(`"${email}" isn't an email address.`);
                const person = { ...old, email };
                if (typeof p === 'object' && typeof p.name === 'string' && p.name.trim()) person.name = p.name.trim();
                if (typeof p === 'object' && p.optional === true) person.role = 'optional';
                else if (typeof p === 'object' && p.optional === false) person.role = 'required';
                person.status ??= 'needs-action';
                person.role ??= 'required';
                people.push(person);
            }
            if (people.length > 0) record.attendees = people;
            else delete record.attendees;
        }
        if (has('repeat')) {
            const rule = input.repeat === null ? '' : String(input.repeat).trim().replace(/^RRULE:/i, '');
            if (rule === '') {
                delete record.rrule;
                delete record.rdates;
                delete record.exdates;
            } else {
                try {
                    parseRule(rule);
                } catch (error) {
                    throw new CalendarError(`The repeat rule can't be read: ${error.message}. Write it like FREQ=WEEKLY;BYDAY=MO,WE or FREQ=MONTHLY;BYMONTHDAY=1;COUNT=6.`);
                }
                record.rrule = rule.toUpperCase();
            }
        }
        // Times: given start and end, a start alone (the length stays), an end alone, or allDay switched.
        const allDay = has('allDay') ? input.allDay === true : has('start') ? isDay(String(input.start).trim()) : (record.allDay === true);
        const tzIn = has('timeZone') && input.timeZone ? String(input.timeZone).trim() : undefined;
        if (tzIn !== undefined && !isZone(tzIn) && tzIn !== 'UTC') throw new CalendarError(`"${tzIn}" isn't a time zone; use an IANA name like Europe/Berlin or America/New_York.`);
        // Wall clocks are read as the event shows them: in its own zone, or the user's for a floating or UTC event.
        const oldTz = record.start && !('date' in record.start) && record.start.tz !== 'UTC' ? record.start.tz : undefined;
        const tz = tzIn ?? oldTz ?? zone;
        if (has('start') || has('end') || has('allDay') || has('timeZone') || base === undefined) {
            const oldLength = base ? spanLength(base, zone) : allDay ? DAY : HOUR;
            let start;
            if (has('start')) start = timeFrom(input.start, allDay, tz, 'start');
            else if (base) start = convertTime(record.start, allDay, tz, zone);
            else throw new CalendarError('Give the start: a day (2026-10-12) or a time (2026-10-12T09:30).');
            let end;
            if (has('end') && input.end !== null && input.end !== '') {
                end = timeFrom(input.end, allDay, tz, 'end');
                if (allDay) end = { date: addDays(end.date, 1) };
            } else if (allDay) {
                const days = base && record.allDay && has('start') ? Math.max(1, Math.round(oldLength / DAY)) : base && record.allDay ? daysBetween(record.start.date, record.end.date) : 1;
                end = { date: addDays(start.date, Math.max(1, days)) };
            } else {
                const length = base && !record.allDay ? oldLength : HOUR;
                const startMs = toInstant(start.local, start.tz, zone);
                end = { local: toLocal(startMs + length, start.tz), tz: start.tz };
            }
            if (allDay) {
                if (end.date <= start.date) throw new CalendarError('The last day is before the first.');
            } else if (toInstant(end.local, end.tz, zone) < toInstant(start.local, start.tz, zone)) {
                throw new CalendarError('The end is before the start.');
            }
            record.start = start;
            record.end = end;
            record.allDay = allDay;
        }
        if (!record.title) throw new CalendarError('Give the event a title.');
        return cleanRecord(record);
    }

    /**
     * Run a change; when the server says the event changed meanwhile, sync
     * and try once more. With retry false (a deletion, a new time, a change
     * that emails or reaches people: decided on the event as it was), sync
     * and say so instead ('changed', naming no one); `recheck` first works
     * the change out again on the event as the sync left it, so one that
     * would now email or reach someone the user wasn't told of says who
     * ('changed', naming them).
     */
    async changing(calendarId, run, { retry = true, recheck } = {}) {
        return this.locked(`sync:${calendarId}`, async () => {
            try {
                return await run();
            } catch (error) {
                if (!(error instanceof SourceError) || error.code !== 'conflict') throw asCalendarError(error);
            }
            this.log(`conflict ${calendarId} ${retry ? 'retry' : 'stopped'}`);
            return CONFLICT;
        }).then(async (result) => {
            if (result !== CONFLICT) return result;
            await this.syncCalendar(calendarId);
            if (!retry) {
                recheck?.();
                // Nobody new to ask about: 'changed' naming no one, so the window offers to look at it again.
                throw new CalendarError('The event changed on its server meanwhile (in another app, or by someone else), so nothing was done. Look at it again first.', 'changed', { people: [] });
            }
            return this.locked(`sync:${calendarId}`, async () => {
                try {
                    return await run();
                } catch (error) {
                    throw asCalendarError(error);
                }
            });
        });
    }

    /**
     * Write a CalDAV or local item's new text (null: no event left in it).
     * opts.scheduleReply false: a deletion asks the server not to tell the
     * organizer (an invitation taken out declines it otherwise).
     */
    async putIcs(calendar, item, edits, uid, { scheduleReply } = {}) {
        const { source } = await this.source(this.store.accounts[calendar.accountId]);
        const raw = editIcs(item?.raw ?? null, edits, { now: this.now(), zone: this.zone() });
        const items = this.store.itemsOf(calendar.id);
        let made;
        if (raw === null) {
            await source.remove({ ...calendar }, item, scheduleReply === false ? { scheduleReply: false } : {});
            delete items[item.remoteId];
        } else {
            const put = await source.put({ ...calendar }, item ?? null, raw, uid);
            if (item && item.remoteId !== put.remoteId) delete items[item.remoteId];
            made = { remoteId: put.remoteId, ...(put.etag !== undefined ? { etag: put.etag } : {}), raw, events: readIcs(raw, { zone: this.zone() }).events };
            items[put.remoteId] = made;
        }
        this.store.touch(calendar.id);
        this.changed();
        return made;
    }

    /** Items a Google or Microsoft change sent back, into the store; a sync soon after fills in the rest. */
    takeItems(calendar, items = [], removed = []) {
        const store = this.store.itemsOf(calendar.id);
        for (const item of items) store[item.remoteId] = { remoteId: item.remoteId, ...(item.etag !== undefined ? { etag: item.etag } : {}), events: (item.events ?? []).map(cleanRecord) };
        for (const remoteId of removed) delete store[remoteId];
        this.store.touch(calendar.id);
        this.changed();
        this.later(() => this.syncCalendar(calendar.id), 1500);
    }

    /**
     * A new event.
     * @param {object} input - calendarId (default: the default calendar), and INPUT_FIELDS.
     * @param {string} by - who asked, for the log: 'window' or 'agent'.
     */
    async createEvent(input, by = 'window', { approved, confirm = false } = {}) {
        const { calendar, account, record, mail } = this.planCreate(input);
        this.checkKnown(mail, this.knownFor(mail, approved, confirm));
        const emails = mail.to.length > 0;
        // A CalDAV server invites the guests of an event that names its organizer.
        if (emails && account.kind === 'caldav') record.organizer = { email: this.selfAddress(account) };
        // A create whose answer was lost goes again with the same uid: the server knows it, and makes it once.
        const key = hex(stableJson([calendar.id, record]), 32);
        this.pruneLostCreates();
        record.uid = this.lostCreates.get(key)?.uid ?? newUid();
        let lost;
        const created = await this.changing(calendar.id, async () => {
            try {
                const { source, style } = await this.source(account);
                if (style === 'ics') {
                    const item = await this.putIcs(calendar, null, [{ uid: record.uid, record }], record.uid);
                    return { remoteId: item.remoteId, uid: record.uid };
                }
                const items = await source.create({ ...calendar }, { ...record, ...(emails ? { notify: true } : {}) });
                this.takeItems(calendar, items);
                const first = items?.[0];
                return { remoteId: first?.remoteId, uid: first?.events?.[0]?.uid ?? record.uid };
            } catch (error) {
                if (maybeMade(error)) lost = error;
                throw error;
            }
        }).catch((error) => {
            if (lost === undefined) throw error;
            this.lostCreates.set(key, { uid: record.uid, at: this.now() });
            this.log(`create ${calendar.id} answer lost`);
            throw new CalendarError(`${asCalendarError(lost).message} It may have been made anyway: asking again with the same details won't make a second one.`);
        });
        this.lostCreates.delete(key);
        this.log(`create ${calendar.id} by=${by}${record.rrule ? ' repeats' : ''}${record.attendees ? ` people=${record.attendees.length}` : ''}${mailLog(mail)}`);
        const eventId = eventIdOf(calendar.id, created.uid);
        const zone = this.zone();
        const startMs = startOfTime(record.start, zone);
        const first = this.find({ from: startMs - DAY, to: startMs + 2 * DAY + spanLength(record, zone), calendars: [calendar.id] })
            .find(({ o }) => o.record.uid === created.uid);
        return withMail(first ? this.view(first) : { id: eventId, eventId, calendarId: calendar.id, title: record.title }, mail);
    }

    /** Lost creates are kept for half an hour: long enough for a second try, not for a new event much later. */
    pruneLostCreates() {
        for (const [key, lost] of this.lostCreates) if (this.now() - lost.at > 30 * MINUTE) this.lostCreates.delete(key);
    }

    /**
     * Change an event. scope: 'one' (this occurrence of a series), 'following'
     * (this one and the ones after it), 'all' (the series, or a single event).
     */
    async updateEvent(id, patchIn = {}, scope = 'all', by = 'window', { approved, confirm = false } = {}) {
        const plan = this.planUpdate(id, patchIn, scope);
        if (plan.move) return this.moveEvent(id, plan.target.id, by, { notify: plan.notify, dropChanges: plan.dropChanges, approved, confirm });
        const first = plan.at;
        const { which } = plan;
        // Who the user was told the change reaches: the approval prompt's or the window's list, else this first look's.
        const known = this.knownFor(plan.mail, approved, confirm);
        this.checkKnown(plan.mail, known);
        // A new time is decided on the event as it was: if it changed meanwhile, say so rather than try again.
        const retry = peopleOf(plan.mail).length === 0 && !['start', 'end', 'allDay', 'timeZone', 'repeat'].some((k) => plan.fields[k] !== undefined);
        let mail = plan.mail;
        let after;
        await this.changing(first.calendar.id, async () => {
            // Worked out again on the event as it is now, since who it emails can have changed since.
            const now = this.planUpdate(id, patchIn, scope);
            this.checkKnown(now.mail, known);
            mail = now.mail;
            const { at, fields } = now;
            const emails = mail.to.length > 0;
            // A CalDAV server tells the guests of an event that names its organizer: the user, when it names none yet.
            if (emails && at.account.kind === 'caldav' && this.roleOf(now.before, at.account) === 'own') fields.organizer = { email: this.selfAddress(at.account) };
            // Google and Microsoft tell guests about a change only when the change says so.
            const tell = emails ? { notify: true } : {};
            const patch = { ...fields, ...tell };
            const { source, style } = await this.source(at.account);
            const calendar = at.calendar;
            if (which === 'one') {
                const current = this.occurrenceRecord(at);
                const changed = this.recordFrom(patch, current);
                changed.uid = at.uid;
                changed.recurrenceId = at.recurrenceId ?? current.recurrenceId;
                delete changed.rrule;
                delete changed.rdates;
                delete changed.exdates;
                if (style === 'ics') {
                    // This occurrence alone: a "this and following" change that starts here goes on from the next one.
                    const onward = this.rangeFromNext(at);
                    delete changed.thisAndFuture;
                    const edits = [{ uid: at.uid, recurrenceId: changed.recurrenceId, record: { ...changed, sequence: (current.sequence ?? 0) + 1 } }];
                    if (onward) edits.push({ uid: at.uid, recurrenceId: onward.recurrenceId, record: onward });
                    await this.putIcs(calendar, at.item, edits, at.uid);
                } else {
                    this.takeItems(calendar, await source.update({ ...calendar }, { item: at.overrideItem ?? at.item, record: at.override ?? at.master, occurrence: at.recurrenceId, planned: now.before }, { ...diffOf(current, changed), ...tell }, 'one'));
                }
                return;
            }
            if (which === 'following') {
                after = await this.splitSeries(at, source, style, patch, now.before);
                return;
            }
            // The whole series, or a single event: the change moves it by as much as this occurrence moved.
            const master = at.master ?? at.override;
            const changed = this.recordFrom(this.shiftedPatch(at, patch), master);
            const zone = this.zone();
            const delta = at.series && at.master && changed.allDay === (at.master.allDay === true)
                ? startOfTime(changed.start, zone) - startOfTime(at.master.start, zone) : 0;
            const moveTime = (time) => {
                if ('date' in time) return { date: addDays(time.date, Math.round(delta / DAY)) };
                return { local: toLocal(instantOf(time, zone) + delta, time.tz ?? zone), tz: time.tz ?? null };
            };
            const ownRule = Object.prototype.hasOwnProperty.call(patch, 'repeat');
            if (delta !== 0 && !ownRule) {
                // Taken-out dates move with the series, and a weekly rule's days with its start.
                if (at.master.exdates?.length) changed.exdates = at.master.exdates.map(moveTime);
                if (changed.rrule) changed.rrule = shiftRuleDays(changed.rrule, at.master.start, changed.start);
            }
            changed.uid = at.uid;
            changed.sequence = (master.sequence ?? 0) + 1;
            if (style === 'ics') {
                const edits = [{ uid: at.uid, record: changed }];
                if (delta !== 0 && !ownRule) {
                    // Changed occurrences keep naming the occurrence they stand in for.
                    for (const r of at.records.filter((x) => x.recurrenceId)) {
                        edits.push({ uid: at.uid, recurrenceId: r.recurrenceId, record: { ...r, recurrenceId: moveTime(r.recurrenceId) } });
                    }
                }
                await this.putIcs(calendar, at.item, edits, at.uid);
            } else {
                const synced = this.store.syncOf(calendar.id)?.state;
                this.takeItems(calendar, await source.update({ ...calendar }, { item: at.item, record: master, planned: now.before, synced }, { ...diffOf(master, changed), ...tell }, 'all'));
            }
            // The occurrence that was asked about, where it is now.
            after = { uid: at.uid, near: at.series ? at.originalStart + delta : startOfTime(changed.start, zone) };
        }, { retry, recheck: () => this.checkKnown(this.planUpdate(id, patchIn, scope).mail, known) });
        this.log(`update ${first.calendar.id} ${first.eventId} scope=${which} by=${by}${mailLog(mail)}`);
        let view;
        try {
            if (which === 'one' || after === undefined) view = this.event(which === 'one' ? id : first.eventId);
            else view = this.viewNear(first.calendar.id, after.uid, after.near) ?? this.event(eventIdOf(first.calendar.id, after.uid));
        } catch {
            view = { id };
        }
        return withMail(view, mail);
    }

    /** The view of an event's occurrence nearest a time (within a day): what a change made. */
    viewNear(calendarId, uid, near) {
        const found = this.find({ from: near - DAY, to: near + 2 * DAY, calendars: [calendarId] }).filter(({ o }) => o.record.uid === uid);
        if (found.length === 0) return undefined;
        found.sort((a, b) => Math.abs(a.o.start - near) - Math.abs(b.o.start - near));
        return this.view(found[0]);
    }

    /** The scope a change really has: a single event's is 'all'. */
    scopeOf(at, scope) {
        const s = scope ?? 'all';
        if (!['one', 'following', 'all'].includes(s)) throw new CalendarError('scope is one, following or all.');
        if (!at.series && !at.instance) return 'all';
        if (at.instance && s === 'following') throw new CalendarError('This account can change one occurrence or the whole series, not this and the following ones.');
        if (s !== 'all' && !at.recurrenceId) throw new CalendarError('Give the id of the occurrence (with its date part) to change only it.');
        return s;
    }

    /**
     * The record an occurrence of a series stands for: its changed record;
     * else, where a "this and following" change reaches it, that change at
     * its place (rangeRecord); else the series' at that start.
     */
    occurrenceRecord(at) {
        if (at.override) return at.override;
        const zone = this.zone();
        const ranged = rangeRecord(at.records, at.recurrenceId, zone);
        if (ranged !== undefined) return ranged;
        const master = at.master;
        const record = structuredClone(master);
        delete record.rrule;
        delete record.rdates;
        delete record.exdates;
        if ('date' in at.recurrenceId) {
            record.start = { date: at.recurrenceId.date };
            record.end = { date: addDays(at.recurrenceId.date, daysBetween(master.start.date, master.end.date)) };
        } else {
            const startMs = instantOf(at.recurrenceId, zone);
            const tz = master.start.tz ?? null;
            record.start = { local: toLocal(startMs, tz ?? zone), tz };
            record.end = { local: toLocal(startMs + spanLength(master, zone), tz ?? zone), tz };
        }
        record.recurrenceId = at.recurrenceId;
        return record;
    }

    /**
     * A "this and following" change that starts at this occurrence
     * (at.override, with thisAndFuture), moved to the next occurrence it
     * reaches: the first after it without a change of its own, before a
     * later such change starts. A change or a delete of this occurrence
     * alone adds it, so the ones after it stay as that change set them.
     * Undefined when none starts here, or it reaches no later occurrence.
     */
    rangeFromNext(at) {
        if (at.override?.thisAndFuture !== true || at.master === undefined) return undefined;
        const zone = this.zone();
        const from = startOfTime(at.recurrenceId, zone);
        // A later "this and following" change holds from its own occurrence on; past that, or a hundred years, it reaches none.
        const later = at.records.filter((r) => r.thisAndFuture && r.recurrenceId && startOfTime(r.recurrenceId, zone) > from).map((r) => startOfTime(r.recurrenceId, zone));
        const end = Math.min(from + 100 * 366 * DAY, ...later);
        // The series' own occurrences after this one, a stretch at a time (a cancelled series' too).
        const series = { ...at.master, status: undefined };
        for (let start = from, span = 60 * DAY; start < end; start += span, span *= 2) {
            for (const o of occurrences([series], { from: start, to: Math.min(end, start + span), zone })) {
                const when = startOfTime(o.recurrenceId, zone);
                if (when <= from) continue;
                if (when >= end) return undefined;
                // An occurrence with a change of its own stays as it is (rangeRecord gives none for it).
                const record = rangeRecord(at.records, o.recurrenceId, zone);
                if (record !== undefined) return { ...record, thisAndFuture: true };
            }
        }
        return undefined;
    }

    /**
     * A change to a whole series given on one of its occurrences: its start
     * and end, if given, move the series' own start and end by as much.
     */
    shiftedPatch(at, patch) {
        if (!at.series || !at.recurrenceId || (patch.start === undefined && patch.end === undefined)) return patch;
        const zone = this.zone();
        const current = this.occurrenceRecord(at);
        const moved = this.recordFrom({ start: patch.start, end: patch.end, allDay: patch.allDay, timeZone: patch.timeZone }, current);
        const master = at.master;
        if (moved.allDay !== (master.allDay === true)) return { ...patch, start: moved.allDay ? moved.start.date : moved.start.local, end: moved.allDay ? addDays(moved.end.date, -1) : moved.end.local };
        const delta = startOfTime(moved.start, zone) - startOfTime(current.start, zone);
        const length = spanLength(moved, zone);
        if (moved.allDay) {
            const days = Math.round(delta / DAY);
            return { ...patch, start: addDays(master.start.date, days), end: addDays(addDays(master.start.date, days), Math.max(1, Math.round(length / DAY)) - 1) };
        }
        const tz = moved.start.tz ?? master.start.tz;
        const startMs = startOfTime(master.start, zone) + delta;
        return { ...patch, timeZone: tz ?? undefined, start: toLocal(startMs, tz ?? zone), end: toLocal(startMs + length, tz ?? zone) };
    }

    /**
     * "This and following": the series ends before this occurrence; a new
     * one starts here with the change. `planned`: the record the change was
     * worked out on (recordOf), for a source that checks it before writing.
     */
    async splitSeries(at, source, style, patch, planned) {
        const master = at.master;
        const zone = this.zone();
        if (master?.rrule === undefined) throw new CalendarError('Only a repeating series can be changed from one occurrence on.');
        const rule = parseRule(master.rrule);
        const splitAt = at.originalStart;
        const firstStart = startOfTime(master.start, zone);
        if (splitAt <= firstStart) {
            // From the first occurrence on is the whole series.
            return this.updateWhole(at, source, style, patch, planned);
        }
        const tell = patch.notify === true ? { notify: true } : {};
        const before = { ...rule };
        let after = { ...rule };
        if (rule.count !== undefined) {
            const done = countBefore(master, rule, splitAt, zone);
            before.count = done;
            after.count = Math.max(1, rule.count - done);
        } else {
            before.until = untilBefore(at.recurrenceId, master, zone);
            delete before.count;
        }
        const older = structuredClone(master);
        older.rrule = ruleText(before);
        older.exdates = (master.exdates ?? []).filter((t) => startOfTime(t, zone) < splitAt);
        older.rdates = (master.rdates ?? []).filter((t) => startOfTime(t, zone) < splitAt);
        older.sequence = (master.sequence ?? 0) + 1;
        const current = this.occurrenceRecord(at);
        const base = structuredClone(master);
        base.start = current.start;
        base.end = current.end;
        base.rrule = ruleText(after);
        base.exdates = (master.exdates ?? []).filter((t) => startOfTime(t, zone) >= splitAt);
        base.rdates = (master.rdates ?? []).filter((t) => startOfTime(t, zone) >= splitAt);
        delete base.recurrenceId;
        delete base.remoteId;
        delete base.sequence;
        const newer = this.recordFrom(patch, cleanRecord(base));
        newer.uid = newUid();
        if (newer.rrule && rule.byDay && !patch.repeat && newer.start.local?.slice(0, 10) !== current.start.local?.slice(0, 10)) {
            newer.rrule = shiftRuleDays(newer.rrule, current.start, newer.start);
        }
        const later = at.records.filter((r) => r.recurrenceId && startOfTime(r.recurrenceId, zone) >= splitAt);
        const near = startOfTime(newer.start, zone);
        if (style === 'ics') {
            const edits = [{ uid: at.uid, record: older }, ...later.map((r) => ({ uid: at.uid, recurrenceId: r.recurrenceId, record: null }))];
            await this.putIcs(at.calendar, at.item, edits, at.uid);
            await this.putIcs(at.calendar, null, [{ uid: newer.uid, record: newer }], newer.uid);
            return { uid: newer.uid, near };
        }
        this.takeItems(at.calendar, await source.update({ ...at.calendar }, { item: at.item, record: master, planned, from: at.recurrenceId }, { rrule: older.rrule, ...tell }, 'all'));
        const made = await source.create({ ...at.calendar }, { ...newer, ...tell });
        this.takeItems(at.calendar, made);
        // Google and Microsoft give the new series their own uid.
        return { uid: made?.find((i) => i.events?.length)?.events[0].uid ?? newer.uid, near };
    }

    async updateWhole(at, source, style, patch, planned) {
        const master = at.master;
        const zone = this.zone();
        const changed = this.recordFrom(this.shiftedPatch(at, patch), master);
        changed.uid = at.uid;
        changed.sequence = (master.sequence ?? 0) + 1;
        if (style === 'ics') await this.putIcs(at.calendar, at.item, [{ uid: at.uid, record: changed }], at.uid);
        else this.takeItems(at.calendar, await source.update({ ...at.calendar }, { item: at.item, record: master, planned }, { ...diffOf(master, changed), ...(patch.notify === true ? { notify: true } : {}) }, 'all'));
        return { uid: at.uid, near: startOfTime(changed.start, zone) };
    }

    /**
     * Move a whole event or series to another calendar: made there, then
     * taken out here. For its guests that is a new meeting, so a move that
     * would email them (a cancellation from here, an invitation from there)
     * is made only when it says to tell them.
     */
    async moveEvent(id, calendarId, by = 'window', { notify = false, dropChanges = false, approved, confirm = false } = {}) {
        const plan = this.planMove(id, calendarId, { notify, dropChanges });
        const { at, target } = plan;
        this.checkHalfMove(at, target);
        const known = this.knownFor(plan.mail, approved, confirm);
        this.checkKnown(plan.mail, known);
        const zone = this.zone();
        const targetAccount = this.store.accounts[target.accountId];
        const { source: to, style: toStyle } = await this.source(targetAccount);
        let mail = plan.mail;
        let master = plan.master;
        let uid;
        // The copies, from the event as it is now: who the move emails is worked out again first.
        const copiesNow = () => {
            const now = this.planMove(id, calendarId, { notify, dropChanges });
            this.checkKnown(now.mail, known);
            mail = now.mail;
            master = now.master;
            // A meeting that is cancelled here and sent from there is a new meeting, with its own uid.
            uid = mail.to.length > 0 || master.organizer ? newUid() : now.at.uid;
            return now.at.records.map((r) => {
                const copy = structuredClone(r);
                copy.uid = uid;
                delete copy.remoteId;
                if (mail.invites && targetAccount.kind === 'caldav') copy.organizer = { email: this.selfAddress(targetAccount) };
                // Where the server schedules, an organizer would make it a meeting: only when it invites.
                else if (!mail.invites && this.mailerOf(target) !== 'never') delete copy.organizer;
                return copy;
            });
        };
        const recheck = () => this.checkKnown(this.planMove(id, calendarId, { notify, dropChanges }).mail, known);
        if (toStyle === 'ics') {
            await this.changing(target.id, () => {
                const copies = copiesNow();
                return this.putIcs(target, null, copies.map((r) => ({ uid, recurrenceId: r.recurrenceId, record: r })), uid);
            }, { retry: false, recheck });
        } else {
            await this.changing(target.id, async () => {
                const copies = copiesNow();
                const copy = copies.find((r) => !r.recurrenceId) ?? copies[0];
                const made = await to.create({ ...target }, { ...copy, ...(mail.invites ? { notify: true } : {}) });
                this.takeItems(target, made);
                // The server can give the copy a uid of its own (Graph's iCalUId): it is found by that.
                uid = made?.[0]?.events?.[0]?.uid ?? uid;
            }, { retry: false, recheck });
        }
        // Out of here, with the cancellation the move said it sends (none when it sends none).
        try {
            await this.deleteEvent(at.master ? at.eventId : id, 'all', by, { notify: mail.cancels === true, approved: known });
        } catch (error) {
            // The copy is made, with its invitations: "nothing was done" would have the move made again, and a second copy.
            const from = this.calendarName(at.calendar);
            const sent = mail.invites && mail.to.length > 0 ? ` (invitations sent to ${peopleWords(mail.to)})` : '';
            // Kept, so the same move asked again doesn't make a second copy (checkHalfMove).
            this.halfMoves.set(stableJson([at.eventId, target.id]), { uid, at: this.now() });
            this.log(`move ${at.calendar.id} ${target.id} by=${by} copied, not taken out`);
            throw new CalendarError(`It was copied to ${this.calendarName(target)}${sent}, but not taken out of ${from}, which stopped: ${asCalendarError(error).message} `
                + `Delete it from ${from} to finish the move; moving it again would make a second copy.`, 'half-moved');
        }
        this.log(`move ${at.calendar.id} ${target.id} by=${by}${mailLog(mail)}`);
        const startMs = startOfTime(master.start, zone);
        const found = this.find({ from: startMs - DAY, to: startMs + 2 * DAY, calendars: [target.id] }).find(({ o }) => o.record.uid === uid);
        return withMail(found ? this.view(found) : { id }, mail);
    }

    /**
     * Refuse a move that was made before and stopped halfway, while its copy
     * is still in that calendar (as the plugin last read it): moving it
     * again would make a second copy, and send its invitations again. Kept
     * for a day, in memory; once the copy is gone, the move goes again.
     */
    checkHalfMove(at, target) {
        for (const [key, half] of this.halfMoves) if (this.now() - half.at > DAY) this.halfMoves.delete(key);
        const key = stableJson([at.eventId, target.id]);
        const half = this.halfMoves.get(key);
        if (half === undefined) return;
        if (!this.index().has(eventIdOf(target.id, half.uid))) {
            this.halfMoves.delete(key);
            return;
        }
        const from = this.calendarName(at.calendar);
        throw new CalendarError(`It was copied to ${this.calendarName(target)} already, by a move that stopped halfway, and that copy is still there. `
            + `Delete it from ${from} to finish the move; moving it again would make a second copy.`);
    }

    /**
     * Delete an event, one occurrence, or this and the following ones.
     * opts.notify: tell the guests (or, for someone else's invitation, its
     * organizer). A delete that would email someone without it is refused.
     * @returns {Promise<{emailed?: {what: string, to: string[]}}>}
     */
    async deleteEvent(id, scope = 'all', by = 'window', { notify = false, approved, confirm = false } = {}) {
        const plan = this.planDelete(id, scope, { notify });
        const first = plan.at;
        const { which } = plan;
        const known = this.knownFor(plan.mail, approved, confirm);
        this.checkKnown(plan.mail, known);
        let mail = plan.mail;
        await this.changing(first.calendar.id, async () => {
            // Worked out again on the event as it is now, since who it emails can have changed since.
            const now = this.planDelete(id, scope, { notify });
            this.checkKnown(now.mail, known);
            mail = now.mail;
            const emails = mail.to.length > 0;
            const tell = emails ? { notify: true } : {};
            // CalDAV: taking out an invitation declines it unless the server is told not to.
            const quiet = emails ? {} : { scheduleReply: false };
            const { at } = now;
            const { source, style } = await this.source(at.account);
            const calendar = at.calendar;
            const zone = this.zone();
            if (which === 'all') {
                if (style === 'ics') {
                    await this.putIcs(calendar, at.item, at.records.map((r) => ({ uid: at.uid, recurrenceId: r.recurrenceId, record: null })), at.uid, quiet);
                } else {
                    const synced = this.store.syncOf(calendar.id)?.state;
                    const out = await source.remove({ ...calendar }, { item: at.item, record: at.master ?? at.override, occurrence: at.recurrenceId, planned: now.before, synced, ...tell }, 'all');
                    this.takeItems(calendar, out?.items, out?.removed ?? [at.item.remoteId]);
                }
                return;
            }
            if (which === 'one') {
                if (style === 'ics') {
                    if (!at.master) {
                        await this.putIcs(calendar, at.overrideItem ?? at.item, [{ uid: at.uid, recurrenceId: at.recurrenceId, record: null }], at.uid, quiet);
                        return;
                    }
                    const master = structuredClone(at.master);
                    master.exdates = [...(master.exdates ?? []), at.recurrenceId];
                    master.sequence = (master.sequence ?? 0) + 1;
                    const edits = [{ uid: at.uid, record: master }];
                    if (at.override) edits.push({ uid: at.uid, recurrenceId: at.override.recurrenceId, record: null });
                    // A "this and following" change that starts here goes on from the next occurrence.
                    const onward = this.rangeFromNext(at);
                    if (onward) edits.push({ uid: at.uid, recurrenceId: onward.recurrenceId, record: onward });
                    await this.putIcs(calendar, at.item, edits, at.uid);
                } else {
                    const out = await source.remove({ ...calendar }, { item: at.overrideItem ?? at.item, record: at.override ?? at.master, occurrence: at.recurrenceId, planned: now.before, ...tell }, 'one');
                    this.takeItems(calendar, out?.items, out?.removed);
                }
                return;
            }
            // This and the following ones: the series ends before this one.
            const master = at.master;
            const rule = parseRule(master.rrule);
            if (at.originalStart <= startOfTime(master.start, zone)) {
                if (style === 'ics') await this.putIcs(calendar, at.item, at.records.map((r) => ({ uid: at.uid, recurrenceId: r.recurrenceId, record: null })), at.uid, quiet);
                else {
                    const out = await source.remove({ ...calendar }, { item: at.item, record: master, planned: now.before, ...tell }, 'all');
                    this.takeItems(calendar, out?.items, out?.removed ?? [at.item.remoteId]);
                }
                return;
            }
            const before = { ...rule };
            if (rule.count !== undefined) before.count = countBefore(master, rule, at.originalStart, zone);
            else before.until = untilBefore(at.recurrenceId, master, zone);
            const older = structuredClone(master);
            older.rrule = ruleText(before);
            older.sequence = (master.sequence ?? 0) + 1;
            if (style === 'ics') {
                const later = at.records.filter((r) => r.recurrenceId && startOfTime(r.recurrenceId, zone) >= at.originalStart);
                await this.putIcs(calendar, at.item, [{ uid: at.uid, record: older }, ...later.map((r) => ({ uid: at.uid, recurrenceId: r.recurrenceId, record: null }))], at.uid);
            } else {
                this.takeItems(calendar, await source.update({ ...calendar }, { item: at.item, record: master, planned: now.before, from: at.recurrenceId }, { rrule: older.rrule, ...tell }, 'all'));
            }
        }, { retry: false, recheck: () => this.checkKnown(this.planDelete(id, scope, { notify }).mail, known) });
        this.log(`delete ${first.calendar.id} ${first.eventId} scope=${which} by=${by}${mailLog(mail)}`);
        return withMail({}, mail);
    }

    /** Answer an invitation: accepted, declined or tentative; for one occurrence ('one') or the whole series ('all'). */
    async respond(id, status, scope = 'all', by = 'window', { approved } = {}) {
        if (!['accepted', 'declined', 'tentative'].includes(status)) throw new CalendarError('The answer is accepted, declined or tentative.');
        const plan = this.planRespond(id, status, scope);
        const first = plan.at;
        const { which } = plan;
        const known = approved ?? peopleOf(plan.mail);
        this.checkKnown(plan.mail, known);
        let mail = plan.mail;
        await this.changing(first.calendar.id, async () => {
            const now = this.planRespond(id, status, scope);
            this.checkKnown(now.mail, known);
            mail = now.mail;
            const { at } = now;
            const { source, style } = await this.source(at.account);
            const base = which === 'one' ? this.occurrenceRecord(at) : (at.master ?? at.override);
            const self = this.selfOf(base, at.account);
            if (!self) throw new CalendarError('You aren\'t on this event\'s guest list, so there is nothing to answer.');
            if (style === 'ics') {
                const record = structuredClone(base);
                const mine = base.attendees.indexOf(self);
                record.attendees = record.attendees.map((p, i) => (i === mine ? { ...p, status } : p));
                await this.putIcs(at.calendar, at.item, [{ uid: at.uid, ...(which === 'one' ? { recurrenceId: at.recurrenceId } : {}), record }], at.uid);
            } else if (typeof source.respond === 'function') {
                this.takeItems(at.calendar, await source.respond({ ...at.calendar }, { item: which === 'one' ? (at.overrideItem ?? at.item) : at.item, record: which === 'one' ? (at.override ?? at.master) : (at.master ?? at.override), occurrence: which === 'one' ? at.recurrenceId : undefined }, status, which));
            } else {
                throw new CalendarError('This account can\'t answer invitations from here.');
            }
        });
        this.log(`respond ${first.calendar.id} ${first.eventId} ${status} by=${by}${mailLog(mail)}`);
        return withMail(this.event(id), mail);
    }

    // ── Files ──────────────────────────────────────────────────────────

    /** A calendar as one iCalendar file. */
    exportCalendar(id) {
        const calendar = this.calendar(id);
        const records = Object.values(this.store.itemsOf(calendar.id)).flatMap((item) => item.events ?? []);
        const text = editIcs(null, records.map((r) => ({ uid: r.uid, recurrenceId: r.recurrenceId, record: r })), { now: this.now(), zone: this.zone() }) ?? editIcs(null, [], {});
        return { name: this.calendarName(calendar), ics: text ?? 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', events: records.length };
    }

    /** Events from an iCalendar file into a calendar that can be written; ones already there (same uid) are left. */
    async importIcs(calendarId, text) {
        const calendar = this.calendar(calendarId);
        this.writable(calendar);
        const { events } = readIcs(String(text ?? ''), { zone: this.zone() });
        if (events.length === 0) throw new CalendarError('The file has no events.');
        const have = new Set(Object.values(this.store.itemsOf(calendar.id)).flatMap((i) => (i.events ?? []).map((r) => r.uid)));
        const byUid = new Map();
        for (const r of events) {
            if (have.has(r.uid)) continue;
            const list = byUid.get(r.uid);
            if (list) list.push(r);
            else byUid.set(r.uid, [r]);
        }
        const account = this.store.accounts[calendar.accountId];
        const { source, style } = await this.source(account);
        // Imported events invite nobody: on a server their guests and organizer stay out (a server that
        // schedules, and Microsoft, would email them all). Calendars kept in DSH keep everything.
        const keep = (r) => {
            if (account.kind === 'local') return r;
            const copy = structuredClone(r);
            delete copy.attendees;
            delete copy.organizer;
            return copy;
        };
        let added = 0;
        for (const [uid, list] of byUid) {
            await this.changing(calendar.id, async () => {
                if (style === 'ics') await this.putIcs(calendar, null, list.map((r) => ({ uid, recurrenceId: r.recurrenceId, record: keep(r) })), uid);
                else this.takeItems(calendar, await source.create({ ...calendar }, keep(list.find((r) => !r.recurrenceId) ?? list[0])));
            });
            added++;
        }
        this.log(`import ${calendar.id} added=${added} skipped=${events.length - added}`);
        return { added, skipped: byUid.size === 0 ? events.length : events.length - [...byUid.values()].flat().length };
    }

    // ── For the window ─────────────────────────────────────────────────

    state() {
        return {
            version: this.version,
            zone: this.zone(),
            accounts: Object.values(this.store.accounts).map((a) => this.accountView(a)),
            calendars: this.calendarList(),
            defaultCalendar: this.defaultCalendarId() ?? null,
            prefs: {
                ...(this.store.prefs.weekStart !== undefined ? { weekStart: this.store.prefs.weekStart } : {}),
                ...(this.store.prefs.view ? { view: this.store.prefs.view } : {}),
                ...(this.store.prefs.hideWeekends === true ? { hideWeekends: true } : {}),
                ...(this.store.prefs.weekNumbers === true ? { weekNumbers: true } : {}),
            },
            syncing: this.syncing.size > 0,
            // calendar.json couldn't be read at this start: the name it is kept under beside it (held: it couldn't be moved, and isn't written over).
            ...(this.store.issue ? { storeIssue: { ...this.store.issue } } : {}),
        };
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

const short = (error) => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 160);

/** A change's result with who it emailed, and whose calendars it reached without emailing them. */
const withMail = (view, mail) => ({
    ...view,
    ...(mail?.to?.length > 0 ? { emailed: { what: mail.what, to: mail.to } } : {}),
    ...(mail?.reaches?.length > 0 ? { reached: { how: mail.reach, to: mail.reaches } } : {}),
});

/** Everyone a change emails or reaches (mailOf), once each. */
export function peopleOf(mail) {
    const out = new Map();
    for (const person of [...(mail?.to ?? []), ...(mail?.reaches ?? [])]) {
        const key = String(person).toLowerCase();
        if (!out.has(key)) out.set(key, person);
    }
    return [...out.values()];
}

/** Everyone on any of these records as guests, each once (by addressKey), the first record's first. */
function everyoneOn(records) {
    const out = new Map();
    for (const person of records.flatMap((r) => r?.attendees ?? [])) {
        const key = addressKey(person?.address ?? person?.email);
        if (key !== '' && !out.has(key)) out.set(key, person);
    }
    return [...out.values()];
}

/** What a change emails or reaches, for a refusal's details: {emailed?: {what, to}, reached?: {how, to}, why?}. */
export const mailDetails = (mail) => ({ ...withMail({}, mail), ...(mail?.forced && mail?.why ? { why: mail.why } : {}) });

/** A window change that didn't say who the user saw, refused in words naming who it would email or reach. */
function approvalText(mail) {
    const parts = [];
    if (mail?.to?.length > 0) parts.push(`email ${mail.what} to ${peopleWords(mail.to)}`);
    if (mail?.reaches?.length > 0) parts.push(`${REACH_WORDS[mail.reach] ?? 'change it on'} the calendars of ${peopleWords(mail.reaches)} without emailing them`);
    return `This would ${parts.join(', and ')}, so it's made once the user has seen who.`;
}

/** " mail=2 reach=1" for the log: how many, never who. */
const mailLog = (mail) => `${mail?.to?.length ? ` mail=${mail.to.length}` : ''}${mail?.reaches?.length ? ` reach=${mail.reaches.length}` : ''}`;

/** People in words: up to five addresses, then how many more. */
export function peopleWords(list) {
    const people = [...(list ?? [])];
    if (people.length === 0) return 'no one';
    const shown = people.slice(0, 5);
    const more = people.length - shown.length;
    if (more > 0) return `${shown.join(', ')} and ${more} more`;
    return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

/** What withdrawing an account's access came to; a page to manage it only on https. */
function withdrawal(revoked, manageUrl) {
    if (revoked) return { revoked: true };
    return { revoked: false, ...(typeof manageUrl === 'string' && /^https:\/\/[^\s]+$/.test(manageUrl) ? { manageUrl } : {}) };
}

/** Whether a failed request may have reached the server anyway: no answer, or the server's own failure. */
function maybeMade(error) {
    if (error?.name === 'HttpError') return true;
    if (!(error instanceof SourceError)) return false;
    return error.code === 'network' || (error.code === 'server' && (error.status === undefined || error.status >= 500));
}

/** JSON with its keys in order, so the same change reads the same however its fields came. */
export function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function asCalendarError(error) {
    if (error instanceof CalendarError) return error;
    if (error instanceof SourceError) return new CalendarError(error.message);
    if (error?.name === 'HttpError') return new CalendarError(error.message);
    return error instanceof Error ? error : new Error(String(error));
}

function safeAddress(url) {
    try {
        const u = new URL(String(url).replace(/^webcals?:\/\//i, 'https://'));
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return '';
    }
}

function validColor(color) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(color ?? '').trim());
    return m ? `#${m[1].toLowerCase()}` : undefined;
}

function hhmm(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
    if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new CalendarError('Hours of the day are like 09:00 and 17:30.');
    return Number(m[1]) === 24 ? '23:59' : `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** When a time starts, in epoch ms (a day: its midnight in the user's zone). */
function startOfTime(time, zone) {
    if ('date' in time) return toInstant(`${time.date}T00:00:00`, zone, zone);
    return instantOf(time, zone);
}

/** How long a record lasts, in ms. */
function spanLength(record, zone) {
    if (!record?.start || !record?.end) return 0;
    if ('date' in record.start) return daysBetween(record.start.date, record.end.date) * DAY;
    return Math.max(0, instantOf(record.end, zone) - instantOf(record.start, zone));
}

/**
 * A time from what a tool or the window gives: 'YYYY-MM-DD' for a day,
 * 'YYYY-MM-DDTHH:MM[:SS]' for a wall clock in the zone, or with Z or an
 * offset for an instant (kept as the zone's wall clock at that instant).
 */
function timeFrom(value, allDay, tz, what) {
    const text = String(value ?? '').trim();
    if (allDay) {
        const day = text.slice(0, 10);
        if (!isDay(day)) throw new CalendarError(`The ${what} day "${text}" isn't a date like 2026-10-12.`);
        return { date: day };
    }
    if (isDay(text)) throw new CalendarError(`The ${what} "${text}" is a day; give a time like ${text}T09:30, or make the event all-day.`);
    const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    if (withZone) {
        const ms = Date.parse(text);
        if (!Number.isFinite(ms)) throw new CalendarError(`The ${what} "${text}" isn't a time.`);
        return { local: toLocal(ms, tz), tz };
    }
    const local = normalLocal(text);
    if (local === undefined || !isDay(local.slice(0, 10))) throw new CalendarError(`The ${what} "${text}" isn't a time like 2026-10-12T09:30.`);
    return { local, tz };
}

/** A record's time moved to all-day or timed, or to another zone, keeping the wall clock. */
function convertTime(time, allDay, tz, zone) {
    if (allDay) return { date: 'date' in time ? time.date : time.local.slice(0, 10) };
    if ('date' in time) return { local: `${time.date}T09:00:00`, tz };
    if ((time.tz ?? null) === (tz ?? null)) return time;
    return { local: time.local, tz };
}

/** The fields that differ between two records: a patch for Google and Microsoft. */
function diffOf(before, after) {
    const patch = {};
    for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
        if (key === 'uid' || key === 'remoteId' || key === 'sequence' || key === 'updated' || key === 'created') continue;
        if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) patch[key] = after?.[key] ?? null;
    }
    return patch;
}

/** How many occurrences a series has before an instant. */
function countBefore(master, rule, before, zone) {
    const allDay = 'date' in master.start;
    const tz = allDay ? zone : (master.start.tz ?? zone);
    const startWall = wallMs(allDay ? `${master.start.date}T00:00:00` : master.start.local);
    let n = 0;
    for (const wall of expandWall(rule, startWall, {})) {
        const at = toInstant(wallOf(wall), tz, zone);
        if (at >= before) break;
        n++;
        if (n > 100000) break;
    }
    return n;
}

/** UNTIL for a series that ends just before an occurrence. */
function untilBefore(recurrenceId, master, zone) {
    if ('date' in master.start) {
        const day = 'date' in recurrenceId ? recurrenceId.date : recurrenceId.local.slice(0, 10);
        return addDays(day, -1).replaceAll('-', '');
    }
    const at = instantOf(recurrenceId, zone) - 1000;
    if (master.start.tz === null || master.start.tz === undefined) return wallOf(wallMs(toLocal(at, zone))).replace(/[-:]/g, '');
    return `${new Date(at).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/** BYDAY of a weekly rule moved with its start, when the start moved to another weekday. */
function shiftRuleDays(rrule, from, to) {
    const rule = parseRule(rrule);
    if (!rule.byDay || rule.byDay.some((d) => d.n) || !from?.local || !to?.local) return rrule;
    const days = Math.round((Date.parse(`${to.local.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.local.slice(0, 10)}T00:00:00Z`)) / DAY);
    if (days === 0) return rrule;
    rule.byDay = rule.byDay.map(({ wd }) => ({ wd: (((wd + days) % 7) + 7) % 7, n: 0 }));
    return ruleText(rule);
}

/** UNTIL in words for describeRule, in the event's zone. */
function untilWords(rrule, zone) {
    try {
        const rule = parseRule(rrule);
        if (!rule.until) return undefined;
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(rule.until);
        if (!m) return undefined;
        const day = m[7] ? dayIn(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), zone) : `${m[1]}-${m[2]}-${m[3]}`;
        return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    } catch {
        return undefined;
    }
}

export { INPUT_FIELDS, WEEKDAYS };
