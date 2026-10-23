/**
 * The store's files: one that can't be read is set aside and nothing is
 * deleted, a calendar's sync state sits in its events file with its items,
 * each write keeps the version before it as .bak, and the files are
 * private. A subscribed feed stands in for a synced calendar; its server
 * is a function here, so nothing goes over the network.
 *
 *   node --test plugins/calendar/test/store.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CalendarManager } from '../lib/manager.js';
import { CalendarStore } from '../lib/store.js';

const ZONE = 'Europe/Berlin';
const NOW = Date.parse('2026-10-11T09:25:00Z');
const STAMP = '20261011T092500Z';
const FEED = 'https://feeds.example.test/holidays.ics';
const at = (local) => Date.parse(`${local}+02:00`);

/** A feed's text: [uid, first day, day after, title] per event. */
const icsOf = (events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Feed//EN', 'X-WR-CALNAME:Holidays',
    ...events.flatMap(([uid, day, next, title]) => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z',
        `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`, `SUMMARY:${title}`, 'END:VEVENT']),
    'END:VCALENDAR', ''].join('\r\n');

function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-store-'));
    const vault = new Map();
    const secrets = {
        async get(id) { return vault.get(id); },
        async set(id, payload) { vault.set(id, structuredClone(payload)); },
        async clear(id) { vault.delete(id); },
    };
    // The feed's server: what it holds, and the ETag each request came with (null: none, so the whole feed).
    // While `hold` is set, it answers only once that promise settles.
    const feed = { etag: '"v1"', events: [['h1@test', '20261103', '20261104', 'Holiday']], asked: [], hold: undefined };
    const fetch = async (url, init = {}) => {
        const sent = init.headers?.['if-none-match'];
        feed.asked.push(sent ?? null);
        await feed.hold;
        if (sent === feed.etag) return new Response(null, { status: 304 });
        return new Response(icsOf(feed.events), { status: 200, headers: { 'content-type': 'text/calendar', etag: feed.etag } });
    };
    const make = (folder = dir) => new CalendarManager({
        config: { storeFile: join(folder, 'calendar.json'), logFile: join(folder, 'calendar.log'), syncMinutes: 15, timeZone: ZONE },
        secrets, fetch, now: () => NOW,
    });
    return { dir, feed, make, storeFile: join(dir, 'calendar.json'), eventsDir: join(dir, 'events'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const read = (file) => readFileSync(file, 'utf8');
const modeOf = (file) => statSync(file).mode & 0o777;
const titles = (m) => m.events({ from: at('2026-10-01T00:00'), to: at('2026-12-01T00:00') }).occurrences.map((o) => o.title).sort();
const calendarOf = (m, accountId) => m.state().calendars.find((c) => c.accountId === accountId);

test('no calendar.json is a first start, not a problem', async () => {
    const s = setup();
    const m = s.make();
    try {
        await m.start();
        assert.equal(m.state().storeIssue, undefined);
        assert.deepEqual(m.state().calendars.map((c) => c.name), ['Personal']);
        assert.deepEqual(readdirSync(s.dir).filter((name) => name.includes('unreadable')), []);
    } finally {
        m.dispose();
        s.done();
    }
});

test('a calendar.json that can\'t be read is set aside, no events file goes, and putting it back brings everything back', async () => {
    const s = setup();
    let m = s.make();
    try {
        await m.start();
        await m.createEvent({ title: 'Dentist', start: '2026-10-13T09:30' });
        const work = await m.createCalendar({ name: 'Work' });
        await m.createEvent({ title: 'Review', start: '2026-10-14T10:00', calendarId: work.id });
        const feedAccount = await m.addAccount({ kind: 'ics', url: FEED });
        assert.deepEqual(titles(m), ['Dentist', 'Holiday', 'Review']);
        m.dispose();

        const good = read(s.storeFile);
        const cut = good.slice(0, Math.floor(good.length / 2));
        const events = Object.fromEntries(readdirSync(s.eventsDir).filter((name) => name.endsWith('.json')).map((name) => [name, read(join(s.eventsDir, name))]));
        assert.equal(Object.keys(events).length, 3);
        writeFileSync(s.storeFile, cut);

        m = s.make();
        await m.start();
        const aside = `calendar.json.unreadable-${STAMP}`;
        assert.deepEqual(m.state().storeIssue, { file: aside, at: NOW });
        assert.equal(read(join(s.dir, aside)), cut, 'kept as it was');
        assert.ok(existsSync(join(s.dir, `${aside}.bak`)), 'its .bak moved with it, so the saves that follow don\'t replace it');
        for (const [name, text] of Object.entries(events)) assert.equal(read(join(s.eventsDir, name)), text, `${name} is still there, unchanged`);
        // Personal is made again under the same id and finds its events; the other calendars wait for their calendar.json.
        assert.deepEqual(m.state().calendars.map((c) => c.name), ['Personal']);
        assert.deepEqual(titles(m), ['Dentist']);
        const log = read(join(s.dir, 'calendar.log'));
        assert.match(log, /store unreadable calendar\.json set aside/);
        assert.match(log, /store kept unknown events files=2\n/);
        assert.ok(!log.split('\n').some((line) => line.includes(' store ') && line.includes(work.id)), 'a count only');
        // A change to Personal keeps what was there.
        await m.createEvent({ title: 'Call', start: '2026-10-15T16:00' });
        m.dispose();

        // The user puts the old file back.
        writeFileSync(s.storeFile, good);
        m = s.make();
        await m.start();
        assert.equal(m.state().storeIssue, undefined);
        assert.deepEqual(m.state().calendars.map((c) => c.name), ['Personal', 'Work', 'Holidays']);
        assert.deepEqual(titles(m), ['Call', 'Dentist', 'Holiday', 'Review']);
        assert.ok(calendarOf(m, feedAccount.id).syncedAt, 'the feed still knows how far it is up to date');
    } finally {
        m.dispose();
        s.done();
    }
});

test('calendar.json of a version this store doesn\'t know is set aside too, and a second one in the same second gets its own name', () => {
    const s = setup();
    try {
        writeFileSync(s.storeFile, '{"version":2,"accounts":{}}');
        const first = new CalendarStore(s.storeFile, { now: () => NOW });
        assert.deepEqual(first.issue, { file: `calendar.json.unreadable-${STAMP}`, at: NOW });
        assert.deepEqual(first.accounts, {});
        writeFileSync(s.storeFile, '{"version":1,"accounts":[]}');
        const second = new CalendarStore(s.storeFile, { now: () => NOW });
        assert.deepEqual(second.issue, { file: `calendar.json.unreadable-${STAMP}-2`, at: NOW });
        assert.equal(read(join(s.dir, `calendar.json.unreadable-${STAMP}`)), '{"version":2,"accounts":{}}');
        assert.equal(read(join(s.dir, `calendar.json.unreadable-${STAMP}-2`)), '{"version":1,"accounts":[]}');
        assert.equal(existsSync(s.storeFile), false);
    } finally {
        s.done();
    }
});

test('an events file that can\'t be read is set aside, never written over, and its calendar starts empty without a sync state', async () => {
    const s = setup();
    let m = s.make();
    try {
        await m.start();
        const personal = m.state().calendars[0];
        await m.createEvent({ title: 'Dentist', start: '2026-10-13T09:30' });
        const account = await m.addAccount({ kind: 'ics', url: FEED });
        const feedCal = calendarOf(m, account.id);
        m.dispose();
        const feedFile = join(s.eventsDir, `${feedCal.id}.json`);
        const personalFile = join(s.eventsDir, `${personal.id}.json`);
        const broken = { feed: read(feedFile).slice(0, 40), personal: '' };
        writeFileSync(feedFile, broken.feed);
        writeFileSync(personalFile, broken.personal);

        m = s.make();
        await m.start();
        const feedAside = `${feedCal.id}.json.unreadable-${STAMP}`;
        const personalAside = `${personal.id}.json.unreadable-${STAMP}`;
        assert.equal(read(join(s.eventsDir, feedAside)), broken.feed);
        assert.equal(read(join(s.eventsDir, personalAside)), broken.personal);
        assert.deepEqual(calendarOf(m, account.id).storeIssue, { file: feedAside, at: NOW });
        assert.deepEqual(calendarOf(m, 'local').storeIssue, { file: personalAside, at: NOW });
        assert.equal(m.state().storeIssue, undefined, 'calendar.json itself was fine');
        assert.equal(m.store.syncOf(feedCal.id), undefined, 'no sync state, so the feed is read whole');
        assert.equal(calendarOf(m, account.id).syncedAt, undefined);
        assert.deepEqual(titles(m), []);

        s.feed.asked.length = 0;
        await m.syncAccount(account.id);
        assert.deepEqual(s.feed.asked, [null], 'asked without its ETag');
        await m.createEvent({ title: 'Call', start: '2026-10-15T16:00' });
        assert.deepEqual(titles(m), ['Call', 'Holiday']);
        m.store.flush();
        assert.equal(read(join(s.eventsDir, feedAside)), broken.feed, 'what was set aside stays as it was');
        assert.equal(read(join(s.eventsDir, personalAside)), broken.personal);
        assert.deepEqual(JSON.parse(read(feedFile)).sync, { etag: '"v1"' });
        assert.match(read(join(s.dir, 'calendar.log')), new RegExp(`store unreadable ${feedCal.id}\\.json set aside`));
    } finally {
        m.dispose();
        s.done();
    }
});

test('a calendar\'s sync state is written in its events file with the items, never in calendar.json', async () => {
    const s = setup();
    let m = s.make();
    try {
        await m.start();
        const account = await m.addAccount({ kind: 'ics', url: FEED });
        const cal = calendarOf(m, account.id);
        assert.deepEqual(s.feed.asked, [null]);
        m.dispose();

        const file = join(s.eventsDir, `${cal.id}.json`);
        const saved = JSON.parse(read(file));
        assert.deepEqual(saved.sync, { etag: '"v1"' });
        assert.equal(saved.syncedAt, NOW);
        assert.deepEqual(Object.keys(saved.items), ['h1@test']);
        const store = JSON.parse(read(s.storeFile));
        assert.equal(store.calendars[cal.id].sync, undefined);
        assert.equal(store.calendars[cal.id].syncedAt, undefined);

        // After a restart the feed is asked from where its events file says.
        m = s.make();
        await m.start();
        assert.equal(calendarOf(m, account.id).syncedAt, NOW);
        s.feed.asked.length = 0;
        await m.syncAccount(account.id);
        assert.deepEqual(s.feed.asked, ['"v1"']);
        assert.deepEqual(titles(m), ['Holiday']);
        m.dispose();

        // An older calendar.json kept the state itself, beside an events file without one: that state is dropped.
        store.calendars[cal.id].sync = { etag: '"v1"' };
        store.calendars[cal.id].syncedAt = NOW;
        writeFileSync(s.storeFile, JSON.stringify(store));
        writeFileSync(file, JSON.stringify({ version: 1, items: saved.items }));
        m = s.make();
        await m.start();
        assert.equal(m.store.syncOf(cal.id), undefined);
        assert.equal(m.store.calendars[cal.id].sync, undefined);
        s.feed.asked.length = 0;
        await m.syncAccount(account.id);
        assert.deepEqual(s.feed.asked, [null], 'read whole once');
        m.dispose();
        assert.equal(JSON.parse(read(s.storeFile)).calendars[cal.id].sync, undefined);
    } finally {
        m.dispose();
        s.done();
    }
});

test('a missing events file means no sync state: the calendar is read whole again', async () => {
    const s = setup();
    let m = s.make();
    try {
        await m.start();
        const account = await m.addAccount({ kind: 'ics', url: FEED });
        const cal = calendarOf(m, account.id);
        m.dispose();
        rmSync(join(s.eventsDir, `${cal.id}.json`));

        m = s.make();
        await m.start();
        assert.equal(m.store.syncOf(cal.id), undefined);
        assert.deepEqual(titles(m), []);
        s.feed.asked.length = 0;
        await m.syncAccount(account.id);
        assert.deepEqual(s.feed.asked, [null]);
        assert.deepEqual(titles(m), ['Holiday']);
    } finally {
        m.dispose();
        s.done();
    }
});

test('stopped before a sync\'s events are written, the files don\'t claim the newer state: the next start fetches what was missed', async () => {
    const s = setup();
    const copy = mkdtempSync(join(tmpdir(), 'calendar-store-crash-'));
    const m = s.make();
    let again;
    try {
        await m.start();
        const account = await m.addAccount({ kind: 'ics', url: FEED });
        const cal = calendarOf(m, account.id);
        m.store.flush();
        s.feed.etag = '"v2"';
        s.feed.events.push(['h2@test', '20261104', '20261105', 'Webinar']);
        await m.syncAccount(account.id);
        assert.deepEqual(titles(m), ['Holiday', 'Webinar']);
        // The files as a crash would leave them now: the events are written a moment after a sync.
        cpSync(s.dir, copy, { recursive: true });
        const onDisk = JSON.parse(read(join(copy, 'events', `${cal.id}.json`)));
        assert.deepEqual(onDisk.sync, { etag: '"v1"' }, 'the state that goes with the items beside it');
        assert.deepEqual(Object.keys(onDisk.items), ['h1@test']);
        assert.equal(JSON.parse(read(join(copy, 'calendar.json'))).calendars[cal.id].sync, undefined);

        again = s.make(copy);
        await again.start();
        s.feed.asked.length = 0;
        await again.syncAccount(account.id);
        assert.deepEqual(s.feed.asked, ['"v1"']);
        assert.deepEqual(titles(again), ['Holiday', 'Webinar']);
    } finally {
        m.dispose();
        again?.dispose();
        rmSync(copy, { recursive: true, force: true });
        s.done();
    }
});

test('a sync that ends after its calendar was removed keeps nothing of it', async () => {
    const s = setup();
    const m = s.make();
    try {
        await m.start();
        const account = await m.addAccount({ kind: 'ics', url: FEED });
        const cal = calendarOf(m, account.id);
        let release;
        s.feed.hold = new Promise((resolve) => { release = resolve; });
        const syncing = m.syncCalendar(cal.id);
        while (s.feed.asked.length < 2) await new Promise((resolve) => setImmediate(resolve));
        await m.removeAccount(account.id);
        release();
        assert.equal(await syncing, false);
        assert.equal(m.store.items.has(cal.id), false);
        assert.equal(m.store.syncOf(cal.id), undefined);
        assert.equal(existsSync(join(s.eventsDir, `${cal.id}.json`)), false);
    } finally {
        m.dispose();
        s.done();
    }
});

test('each write keeps the version before it as .bak, every file is 600 in a 700 folder, and removing a calendar takes its files', async () => {
    const s = setup();
    const m = s.make();
    try {
        await m.start();
        const personal = m.state().calendars[0];
        const before = read(s.storeFile);
        m.setPrefs({ weekStart: 1 });
        assert.equal(read(`${s.storeFile}.bak`), before);
        assert.equal(JSON.parse(read(s.storeFile)).prefs.weekStart, 1);

        const file = join(s.eventsDir, `${personal.id}.json`);
        await m.createEvent({ title: 'Dentist', start: '2026-10-13T09:30' });
        m.store.flush();
        assert.equal(existsSync(`${file}.bak`), false, 'nothing before the first write');
        const first = read(file);
        await m.createEvent({ title: 'Call', start: '2026-10-15T16:00' });
        m.store.flush();
        assert.equal(read(`${file}.bak`), first);
        assert.notEqual(read(file), first);

        for (const f of [s.storeFile, `${s.storeFile}.bak`, file, `${file}.bak`, join(s.dir, 'calendar.log')]) assert.equal(modeOf(f), 0o600, f);
        for (const d of [s.dir, s.eventsDir]) assert.equal(modeOf(d), 0o700, d);

        // Deleting a calendar is the user's own doing: its events file and its .bak go.
        const work = await m.createCalendar({ name: 'Work' });
        const workFile = join(s.eventsDir, `${work.id}.json`);
        await m.createEvent({ title: 'Review', start: '2026-10-14T10:00', calendarId: work.id });
        m.store.flush();
        await m.createEvent({ title: 'Plan', start: '2026-10-16T10:00', calendarId: work.id });
        m.store.flush();
        assert.ok(existsSync(workFile) && existsSync(`${workFile}.bak`));
        await m.deleteCalendar(work.id);
        assert.equal(existsSync(workFile), false);
        assert.equal(existsSync(`${workFile}.bak`), false);
    } finally {
        m.dispose();
        s.done();
    }
});

test('a start removes temporary files left by a crash and leaves events files it doesn\'t know', async () => {
    const s = setup();
    const m = s.make();
    try {
        mkdirSync(s.eventsDir, { mode: 0o700 });
        const stray = join(s.eventsDir, 'cal-000000000000.json');
        writeFileSync(stray, '{"version":1,"items":{}}\n');
        writeFileSync(`${stray}.4242.tmp`, '{"version":1,');
        writeFileSync(`${s.storeFile}.4242.tmp`, '{"version":1,');
        await m.start();
        assert.equal(read(stray), '{"version":1,"items":{}}\n');
        assert.equal(existsSync(`${stray}.4242.tmp`), false);
        assert.equal(existsSync(`${s.storeFile}.4242.tmp`), false);
        const log = read(join(s.dir, 'calendar.log'));
        assert.match(log, /store kept unknown events files=1\n/);
        assert.doesNotMatch(log, /cal-000000000000/);
    } finally {
        m.dispose();
        s.done();
    }
});
