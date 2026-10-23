/**
 * The plugin's durable state, in its own folder (~/.dsh/calendar, mode 700):
 *
 *   calendar.json            accounts, calendars and the user's choices for
 *                            them, preferences (mode 600). Never a secret:
 *                            passwords and sign-ins are in DSH's credential
 *                            store.
 *   events/<calendar>.json   each calendar's items: what the server holds
 *                            (iCalendar text for CalDAV and local calendars)
 *                            and the events read from it, with the sync state
 *                            that says how far they are up to date (mode 600).
 *                            The two are written together, so the state is
 *                            never ahead of the items: no file, no state, and
 *                            the calendar is read whole again.
 *
 * Every write goes to a temporary file that then takes the file's place,
 * and the version it replaces stays as <file>.bak (one generation), so a
 * bad write can be undone by hand. A file that is there but can't be read
 * is renamed to <file>.unreadable-<UTC time>, its .bak with it, and the
 * store goes on without it: what the plugin can't read is never deleted or
 * written over, and can be put back by hand.
 *
 * calendar.json:
 * { version: 1,
 *   accounts: { [id]: { id, kind, name, url? (CalDAV; a subscription's address is in its credential
 *     record), host? (a subscription's site), username?, email?, addresses? (the user's own, where the
 *     server names them), preset?, allowHttp?, createdAt, calendars?: [{remoteId, name, color}] (local
 *     accounts: their calendars), error?, syncedAt?, calendarsAt? } },
 *   calendars: { [id]: { id, accountId, remoteId, name, color?, readOnly?, timeZone?, description?, mode?,
 *     scheduling? (CalDAV: whether its server emails a meeting's guests itself),
 *     own?: {name?, color?} (the user's choices, over the server's), hidden?, error? } },
 *   prefs: { defaultCalendar?, weekStart?, ... } }
 *
 * events/<calendar>.json:
 * { version: 1, sync?: the source's opaque state, syncedAt?, items: { [remoteId]: item } }
 *
 * @module dsh-plugin-calendar/store
 */
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** Resolve a '~'-prefixed path. */
export function expand(p) {
    return p.startsWith('~/') || p === '~' ? `${homedir()}${p.slice(1)}` : p;
}

/** DSH's own data folder: `$DSH_HOME`, else ~/.dsh, as DSH resolves it. */
export function dshHome() {
    const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
    return env === '' ? join(homedir(), '.dsh') : resolve(expand(env));
}

/** A data path: one under ~/.dsh follows DSH_HOME, so a test copy of DSH keeps its own calendars. */
export function dataPath(p) {
    if (p === '~/.dsh' || p.startsWith('~/.dsh/')) return `${dshHome()}${p.slice('~/.dsh'.length)}`;
    return expand(p);
}

/** A folder (and missing parents) as mode 700, whatever the umask. */
export function ensurePrivateDir(dir) {
    const missing = [];
    for (let d = dir; !existsSync(d); d = dirname(d)) {
        missing.unshift(d);
        if (dirname(d) === d) break;
    }
    if (missing.length === 0) {
        const st = statSync(dir);
        if ((st.mode & 0o700) !== 0o700 && st.uid === process.getuid?.()) chmodSync(dir, (st.mode & 0o777) | 0o700);
        return;
    }
    for (const d of missing) {
        try { mkdirSync(d, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
        chmodSync(d, 0o700);
    }
}

/**
 * Write a file atomically as mode 600, its folder made private first: the
 * text goes to a temporary file that then takes the file's place, and the
 * version it replaces stays as <file>.bak.
 */
export function writePrivate(file, text) {
    ensurePrivateDir(dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    keepPrevious(file);
    renameSync(tmp, file);
}

/** The file as it is now, as <file>.bak: a second name for it, or a copy where the disk has no such names. */
function keepPrevious(file) {
    if (!existsSync(file)) return;
    const bak = `${file}.bak`;
    rmSync(bak, { force: true });
    try {
        linkSync(file, bak);
    } catch {
        copyFileSync(file, bak);
    }
    try { chmodSync(bak, 0o600); } catch {}
}

/** A JSON file's value, undefined when there is no such file. Throws when it is there but can't be read or parsed. */
function readJson(file) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
    }
    return JSON.parse(text);
}

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const plain = (value) => (isPlain(value) ? value : {});
const ID = /^[a-z][a-z0-9-]{0,63}$/;

/** A time as part of a file name: 20261011T092500Z. */
const stampOf = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');

/**
 * Each start of the plugin reads the files as they are then; nothing is
 * kept across a switch-off, so the next start sees what the files say.
 */
export class CalendarStore {
    /**
     * @param {string} file - calendar.json's path; the events folder sits beside it.
     * @param {object} [opts]
     * @param {() => number} [opts.now] - for tests.
     * @param {(line: string) => void} [opts.log] - the plugin's log: names and counts, never event text.
     */
    constructor(file, { now, log } = {}) {
        this.file = dataPath(file);
        this.eventsDir = join(dirname(this.file), 'events');
        this.now = now ?? Date.now;
        this.log = log ?? (() => {});
        this.accounts = {};
        this.calendars = {};
        this.prefs = {};
        /** @type {Map<string, Record<string, object>>} calendar id → its items by remote id */
        this.items = new Map();
        /** @type {Map<string, {state: any, at?: number}>} calendar id → how far its items are up to date */
        this.syncs = new Map();
        /** calendar.json couldn't be read at this start: {file, at} with the name it was moved to (held: it couldn't be moved). */
        this.issue = undefined;
        /** @type {Map<string, {file: string, at: number, held?: true}>} the same for calendars' events files */
        this.issues = new Map();
        /** Files that can't be read and couldn't be moved aside either: never written over. */
        this.held = new Set();
        this.dirty = new Set();
        this.timer = undefined;
        this.load();
    }

    load() {
        this.accounts = {};
        this.calendars = {};
        this.prefs = {};
        this.items.clear();
        this.syncs.clear();
        this.issue = undefined;
        this.issues.clear();
        this.held.clear();
        let parsed;
        try {
            parsed = readJson(this.file);
            if (parsed !== undefined && !storeShaped(parsed)) throw new Error('not a calendar store');
        } catch {
            // There but unreadable: kept for the user, and this start goes on without it. Missing is a first start.
            this.issue = this.setAside(this.file);
            parsed = undefined;
        }
        if (parsed !== undefined) {
            for (const [id, a] of Object.entries(plain(parsed.accounts))) {
                if (ID.test(id) && typeof a?.kind === 'string') this.accounts[id] = { ...a, id };
            }
            for (const [id, c] of Object.entries(plain(parsed.calendars))) {
                if (!ID.test(id) || typeof c?.accountId !== 'string' || !this.accounts[c.accountId]) continue;
                // An older file kept the sync state here; it lives with the items now, so this one goes (a full sync follows).
                const { sync, syncedAt, ...calendar } = c;
                this.calendars[id] = { ...calendar, id };
            }
            this.prefs = plain(parsed.prefs);
        }
        for (const id of Object.keys(this.calendars)) this.open(id);
    }

    /**
     * A file that is there but can't be read, renamed aside with its .bak:
     * → {file, at} with the name it has now. When it can't be moved either,
     * it stays as it is and is never written over: → {file, at, held}.
     */
    setAside(file) {
        const at = this.now();
        let aside = `${file}.unreadable-${stampOf(at)}`;
        for (let n = 2; existsSync(aside) || existsSync(`${aside}.bak`); n++) aside = `${file}.unreadable-${stampOf(at)}-${n}`;
        try {
            renameSync(file, aside);
        } catch {
            this.held.add(file);
            this.log(`unreadable ${basename(file)} left in place`);
            return { file: basename(file), at, held: true };
        }
        // Its backup goes with it, so the writes that follow don't replace it.
        try { renameSync(`${file}.bak`, `${aside}.bak`); } catch {}
        this.log(`unreadable ${basename(file)} set aside`);
        return { file: basename(aside), at };
    }

    eventsFile(calendarId) {
        return join(this.eventsDir, `${calendarId}.json`);
    }

    /** Read a calendar's events file: its items, and how far they are up to date. → the items. */
    open(calendarId) {
        const file = this.eventsFile(calendarId);
        let items = {};
        this.syncs.delete(calendarId);
        try {
            const parsed = readJson(file);
            if (parsed !== undefined) {
                if (!isPlain(parsed) || parsed.version !== 1 || !isPlain(parsed.items)) throw new Error('not an events file');
                items = parsed.items;
                if (parsed.sync !== undefined && parsed.sync !== null) {
                    this.syncs.set(calendarId, { state: parsed.sync, ...(Number.isFinite(parsed.syncedAt) ? { at: parsed.syncedAt } : {}) });
                }
            }
        } catch {
            // Kept aside; the calendar starts empty and without a sync state, so a synced one is read whole again.
            this.issues.set(calendarId, this.setAside(file));
        }
        this.items.set(calendarId, items);
        return items;
    }

    /** Write calendar.json now. */
    save() {
        if (this.held.has(this.file)) throw new Error(`${basename(this.file)} can't be read and couldn't be moved aside, so it isn't written over`);
        writePrivate(this.file, `${JSON.stringify({ version: 1, accounts: this.accounts, calendars: this.calendars, prefs: this.prefs }, null, 1)}\n`);
    }

    /**
     * A calendar's items by remote id. The first time the store meets a
     * calendar they come from its events file when there is one (Personal's
     * is still there after calendar.json was moved aside), else none.
     */
    itemsOf(calendarId) {
        return this.items.get(calendarId) ?? this.open(calendarId);
    }

    /** How far a calendar's items are up to date: {state (its source's own), at}; undefined: read it whole. */
    syncOf(calendarId) {
        return this.syncs.get(calendarId);
    }

    /**
     * A sync's new state, kept with the calendar's items: both go into its
     * events file in one write, so the file never says it is more up to date
     * than its items. A state that didn't change isn't worth a write; its
     * time goes with the next one.
     */
    setSync(calendarId, state, at) {
        const before = this.syncs.get(calendarId);
        this.syncs.set(calendarId, { state, at });
        if (JSON.stringify(before?.state) !== JSON.stringify(state)) this.touch(calendarId);
    }

    /** Mark a calendar's items changed; they're written shortly after (several changes, one write). */
    touch(calendarId) {
        this.dirty.add(calendarId);
        if (this.timer !== undefined) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, 400);
        this.timer.unref?.();
    }

    /** Write every changed calendar's items, with their sync state, now. */
    flush() {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        for (const id of [...this.dirty]) {
            this.dirty.delete(id);
            const file = this.eventsFile(id);
            if (!this.calendars[id] || this.held.has(file)) continue;
            const sync = this.syncs.get(id);
            try {
                writePrivate(file, `${JSON.stringify({ version: 1, sync: sync?.state, syncedAt: sync?.at, items: this.itemsOf(id) })}\n`);
            } catch {
                // Kept in memory; the next change writes it again.
                this.dirty.add(id);
            }
        }
    }

    /** Forget a calendar, its items and its events file with the file's .bak (the user removed it, or its server did). */
    dropCalendar(calendarId) {
        delete this.calendars[calendarId];
        this.items.delete(calendarId);
        this.syncs.delete(calendarId);
        this.issues.delete(calendarId);
        this.dirty.delete(calendarId);
        const file = this.eventsFile(calendarId);
        // One that couldn't be read stays: nobody saw what's in it.
        if (this.held.has(file)) return;
        try {
            rmSync(file, { force: true });
            rmSync(`${file}.bak`, { force: true });
        } catch {}
    }

    /**
     * Tidying at the start: temporary files a crash left go. Events files of
     * calendars the store doesn't know stay where they are (calendar.json may
     * have been moved aside, to be put back); only their count is logged.
     * → that count.
     */
    sweep() {
        let unknown = 0;
        try {
            for (const name of readdirSync(this.eventsDir)) {
                if (name.endsWith('.tmp')) rmSync(join(this.eventsDir, name), { force: true });
                else if (name.endsWith('.json') && !this.calendars[name.slice(0, -'.json'.length)]) unknown++;
            }
        } catch {}
        try {
            const dir = dirname(this.file);
            const own = `${basename(this.file)}.`;
            for (const name of readdirSync(dir)) {
                if (name.startsWith(own) && /^\d+\.tmp$/.test(name.slice(own.length))) rmSync(join(dir, name), { force: true });
            }
        } catch {}
        if (unknown > 0) this.log(`kept unknown events files=${unknown}`);
        return unknown;
    }
}

/** Whether a parsed calendar.json is one this store reads: version 1, with objects where it keeps them. */
function storeShaped(parsed) {
    return isPlain(parsed) && parsed.version === 1 && ['accounts', 'calendars', 'prefs'].every((key) => parsed[key] === undefined || isPlain(parsed[key]));
}
