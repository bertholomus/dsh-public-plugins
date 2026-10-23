/**
 * The manager on calendars kept on this computer and a subscribed feed:
 * adding, reading, changing (one occurrence, this and the following ones,
 * the whole series), moving, deleting, answering, searching, free time,
 * export and import, and a restart that keeps everything. A feed's address
 * stays in its credential record, out of the files, the log and anything
 * the window or an agent gets.
 *
 *   node --test plugins/calendar/test/manager.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CalendarError, CalendarManager, calendarIdOf } from '../lib/manager.js';

// The agents' tools without DSH: a stand-in for its tool package, whose defineTool hands each tool back as it is.
const TOOLS_STANDIN = 'data:text/javascript,export const defineTool = (tool) => tool;';
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
    return specifier === '@deepseek-ai/dsh-tools' ? { shortCircuit: true, url: ${JSON.stringify(TOOLS_STANDIN)} } : next(specifier, context);
}`)}`);
const { calendarTools } = await import('../lib/tools.js');
const { ShownPlans, changeGate, planOf } = await import('../lib/policy.js');

const ZONE = 'Europe/Berlin';
const NOW = Date.parse('2026-10-11T10:00:00Z');
const at = (local) => Date.parse(`${local}+02:00`);

function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-manager-'));
    const vault = new Map();
    const secrets = {
        async get(id) { return vault.get(id); },
        async set(id, payload) { vault.set(id, structuredClone(payload)); },
        async clear(id) { vault.delete(id); },
    };
    const config = { storeFile: join(dir, 'calendar.json'), logFile: join(dir, 'calendar.log'), syncMinutes: 15, timeZone: ZONE };
    const make = () => new CalendarManager({ config, secrets, now: () => NOW });
    return { dir, vault, config, make, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const week = (m, from = '2026-10-12T00:00', to = '2026-10-26T00:00') => m.events({ from: at(from), to: at(to) }).occurrences;
const titles = (list) => list.map((o) => `${o.startLocal ?? o.startDay} ${o.title}`);

test('a calendar on this computer: add, read, change and delete single events', async () => {
    const { make, done, config } = setup();
    const m = make();
    try {
        await m.start();
        const state = m.state();
        assert.equal(state.zone, ZONE);
        assert.equal(state.calendars.length, 1);
        assert.equal(state.calendars[0].name, 'Personal');
        assert.equal(state.defaultCalendar, state.calendars[0].id);

        const dentist = await m.createEvent({ title: 'Dentist', start: '2026-10-13T09:30', end: '2026-10-13T10:15', location: 'Main St 1', alarms: [30, 10] }, 'agent');
        assert.equal(dentist.title, 'Dentist');
        assert.equal(dentist.startLocal, '2026-10-13T09:30');
        assert.equal(dentist.endLocal, '2026-10-13T10:15');
        assert.equal(dentist.timeZone, ZONE);
        assert.equal(dentist.start, at('2026-10-13T09:30'));
        assert.deepEqual(dentist.alarms, [10, 30]);
        assert.match(dentist.id, /^ev-[0-9a-f]{12}$/);

        const trip = await m.createEvent({ title: 'Trip', start: '2026-10-20', end: '2026-10-22' });
        assert.equal(trip.allDay, true);
        assert.equal(trip.startDay, '2026-10-20');
        assert.equal(trip.lastDay, '2026-10-22');

        const timedDefault = await m.createEvent({ title: 'Call', start: '2026-10-14T16:00' });
        assert.equal(timedDefault.endLocal, '2026-10-14T17:00', 'an hour by default');

        assert.deepEqual(titles(week(m)), ['2026-10-13T09:30 Dentist', '2026-10-14T16:00 Call', '2026-10-20 Trip']);

        // A start alone moves the event and keeps its length; another zone keeps the event's own wall clock.
        const moved = await m.updateEvent(dentist.id, { start: '2026-10-13T11:00' });
        assert.equal(moved.startLocal, '2026-10-13T11:00');
        assert.equal(moved.endLocal, '2026-10-13T11:45');
        const ny = await m.updateEvent(timedDefault.id, { start: '2026-10-14T09:00', timeZone: 'America/New_York' });
        assert.equal(ny.timeZone, 'America/New_York');
        assert.equal(ny.startLocal, '2026-10-14T09:00');
        assert.equal(ny.start, Date.parse('2026-10-14T09:00:00-04:00'));
        // Given with an offset, a time is the same instant on the event's own clock.
        const offset = await m.updateEvent(timedDefault.id, { start: '2026-10-14T17:00+02:00' });
        assert.equal(offset.startLocal, '2026-10-14T11:00');
        assert.equal(offset.timeZone, 'America/New_York');

        // Fields clear with null; bad input is refused with a message that says what to give.
        const cleared = await m.updateEvent(dentist.id, { location: null, alarms: [] });
        assert.equal(cleared.location, undefined);
        assert.equal(cleared.alarms, undefined);
        await assert.rejects(m.updateEvent(dentist.id, { end: '2026-10-13T08:00' }), CalendarError);
        await assert.rejects(m.createEvent({ title: 'x', start: 'soon' }), /isn't a time/);
        await assert.rejects(m.createEvent({ title: '', start: '2026-10-13T09:00' }), /title/);
        await assert.rejects(m.createEvent({ title: 'x', start: '2026-10-13T09:00', repeat: 'FREQ=SOMETIMES' }), /repeat rule/);
        await assert.rejects(m.updateEvent('ev-000000000000', { title: 'x' }), /There is no event/);

        // The item on disk is iCalendar text, and the files are private.
        await m.store.flush();
        const file = m.store.eventsFile(state.calendars[0].id);
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        const raw = Object.values(saved.items).map((i) => i.raw).join('\n');
        assert.match(raw, /SUMMARY:Dentist/);
        assert.match(raw, /DTSTART;TZID=Europe\/Berlin:20261013T110000/);
        assert.match(raw, /BEGIN:VTIMEZONE\r\nTZID:America\/New_York/);
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(config.storeFile).mode & 0o777, 0o600);
        assert.equal(statSync(join(config.storeFile, '..')).mode & 0o777, 0o700);

        await m.deleteEvent(trip.id);
        assert.deepEqual(titles(week(m)), ['2026-10-13T11:00 Dentist', '2026-10-14T11:00 Call']);
        assert.match(readFileSync(config.logFile, 'utf8'), /create cal-[0-9a-f]+ by=agent/);
        assert.doesNotMatch(readFileSync(config.logFile, 'utf8'), /Dentist/, 'the log has no event text');
    } finally {
        m.dispose();
        done();
    }
});

test('a repeating event: one occurrence, this and the following ones, the whole series', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const standup = await m.createEvent({ title: 'Standup', start: '2026-10-12T09:00', end: '2026-10-12T09:15', repeat: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' });
        assert.equal(standup.recurring, true);
        assert.equal(standup.repeats, 'Every week on Monday, Wednesday and Friday');
        let list = week(m);
        assert.equal(list.length, 6);
        assert.deepEqual(list.map((o) => o.id.split('.')[1]), ['20261012T090000', '20261014T090000', '20261016T090000', '20261019T090000', '20261021T090000', '20261023T090000']);
        assert.ok(list.every((o) => o.eventId === standup.eventId));

        // Only Wednesday's moves; it says it changed.
        const wed = list[1];
        const changed = await m.updateEvent(wed.id, { start: '2026-10-14T10:00' }, 'one');
        assert.equal(changed.startLocal, '2026-10-14T10:00');
        assert.equal(changed.endLocal, '2026-10-14T10:15');
        assert.equal(changed.changed, true);
        assert.equal(changed.id, wed.id, 'a changed occurrence keeps its id');
        list = week(m);
        assert.deepEqual(titles(list).slice(0, 3), ['2026-10-12T09:00 Standup', '2026-10-14T10:00 Standup', '2026-10-16T09:00 Standup']);

        // An occurrence taken out.
        await m.deleteEvent(list[2].id, 'one');
        list = week(m);
        assert.equal(list.length, 5);
        assert.ok(!list.some((o) => o.startLocal === '2026-10-16T09:00'));

        // From the 19th on: a new title; the earlier ones (and Wednesday's change) stay.
        const mon = list.find((o) => o.startLocal === '2026-10-19T09:00');
        const following = await m.updateEvent(mon.id, { title: 'Team sync' }, 'following');
        assert.equal(following.title, 'Team sync');
        list = week(m);
        assert.deepEqual(titles(list), [
            '2026-10-12T09:00 Standup', '2026-10-14T10:00 Standup',
            '2026-10-19T09:00 Team sync', '2026-10-21T09:00 Team sync', '2026-10-23T09:00 Team sync',
        ]);
        const older = m.event(list[0].id);
        assert.match(older.repeat, /UNTIL=20261019T065959Z/);
        assert.notEqual(list[2].eventId, list[0].eventId, 'the new part is its own series');

        // The whole new series moves half an hour, given on one of its occurrences.
        const fri = list.find((o) => o.startLocal === '2026-10-23T09:00');
        await m.updateEvent(fri.id, { start: '2026-10-23T09:30' }, 'all');
        list = week(m);
        assert.deepEqual(titles(list).slice(2), ['2026-10-19T09:30 Team sync', '2026-10-21T09:30 Team sync', '2026-10-23T09:30 Team sync']);
        assert.ok(list.slice(2).every((o) => o.endLocal.endsWith('09:45')));

        // Moving a weekly series to another weekday moves its days with it.
        const tue = await m.updateEvent(list[2].id, { start: '2026-10-20T09:30' }, 'all');
        assert.match(tue.repeat, /BYDAY=TU,TH,SA/);

        // A scope only for repeating events, and a whole-series change through its own id.
        await assert.rejects(m.updateEvent(standup.eventId, { title: 'x' }, 'one'), /occurrence/);
        const series = await m.updateEvent(standup.eventId, { title: 'Daily' }, 'all');
        assert.equal(series.title, 'Daily');
        assert.equal(m.event(list[1].id).title, 'Standup', 'a changed occurrence keeps its own title');

        // This and the following ones, deleted: the series ends before.
        const nov = m.events({ from: at('2026-10-26T00:00'), to: at('2026-11-30T00:00') }).occurrences.filter((o) => o.title === 'Team sync');
        assert.ok(nov.length > 5);
        await m.deleteEvent(nov[2].id, 'following');
        const after = m.events({ from: at('2026-10-26T00:00'), to: at('2027-03-01T00:00') }).occurrences.filter((o) => o.title === 'Team sync');
        assert.equal(after.length, 2);

        // The whole series deleted, its changed occurrence too.
        await m.deleteEvent(standup.eventId, 'all');
        assert.ok(!week(m).some((o) => o.eventId === standup.eventId));
    } finally {
        m.dispose();
        done();
    }
});

test('counted series split and all-day series', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const pay = await m.createEvent({ title: 'Rent', start: '2026-11-01', repeat: 'FREQ=MONTHLY;BYMONTHDAY=1;COUNT=6' });
        assert.equal(pay.allDay, true);
        const all = m.events({ from: at('2026-10-01T00:00'), to: at('2027-06-01T00:00') }).occurrences;
        assert.deepEqual(all.map((o) => o.startDay), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01']);
        await m.updateEvent(all[3].id, { title: 'Rent (new place)' }, 'following');
        const split = m.events({ from: at('2026-10-01T00:00'), to: at('2027-06-01T00:00') }).occurrences;
        assert.deepEqual(split.map((o) => `${o.startDay} ${o.title}`), [
            '2026-11-01 Rent', '2026-12-01 Rent', '2027-01-01 Rent',
            '2027-02-01 Rent (new place)', '2027-03-01 Rent (new place)', '2027-04-01 Rent (new place)',
        ]);
        assert.match(m.event(split[0].id).repeat, /COUNT=3/);
        assert.match(m.event(split[3].id).repeat, /COUNT=3/);
        // A three-day event that repeats yearly.
        const fest = await m.createEvent({ title: 'Festival', start: '2026-12-30', end: '2027-01-01', repeat: 'FREQ=YEARLY' });
        assert.equal(fest.lastDay, '2027-01-01');
        const next = m.events({ from: at('2027-12-31T00:00'), to: at('2028-01-02T00:00') }).occurrences.find((o) => o.title === 'Festival');
        assert.equal(next.startDay, '2027-12-30');
        assert.equal(next.lastDay, '2028-01-01');
    } finally {
        m.dispose();
        done();
    }
});

test('search, busy time and free slots', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        await m.createEvent({ title: 'Dentist', start: '2026-10-13T09:30', end: '2026-10-13T10:15', location: 'Main St' });
        await m.createEvent({ title: 'Lunch with Sam', start: '2026-10-13T12:00', end: '2026-10-13T13:00', attendees: ['sam@example.com'] });
        await m.createEvent({ title: 'Focus', start: '2026-10-13T14:00', end: '2026-10-13T16:00', busy: false });
        await m.createEvent({ title: 'Old dentist visit', start: '2026-09-01T09:00' });
        const found = m.search({ text: 'dentist' }).occurrences;
        assert.deepEqual(found.map((o) => o.title), ['Dentist', 'Old dentist visit'], 'upcoming first');
        assert.deepEqual(m.search({ text: 'main dentist' }).occurrences.map((o) => o.title), ['Dentist']);
        assert.deepEqual(m.search({ text: 'sam@example' }).occurrences.map((o) => o.title), ['Lunch with Sam']);
        assert.throws(() => m.search({ text: '  ' }), CalendarError);
        const { slots } = m.freeSlots({ from: at('2026-10-13T00:00'), to: at('2026-10-14T00:00'), minutes: 60 });
        assert.deepEqual(slots.map((s) => [new Date(s.start).toISOString(), new Date(s.end).toISOString()]), [
            ['2026-10-13T08:15:00.000Z', '2026-10-13T10:00:00.000Z'],
            ['2026-10-13T11:00:00.000Z', '2026-10-13T15:00:00.000Z'],
        ], 'free shows through events marked free');
        const weekend = m.freeSlots({ from: at('2026-10-17T00:00'), to: at('2026-10-19T00:00') });
        assert.equal(weekend.slots.length, 0, 'Saturday and Sunday are left out by default');
    } finally {
        m.dispose();
        done();
    }
});

test('calendars: make, rename, hide, default, move an event between them, export and import', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const work = await m.createCalendar({ name: 'Work', color: '#30A46C' });
        assert.equal(work.color, '#30a46c');
        const personal = m.state().calendars.find((c) => c.name === 'Personal');
        const series = await m.createEvent({ title: 'Gym', start: '2026-10-12T18:00', repeat: 'FREQ=WEEKLY;COUNT=4', calendarId: personal.id });
        const occ = week(m).filter((o) => o.title === 'Gym');
        await m.updateEvent(occ[1].id, { title: 'Gym (late)', start: '2026-10-19T20:00' }, 'one');
        const moved = await m.updateEvent(series.eventId, { calendarId: work.id });
        assert.equal(moved.calendarId, work.id);
        const after = week(m).filter((o) => o.title.startsWith('Gym'));
        assert.ok(after.every((o) => o.calendarId === work.id), 'the series and its changed occurrence moved');
        assert.deepEqual(titles(after), ['2026-10-12T18:00 Gym', '2026-10-19T20:00 Gym (late)']);

        m.updateCalendar(work.id, { hidden: true });
        assert.equal(week(m).filter((o) => o.title.startsWith('Gym')).length, 0, 'hidden calendars are left out');
        assert.equal(m.events({ from: at('2026-10-12T00:00'), to: at('2026-10-26T00:00'), calendars: [work.id] }).occurrences.length, 2, 'unless asked for');
        m.updateCalendar(work.id, { hidden: false, name: 'Job' });
        m.setDefaultCalendar(work.id);
        assert.equal(m.state().defaultCalendar, work.id);
        const made = await m.createEvent({ title: 'Review', start: '2026-10-15T10:00' });
        assert.equal(made.calendar, 'Job');

        const exported = m.exportCalendar(work.id);
        assert.equal(exported.events, 3);
        assert.match(exported.ics, /BEGIN:VCALENDAR/);
        assert.match(exported.ics, /RECURRENCE-ID/);
        const copy = await m.createCalendar({ name: 'Copy' });
        const imported = await m.importIcs(copy.id, exported.ics);
        assert.equal(imported.added, 2);
        const again = await m.importIcs(copy.id, exported.ics);
        assert.equal(again.added, 0, 'the same events again are left');
        assert.equal(m.events({ from: at('2026-10-12T00:00'), to: at('2026-10-26T00:00'), calendars: [copy.id] }).occurrences.length, 3);

        await assert.rejects(m.deleteCalendar(m.state().calendars.find((c) => c.name === 'Personal').id).then(() => m.deleteCalendar(work.id)).then(() => m.deleteCalendar(copy.id)), /last calendar/);
    } finally {
        m.dispose();
        done();
    }
});

test('answering an invitation on a calendar whose account has the user\'s address', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        m.store.accounts.local.email = 'me@example.com';
        const ev = await m.createEvent({ title: 'Planning', start: '2026-10-15T14:00', attendees: ['me@example.com', { email: 'boss@example.com', name: 'Boss' }] });
        // An invitation from someone else.
        const at0 = m.locate(ev.id);
        at0.master.organizer = { email: 'boss@example.com', name: 'Boss' };
        m.changed();
        const seen = m.event(ev.id);
        assert.equal(seen.myStatus, 'needs-action');
        assert.equal(seen.canRespond, true);
        const answered = await m.respond(ev.id, 'accepted');
        assert.equal(answered.myStatus, 'accepted');
        await assert.rejects(m.respond(ev.id, 'maybe'), /accepted, declined or tentative/);
    } finally {
        m.dispose();
        done();
    }
});

test('a subscribed feed is read only, follows its ETag, survives a restart, and its address stays a secret', async (t) => {
    let hits = 0;
    let answer = 200;
    let body = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Feed//EN', 'X-WR-CALNAME:Holidays', 'X-WR-TIMEZONE:Europe/Berlin',
        'BEGIN:VEVENT', 'UID:h1@test', 'DTSTAMP:20260101T000000Z', 'DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261104', 'SUMMARY:Holiday', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:h2@test', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261104T170000Z', 'DURATION:PT2H', 'SUMMARY:Webinar', 'END:VEVENT',
        'END:VCALENDAR', '',
    ].join('\r\n');
    // A private feed's address, like Google's secret one: its key is in the path (and here in the query too).
    const key = 'private-9f8e7d6c5b4a3928';
    const query = 'token=1706f5e4d3c2b1a0';
    const path = `/calendar/ical/me%40example.com/${key}/basic.ics?${query}`;
    const server = createServer((req, res) => {
        if (req.url !== path) {
            res.writeHead(404);
            return res.end('not here');
        }
        hits++;
        if (answer !== 200) {
            res.writeHead(answer, answer === 429 ? { 'retry-after': '120' } : {});
            return res.end();
        }
        if (req.headers['if-none-match'] === '"v1"' && body.includes('Webinar')) {
            res.writeHead(304);
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/calendar', etag: '"v1"' });
        res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const host = `127.0.0.1:${server.address().port}`;
    const url = `http://${host}${path}`;
    const { dir, vault, config, make, done } = setup();
    // The address may be in the account's credential record only. Each check says where it looked, never what it found.
    const hidden = (text, where) => assert.ok(!String(text).includes(key) && !String(text).includes(query), `${where} holds the feed's address`);
    const listCalendars = (manager) => calendarTools(manager).find((tool) => tool.name === 'calendar_list_calendars').execute({});
    /** Not in calendar.json, the events files or the log, nor in what the window or an agent gets. */
    const hiddenEverywhere = async (manager) => {
        manager.store.flush();
        const events = join(dir, 'events');
        for (const file of [config.storeFile, config.logFile, ...readdirSync(events).map((name) => join(events, name))]) hidden(readFileSync(file, 'utf8'), file);
        hidden(JSON.stringify(manager.state()), 'the window\'s state');
        hidden(JSON.stringify(await listCalendars(manager)), 'calendar_list_calendars');
    };
    let m = make();
    try {
        await m.start();
        const account = await m.addAccount({ kind: 'ics', url });
        // The account shows its host; the address is in its record, and its calendar has a fixed remote id.
        hidden(JSON.stringify(account), 'the account view');
        await hiddenEverywhere(m);
        assert.equal(account.name, 'Holidays', 'named by the feed');
        assert.equal(account.host, host);
        assert.ok(!('url' in account), 'the account view has no url');
        assert.ok(vault.get(account.id)?.url === url, 'the address is in the account\'s record');
        assert.equal(JSON.parse(readFileSync(config.storeFile, 'utf8')).accounts[account.id].host, host);
        const cal = m.state().calendars.find((c) => c.accountId === account.id);
        assert.ok(m.store.calendars[cal.id].remoteId === 'feed', 'the feed\'s calendar has a fixed remote id');
        assert.equal(cal.readOnly, true);
        const list = m.events({ from: at('2026-11-01T00:00'), to: at('2026-11-08T00:00') }).occurrences;
        assert.deepEqual(list.map((o) => o.title), ['Holiday', 'Webinar']);
        assert.equal(list[1].startLocal, '2026-11-04T18:00');
        assert.equal(list[1].endLocal, '2026-11-04T20:00');
        assert.ok(list.every((o) => o.readOnly));
        await assert.rejects(m.updateEvent(list[0].id, { title: 'x' }), /read only/);
        await assert.rejects(m.deleteEvent(list[0].id), /read only/);
        assert.throws(() => m.setDefaultCalendar(cal.id), /can't be written/);
        await m.syncAccount(account.id);
        assert.equal(hits, 2);
        assert.equal(m.events({ from: at('2026-11-01T00:00'), to: at('2026-11-08T00:00') }).occurrences.length, 2, 'a 304 changes nothing');
        await hiddenEverywhere(m);

        // A failed fetch: the window's message names the host only, and agents get a fixed category, never the message.
        answer = 500;
        await m.syncAccount(account.id);
        const failed = m.state().calendars.find((c) => c.id === cal.id);
        hidden(failed.error, 'the calendar\'s error');
        assert.equal(failed.error, `Reading the calendar at ${host}: the server answered HTTP 500.`);
        assert.equal(failed.problem, 'server error');
        const listed = await listCalendars(m);
        hidden(JSON.stringify(listed), 'calendar_list_calendars');
        assert.match(listed.text, /^- Holidays · Holidays · read only · problem: server error {2}\[id cal-/m);
        assert.ok(!('error' in listed.view.calendars.find((c) => c.id === cal.id)), 'the chat card has no message');
        await hiddenEverywhere(m);
        // Told to wait, the account has a problem too.
        answer = 429;
        await m.syncAccount(account.id);
        await hiddenEverywhere(m);
        const waiting = m.state().accounts.find((a) => a.id === account.id);
        assert.equal(waiting.status, 'error');
        assert.equal(waiting.problem, 'rate limited');
        assert.match((await listCalendars(m)).text, /\nAccounts with problems:\n- Holidays: rate limited$/);
        answer = 200;
        await m.syncAccount(account.id);
        assert.equal(m.state().calendars.find((c) => c.id === cal.id).error, undefined);
        assert.equal(m.state().accounts.find((a) => a.id === account.id).status, 'ok');

        // The feed drops an event.
        body = body.replace(/BEGIN:VEVENT\r\nUID:h2@test[\s\S]*?END:VEVENT\r\n/, '');
        await m.syncAccount(account.id);
        assert.deepEqual(m.events({ from: at('2026-11-01T00:00'), to: at('2026-11-08T00:00') }).occurrences.map((o) => o.title), ['Holiday']);
        const ids = m.events({ from: at('2026-11-01T00:00'), to: at('2026-11-08T00:00') }).occurrences.map((o) => o.id);
        m.dispose();

        // The next start reads the files (same calendars, same ids), and the feed from the address in its record.
        m = make();
        await m.start();
        assert.deepEqual(m.events({ from: at('2026-11-01T00:00'), to: at('2026-11-08T00:00') }).occurrences.map((o) => o.id), ids);
        const before = hits;
        await m.syncAccount(account.id);
        assert.ok(hits > before, 'fetched from the address in its record');
        await hiddenEverywhere(m);
        assert.equal(m.state().calendars.find((c) => c.id === cal.id).error, undefined);
        m.dispose();

        // A calendar.json from before the address moved to the record: it was the account's url, and the
        // calendar's remoteId (so its id too), and old errors named it. The next start moves it, once.
        const old = JSON.parse(readFileSync(config.storeFile, 'utf8'));
        const oldId = calendarIdOf(account.id, url);
        old.accounts[account.id] = { ...old.accounts[account.id], url, error: { code: 'rate', message: `Reading ${url}: the server asked to wait.`, at: NOW, until: NOW } };
        delete old.accounts[account.id].host;
        old.calendars[oldId] = { ...old.calendars[cal.id], id: oldId, remoteId: url, own: { name: 'Feiertage' }, error: { code: 'server', message: `Reading ${url}: the server answered HTTP 500.`, at: NOW } };
        delete old.calendars[cal.id];
        writeFileSync(config.storeFile, JSON.stringify(old));
        vault.delete(account.id);
        m = make();
        assert.ok(!('url' in m.state().accounts.find((a) => a.id === account.id)), 'before the move too, the window gets no url for a feed');
        await m.start();
        await hiddenEverywhere(m);
        assert.ok(vault.get(account.id)?.url === url, 'the address moved to the account\'s record');
        assert.equal(m.store.accounts[account.id].host, host);
        assert.deepEqual(m.state().calendars.filter((c) => c.accountId === account.id).map((c) => [c.id, c.name, c.error]), [[cal.id, 'Feiertage', undefined]],
            'the calendar has the feed\'s id again, with the user\'s name for it');
        await m.syncAccount(account.id);
        assert.deepEqual(m.events({ from: at('2026-11-01T00:00'), to: at('2026-11-08T00:00') }).occurrences.map((o) => o.title), ['Holiday'], 'its events come again');
        await hiddenEverywhere(m);
        m.dispose();
        m = make();
        await m.start();
        assert.equal(readFileSync(config.logFile, 'utf8').match(/address moved/g)?.length, 1, 'moved once');

        // Removing the account removes its record.
        await m.removeAccount(account.id);
        assert.equal(m.state().calendars.length, 1);
        assert.equal(vault.has(account.id), false);
        await assert.rejects(m.addAccount({ kind: 'ics', url: 'ftp://example.com/x.ics' }), /https/);
        // A feed that fails is refused in words that name the host only, and neither it nor its record is kept.
        const refused = await m.addAccount({ kind: 'ics', url: `http://${host}/calendar/ical/me%40example.com/${key}-gone/basic.ics?${query}` }).then(() => undefined, (error) => error);
        assert.ok(refused instanceof CalendarError, 'a feed that fails is refused');
        hidden(refused.message, 'the refusal');
        assert.equal(refused.message, `Reading the calendar at ${host}: the server has no such thing (any more).`);
        // Nothing answers at the address: the network's error names the host only too.
        const closed = createServer();
        await new Promise((r) => closed.listen(0, '127.0.0.1', r));
        const nobody = `127.0.0.1:${closed.address().port}`;
        await new Promise((r) => closed.close(r));
        const unreachable = await m.addAccount({ kind: 'ics', url: `http://${nobody}${path}` }).then(() => undefined, (error) => error);
        assert.ok(unreachable instanceof CalendarError, 'a feed nobody answers for is refused');
        hidden(unreachable.message, 'the refusal');
        assert.equal(unreachable.message, `Couldn't reach ${nobody}: the connection was refused`);
        assert.equal(m.state().accounts.length, 1, 'a feed that fails is not kept');
        assert.equal(vault.size, 0, 'nor its record');
        await hiddenEverywhere(m);
    } finally {
        m.dispose();
        done();
    }
});

// ── Guests and email ───────────────────────────────────────────────────

/**
 * A stand-in source for an account added to the store by hand: CalDAV-like
 * ('ics': iCalendar text, put and remove) or Google/Microsoft-like
 * ('events': create, update, remove, respond). Every call is noted.
 */
/**
 * A source for one account, in memory: `calls` keeps what it was asked to
 * do. calls.fail: errors its next changes throw, one each; calls.syncItems:
 * items its next sync brings (a change made on the server).
 */
function standIn(m, account, calendar, style) {
    const calls = [];
    let n = 0;
    const failing = () => {
        if (calls.fail?.length) throw calls.fail.shift();
    };
    const sync = async (_calendar, state) => ({ reset: false, items: calls.syncItems?.splice(0) ?? [], removed: [], state: state ?? {} });
    const source = style === 'ics' ? {
        async put(_calendar, item, raw, uid) {
            calls.push({ op: 'put', raw, item: item?.remoteId });
            failing();
            return { remoteId: item?.remoteId ?? `${calendar.remoteId}${uid}.ics`, etag: `"e${++n}"` };
        },
        async remove(_calendar, item, opts = {}) {
            calls.push({ op: 'remove', item: item?.remoteId, ...opts });
            failing();
        },
        sync,
    } : {
        async create(_calendar, record) {
            calls.push({ op: 'create', record });
            const uid = `${account.kind}-${++n}`;
            const { notify: _notify, ...kept } = record;
            return [{ remoteId: uid, events: [{ ...kept, uid, organizer: { email: account.email, self: true } }] }];
        },
        async update(_calendar, target, patch, scope) {
            calls.push({ op: 'update', patch, scope, planned: target.planned, ...(target.from !== undefined ? { from: target.from } : {}) });
            failing();
            return [];
        },
        async remove(_calendar, target, scope) {
            calls.push({ op: 'remove', notify: target.notify === true, scope, planned: target.planned });
            failing();
            return { removed: [target.item.remoteId], items: [] };
        },
        async respond(_calendar, target, status, scope) {
            calls.push({ op: 'respond', status, scope });
            return [];
        },
        sync,
    };
    m.store.accounts[account.id] = { calendarsAt: NOW, ...account };
    m.store.calendars[calendar.id] = { readOnly: false, mode: 'masters', color: '#4f7cff', ...calendar, accountId: account.id };
    m.store.itemsOf(calendar.id);
    const previous = m.source.bind(m);
    m.source = async (a) => (a.id === account.id ? { style, source } : previous(a));
    m.changed();
    return calls;
}

/** An invitation from someone else, as a CalDAV server would hold it. */
function invitationIcs(uid, start) {
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z',
        `DTSTART;TZID=Europe/Berlin:${start}`, 'DURATION:PT1H', 'SUMMARY:Board review',
        'ORGANIZER;CN=Boss:mailto:boss@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@icloud.com',
        'ATTENDEE;PARTSTAT=ACCEPTED:mailto:ann@example.com', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

/** iCalendar text with its folded lines joined again. */
const unfold = (raw) => String(raw).replace(/\r\n[ \t]/g, '');

const refusedFor = (code, pattern) => (error) => error instanceof CalendarError && error.code === code && pattern.test(error.message);

test('CalDAV that schedules: a change that would email guests is made only when it says to tell them', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const calls = standIn(m,
            { id: 'dav', kind: 'caldav', name: 'iCloud', url: 'https://caldav.icloud.com/', username: 'me@icloud.com', email: 'me@icloud.com', addresses: ['me@icloud.com'] },
            { id: 'cal-dav', remoteId: 'https://p52-caldav.icloud.com/1/calendars/home/', name: 'Home', scheduling: true }, 'ics');
        assert.equal(m.calendarView(m.calendar('cal-dav')).canEmail, true);

        // Guests without telling them: the server isn't asked to schedule (no organizer), and nobody is emailed.
        const quiet = await m.createEvent({ calendarId: 'cal-dav', title: 'Lunch', start: '2026-10-14T12:00', attendees: ['ann@example.com'] });
        assert.equal(quiet.emailed, undefined);
        assert.doesNotMatch(unfold(calls.at(-1).raw), /ORGANIZER/);
        assert.match(unfold(calls.at(-1).raw), /ATTENDEE.*ann@example\.com/);

        // Telling them names the user as the organizer, and the server sends the invitations.
        const meeting = await m.createEvent({ calendarId: 'cal-dav', title: 'Planning', start: '2026-10-15T10:00', attendees: ['ann@example.com', 'bob@example.com'], notify: true });
        assert.deepEqual(meeting.emailed, { what: 'invitations', to: ['ann@example.com', 'bob@example.com'] });
        assert.match(unfold(calls.at(-1).raw), /ORGANIZER:mailto:me@icloud\.com/);

        // Now the server emails its guests about every change: refused without notify, nothing sent to the server.
        const sent = calls.length;
        await assert.rejects(m.updateEvent(meeting.id, { start: '2026-10-15T11:00' }),
            refusedFor('needs-notify', /^This would email an update to ann@example\.com and bob@example\.com \(this calendar's server emails a meeting's guests itself\)/));
        await assert.rejects(m.deleteEvent(meeting.id), refusedFor('needs-notify', /a cancellation to ann@example\.com and bob@example\.com/));
        // The refusal lists them and what they'd get, for the window to hold the change to when the user says to send it.
        await assert.rejects(m.deleteEvent(meeting.id), (error) => {
            assert.deepEqual(error.people, ['ann@example.com', 'bob@example.com']);
            assert.deepEqual(error.mail, { emailed: { what: 'a cancellation', to: ['ann@example.com', 'bob@example.com'] }, why: 'this calendar\'s server emails a meeting\'s guests itself' });
            return true;
        });
        await assert.rejects(m.deleteEvent(meeting.id, 'all', 'window', { notify: true, approved: ['ann@example.com'] }),
            refusedFor('changed', /it would now also email a cancellation to bob@example\.com, so nothing was done/));
        assert.equal(calls.length, sent);
        // The user's own reminders tell nobody anything.
        assert.equal((await m.updateEvent(meeting.id, { alarms: [15] })).emailed, undefined);
        const moved = await m.updateEvent(meeting.id, { start: '2026-10-15T11:00', notify: true });
        assert.deepEqual(moved.emailed, { what: 'an update', to: ['ann@example.com', 'bob@example.com'] });
        assert.equal(moved.startLocal, '2026-10-15T11:00');
        // A guest taken off is told too.
        const fewer = await m.updateEvent(meeting.id, { attendees: ['ann@example.com'], notify: true });
        assert.deepEqual(fewer.emailed.to, ['ann@example.com', 'bob@example.com']);

        // Someone else's invitation: taking it out doesn't decline it unless asked (Schedule-Reply: F).
        const items = m.store.itemsOf('cal-dav');
        items['https://p52-caldav.icloud.com/1/calendars/home/inv-1.ics'] = {
            remoteId: 'https://p52-caldav.icloud.com/1/calendars/home/inv-1.ics', etag: '"i1"', raw: invitationIcs('inv-1', '20261016T090000'),
            events: (await import('../lib/ical.js')).readIcs(invitationIcs('inv-1', '20261016T090000'), { zone: ZONE }).events,
        };
        m.changed();
        const invitation = week(m).find((o) => o.title === 'Board review');
        assert.equal(invitation.invitation, true);
        assert.equal(invitation.canRespond, true);
        await assert.rejects(m.updateEvent(invitation.id, { attendees: ['ann@example.com', 'eve@example.com'], notify: true }), /someone else's invitation: only its organizer changes who is invited/);
        // Its time and words are its organizer's; the user's own reminders are theirs.
        await assert.rejects(m.updateEvent(invitation.id, { start: '2026-10-16T10:00' }), /its organizer sets its title, time, place, link and notes/);
        assert.equal((await m.updateEvent(invitation.id, { alarms: [10] })).emailed, undefined);
        await assert.rejects(m.moveEvent(invitation.id, m.defaultCalendarId() === 'cal-dav' ? m.state().calendars.find((c) => c.name === 'Personal').id : m.defaultCalendarId()), /someone else's invitation/);
        const answered = await m.respond(invitation.id, 'accepted');
        assert.deepEqual(answered.emailed, { what: 'the answer', to: ['boss@example.com'] });
        await assert.rejects(m.respond(invitation.id, 'declined', 'following'), /one occurrence \(one\) or the whole series \(all\)/);
        assert.deepEqual(await m.deleteEvent(invitation.id), {});
        assert.deepEqual(calls.at(-1), { op: 'remove', item: 'https://p52-caldav.icloud.com/1/calendars/home/inv-1.ics', scheduleReply: false });

        // Many guests: five by name, then how many more.
        const crowd = Array.from({ length: 7 }, (_, i) => `p${i + 1}@example.com`);
        const big = await m.createEvent({ calendarId: 'cal-dav', title: 'All hands', start: '2026-10-16T15:00', attendees: crowd, notify: true });
        await assert.rejects(m.deleteEvent(big.id), refusedFor('needs-notify', /to p1@example\.com, p2@example\.com, p3@example\.com, p4@example\.com, p5@example\.com and 2 more \(/));
        assert.deepEqual((await m.deleteEvent(big.id, 'all', 'window', { notify: true })).emailed.to, crowd);
        assert.equal(calls.at(-1).scheduleReply, undefined);

        // What the log keeps: counts, never addresses.
        const log = readFileSync(m.config.logFile, 'utf8');
        assert.match(log, /create cal-dav by=window people=2 mail=2/);
        assert.doesNotMatch(log, /@example\.com|@icloud\.com/);
    } finally {
        m.dispose();
        done();
    }
});

test('CalDAV that doesn\'t schedule, and calendars kept here: nothing is emailed, and a change that says to tell guests is refused', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        standIn(m, { id: 'rad', kind: 'caldav', name: 'Radicale', url: 'https://dav.example.com/', username: 'me', email: 'me@example.com' },
            { id: 'cal-rad', remoteId: 'https://dav.example.com/me/cal/', name: 'Cal', scheduling: false }, 'ics');
        assert.equal(m.calendarView(m.calendar('cal-rad')).canEmail, false);
        await assert.rejects(m.createEvent({ calendarId: 'cal-rad', title: 'X', start: '2026-10-14T12:00', attendees: ['ann@example.com'], notify: true }),
            /This calendar's server doesn't email guests\. Save it without telling them, and tell them another way\./);
        const ev = await m.createEvent({ calendarId: 'cal-rad', title: 'X', start: '2026-10-14T12:00', attendees: ['ann@example.com'] });
        assert.equal((await m.updateEvent(ev.id, { start: '2026-10-14T13:00' })).emailed, undefined);

        const personal = m.state().calendars.find((c) => c.name === 'Personal');
        assert.equal(personal.canEmail, false);
        const local = await m.createEvent({ calendarId: personal.id, title: 'Y', start: '2026-10-14T12:00', attendees: ['ann@example.com'] });
        await assert.rejects(m.deleteEvent(local.id, 'all', 'window', { notify: true }), /Calendars kept in DSH can't email anyone/);
        // Without guests, telling them is nothing to refuse.
        const alone = await m.createEvent({ calendarId: personal.id, title: 'Z', start: '2026-10-14T15:00', notify: true });
        assert.equal(alone.emailed, undefined);
    } finally {
        m.dispose();
        done();
    }
});

test('Microsoft and Google: Microsoft emails a meeting\'s guests about every change, Google only when told', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const ms = standIn(m, { id: 'ms', kind: 'microsoft', name: 'Outlook', email: 'me@outlook.com' }, { id: 'cal-ms', remoteId: 'AAA', name: 'Calendar' }, 'events');
        await assert.rejects(m.createEvent({ calendarId: 'cal-ms', title: 'Sync', start: '2026-10-14T12:00', attendees: ['ann@example.com'] }),
            refusedFor('needs-notify', /invitations to ann@example\.com \(Microsoft invites the guests as soon as an event with them is saved\)/));
        assert.equal(ms.length, 0);
        const sync = await m.createEvent({ calendarId: 'cal-ms', title: 'Sync', start: '2026-10-14T12:00', attendees: ['ann@example.com'], notify: true });
        assert.equal(ms.at(-1).record.notify, true);
        assert.deepEqual(sync.emailed, { what: 'invitations', to: ['ann@example.com'] });
        await assert.rejects(m.updateEvent(sync.id, { title: 'Sync (moved)' }), refusedFor('needs-notify', /an update to ann@example\.com \(Microsoft emails a meeting's guests about each change to it\)/));
        await m.updateEvent(sync.id, { title: 'Sync (moved)', notify: true });
        assert.equal(ms.at(-1).patch.notify, true);
        await assert.rejects(m.deleteEvent(sync.id), refusedFor('needs-notify', /a cancellation to ann@example\.com \(Microsoft emails a meeting's guests when it is cancelled\)/));
        // An event of the user's own with no one else on it: nothing to tell.
        const solo = await m.createEvent({ calendarId: 'cal-ms', title: 'Focus', start: '2026-10-14T15:00' });
        assert.deepEqual(await m.deleteEvent(solo.id), {});

        const google = standIn(m, { id: 'g', kind: 'google', name: 'Google', email: 'me@gmail.com' }, { id: 'cal-g', remoteId: 'primary', name: 'Me' }, 'events');
        const lunch = await m.createEvent({ calendarId: 'cal-g', title: 'Lunch', start: '2026-10-15T12:00', attendees: ['ann@example.com'] });
        assert.equal(google.at(-1).record.notify, undefined, 'Google is told not to email');
        assert.equal(lunch.emailed, undefined);
        assert.equal((await m.updateEvent(lunch.id, { start: '2026-10-15T13:00' })).emailed, undefined);
        assert.deepEqual((await m.updateEvent(lunch.id, { start: '2026-10-15T12:30', notify: true })).emailed, { what: 'an update', to: ['ann@example.com'] });
        assert.equal(google.at(-1).patch.notify, true);
        assert.deepEqual(await m.deleteEvent(lunch.id, 'all', 'window', { notify: true }), { emailed: { what: 'a cancellation', to: ['ann@example.com'] } });
        assert.equal(google.at(-1).notify, true);
    } finally {
        m.dispose();
        done();
    }
});

test('moving: only a whole event or series, on its own; a meeting moved is a new one for its guests', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const work = await m.createCalendar({ name: 'Work' });
        const personal = m.state().calendars.find((c) => c.name === 'Personal');
        await m.createEvent({ title: 'Gym', start: '2026-10-12T18:00', repeat: 'FREQ=DAILY;COUNT=5', calendarId: personal.id });
        const gym = () => week(m).filter((o) => o.title === 'Gym');
        const second = gym()[1];
        await assert.rejects(m.updateEvent(second.id, { calendarId: work.id, start: '2026-10-13T19:00' }, 'one'), /Only a whole event or series moves to another calendar/);
        await assert.rejects(m.updateEvent(second.id, { calendarId: work.id }, 'following'), /Only a whole event or series moves/);
        await assert.rejects(m.updateEvent(second.id, { calendarId: work.id, title: 'Gym!' }, 'all'), /Move the event to the other calendar on its own first, then change it there\./);
        assert.equal(gym().length, 5);
        assert.ok(gym().every((o) => o.calendarId === personal.id), 'nothing moved, nothing lost');
        const moved = await m.updateEvent(second.id, { calendarId: work.id }, 'all');
        assert.equal(moved.calendarId, work.id);
        assert.equal(gym().length, 5);
        assert.ok(gym().every((o) => o.calendarId === work.id));

        // A meeting with guests moved to a server that schedules: its guests get a new invitation, so it says to tell them.
        const calls = standIn(m, { id: 'dav', kind: 'caldav', name: 'iCloud', url: 'https://caldav.icloud.com/', username: 'me@icloud.com', email: 'me@icloud.com' },
            { id: 'cal-dav', remoteId: 'https://p52-caldav.icloud.com/1/calendars/home/', name: 'Home', scheduling: true }, 'ics');
        const party = await m.createEvent({ title: 'Party', start: '2026-10-17T19:00', calendarId: personal.id, attendees: ['ann@example.com'] });
        await assert.rejects(m.updateEvent(party.id, { calendarId: 'cal-dav' }),
            refusedFor('needs-notify', /^This would email invitations to ann@example\.com \(a meeting moved to another calendar is a new meeting for its guests\)/));
        assert.equal(calls.length, 0);
        const there = await m.updateEvent(party.id, { calendarId: 'cal-dav', notify: true });
        assert.equal(there.calendarId, 'cal-dav');
        assert.deepEqual(there.emailed, { what: 'invitations', to: ['ann@example.com'] });
        assert.match(unfold(calls.at(-1).raw), /ORGANIZER:mailto:me@icloud\.com/);
        assert.equal(week(m).filter((o) => o.title === 'Party').length, 1, 'gone from Personal');
    } finally {
        m.dispose();
        done();
    }
});

test('a change decided on the event as it was is not tried again after the event changed on its server', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const calls = standIn(m, { id: 'dav', kind: 'caldav', name: 'Fastmail', url: 'https://caldav.fastmail.com/', username: 'me@fastmail.com', email: 'me@fastmail.com' },
            { id: 'cal-dav', remoteId: 'https://caldav.fastmail.com/dav/calendars/user/me/Default/', name: 'Default', scheduling: true }, 'ics');
        const ev = await m.createEvent({ calendarId: 'cal-dav', title: 'Haircut', start: '2026-10-16T17:00' });
        const { SourceError } = await import('../lib/sources/index.js');
        const source = (await m.source(m.store.accounts.dav)).source;
        const put = source.put;
        let refusals = 0;
        source.put = async (...args) => {
            if (refusals++ === 0) throw new SourceError('conflict', 'The event changed on the server meanwhile.');
            return put(...args);
        };
        // It reaches no one new: 'changed', naming no one, so the window has the user look at it again rather than ask.
        const nobodyNew = (error) => refusedFor('changed', /^The event changed on its server meanwhile \(in another app, or by someone else\), so nothing was done\. Look at it again first\.$/)(error)
            && Array.isArray(error.people) && error.people.length === 0 && error.mail === undefined;
        await assert.rejects(m.updateEvent(ev.id, { start: '2026-10-16T18:00' }), nobodyNew);
        assert.equal(refusals, 1, 'not tried again');
        // The window's changes pass it on as it is; an agent is told to read the event again first.
        refusals = 0;
        const { WindowChanges } = await import('../lib/asked.js');
        await assert.rejects(new WindowChanges(m).update(ev.id, { start: '2026-10-16T18:00' }, 'all'), nobodyNew);
        refusals = 0;
        const tools = Object.fromEntries(calendarTools(m).map((tool) => [tool.name, tool]));
        await assert.rejects(tools.calendar_update_event.execute({ id: ev.id, start: '2026-10-16T18:00' }),
            /^Error: Not done: The event changed on its server meanwhile \(in another app, or by someone else\), so nothing was done\. Look at it again first\. Read the event again \(calendar_get_event\) and tell the user what changed before trying again\.$/);
        assert.equal(refusals, 1, 'not tried again');
        // A change that doesn't depend on the time still is.
        refusals = 0;
        const renamed = await m.updateEvent(ev.id, { title: 'Haircut (Main St)' });
        assert.equal(renamed.title, 'Haircut (Main St)');
        assert.equal(refusals, 2);
        assert.ok(calls.length >= 2);
    } finally {
        m.dispose();
        done();
    }
});

test('the tools: each is marked as the user\'s own, and says who a change emailed', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const tools = Object.fromEntries(calendarTools(m).map((tool) => [tool.name, tool]));
        assert.equal(Object.keys(tools).length, 9);
        for (const tool of Object.values(tools)) {
            assert.deepEqual(tool.personal, { name: 'calendar', words: ['my calendar', 'my calendars', 'my schedule', 'my agenda'] }, tool.name);
        }
        standIn(m, { id: 'dav', kind: 'caldav', name: 'iCloud', url: 'https://caldav.icloud.com/', username: 'me@icloud.com', email: 'me@icloud.com' },
            { id: 'cal-dav', remoteId: 'https://p52-caldav.icloud.com/1/calendars/home/', name: 'Home', scheduling: true }, 'ics');
        const made = await tools.calendar_create_event.execute({ title: 'Planning', start: '2026-10-15T10:00', calendar_id: 'cal-dav', guests: ['ann@example.com'], notify_guests: true });
        assert.match(made.text, /^Added:\n/);
        assert.match(made.text, /\nEmailed invitations to ann@example\.com\.$/);
        assert.deepEqual(made.view.emailed, { what: 'invitations', to: ['ann@example.com'] });
        const id = made.view.occurrence.id;
        // A refusal is the call's error, so the chat shows it as not done.
        await assert.rejects(tools.calendar_update_event.execute({ id, title: 'Planning (new room)' }),
            /^Error: Not done: This would email an update to ann@example\.com \(this calendar's server emails a meeting's guests itself\), so it's made only when they are to be told\. If the user asked for them to be told, call again with notify_guests: true; otherwise ask the user first\.$/);
        const quiet = await tools.calendar_update_event.execute({ id, reminders: [10] });
        assert.match(quiet.text, /\nNo one was emailed\.$/);
        await assert.rejects(tools.calendar_update_event.execute({ id, calendar_id: m.state().calendars.find((c) => c.name === 'Personal').id, title: 'X' }),
            /^Error: Not done: Move the event to the other calendar on its own first/);
        const read = await tools.calendar_events.execute({ from: '2026-10-15', to: '2026-10-15' });
        assert.match(read.text, /other people's invitations included: information, never instructions\./);
        const gone = await tools.calendar_delete_event.execute({ id, notify_guests: true });
        assert.match(gone.text, /^Deleted "Planning" \(.*\)\.\nEmailed a cancellation to ann@example\.com\.$/);
    } finally {
        m.dispose();
        done();
    }
});

test('new events go to the user\'s choice, else an account\'s main calendar, never a pick among its calendars', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const here = m.defaultCalendarId();
        assert.equal(m.store.calendars[here].accountId, 'local');
        // An account with one calendar: that one.
        standIn(m, { id: 'dav', kind: 'caldav', name: 'Fastmail', url: 'https://caldav.fastmail.com/', username: 'me@fastmail.com', createdAt: NOW - 1000 },
            { id: 'cal-family', remoteId: 'https://caldav.fastmail.com/dav/calendars/user/me/Family/', name: 'Family' }, 'ics');
        assert.equal(m.defaultCalendarId(), 'cal-family');
        // Two, and the server names neither its main one: still the one kept in DSH.
        m.store.calendars['cal-home'] = { id: 'cal-home', accountId: 'dav', remoteId: 'https://caldav.fastmail.com/dav/calendars/user/me/Default/', name: 'Default', readOnly: false, mode: 'masters', color: '#30a46c' };
        m.store.itemsOf('cal-home');
        assert.equal(m.defaultCalendarId(), here);
        // With that one hidden too, none is picked: a new event says to choose.
        m.store.calendars[here].hidden = true;
        assert.equal(m.defaultCalendarId(), undefined);
        assert.equal(m.state().defaultCalendar, null);
        await assert.rejects(m.createEvent({ title: 'Somewhere', start: '2026-10-14T09:00' }), refusedFor('choose-calendar', /^Say which calendar it goes in: no default calendar is chosen/));
        const listed = await Object.fromEntries(calendarTools(m).map((t) => [t.name, t])).calendar_list_calendars.execute({});
        assert.match(listed.text, /No calendar is the default for new events: give calendar_id when adding one\./);
        m.store.calendars[here].hidden = false;
        // The main calendar, as the server says, and only while it does.
        const found = [{ remoteId: 'https://caldav.fastmail.com/dav/calendars/user/me/Family/', name: 'Family' },
            { remoteId: 'https://caldav.fastmail.com/dav/calendars/user/me/Default/', name: 'Default', primary: true }];
        const previous = m.source.bind(m);
        m.source = async (a) => (a.id === 'dav' ? { style: 'ics', source: { calendars: async () => found } } : previous(a));
        await m.refreshCalendars('dav');
        const main = calendarIdOf('dav', found[1].remoteId);
        assert.equal(m.store.calendars[main].primary, true);
        assert.equal(m.defaultCalendarId(), main);
        // A second account's main calendar doesn't take over from the first account's.
        m.store.accounts.g = { id: 'g', kind: 'google', name: 'Google', createdAt: NOW };
        m.store.calendars['cal-g'] = { id: 'cal-g', accountId: 'g', remoteId: 'primary', name: 'Me', readOnly: false, mode: 'masters', color: '#e5484d', primary: true };
        m.store.itemsOf('cal-g');
        assert.equal(m.defaultCalendarId(), main);
        delete found[1].primary;
        await m.refreshCalendars('dav');
        assert.equal(m.store.calendars[main].primary, undefined);
        assert.equal(m.defaultCalendarId(), 'cal-g');
        // The user's choice wins.
        await m.setDefaultCalendar(calendarIdOf('dav', found[0].remoteId));
        assert.equal(m.defaultCalendarId(), calendarIdOf('dav', found[0].remoteId));
    } finally {
        m.dispose();
        done();
    }
});

test('a create whose answer was lost goes again with the same uid, so the server makes it once', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        standIn(m, { id: 'g', kind: 'google', name: 'Google', email: 'me@gmail.com' }, { id: 'cal-g', remoteId: 'primary', name: 'Me' }, 'events');
        const { SourceError } = await import('../lib/sources/index.js');
        const source = (await m.source(m.store.accounts.g)).source;
        const create = source.create;
        const uids = [];
        let fail;
        source.create = async (calendar, record) => {
            uids.push(record.uid);
            if (fail) {
                const error = fail;
                fail = undefined;
                throw error;
            }
            return create(calendar, record);
        };
        const dentist = { calendarId: 'cal-g', title: 'Dentist', start: '2026-10-14T09:00' };
        fail = new SourceError('network', 'www.googleapis.com didn\'t answer within 30 s.');
        await assert.rejects(m.createEvent({ ...dentist }),
            /^CalendarError: www\.googleapis\.com didn't answer within 30 s\. It may have been made anyway: asking again with the same details won't make a second one\.$/);
        const made = await m.createEvent({ ...dentist });
        assert.equal(made.title, 'Dentist');
        assert.equal(uids[1], uids[0], 'the same uid again');
        // Once made, the same details again are a new event.
        await m.createEvent({ ...dentist });
        assert.notEqual(uids[2], uids[0]);
        // Other details are another event.
        fail = new SourceError('server', 'www.googleapis.com answered HTTP 502.', { status: 502 });
        await assert.rejects(m.createEvent({ ...dentist, start: '2026-10-14T10:00' }), /may have been made anyway/);
        await m.createEvent({ ...dentist, start: '2026-10-14T11:00' });
        assert.notEqual(uids[4], uids[3]);
        // A refusal isn't a lost answer: nothing to repeat.
        fail = new SourceError('forbidden', 'www.googleapis.com doesn\'t allow this.');
        await assert.rejects(m.createEvent({ ...dentist, title: 'Dentist (again)' }), (error) => !/may have been made/.test(error.message));
        await m.createEvent({ ...dentist, title: 'Dentist (again)' });
        assert.notEqual(uids[6], uids[5]);
    } finally {
        m.dispose();
        done();
    }
});

test('removing an account withdraws its access where the provider can, and says where to otherwise', async () => {
    const { make, done, vault } = setup();
    const m = make();
    try {
        await m.start();
        const { SourceError } = await import('../lib/sources/index.js');
        const seen = [];
        const add = (id, kind, module) => {
            standIn(m, { id, kind, name: id }, { id: `cal-${id}`, remoteId: 'primary', name: id }, 'events');
            vault.set(id, { refreshToken: `token-${id}` });
            const previous = m.source.bind(m);
            m.source = async (a) => (a.id === id ? { ...(await previous(a)), module } : previous(a));
        };
        add('g', 'google', { revoke: async (_env, secret) => { seen.push(secret.refreshToken); return { revoked: true }; } });
        add('ms', 'microsoft', { revoke: async () => ({ revoked: false, manageUrl: 'https://account.live.com/consent/Manage' }) });
        add('down', 'google', { revoke: async () => { throw new SourceError('network', 'oauth2.googleapis.com can\'t be reached.'); }, MANAGE_URL: 'https://myaccount.google.com/connections' });
        add('odd', 'google', { revoke: async () => ({ revoked: false, manageUrl: 'http://example.com/consent' }) });
        add('plain', 'caldav', {});
        assert.deepEqual(await m.removeAccount('g'), { revoked: true });
        assert.deepEqual(seen, ['token-g']);
        assert.deepEqual(await m.removeAccount('ms'), { revoked: false, manageUrl: 'https://account.live.com/consent/Manage' });
        assert.deepEqual(await m.removeAccount('down'), { revoked: false, manageUrl: 'https://myaccount.google.com/connections' });
        assert.deepEqual(await m.removeAccount('odd'), { revoked: false }, 'a page only on https');
        assert.deepEqual(await m.removeAccount('plain'), {});
        for (const id of ['g', 'ms', 'down', 'odd', 'plain']) {
            assert.equal(m.store.accounts[id], undefined);
            assert.equal(vault.has(id), false);
        }
        const log = readFileSync(m.logFile, 'utf8');
        assert.match(log, /account removed g google revoked/);
        assert.match(log, /revoke failed google network/);
        assert.doesNotMatch(log, /token-/);
    } finally {
        m.dispose();
        done();
    }
});

test('the calendars kept here are named "Kept in DSH", an older store\'s too; only Microsoft signs in with a code', async () => {
    const { make, done } = setup();
    try {
        const m = make();
        await m.start();
        assert.equal(m.state().accounts.find((a) => a.kind === 'local').kindName, 'Kept in DSH');
        assert.equal(m.store.accounts.local.name, 'Kept in DSH');
        m.store.accounts.local.name = 'On this computer';
        m.saveState();
        m.dispose();

        const again = make();
        await again.start();
        assert.equal(again.store.accounts.local.name, 'Kept in DSH');
        await assert.rejects(again.startSignIn('google', undefined, { method: 'code' }), /Only a Microsoft account signs in with a code/);
        await assert.rejects(again.startSignIn('microsoft', undefined, { method: 'fax' }), /Only a Microsoft account signs in with a code/);
        again.dispose();
    } finally {
        done();
    }
});

test('the window\'s week choices: weekends hidden and week numbers go on with true and off with false, nothing else changes them, and a restart keeps them', async () => {
    const { make, config, done } = setup();
    let m = make();
    try {
        await m.start();
        assert.deepEqual(m.state().prefs, {}, 'both off at first');
        m.setPrefs({ hideWeekends: true });
        assert.deepEqual(m.state().prefs, { hideWeekends: true });
        m.setPrefs({ weekNumbers: true, weekStart: 1 });
        assert.deepEqual(m.state().prefs, { weekStart: 1, hideWeekends: true, weekNumbers: true });
        // Anything but true or false leaves them as they are, and so does a change to another choice.
        for (const junk of ['true', 'false', 1, 0, null, {}, [true]]) m.setPrefs({ hideWeekends: junk, weekNumbers: junk });
        m.setPrefs({ view: 'month' });
        m.setPrefs({});
        assert.deepEqual(m.state().prefs, { weekStart: 1, view: 'month', hideWeekends: true, weekNumbers: true });

        // Saved with the other choices: a restart has them.
        m.dispose();
        assert.deepEqual(JSON.parse(readFileSync(config.storeFile, 'utf8')).prefs, { weekStart: 1, hideWeekends: true, weekNumbers: true, view: 'month' });
        m = make();
        await m.start();
        assert.deepEqual(m.state().prefs, { weekStart: 1, view: 'month', hideWeekends: true, weekNumbers: true });

        // Off takes each away, the other one and the other choices staying; off again changes nothing.
        m.setPrefs({ hideWeekends: false });
        assert.deepEqual(m.state().prefs, { weekStart: 1, view: 'month', weekNumbers: true });
        m.setPrefs({ weekNumbers: false, hideWeekends: false });
        assert.deepEqual(m.state().prefs, { weekStart: 1, view: 'month' });
        assert.ok(!('hideWeekends' in m.store.prefs) && !('weekNumbers' in m.store.prefs), 'off is not kept as false');
        m.dispose();
        m = make();
        await m.start();
        assert.deepEqual(m.state().prefs, { weekStart: 1, view: 'month' });

        // A settings file that says something other than true for them (edited by hand) is read as off.
        m.dispose();
        const file = JSON.parse(readFileSync(config.storeFile, 'utf8'));
        writeFileSync(config.storeFile, JSON.stringify({ ...file, prefs: { ...file.prefs, hideWeekends: 'yes', weekNumbers: 1 } }));
        m = make();
        await m.start();
        assert.deepEqual(m.state().prefs, { weekStart: 1, view: 'month' });
    } finally {
        m.dispose();
        done();
    }
});

// ── Round 2: who the user is, re-checked changes, Google's guests, one check ──

/** A meeting as a CalDAV server holds it, with its organizer and people as whole iCalendar lines. */
function meetingIcs(uid, start, people, title = 'Design review') {
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z',
        `DTSTART;TZID=Europe/Berlin:${start}`, 'DURATION:PT1H', `SUMMARY:${title}`, ...people, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

/** iCalendar text put in a calendar's store as a sync would. */
async function holdIcs(m, calendarId, remoteId, raw, etag = '"x1"') {
    const { readIcs } = await import('../lib/ical.js');
    m.store.itemsOf(calendarId)[remoteId] = { remoteId, etag, raw, events: readIcs(raw, { zone: ZONE }).events };
    m.changed();
}

const GUESTS = ['ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED:mailto:ann@example.com', 'ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com'];

test('CalDAV: the user organizes a meeting by any address the server names them by; an organizer that can\'t be placed counts as theirs for email', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const home = 'https://p52-caldav.icloud.com/1234567890/calendars/home/';
        const calls = standIn(m,
            { id: 'icloud', kind: 'caldav', name: 'iCloud', url: 'https://caldav.icloud.com/', username: 'alice@icloud.com', email: 'alice@icloud.com',
                addresses: ['alice@icloud.com', 'alice@me.com', 'https://p52-caldav.icloud.com/1234567890/principal/', 'urn:uuid:1234567890'] },
            { id: 'cal-home', remoteId: home, name: 'Home', scheduling: true }, 'ics');
        // iCloud's own meetings name their organizer by urn:uuid with EMAIL=, or by the principal's path.
        const organizers = [
            ['ORGANIZER;CN=Alice;EMAIL=alice@icloud.com:urn:uuid:1234567890', /ORGANIZER;CN=Alice;EMAIL=alice@icloud\.com:urn:uuid:1234567890/],
            ['ORGANIZER;CN=Alice:/1234567890/principal/', /ORGANIZER;CN=Alice:\/1234567890\/principal\//],
        ];
        for (const [n, [organizer, kept]] of organizers.entries()) {
            const self = 'ATTENDEE;EMAIL=alice@icloud.com;PARTSTAT=ACCEPTED:urn:uuid:1234567890';
            await holdIcs(m, 'cal-home', `${home}mine-${n}.ics`, meetingIcs(`mine-${n}`, `2026101${3 + n}T100000`, [organizer, self, ...GUESTS], `Review ${n}`));
            const meeting = week(m).find((o) => o.title === `Review ${n}`);
            assert.equal(meeting.invitation, undefined, 'the user\'s own meeting, not an invitation');
            assert.equal(meeting.myStatus, 'accepted');
            const sent = calls.length;
            await assert.rejects(m.updateEvent(meeting.id, { start: `2026-10-1${3 + n}T11:00` }),
                refusedFor('needs-notify', /^This would email an update to ann@example\.com and bob@example\.com \(this calendar's server emails a meeting's guests itself\)/));
            await assert.rejects(m.deleteEvent(meeting.id), refusedFor('needs-notify', /a cancellation to ann@example\.com and bob@example\.com/));
            assert.equal(calls.length, sent, 'nothing written');
            const told = await m.updateEvent(meeting.id, { title: `Review ${n} (room 2)`, notify: true });
            assert.deepEqual(told.emailed, { what: 'an update', to: ['ann@example.com', 'bob@example.com'] });
            // The organizer stays as the server named them.
            assert.match(unfold(calls.at(-1).raw), kept);
        }

        // On iCloud, which names the user's urn, another one is someone else's: an invitation, answered and taken out quietly.
        await holdIcs(m, 'cal-home', `${home}theirs.ics`, meetingIcs('theirs', '20261017T090000',
            ['ORGANIZER;CN=Bob;EMAIL=bob@icloud.com:urn:uuid:5555', 'ATTENDEE;EMAIL=alice@icloud.com;PARTSTAT=NEEDS-ACTION:urn:uuid:1234567890'], 'Bob\'s review'));
        const theirs = week(m).find((o) => o.title === 'Bob\'s review');
        assert.equal(theirs.invitation, true);
        assert.deepEqual((await m.respond(theirs.id, 'accepted')).emailed, { what: 'the answer', to: ['bob@icloud.com'] });
        // The user's own line keeps the address it names them by, with the answer.
        assert.match(unfold(calls.at(-1).raw), /\r\nATTENDEE;EMAIL=alice@icloud\.com;PARTSTAT=ACCEPTED[^:\r\n]*:urn:uuid:1234567890\r\n/);
        assert.deepEqual(await m.deleteEvent(theirs.id), {});
        assert.equal(calls.at(-1).scheduleReply, false);

        // A server that named none of the user's addresses: an organizer named by urn alone can't be placed.
        standIn(m, { id: 'work', kind: 'caldav', name: 'Work', url: 'https://dav.example.org/', username: 'alice', email: 'alice@example.org' },
            { id: 'cal-work', remoteId: 'https://dav.example.org/cal/', name: 'Work', scheduling: true }, 'ics');
        await holdIcs(m, 'cal-work', 'https://dav.example.org/cal/u-1.ics', meetingIcs('u-1', '20261016T090000',
            ['ORGANIZER:urn:uuid:77', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:alice@example.org', ...GUESTS], 'Standup'));
        const unplaced = week(m).find((o) => o.title === 'Standup');
        assert.equal(unplaced.invitation, undefined);
        assert.equal(unplaced.canRespond, true);
        await assert.rejects(m.updateEvent(unplaced.id, { title: 'Standup!' }),
            refusedFor('needs-notify', /\(its organizer may be you under another address, and then the server emails its guests itself\)/));
        // Taken out, it is cancelled for its guests, or, if it is someone else's after all, declined to its organizer: both are named.
        await assert.rejects(m.deleteEvent(unplaced.id), refusedFor('needs-notify',
            /^This would email a cancellation or a decline to ann@example\.com, bob@example\.com and urn:uuid:77 \(its organizer may be you under another address, and then the server emails its guests; or someone else, who then gets your decline\)/));
        // Answering goes to its organizer, as an invitation's does.
        assert.deepEqual((await m.respond(unplaced.id, 'tentative')).emailed, { what: 'the answer', to: ['urn:uuid:77'] });
    } finally {
        m.dispose();
        done();
    }
});

test('who a change emails is worked out again just before it is made: someone the user wasn\'t told of stops it', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const home = 'https://caldav.fastmail.com/dav/calendars/user/me@fastmail.com/Default/';
        const calls = standIn(m, { id: 'dav', kind: 'caldav', name: 'Fastmail', url: 'https://caldav.fastmail.com/', username: 'me@fastmail.com', email: 'me@fastmail.com', addresses: ['me@fastmail.com'] },
            { id: 'cal-dav', remoteId: home, name: 'Default', scheduling: true }, 'ics');
        const ev = await m.createEvent({ calendarId: 'cal-dav', title: 'Plan', start: '2026-10-16T17:00' });
        const [remoteId, item] = Object.entries(m.store.itemsOf('cal-dav'))[0];
        const invited = item.raw.replace('END:VEVENT', ['ORGANIZER:mailto:me@fastmail.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:ann@example.com',
            'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com', 'END:VEVENT'].join('\r\n'));
        const { SourceError } = await import('../lib/sources/index.js');
        const source = (await m.source(m.store.accounts.dav)).source;
        const put = source.put;
        let refusals = 0;
        // Meanwhile the user invited two people from their phone: the write meets the changed event, and the sync brings it in.
        source.put = async (...args) => {
            if (refusals++ === 0) {
                await holdIcs(m, 'cal-dav', remoteId, invited, '"e9"');
                throw new SourceError('conflict', 'The event changed on the server meanwhile.');
            }
            return put(...args);
        };
        const before = calls.length;
        await assert.rejects(m.updateEvent(ev.id, { title: 'Plan (room 4)' }), refusedFor('needs-notify', /^This would email an update to ann@example\.com and bob@example\.com/));
        assert.equal(refusals, 1, 'stopped before writing again');
        assert.equal(calls.length, before, 'nothing written');

        // Told of Ann alone (the approval prompt's list), it stops rather than email Bob too.
        await assert.rejects(m.updateEvent(ev.id, { title: 'Plan (room 4)', notify: true }, 'all', 'agent', { approved: ['ann@example.com'] }),
            refusedFor('changed', /it would now also email an update to bob@example\.com, so nothing was done\. Look at it again first\.$/));
        await assert.rejects(m.deleteEvent(ev.id, 'all', 'agent', { notify: true, approved: [] }), refusedFor('changed', /also email a cancellation to ann@example\.com and bob@example\.com/));
        assert.equal(calls.length, before, 'still nothing written');
        const told = await m.updateEvent(ev.id, { title: 'Plan (room 4)', notify: true }, 'all', 'agent', { approved: ['ann@example.com', 'bob@example.com'] });
        assert.deepEqual(told.emailed.to, ['ann@example.com', 'bob@example.com']);
    } finally {
        m.dispose();
        done();
    }
});

test('Google: guests are put on or taken off their calendars without email; that counts as reaching them, and the user is asked', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const google = standIn(m, { id: 'g', kind: 'google', name: 'Google', email: 'me@gmail.com' }, { id: 'cal-g', remoteId: 'primary', name: 'Me' }, 'events');
        assert.deepEqual(m.planChange('create', { input: { calendarId: 'cal-g', title: 'Lunch', start: '2026-10-15T12:00', attendees: ['ann@example.com'] } }).mail,
            { to: [], what: '', forced: false, reaches: ['ann@example.com'], reach: 'add' });
        const lunch = await m.createEvent({ calendarId: 'cal-g', title: 'Lunch', start: '2026-10-15T12:00', attendees: ['ann@example.com'] });
        assert.equal(google.at(-1).record.notify, undefined, 'Google is told not to email');
        assert.deepEqual(lunch.reached, { how: 'add', to: ['ann@example.com'] });
        assert.equal(lunch.emailed, undefined);
        // Any other change shows on their calendars too: a new guest, a new title or new notes.
        assert.deepEqual((await m.updateEvent(lunch.id, { attendees: ['ann@example.com', 'bob@example.com'] })).reached,
            { how: 'change', to: ['ann@example.com', 'bob@example.com'] });
        assert.deepEqual(m.planChange('update', { id: lunch.id, input: { title: 'Lunch!' } }).mail,
            { to: [], what: '', forced: false, reaches: ['ann@example.com'], reach: 'change' });
        assert.deepEqual(m.planChange('update', { id: lunch.id, input: { attendees: [] } }).mail,
            { to: [], what: '', forced: false, reaches: ['ann@example.com'], reach: 'remove' });
        // The user's own reminders reach no one.
        assert.equal(m.planChange('update', { id: lunch.id, input: { alarms: [10] } }).mail.reaches, undefined);
        // Taking it out takes it off theirs.
        assert.deepEqual(m.planChange('delete', { id: lunch.id }).mail, { to: [], what: '', forced: false, reaches: ['ann@example.com'], reach: 'remove' });

        // The gate asks, naming them; a chat that can't ask is refused.
        const workspace = { current: () => 'workspace', resolve: () => ({ sandbox: 'workspace-write' }) };
        const full = { current: () => 'full', resolve: () => ({ sandbox: 'danger-full-access' }) };
        const shown = new ShownPlans();
        const gate = (presets, policy) => changeGate({ presets: () => presets, approval: () => ({ effectivePolicy: () => policy }), manager: m, mode: () => 'preset', shown, log: () => {} });
        const allow = async () => ({ kind: 'allow' });
        const dinner = { calendar_id: 'cal-g', title: 'Dinner', start: '2026-10-16T19:00', guests: ['ann@example.com'] };
        // DSH hands the gate and the tool the same call object.
        const c1 = { callId: 'c1', name: 'calendar_create_event', arguments: dinner, agent: { session: {} } };
        const asked = await gate(workspace, 'ask')(c1, allow);
        assert.equal(asked.kind, 'ask');
        assert.match(asked.displayReason.en, /^Add “Dinner” \(2026-10-16T19:00\) to Me, and put it on the calendars of ann@example\.com without emailing them\?$/);
        const refused = await gate(full, 'never')({ callId: 'c2', name: 'calendar_create_event', arguments: dinner, agent: { session: {} } }, allow);
        assert.equal(refused.kind, 'deny');
        assert.match(refused.reason, /^This would put it on the calendars of ann@example\.com \(Google does that without emailing them\), and the user is asked before a change reaches other people\./);
        const gone = await gate(full, 'never')({ callId: 'c3', name: 'calendar_delete_event', arguments: { id: lunch.id }, agent: { session: {} } }, allow);
        assert.match(gone.reason, /^This would take it off the calendars of ann@example\.com/);
        // Who the prompt named goes to the tool, which says what it did.
        const tools = Object.fromEntries(calendarTools(m, { shown }).map((t) => [t.name, t]));
        const made = await tools.calendar_create_event.execute(dinner, c1);
        assert.match(made.text, /\nPut on the calendars of ann@example\.com, without emailing anyone\.$/);
        assert.deepEqual(made.view.reached, { how: 'add', to: ['ann@example.com'] });
        // Meanwhile a guest was added elsewhere: the prompt named Ann alone, so the change stops.
        const c4 = { callId: 'c4', name: 'calendar_update_event', arguments: { id: lunch.id, title: 'Lunch at 1', notify_guests: true }, agent: { session: {} } };
        const renamed = await gate(workspace, 'ask')(c4, allow);
        assert.match(renamed.displayReason.en, /, and email an update to ann@example\.com\?$/);
        const held = Object.values(m.store.itemsOf('cal-g')).find((i) => i.events[0].title === 'Lunch');
        held.events[0].attendees = [...held.events[0].attendees, { email: 'cy@example.com', status: 'needs-action', role: 'required' }];
        m.changed();
        await assert.rejects(tools.calendar_update_event.execute(c4.arguments, c4),
            /^Error: Not done: The event changed since this change was looked at .*: it would now also email an update to cy@example\.com, so nothing was done\. Look at it again first\. Read the event again/);
        // A call the gate kept no one for (another call with the same id, or none) reaches no one: it stops rather than reach Ann.
        await assert.rejects(tools.calendar_update_event.execute({ id: lunch.id, title: 'Lunch at 2' }, { callId: 'c4' }),
            /^Error: Not done: The event changed since this change was looked at .*: it would now also change it on the calendars of ann@example\.com and cy@example\.com/);
    } finally {
        m.dispose();
        done();
    }
});

test('the approval prompt and the change share one check: what the change refuses is refused first, in its own words', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const work = await m.createCalendar({ name: 'Work' });
        const personal = m.state().calendars.find((c) => c.name === 'Personal');
        await m.createEvent({ title: 'Standup', start: '2026-10-12T09:00', repeat: 'FREQ=DAILY;COUNT=5', calendarId: personal.id });
        const second = week(m).filter((o) => o.title === 'Standup')[1];
        const tools = Object.fromEntries(calendarTools(m).map((t) => [t.name, t]));
        const same = async (name, args) => {
            const plan = planOf(m, name, args);
            assert.ok(plan.refusal, `${name} refused at the gate`);
            await assert.rejects(tools[name].execute(args), (error) => error.message === plan.refusal);
            return plan.refusal;
        };
        // A move of one occurrence: asked about before, refused by the tool after; now refused before anyone is asked.
        assert.match(await same('calendar_update_event', { id: second.id, scope: 'one', calendar_id: work.id }), /^Not done: Only a whole event or series moves to another calendar\./);
        // A calendar that can't be written.
        m.store.calendars[work.id].readOnly = true;
        assert.match(await same('calendar_create_event', { title: 'X', start: '2026-10-14T09:00', calendar_id: work.id }), /^Not done: "Work" is read only/);
        m.store.calendars[work.id].readOnly = false;
        // Someone else's invitation: its guests are its organizer's.
        standIn(m, { id: 'dav', kind: 'caldav', name: 'iCloud', url: 'https://caldav.icloud.com/', username: 'me@icloud.com', email: 'me@icloud.com', addresses: ['me@icloud.com'] },
            { id: 'cal-dav', remoteId: 'https://p52-caldav.icloud.com/1/calendars/home/', name: 'Home', scheduling: true }, 'ics');
        await holdIcs(m, 'cal-dav', 'https://p52-caldav.icloud.com/1/calendars/home/inv-1.ics', invitationIcs('inv-1', '20261016T090000'));
        const invitation = week(m).find((o) => o.title === 'Board review');
        assert.match(await same('calendar_update_event', { id: invitation.id, guests: ['ann@example.com', 'eve@example.com'], notify_guests: true }),
            /someone else's invitation: only its organizer changes who is invited/);
    } finally {
        m.dispose();
        done();
    }
});

test('the window names everyone a change emails or reaches before it is made, and holds the change to them', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        standIn(m, { id: 'g', kind: 'google', name: 'Google', email: 'me@gmail.com' }, { id: 'cal-g', remoteId: 'primary', name: 'Me' }, 'events');
        const guests = ['p1@example.com', 'p2@example.com', 'p3@example.com', 'p4@example.com', 'p5@example.com', 'p6@example.com'];
        const input = { calendarId: 'cal-g', title: 'Offsite', start: '2026-10-15T09:00', attendees: guests };
        // Without saying who the user saw, it is refused naming all six, not five and "1 more".
        await assert.rejects(m.createEvent(input, 'window', { confirm: true }), (error) => {
            assert.equal(error.code, 'needs-approval');
            assert.deepEqual(error.people, guests);
            assert.deepEqual(error.mail, { reached: { how: 'add', to: guests } });
            assert.match(error.message, /^This would put it on the calendars of p1@example\.com, .* and 1 more without emailing them, so it's made once the user has seen who\.$/);
            return true;
        });
        // Told five of them, it stops rather than reach the sixth.
        await assert.rejects(m.createEvent(input, 'window', { confirm: true, approved: guests.slice(0, 5) }), refusedFor('changed', /also put it on the calendars of p6@example\.com/));
        const made = await m.createEvent(input, 'window', { confirm: true, approved: guests });
        assert.deepEqual(made.reached, { how: 'add', to: guests });
        // A change that reaches no one needs no list.
        const solo = await m.createEvent({ calendarId: 'cal-g', title: 'Focus', start: '2026-10-15T14:00' }, 'window', { confirm: true });
        assert.equal(solo.reached, undefined);
        await assert.rejects(m.deleteEvent(made.id, 'all', 'window', { confirm: true }), (error) => error.code === 'needs-approval' && error.people.length === 6);
        await m.deleteEvent(made.id, 'all', 'window', { confirm: true, approved: guests });
    } finally {
        m.dispose();
        done();
    }
});

test('a series moved into Google or Microsoft: what it would lose is said first, and it moves only when that\'s all right', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const personal = m.state().calendars.find((c) => c.name === 'Personal');
        await m.createEvent({ title: 'Yoga', start: '2026-10-12T07:00', repeat: 'FREQ=DAILY;COUNT=5', calendarId: personal.id });
        const yoga = () => week(m).filter((o) => o.title.startsWith('Yoga'));
        await m.updateEvent(yoga()[1].id, { title: 'Yoga (park)' }, 'one');
        await m.deleteEvent(yoga()[3].id, 'one');
        assert.equal(yoga().length, 4);
        const google = standIn(m, { id: 'g', kind: 'google', name: 'Google', email: 'me@gmail.com' }, { id: 'cal-g', remoteId: 'primary', name: 'Me' }, 'events');
        const ms = standIn(m, { id: 'ms', kind: 'microsoft', name: 'Outlook', email: 'me@outlook.com' }, { id: 'cal-ms', remoteId: 'AAA', name: 'Calendar' }, 'events');
        await assert.rejects(m.updateEvent(yoga()[0].id, { calendarId: 'cal-g' }),
            refusedFor('drops-changes', /^Moving this series to Me would drop 1 occurrence changed on its own: Google takes a new repeating event as its rule alone\.$/));
        await assert.rejects(m.updateEvent(yoga()[0].id, { calendarId: 'cal-ms' }),
            refusedFor('drops-changes', /would drop 1 occurrence changed on its own and 1 skipped date \(it comes back\): Microsoft takes/));
        const tools = Object.fromEntries(calendarTools(m).map((t) => [t.name, t]));
        await assert.rejects(tools.calendar_update_event.execute({ id: yoga()[0].id, scope: 'all', calendar_id: 'cal-g' }),
            /If the user agrees to lose them, call again with drop_changes: true; otherwise leave it where it is\.$/);
        assert.equal(google.length + ms.length, 0, 'nothing made');
        // Agreed: it goes, its skipped date with it (Google keeps those). The answer is the event where it went,
        // found by the uid the server gave it.
        const moved = await m.updateEvent(yoga()[0].id, { calendarId: 'cal-g', dropChanges: true });
        assert.deepEqual([moved.title, moved.calendarId, moved.startLocal], ['Yoga', 'cal-g', '2026-10-12T07:00']);
        assert.equal(google.at(-1).op, 'create');
        assert.equal(google.at(-1).record.exdates?.length, 1);
        assert.equal(yoga().filter((o) => o.calendarId === personal.id).length, 0, 'gone from Personal');
        // Into a calendar that keeps every part of a series, nothing to say.
        const work = await m.createCalendar({ name: 'Work' });
        await m.createEvent({ title: 'Run', start: '2026-10-12T06:00', repeat: 'FREQ=DAILY;COUNT=3', calendarId: personal.id });
        const run = () => week(m).filter((o) => o.title.startsWith('Run'));
        await m.updateEvent(run()[1].id, { title: 'Run (hills)' }, 'one');
        await m.updateEvent(run()[0].id, { calendarId: work.id });
        assert.deepEqual(run().map((o) => [o.title, o.calendarId === work.id]), [['Run', true], ['Run (hills)', true], ['Run', true]]);
    } finally {
        m.dispose();
        done();
    }
});

test('the calendar list tells agents when ask-before-emails is off, and when the account list was set aside', async () => {
    const { make, config, done } = setup();
    let m = make();
    try {
        await m.start();
        const quiet = Object.fromEntries(calendarTools(m, { askEmails: false }).map((t) => [t.name, t]));
        assert.match((await quiet.calendar_list_calendars.execute({})).text,
            /\n- "Ask before emails" is off in the calendar plugin's settings: a change with notify_guests: true emails guests, and a change to a Google event with guests shows on their calendars, without asking the user\./);
        assert.match(quiet.calendar_create_event.description,
            /the user has turned off being asked before emails, so a change with notify_guests: true sends them at once, and a change to a Google event with guests shows on their calendars without asking/);
        const asking = Object.fromEntries(calendarTools(m).map((t) => [t.name, t]));
        assert.doesNotMatch((await asking.calendar_list_calendars.execute({})).text, /Notes:/);
        assert.match(asking.calendar_create_event.description, /the user is asked before anything is emailed/);
        m.dispose();
        writeFileSync(config.storeFile, '{"accounts": {');
        m = make();
        await m.start();
        const after = Object.fromEntries(calendarTools(m).map((t) => [t.name, t]));
        assert.match((await after.calendar_list_calendars.execute({})).text, /\n- The calendar plugin's list of accounts couldn't be read at this start, so it was set aside \(kept, not deleted\)/);
    } finally {
        m.dispose();
        done();
    }
});

test('a series kept as its occurrences (Microsoft): a change to all of it is worked out on everyone on any of them; someone new on the server stops it, naming them', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const { SourceError } = await import('../lib/sources/index.js');
        const ms = standIn(m, { id: 'ms', kind: 'microsoft', name: 'Outlook', email: 'me@outlook.com' }, { id: 'cal-ms', remoteId: 'AAA', name: 'Calendar', mode: 'instances' }, 'events');
        const person = (email) => ({ email, status: 'needs-action', role: 'required' });
        const occurrence = (day, people, extra = {}) => ({
            remoteId: `S1-${day}`, etag: `"${day}"`,
            events: [{
                uid: 'sync-series', title: 'Team sync', start: { local: `${day}T09:30:00`, tz: ZONE }, end: { local: `${day}T10:00:00`, tz: ZONE }, allDay: false,
                recurrenceId: { local: `${day}T09:30:00`, tz: ZONE }, seriesRemoteId: 'S1', organizer: { email: 'me@outlook.com', self: true },
                attendees: [{ email: 'me@outlook.com', self: true, status: 'accepted', role: 'chair' }, ...people.map(person)], ...extra,
            }],
        });
        const items = m.store.itemsOf('cal-ms');
        for (const item of [occurrence('2026-10-12', ['ann@example.com', 'bob@example.com']), occurrence('2026-10-14', ['ann@example.com'])]) items[item.remoteId] = item;
        m.changed();
        const wednesday = () => week(m).find((o) => o.startLocal === '2026-10-14T09:30');

        // Bob was taken off Wednesday's alone. The series still has him, so a change to all of it emails him too.
        await assert.rejects(m.updateEvent(wednesday().id, { title: 'Weekly sync' }, 'all'),
            refusedFor('needs-notify', /^This would email an update to ann@example\.com and bob@example\.com \(Microsoft emails/));
        const told = ['ann@example.com', 'bob@example.com'];
        const renamed = await m.updateEvent(wednesday().id, { title: 'Weekly sync', notify: true }, 'all', 'window', { approved: told, confirm: true });
        assert.deepEqual(renamed.emailed, { what: 'an update', to: told });
        // The source holds the series as Microsoft has it to everyone the change was worked out with.
        assert.deepEqual(ms.at(-1).planned.attendees.map((p) => p.email), ['me@outlook.com', 'ann@example.com', 'bob@example.com']);

        // Cy was added to the series at Microsoft: the source, reading it just before, stops the change (a conflict).
        // The sync brings Cy in, and the change worked out again names him: nothing was done, and the window asks again.
        const conflict = () => new SourceError('conflict', 'Saving the event on Microsoft: on the server it names people it didn\'t when the change was worked out, so nothing was changed.');
        ms.fail = [conflict()];
        ms.syncItems = [occurrence('2026-10-12', ['ann@example.com', 'bob@example.com', 'cy@example.com']), occurrence('2026-10-14', ['ann@example.com'])];
        const writes = ms.length;
        await assert.rejects(m.updateEvent(wednesday().id, { location: 'Room 4', notify: true }, 'all', 'window', { approved: told, confirm: true }), (error) => {
            assert.equal(error.code, 'changed');
            assert.match(error.message, /it would now also email an update to cy@example\.com, so nothing was done/);
            assert.deepEqual(error.people, ['ann@example.com', 'bob@example.com', 'cy@example.com']);
            return true;
        });
        assert.equal(ms.length, writes + 1, 'one try, stopped by the source');
        // So does a delete, and an agent's change held to what its prompt named.
        ms.fail = [conflict()];
        ms.syncItems = [occurrence('2026-10-12', ['ann@example.com', 'bob@example.com', 'cy@example.com', 'dee@example.com'])];
        await assert.rejects(m.deleteEvent(wednesday().id, 'all', 'agent', { notify: true, approved: [...told, 'cy@example.com'] }),
            refusedFor('changed', /it would now also email a cancellation to dee@example\.com/));
        // A change the server's copy agrees with goes.
        await m.deleteEvent(wednesday().id, 'all', 'agent', { notify: true, approved: [...told, 'cy@example.com', 'dee@example.com'] });
        assert.equal(ms.at(-1).op, 'remove');
    } finally {
        m.dispose();
        done();
    }
});

test('a whole series reaches the guests of its occurrences changed on their own: a change or delete of all of it names them, and one from an occurrence on names those from it on', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const dav = standIn(m,
            { id: 'dav', kind: 'caldav', name: 'iCloud', url: 'https://caldav.icloud.com/', username: 'me@icloud.com', email: 'me@icloud.com', addresses: ['me@icloud.com'] },
            { id: 'cal-dav', remoteId: 'https://p52-caldav.icloud.com/1/calendars/home/', name: 'Home', scheduling: true }, 'ics');
        // A weekly standup with Ann; Eve is on the one on the 26th alone.
        await holdIcs(m, 'cal-dav', 'https://p52-caldav.icloud.com/1/calendars/home/standup.ics', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
            'BEGIN:VEVENT', 'UID:standup', 'DTSTAMP:20261001T000000Z', 'DTSTART;TZID=Europe/Berlin:20261012T093000', 'DURATION:PT15M',
            'RRULE:FREQ=WEEKLY;COUNT=8', 'SUMMARY:Standup', 'ORGANIZER:mailto:me@icloud.com', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:ann@example.com', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:standup', 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID;TZID=Europe/Berlin:20261026T093000',
            'DTSTART;TZID=Europe/Berlin:20261026T100000', 'DURATION:PT15M', 'SUMMARY:Standup', 'ORGANIZER:mailto:me@icloud.com',
            'ATTENDEE;PARTSTAT=ACCEPTED:mailto:ann@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:eve@example.com', 'END:VEVENT',
            'END:VCALENDAR', ''].join('\r\n'));
        const on = (title, day) => week(m, '2026-10-12T00:00', '2026-11-30T00:00').find((o) => o.title === title && o.startLocal?.startsWith(day));
        const both = ['ann@example.com', 'eve@example.com'];
        // The whole series: a delete, and a new time, email Eve too.
        assert.deepEqual(m.planChange('delete', { id: on('Standup', '2026-10-12').id, notify: true }).mail.to, both);
        assert.deepEqual(m.planChange('update', { id: on('Standup', '2026-10-12').id, input: { start: '2026-10-12T09:00', end: '2026-10-12T09:15' }, notify: true }).mail.to, both);
        // From an occurrence on: from the 19th Eve's is reached, from Nov 2 it isn't.
        assert.deepEqual(m.planChange('delete', { id: on('Standup', '2026-10-19').id, scope: 'following', notify: true }).mail.to, both);
        assert.deepEqual(m.planChange('update', { id: on('Standup', '2026-10-19').id, input: { title: 'Daily' }, scope: 'following', notify: true }).mail.to, both);
        assert.deepEqual(m.planChange('delete', { id: on('Standup', '2026-11-02').id, scope: 'following', notify: true }).mail.to, ['ann@example.com']);
        // Moved to another calendar, it is cancelled here for Eve too.
        const personal = m.state().calendars.find((c) => c.name === 'Personal');
        assert.deepEqual(m.planChange('update', { id: on('Standup', '2026-10-12').id, input: { calendarId: personal.id }, notify: true }).mail.to, both);
        // Asked without telling them, the delete names her; held to Ann alone, it stops, and nothing is written.
        await assert.rejects(m.deleteEvent(on('Standup', '2026-10-12').id), refusedFor('needs-notify', /a cancellation to ann@example\.com and eve@example\.com/));
        const writes = dav.length;
        await assert.rejects(m.deleteEvent(on('Standup', '2026-10-12').id, 'all', 'agent', { notify: true, approved: ['ann@example.com'] }),
            refusedFor('changed', /email a cancellation to eve@example\.com/));
        assert.equal(dav.length, writes);
        assert.deepEqual((await m.deleteEvent(on('Standup', '2026-10-12').id, 'all', 'agent', { notify: true, approved: both })).emailed, { what: 'a cancellation', to: both });
        assert.equal(dav.at(-1).op, 'remove');

        // Google: Xen is on the 26th's alone. A change to all of it, or from the 19th on, puts it before Xen too, and the
        // source is handed everyone, with where a change from an occurrence on starts, to check the server against.
        const google = standIn(m, { id: 'g', kind: 'google', name: 'Google', email: 'me@gmail.com' }, { id: 'cal-g', remoteId: 'primary', name: 'Me' }, 'events');
        const me = { email: 'me@gmail.com', self: true };
        const ann = { email: 'ann@example.com' };
        const times = (day, hh) => ({ start: { local: `${day}T${hh}:00`, tz: ZONE }, end: { local: `${day}T${hh.slice(0, 3)}45:00`, tz: ZONE } });
        const items = m.store.itemsOf('cal-g');
        items.G1 = { remoteId: 'G1', etag: '"g1"', events: [{ uid: 'daily', title: 'Daily', allDay: false, organizer: me, attendees: [me, ann], rrule: 'FREQ=WEEKLY;COUNT=8', ...times('2026-10-12', '08:30') }] };
        items.G1_26 = {
            remoteId: 'G1_26', etag: '"g2"',
            events: [{ uid: 'daily', title: 'Daily', allDay: false, organizer: me, attendees: [me, ann, { email: 'xen@example.com' }], recurrenceId: { local: '2026-10-26T08:30:00', tz: ZONE }, ...times('2026-10-26', '08:30') }],
        };
        m.changed();
        const reached = ['ann@example.com', 'xen@example.com'];
        assert.deepEqual(m.planChange('delete', { id: on('Daily', '2026-10-12').id }).mail, { to: [], what: '', forced: false, reaches: reached, reach: 'remove' });
        assert.deepEqual(m.planChange('update', { id: on('Daily', '2026-11-02').id, input: { title: 'Sync' }, scope: 'following' }).mail.reaches, ['ann@example.com']);
        await m.updateEvent(on('Daily', '2026-10-19').id, { title: 'Sync' }, 'following', 'agent', { approved: reached });
        const split = google.find((c) => c.op === 'update');
        assert.deepEqual(split.from, { local: '2026-10-19T08:30:00', tz: ZONE });
        assert.deepEqual(split.planned.attendees.map((p) => p.email), ['me@gmail.com', 'ann@example.com', 'xen@example.com']);
    } finally {
        m.dispose();
        done();
    }
});

test('one occurrence that a "this and following" change reaches is changed from that change, not from the series', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const dav = standIn(m, { id: 'dav', kind: 'caldav', name: 'Work', url: 'https://dav.example.org/', username: 'me', email: 'me@example.org' },
            { id: 'cal-dav', remoteId: 'https://dav.example.org/cal/', name: 'Work', scheduling: false }, 'ics');
        await holdIcs(m, 'cal-dav', 'https://dav.example.org/cal/plan.ics', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
            'BEGIN:VEVENT', 'UID:plan', 'DTSTAMP:20261001T000000Z', 'DTSTART;TZID=Europe/Berlin:20261012T100000', 'DURATION:PT1H',
            'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Planning', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:ann@example.com', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:plan', 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20261019T100000',
            'DTSTART;TZID=Europe/Berlin:20261019T140000', 'DURATION:PT1H', 'SUMMARY:Planning (afternoons)',
            'ATTENDEE;PARTSTAT=ACCEPTED:mailto:ann@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:cy@example.com', 'END:VEVENT',
            'END:VCALENDAR', ''].join('\r\n'));
        const later = week(m, '2026-10-26T00:00', '2026-11-02T00:00').find((o) => o.title.startsWith('Planning'));
        assert.deepEqual([later.title, later.startLocal], ['Planning (afternoons)', '2026-10-26T14:00']);
        // Its record is the range's: Cy is on it.
        assert.deepEqual(m.planChange('update', { id: later.id, input: { location: 'Room 2' }, scope: 'one' }).mail, { to: [], what: '', forced: false });
        await m.updateEvent(later.id, { location: 'Room 2' }, 'one');
        const written = unfold(dav.at(-1).raw);
        const own = written.split('BEGIN:VEVENT').find((part) => /RECURRENCE-ID;TZID=Europe\/Berlin:20261026T100000/.test(part));
        assert.ok(own, 'an occurrence of its own');
        assert.match(own, /SUMMARY:Planning \(afternoons\)/);
        assert.match(own, /DTSTART;TZID=Europe\/Berlin:20261026T140000/);
        assert.match(own, /LOCATION:Room 2/);
        assert.match(own, /mailto:cy@example\.com/);
        assert.doesNotMatch(own, /RANGE=THISANDFUTURE/);
        const after = week(m, '2026-10-26T00:00', '2026-11-02T00:00').find((o) => o.title.startsWith('Planning'));
        assert.deepEqual([after.title, after.startLocal, after.location], ['Planning (afternoons)', '2026-10-26T14:00', 'Room 2']);
    } finally {
        m.dispose();
        done();
    }
});

test('a "this and following" change whose own occurrence is changed or deleted alone goes on from the next one, never past a later such change', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const dav = standIn(m, { id: 'dav', kind: 'caldav', name: 'Work', url: 'https://dav.example.org/', username: 'me', email: 'me@example.org' },
            { id: 'cal-dav', remoteId: 'https://dav.example.org/cal/', name: 'Work', scheduling: false }, 'ics');
        const event = (...lines) => ['BEGIN:VEVENT', 'UID:plan', 'DTSTAMP:20261001T000000Z', ...lines, 'DURATION:PT1H', 'END:VEVENT'];
        await holdIcs(m, 'cal-dav', 'https://dav.example.org/cal/plan.ics', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
            ...event('DTSTART;TZID=Europe/Berlin:20261012T100000', 'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Plan'),
            ...event('RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20261019T100000', 'DTSTART;TZID=Europe/Berlin:20261019T100000', 'SUMMARY:Plan A'),
            ...event('RECURRENCE-ID;TZID=Europe/Berlin:20261026T100000', 'DTSTART;TZID=Europe/Berlin:20261026T120000', 'SUMMARY:Plan at noon'),
            ...event('RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20261102T100000', 'DTSTART;TZID=Europe/Berlin:20261102T100000', 'SUMMARY:Plan B'),
            'END:VCALENDAR', ''].join('\r\n'));
        const shown = () => titles(week(m, '2026-10-12T00:00', '2026-11-20T00:00'));
        const ranges = () => [...unfold(dav.at(-1).raw).matchAll(/RECURRENCE-ID([^:\r\n]*):(\d{8})/g)].map((r) => `${r[2]}${/THISANDFUTURE/.test(r[1]) ? ' and following' : ''}`);
        // Oct 19 alone: Oct 26 has a change of its own, and from Nov 2 on the later change holds, so Plan A reaches no other occurrence.
        await m.updateEvent(week(m).find((o) => o.startLocal === '2026-10-19T10:00').id, { title: 'Plan A, once' }, 'one');
        assert.deepEqual(ranges(), ['20261019', '20261026', '20261102 and following']);
        assert.deepEqual(shown(), ['2026-10-12T10:00 Plan', '2026-10-19T10:00 Plan A, once', '2026-10-26T12:00 Plan at noon',
            '2026-11-02T10:00 Plan B', '2026-11-09T10:00 Plan B', '2026-11-16T10:00 Plan B']);
        // Nov 2 deleted alone: Plan B goes on from Nov 9.
        await m.deleteEvent(week(m, '2026-11-02T00:00', '2026-11-03T00:00')[0].id, 'one');
        assert.deepEqual(ranges(), ['20261019', '20261026', '20261109 and following']);
        assert.deepEqual(shown(), ['2026-10-12T10:00 Plan', '2026-10-19T10:00 Plan A, once', '2026-10-26T12:00 Plan at noon', '2026-11-09T10:00 Plan B', '2026-11-16T10:00 Plan B']);
    } finally {
        m.dispose();
        done();
    }
});

test('a move whose second step fails says it was copied, and what to do, rather than "nothing was done"', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const { SourceError } = await import('../lib/sources/index.js');
        const personal = m.state().calendars.find((c) => c.name === 'Personal');
        const dav = standIn(m, { id: 'dav', kind: 'caldav', name: 'Work', url: 'https://dav.example.org/', username: 'me', email: 'me@example.org' },
            { id: 'cal-dav', remoteId: 'https://dav.example.org/cal/', name: 'Work', scheduling: false }, 'ics');
        const lunch = await m.createEvent({ calendarId: 'cal-dav', title: 'Lunch', start: '2026-10-14T12:00' });
        dav.fail = [new SourceError('forbidden', 'Deleting the event: the server doesn\'t allow this.')];
        await assert.rejects(m.updateEvent(lunch.id, { calendarId: personal.id }), (error) => {
            assert.equal(error.code, 'half-moved');
            assert.equal(error.message, 'It was copied to Personal, but not taken out of Work, which stopped: Deleting the event: the server doesn\'t allow this. '
                + 'Delete it from Work to finish the move; moving it again would make a second copy.');
            return true;
        });
        assert.deepEqual(week(m).filter((o) => o.title === 'Lunch').map((o) => o.calendarId).sort(), ['cal-dav', personal.id].sort());
        // An agent is told it is done in part, and not to move it again (here the copy was deleted first, so it moves again).
        const tools = Object.fromEntries(calendarTools(m).map((t) => [t.name, t]));
        await m.deleteEvent(week(m).find((o) => o.title === 'Lunch' && o.calendarId === personal.id).id);
        dav.fail = [new SourceError('forbidden', 'Deleting the event: the server doesn\'t allow this.')];
        const work = week(m).find((o) => o.title === 'Lunch' && o.calendarId === 'cal-dav');
        await assert.rejects(tools.calendar_update_event.execute({ id: work.id, calendar_id: personal.id }),
            /^Error: Done in part: It was copied to Personal, .* Don't move it again: tell the user, and delete it from the calendar it came from only if they say so\.$/);
        assert.deepEqual(week(m).filter((o) => o.title === 'Lunch').map((o) => o.calendarId).sort(), ['cal-dav', personal.id].sort());
    } finally {
        m.dispose();
        done();
    }
});

test('a move asked again after it stopped halfway is refused while its copy is there, so it makes no second copy', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const { SourceError } = await import('../lib/sources/index.js');
        const me = { username: 'me@example.org', email: 'me@example.org', addresses: ['me@example.org'] };
        const work = standIn(m, { id: 'work', kind: 'caldav', name: 'Work', url: 'https://work.example.org/', ...me },
            { id: 'cal-work', remoteId: 'https://work.example.org/cal/', name: 'Work', scheduling: true }, 'ics');
        const home = standIn(m, { id: 'home', kind: 'caldav', name: 'Home', url: 'https://home.example.org/', ...me },
            { id: 'cal-home', remoteId: 'https://home.example.org/cal/', name: 'Home', scheduling: true }, 'ics');
        const offsite = (...people) => meetingIcs('offsite', '20261015T090000', ['ORGANIZER:mailto:me@example.org', ...people.map((p) => `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${p}`)], 'Offsite');
        await holdIcs(m, 'cal-work', 'https://work.example.org/cal/offsite.ics', offsite('ann@example.com'));
        const inWork = () => week(m).find((o) => o.title === 'Offsite' && o.calendarId === 'cal-work');
        const copies = () => week(m).filter((o) => o.title === 'Offsite' && o.calendarId === 'cal-home');
        // Moved to Home with invitations to ann; meanwhile bob joined it on the server, so taking it out of Work stops.
        work.fail = [new SourceError('conflict', 'Deleting the event: it changed on the server meanwhile.')];
        work.syncItems = [{ remoteId: 'https://work.example.org/cal/offsite.ics', raw: offsite('ann@example.com', 'bob@example.com') }];
        await assert.rejects(m.updateEvent(inWork().id, { calendarId: 'cal-home', notify: true }), (error) => error.code === 'half-moved'
            && /^It was copied to Home \(invitations sent to ann@example\.com\), but not taken out of Work, which stopped: The event changed since/.test(error.message));
        assert.equal(copies().length, 1);
        // The same move again, here or from an agent: refused while the copy is there, and nothing is written.
        const writes = home.length;
        const refusal = 'It was copied to Home already, by a move that stopped halfway, and that copy is still there. '
            + 'Delete it from Work to finish the move; moving it again would make a second copy.';
        await assert.rejects(m.updateEvent(inWork().id, { calendarId: 'cal-home', notify: true }), (error) => error.code === undefined && error.message === refusal);
        const tools = Object.fromEntries(calendarTools(m).map((t) => [t.name, t]));
        const again = { id: inWork().id, calendar_id: 'cal-home', notify_guests: true };
        await assert.rejects(tools.calendar_update_event.execute(again), { message: `Not done: ${refusal}` });
        // The agent's call is refused before anyone is asked about it.
        assert.deepEqual(planOf(m, 'calendar_update_event', again), { refusal: `Not done: ${refusal}` });
        assert.equal(home.length, writes);
        assert.equal(copies().length, 1);
        // With the copy deleted, the move is made.
        await m.deleteEvent(copies()[0].id, 'all', 'window', { notify: true });
        const moved = await m.updateEvent(inWork().id, { calendarId: 'cal-home', notify: true });
        assert.deepEqual([moved.calendarId, moved.emailed.to], ['cal-home', ['ann@example.com', 'bob@example.com']]);
        assert.deepEqual([copies().length, inWork()], [1, undefined]);
    } finally {
        m.dispose();
        done();
    }
});

test('a series moved into Google: an occurrence cancelled on its own comes back, and the move says so', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        standIn(m, { id: 'dav', kind: 'caldav', name: 'Work', url: 'https://dav.example.org/', username: 'me', email: 'me@example.org' },
            { id: 'cal-dav', remoteId: 'https://dav.example.org/cal/', name: 'Work', scheduling: false }, 'ics');
        standIn(m, { id: 'g', kind: 'google', name: 'Google', email: 'me@gmail.com' }, { id: 'cal-g', remoteId: 'primary', name: 'Me' }, 'events');
        await holdIcs(m, 'cal-dav', 'https://dav.example.org/cal/run.ics', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
            'BEGIN:VEVENT', 'UID:run', 'DTSTAMP:20261001T000000Z', 'DTSTART;TZID=Europe/Berlin:20261012T070000', 'DURATION:PT1H',
            'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Run', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:run', 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID;TZID=Europe/Berlin:20261013T070000',
            'DTSTART;TZID=Europe/Berlin:20261013T070000', 'DURATION:PT1H', 'SUMMARY:Run', 'STATUS:CANCELLED', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:run', 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID;TZID=Europe/Berlin:20261014T070000',
            'DTSTART;TZID=Europe/Berlin:20261014T080000', 'DURATION:PT1H', 'SUMMARY:Run (late)', 'END:VEVENT',
            'END:VCALENDAR', ''].join('\r\n'));
        const run = week(m).find((o) => o.title === 'Run');
        await assert.rejects(m.updateEvent(run.id, { calendarId: 'cal-g' }, 'all'),
            refusedFor('drops-changes', /^Moving this series to Me would drop 1 occurrence changed on its own and the cancellation of 1 occurrence \(it comes back\): Google takes/));
    } finally {
        m.dispose();
        done();
    }
});

test('the window\'s yes counts only for the change it was asked about, once, and only for the people it named', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const { WindowChanges } = await import('../lib/asked.js');
        const calls = standIn(m, { id: 'dav', kind: 'caldav', name: 'iCloud', url: 'https://caldav.icloud.com/', username: 'me@icloud.com', email: 'me@icloud.com', addresses: ['me@icloud.com'] },
            { id: 'cal-dav', remoteId: 'https://p52-caldav.icloud.com/1/calendars/home/', name: 'Home', scheduling: true }, 'ics');
        const told = ['ann@example.com', 'bob@example.com'];
        let clock = NOW;
        const window = new WindowChanges(m, { now: () => clock });
        // A new meeting that invites its guests: asked about, then made with the yes.
        const input = { calendarId: 'cal-dav', title: 'Planning', start: '2026-10-15T10:00', attendees: told, notify: true };
        await assert.rejects(window.create(input), (error) => error.code === 'needs-approval' && error.people.join() === told.join());
        assert.equal(calls.length, 0);
        const meeting = await window.create({ ...input, approved: told });
        assert.deepEqual(meeting.emailed, { what: 'invitations', to: told });
        const writes = () => calls.filter((c) => c.op === 'put' || c.op === 'remove').length;

        // Asked about moving it to 11:00. A yes sent with another time, or for another scope, counts for nothing: asked again.
        await assert.rejects(window.update(meeting.id, { start: '2026-10-15T11:00' }, 'all'), refusedFor('needs-notify', /an update to ann@example\.com and bob@example\.com/));
        const before = writes();
        await assert.rejects(window.update(meeting.id, { start: '2026-10-15T12:00', notify: true, approved: told }, 'all'), refusedFor('needs-approval', /ann@example\.com and bob@example\.com/));
        assert.equal(writes(), before);
        // The yes for the change asked about: made, once.
        await assert.rejects(window.update(meeting.id, { start: '2026-10-15T11:00' }, 'all'), refusedFor('needs-notify', /ann@example\.com/));
        const moved = await window.update(meeting.id, { start: '2026-10-15T11:00', notify: true, approved: told }, 'all');
        assert.deepEqual([moved.startLocal, moved.emailed], ['2026-10-15T11:00', { what: 'an update', to: told }]);
        await assert.rejects(window.update(meeting.id, { title: 'Planning!', notify: true, approved: told }, 'all'), refusedFor('needs-approval', /ann@example\.com/));

        // A yes names only who its question did: Cy, added since, isn't covered by naming him in it.
        await assert.rejects(window.delete(meeting.id, 'all', false), refusedFor('needs-notify', /a cancellation to ann@example\.com and bob@example\.com/));
        const held = Object.values(m.store.itemsOf('cal-dav')).find((i) => i.events[0].title === 'Planning');
        held.events[0].attendees.push({ email: 'cy@example.com', status: 'needs-action', role: 'required' });
        m.changed();
        await assert.rejects(window.delete(meeting.id, 'all', true, [...told, 'cy@example.com']), refusedFor('changed', /also email a cancellation to cy@example\.com/));
        // Asked again (the refusal named all three), and then half an hour passes: the yes counts for nothing.
        clock += 31 * 60_000;
        await assert.rejects(window.delete(meeting.id, 'all', true, [...told, 'cy@example.com']), (error) => error.code === 'needs-approval' && error.people.length === 3);
        // Answered in time, it goes.
        await window.delete(meeting.id, 'all', true, [...told, 'cy@example.com']);
        assert.equal(week(m).filter((o) => o.title === 'Planning').length, 0);
    } finally {
        m.dispose();
        done();
    }
});

test('the window\'s yes holds to whether the change tells the guests: one to change their calendars quietly can\'t email them', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const { WindowChanges } = await import('../lib/asked.js');
        const google = standIn(m, { id: 'g', kind: 'google', name: 'Google', email: 'me@gmail.com' }, { id: 'cal-g', remoteId: 'primary', name: 'Me' }, 'events');
        const window = new WindowChanges(m, { now: () => NOW });
        const lunch = await m.createEvent({ calendarId: 'cal-g', title: 'Lunch', start: '2026-10-15T12:00', attendees: ['ann@example.com'] });
        const updates = () => google.filter((c) => c.op === 'update');
        // Asked about a new title, which changes it on ann's calendar without emailing her.
        await assert.rejects(window.update(lunch.id, { title: 'Lunch!' }), refusedFor('needs-approval', /^This would change it on the calendars of ann@example\.com without emailing them/));
        // That yes, sent back saying to tell her, counts for nothing: emailing her is asked about first.
        await assert.rejects(window.update(lunch.id, { title: 'Lunch!', notify: true, approved: ['ann@example.com'] }), refusedFor('needs-approval', /^This would email an update to ann@example\.com/));
        assert.equal(updates().length, 0);
        // As it was asked, it goes, without email.
        const quiet = await window.update(lunch.id, { title: 'Lunch!', approved: ['ann@example.com'] });
        assert.deepEqual([quiet.reached, quiet.emailed, updates().length, updates()[0].patch.notify], [{ how: 'change', to: ['ann@example.com'] }, undefined, 1, undefined]);

        // A question whether to tell the guests is kept for the change that tells them: the window's yes comes back with notify set.
        standIn(m, { id: 'dav', kind: 'caldav', name: 'iCloud', url: 'https://caldav.icloud.com/', username: 'me@icloud.com', email: 'me@icloud.com', addresses: ['me@icloud.com'] },
            { id: 'cal-dav', remoteId: 'https://p52-caldav.icloud.com/1/calendars/home/', name: 'Home', scheduling: true }, 'ics');
        const planning = await m.createEvent({ calendarId: 'cal-dav', title: 'Planning', start: '2026-10-15T10:00', attendees: ['ann@example.com'], notify: true });
        await assert.rejects(window.update(planning.id, { start: '2026-10-15T11:00' }), refusedFor('needs-notify', /an update to ann@example\.com/));
        const moved = await window.update(planning.id, { start: '2026-10-15T11:00', notify: true, approved: ['ann@example.com'] });
        assert.deepEqual([moved.startLocal, moved.emailed], ['2026-10-15T11:00', { what: 'an update', to: ['ann@example.com'] }]);
    } finally {
        m.dispose();
        done();
    }
});

test('someone else\'s Google meeting that lets its guests change it: a change to it reaches everyone on it, so it is asked about', async () => {
    const { make, done } = setup();
    const m = make();
    try {
        await m.start();
        const google = standIn(m, { id: 'g', kind: 'google', name: 'Google', email: 'me@gmail.com' }, { id: 'cal-g', remoteId: 'primary', name: 'Me' }, 'events');
        const invitation = (id, extra = {}) => ({
            remoteId: id, etag: `"${id}"`,
            events: [{
                uid: `${id}@google.com`, title: 'Offsite', start: { local: '2026-10-15T09:00:00', tz: ZONE }, end: { local: '2026-10-15T12:00:00', tz: ZONE }, allDay: false,
                organizer: { email: 'boss@example.com' },
                attendees: [{ email: 'boss@example.com', status: 'accepted', role: 'chair' }, { email: 'me@gmail.com', self: true, status: 'needs-action', role: 'required' },
                    { email: 'ann@example.com', status: 'accepted', role: 'required' }],
                ...extra,
            }],
        });
        const items = m.store.itemsOf('cal-g');
        for (const item of [invitation('open', { guestsMayChange: true }), invitation('closed', { title: 'Review' })]) items[item.remoteId] = item;
        m.changed();
        const open = week(m).find((o) => o.title === 'Offsite');
        const closed = week(m).find((o) => o.title === 'Review');
        assert.deepEqual(m.planChange('update', { id: open.id, input: { busy: false } }).mail, { to: [], what: '', forced: false, reaches: ['boss@example.com', 'ann@example.com'], reach: 'change' });
        await assert.rejects(m.updateEvent(open.id, { privacy: 'private' }, 'all', 'window', { confirm: true }),
            refusedFor('needs-approval', /^This would change it on the calendars of boss@example\.com and ann@example\.com without emailing them/));
        assert.equal(google.length, 0);
        // The user's own reminders stay theirs; so does a meeting whose guests can't change it.
        assert.equal((await m.updateEvent(open.id, { alarms: [30] }, 'all', 'window', { confirm: true })).reached, undefined);
        assert.equal((await m.updateEvent(closed.id, { busy: false }, 'all', 'window', { confirm: true })).reached, undefined);
        const changed = await m.updateEvent(open.id, { busy: false }, 'all', 'window', { approved: ['boss@example.com', 'ann@example.com'], confirm: true });
        assert.deepEqual(changed.reached, { how: 'change', to: ['boss@example.com', 'ann@example.com'] });
    } finally {
        m.dispose();
        done();
    }
});
