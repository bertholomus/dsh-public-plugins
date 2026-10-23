/**
 * Calendar files as other apps write them: an Exchange series changed for
 * "this and the following ones" (RECURRENCE-ID;RANGE=THISANDFUTURE), zones
 * named as Lotus Notes and older Outlook name them, bare "GMT+01.00"
 * zones, and files written back with their own zone names, their
 * VTIMEZONEs and their ranges.
 *
 *   node --test plugins/calendar/test/ical.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrences, rangeRecord } from '../lib/expand.js';
import { editIcs, parseIcs, readIcs } from '../lib/ical.js';
import { cleanRecord, instantOf } from '../lib/model.js';
import { ianaZone, nameOffsets } from '../lib/zones.js';

const NOW = Date.parse('2026-10-11T09:25:00Z');
const iso = (ms) => new Date(ms).toISOString().slice(0, 16);
const ics = (...lines) => `${lines.flat().join('\r\n')}\r\n`;
/** A written file with its long lines unfolded, to look for one. */
const unfolded = (text) => text.replace(/\r\n[ \t]/g, '');

/** Each occurrence as 'start–end title' in UTC (all-day: its days). */
const listed = (list) => list.map((o) => (o.allDay ? `${o.startDay}..${o.endDay} ${o.record.title}` : `${iso(o.start)}–${iso(o.end).slice(11)} ${o.record.title}`));

// ── Exchange: "this and the following ones" ─────────────────────────────

const EXCHANGE_UID = '040000008200E00074C5B7101A82E00800000000D0B5B1B5B1D8DC0100000000000000001000000045A3E2C6F0F1A84B8E3C1B7C2D4E5F60';

const W_EUROPE = [
    'BEGIN:VTIMEZONE',
    'TZID:W. Europe Standard Time',
    'BEGIN:STANDARD',
    'DTSTART:16010101T030000',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:16010101T020000',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
];

/** Exchange's own parts of an event, which a file written back keeps. */
const exchangeTail = (sequence, instType) => [
    'CLASS:PUBLIC',
    'PRIORITY:5',
    'DTSTAMP:20261001T120000Z',
    'TRANSP:OPAQUE',
    'STATUS:CONFIRMED',
    `SEQUENCE:${sequence}`,
    'LOCATION;LANGUAGE=en-US:Room 4.12',
    `X-MICROSOFT-CDO-APPT-SEQUENCE:${sequence}`,
    'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
    'X-MICROSOFT-CDO-INTENDEDSTATUS:BUSY',
    'X-MICROSOFT-CDO-ALLDAYEVENT:FALSE',
    'X-MICROSOFT-CDO-IMPORTANCE:1',
    `X-MICROSOFT-CDO-INSTTYPE:${instType}`,
    'X-MICROSOFT-DONOTFORWARDMEETING:FALSE',
    'X-MICROSOFT-DISALLOW-COUNTER:FALSE',
];

/**
 * A weekly Monday meeting at 09:00 in Berlin from 7 September 2026; from 5
 * October on ("this and following") at 10:00 for an hour and a half under
 * a new name; 19 October moved on its own; 2 November taken out. Daylight
 * saving ends in Berlin on 25 October.
 */
const EXCHANGE_SERIES = ics(
    'BEGIN:VCALENDAR',
    'METHOD:PUBLISH',
    'PRODID:Microsoft Exchange Server 2010',
    'VERSION:2.0',
    'X-WR-CALNAME:Calendar',
    W_EUROPE,
    'BEGIN:VEVENT',
    'DESCRIPTION:\\n',
    'RRULE:FREQ=WEEKLY;UNTIL=20261130T080000Z;INTERVAL=1;BYDAY=MO;WKST=MO',
    'EXDATE;TZID=W. Europe Standard Time:20261102T090000',
    `UID:${EXCHANGE_UID}`,
    'SUMMARY;LANGUAGE=en-US:Team sync',
    'DTSTART;TZID=W. Europe Standard Time:20260907T090000',
    'DTEND;TZID=W. Europe Standard Time:20260907T100000',
    exchangeTail(0, 1),
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DESCRIPTION:\\n',
    `UID:${EXCHANGE_UID}`,
    'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=W. Europe Standard Time:20261005T090000',
    'SUMMARY;LANGUAGE=en-US:Team sync (new time)',
    'DTSTART;TZID=W. Europe Standard Time:20261005T100000',
    'DTEND;TZID=W. Europe Standard Time:20261005T113000',
    exchangeTail(1, 3),
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DESCRIPTION:\\n',
    `UID:${EXCHANGE_UID}`,
    'RECURRENCE-ID;TZID=W. Europe Standard Time:20261019T090000',
    'SUMMARY;LANGUAGE=en-US:Team sync with the board',
    'DTSTART;TZID=W. Europe Standard Time:20261019T140000',
    'DTEND;TZID=W. Europe Standard Time:20261019T150000',
    exchangeTail(1, 3),
    'END:VEVENT',
    'END:VCALENDAR',
);

test('an Exchange series changed "this and following" reads as the series, moved and renamed from that occurrence on', () => {
    const zone = 'America/New_York';
    const { events, warnings } = readIcs(EXCHANGE_SERIES, { zone, now: NOW });
    assert.deepEqual(warnings, []);
    assert.equal(events.length, 3);
    const range = events.find((r) => r.title === 'Team sync (new time)');
    assert.equal(range.thisAndFuture, true);
    assert.deepEqual(range.recurrenceId, { local: '2026-10-05T09:00:00', tz: 'Europe/Berlin' });
    assert.equal(events.find((r) => r.title === 'Team sync with the board').thisAndFuture, undefined);
    assert.equal(events.find((r) => r.rrule).thisAndFuture, undefined);
    // The store keeps it.
    assert.equal(cleanRecord(range).thisAndFuture, true);

    const found = occurrences(events, { from: Date.parse('2026-09-01T00:00:00Z'), to: Date.parse('2026-12-31T00:00:00Z'), zone });
    assert.deepEqual(listed(found), [
        '2026-09-07T07:00–08:00 Team sync',
        '2026-09-14T07:00–08:00 Team sync',
        '2026-09-21T07:00–08:00 Team sync',
        '2026-09-28T07:00–08:00 Team sync',
        // The change itself: 10:00 to 11:30 in Berlin, summer time.
        '2026-10-05T08:00–09:30 Team sync (new time)',
        '2026-10-12T08:00–09:30 Team sync (new time)',
        // An occurrence changed on its own keeps its own change.
        '2026-10-19T12:00–13:00 Team sync with the board',
        // Still 10:00 in Berlin after daylight saving ends, for an hour and a half.
        '2026-10-26T09:00–10:30 Team sync (new time)',
        // 2 November is taken out; the rule's last one, 30 November, is in.
        '2026-11-09T09:00–10:30 Team sync (new time)',
        '2026-11-16T09:00–10:30 Team sync (new time)',
        '2026-11-23T09:00–10:30 Team sync (new time)',
        '2026-11-30T09:00–10:30 Team sync (new time)',
    ]);
    // Each later one still names the occurrence it is, and shows the change's own clock.
    const later = found.find((o) => iso(o.start) === '2026-10-26T09:00');
    assert.deepEqual(later.recurrenceId, { local: '2026-10-26T09:00:00', tz: 'Europe/Berlin' });
    assert.equal(later.record, range);
    assert.equal(later.series, found[0].record);

    // A window that holds only where an occurrence moved to, not where it was: still found.
    const moved = occurrences(events, { from: Date.parse('2026-10-12T07:30:00Z'), to: Date.parse('2026-10-12T09:00:00Z'), zone });
    assert.deepEqual(listed(moved), ['2026-10-12T08:00–09:30 Team sync (new time)']);

    // What an occurrence stands for, to change it alone.
    const one = rangeRecord(events, { local: '2026-10-26T09:00:00', tz: 'Europe/Berlin' }, zone);
    assert.equal(one.title, 'Team sync (new time)');
    assert.equal(one.location, 'Room 4.12');
    assert.deepEqual(one.start, { local: '2026-10-26T10:00:00', tz: 'Europe/Berlin' });
    assert.deepEqual(one.end, { local: '2026-10-26T11:30:00', tz: 'Europe/Berlin' });
    assert.deepEqual(one.recurrenceId, { local: '2026-10-26T09:00:00', tz: 'Europe/Berlin' });
    assert.equal(one.thisAndFuture, undefined);
    assert.equal(rangeRecord(events, { local: '2026-09-14T09:00:00', tz: 'Europe/Berlin' }, zone), undefined);
    assert.equal(rangeRecord(events, { local: '2026-10-19T09:00:00', tz: 'Europe/Berlin' }, zone), undefined);
    assert.equal(rangeRecord(events, { local: '2026-10-05T09:00:00', tz: 'Europe/Berlin' }, zone), undefined);
});

test('a later "this and following" change takes over from an earlier one, and a cancelled one ends the series there', () => {
    const zone = 'Europe/Berlin';
    const master = { uid: 's1', title: 'Standup', start: { local: '2026-10-05T09:00:00', tz: zone }, end: { local: '2026-10-05T09:15:00', tz: zone }, allDay: false, rrule: 'FREQ=WEEKLY;COUNT=8' };
    const first = { uid: 's1', title: 'Standup, later', start: { local: '2026-10-12T09:30:00', tz: zone }, end: { local: '2026-10-12T09:45:00', tz: zone }, allDay: false, recurrenceId: { local: '2026-10-12T09:00:00', tz: zone }, thisAndFuture: true };
    // Two days later, on a Wednesday, from 2 November on: each later one moves two days too (not on top of the first change).
    const second = { uid: 's1', title: 'Standup, Wednesdays', start: { local: '2026-11-04T09:00:00', tz: zone }, end: { local: '2026-11-04T09:20:00', tz: zone }, allDay: false, recurrenceId: { local: '2026-11-02T09:00:00', tz: zone }, thisAndFuture: true };
    const list = (records, from = '2026-10-01T00:00:00Z', to = '2026-12-31T00:00:00Z') => listed(occurrences(records, { from: Date.parse(from), to: Date.parse(to), zone }));
    assert.deepEqual(list([master, first, second]), [
        '2026-10-05T07:00–07:15 Standup',
        '2026-10-12T07:30–07:45 Standup, later',
        '2026-10-19T07:30–07:45 Standup, later',
        '2026-10-26T08:30–08:45 Standup, later',
        '2026-11-04T08:00–08:20 Standup, Wednesdays',
        '2026-11-11T08:00–08:20 Standup, Wednesdays',
        '2026-11-18T08:00–08:20 Standup, Wednesdays',
        '2026-11-25T08:00–08:20 Standup, Wednesdays',
    ]);
    // A window on the Wednesday alone: the Monday it was is two days before it.
    assert.deepEqual(list([master, first, second], '2026-11-18T07:00:00Z', '2026-11-18T12:00:00Z'), ['2026-11-18T08:00–08:20 Standup, Wednesdays']);
    // Cancelled from 26 October on.
    const cancelled = { ...first, title: 'Standup', status: 'cancelled', start: { local: '2026-10-26T09:00:00', tz: zone }, end: { local: '2026-10-26T09:15:00', tz: zone }, recurrenceId: { local: '2026-10-26T09:00:00', tz: zone } };
    assert.deepEqual(list([master, cancelled]), ['2026-10-05T07:00–07:15 Standup', '2026-10-12T07:00–07:15 Standup', '2026-10-19T07:00–07:15 Standup']);
});

test('an all-day series changed "this and following" to days earlier', () => {
    const zone = 'Europe/Berlin';
    const text = ics(
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lotus Development Corporation//NONSGML Notes 9.0.1//EN_C',
        'BEGIN:VEVENT', 'UID:7C1D9E2A44B6F0B1C1258A6B003F2D11', 'DTSTAMP:20261001T080000Z', 'SUMMARY:On call',
        'DTSTART;VALUE=DATE:20261002', 'DTEND;VALUE=DATE:20261003', 'RRULE:FREQ=WEEKLY;COUNT=6', 'END:VEVENT',
        // From 16 October on, on the Tuesday before, for two days.
        'BEGIN:VEVENT', 'UID:7C1D9E2A44B6F0B1C1258A6B003F2D11', 'DTSTAMP:20261008T080000Z', 'SUMMARY:On call (Tue-Wed)',
        'RECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20261016', 'DTSTART;VALUE=DATE:20261013', 'DTEND;VALUE=DATE:20261015',
        'SEQUENCE:1', 'END:VEVENT',
        'END:VCALENDAR',
    );
    const { events } = readIcs(text, { zone, now: NOW });
    const list = (from, to) => listed(occurrences(events, { from: Date.parse(from), to: Date.parse(to), zone }));
    assert.deepEqual(list('2026-10-01T00:00:00+02:00', '2026-11-30T00:00:00+01:00'), [
        '2026-10-02..2026-10-03 On call',
        '2026-10-09..2026-10-10 On call',
        '2026-10-13..2026-10-15 On call (Tue-Wed)',
        '2026-10-20..2026-10-22 On call (Tue-Wed)',
        '2026-10-27..2026-10-29 On call (Tue-Wed)',
        '2026-11-03..2026-11-05 On call (Tue-Wed)',
    ]);
    // The Tuesday alone: the Friday it was is after the window.
    assert.deepEqual(list('2026-10-27T00:00:00+01:00', '2026-10-28T00:00:00+01:00'), ['2026-10-27..2026-10-29 On call (Tue-Wed)']);
    assert.deepEqual(rangeRecord(events, { date: '2026-10-30' }, zone).start, { date: '2026-10-27' });
});

test('a "this and following" change keeps its range when the file is written back', () => {
    const zone = 'Europe/Berlin';
    const { events } = readIcs(EXCHANGE_SERIES, { zone, now: NOW });
    const range = events.find((r) => r.thisAndFuture);
    // Another field changed: the RECURRENCE-ID line stays as Exchange wrote it, and so does what the plugin doesn't model.
    const placed = unfolded(editIcs(EXCHANGE_SERIES, [{ uid: range.uid, recurrenceId: range.recurrenceId, record: { ...range, location: 'Room 5.01' } }], { now: NOW, zone }));
    assert.match(placed, /\r\nRECURRENCE-ID;RANGE=THISANDFUTURE;TZID=W\. Europe Standard Time:20261005T090000\r\n/);
    assert.match(placed, /\r\nLOCATION:Room 5\.01\r\n/);
    assert.match(placed, /X-MICROSOFT-CDO-INSTTYPE:3/);
    assert.equal(readIcs(placed, { zone, now: NOW }).events.find((r) => r.location === 'Room 5.01').thisAndFuture, true);
    // The occurrence it names moved (the whole series moved half an hour later): written anew, with its range and the file's zone name.
    const shifted = unfolded(editIcs(EXCHANGE_SERIES, [{ uid: range.uid, recurrenceId: range.recurrenceId, record: { ...range, recurrenceId: { local: '2026-10-05T09:30:00', tz: 'Europe/Berlin' } } }], { now: NOW, zone }));
    assert.match(shifted, /\r\nRECURRENCE-ID;RANGE=THISANDFUTURE;TZID="W\. Europe Standard Time":20261005T093000\r\n/);
    assert.doesNotMatch(shifted, /TZID:Europe\/Berlin/);
    const again = readIcs(shifted, { zone, now: NOW }).events.find((r) => r.recurrenceId?.local === '2026-10-05T09:30:00');
    assert.equal(again.thisAndFuture, true);
    // A new file (an export, or a copy to another calendar): written with its range, and it reads the same.
    const copy = unfolded(editIcs(null, events.map((r) => ({ uid: r.uid, recurrenceId: r.recurrenceId, record: r })), { now: NOW, zone }));
    assert.match(copy, /\r\nRECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe\/Berlin:20261005T090000\r\n/);
    assert.match(copy, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Berlin/);
    const window = { from: Date.parse('2026-09-01T00:00:00Z'), to: Date.parse('2026-12-31T00:00:00Z'), zone };
    assert.deepEqual(listed(occurrences(readIcs(copy, { zone, now: NOW }).events, window)), listed(occurrences(events, window)));
    // Taken off the record, the range goes from the file too.
    const plain = unfolded(editIcs(EXCHANGE_SERIES, [{ uid: range.uid, recurrenceId: range.recurrenceId, record: { ...range, thisAndFuture: undefined } }], { now: NOW, zone }));
    assert.match(plain, /\r\nRECURRENCE-ID;TZID="W\. Europe Standard Time":20261005T090000\r\n/);
    assert.doesNotMatch(plain, /RANGE=/);
});

// ── Zones other apps name ─────────────────────────────────────────────

test('zone names from Windows, Outlook, Lotus Notes and older clients', () => {
    assert.equal(ianaZone('W. Europe Standard Time'), 'Europe/Berlin');
    assert.equal(ianaZone('W. Europe Daylight Time'), 'Europe/Berlin');
    assert.equal(ianaZone('W. Europe'), 'Europe/Berlin');
    assert.equal(ianaZone('Eastern'), 'America/New_York');
    assert.equal(ianaZone('Z=-1$DO=1$DL=3 -1 1 10 -1 1$ZX=21$ZN=Romance'), 'Europe/Paris');
    assert.equal(ianaZone('/mozilla.org/20050126_1/Europe/Berlin'), 'Europe/Berlin');
    assert.equal(ianaZone('/citadel.org/20190914_1/America/New_York'), 'America/New_York');
    assert.equal(ianaZone('/softwarestudio.org/Olson_20011030_5/America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires');
    assert.equal(ianaZone('(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna'), 'Europe/Amsterdam');
    assert.equal(ianaZone('(UTC+01:00) Amsterdam\\, Berlin\\, Bern\\, Rome\\, Stockholm\\, Vienna'), 'Europe/Amsterdam');
    assert.equal(ianaZone('(GMT+01.00) Amsterdam / Berlin / Bern / Rome / Stockholm / Vienna'), 'Europe/Amsterdam');
    assert.equal(ianaZone('(GMT-05:00) Eastern Time (US & Canada)'), 'America/New_York');
    assert.equal(ianaZone('(UTC-06:00) Guadalajara, Mexico City, Monterrey'), 'America/Mexico_City');
    assert.equal(ianaZone('(UTC) Dublin, Edinburgh, Lisbon, London'), 'Europe/Dublin');
    assert.equal(ianaZone('(GMT) Greenwich Mean Time : Dublin, Edinburgh, Lisbon, London'), 'Europe/Dublin');
    assert.equal(ianaZone('(GMT) Casablanca, Monrovia'), 'Africa/Monrovia');
    assert.equal(ianaZone('GMT+01.00'), 'Etc/GMT-1');
    assert.equal(ianaZone('(GMT-05.00)'), 'Etc/GMT+5');
    assert.equal(ianaZone('UTC+02:00'), 'Etc/GMT-2');
    // An offset that isn't whole hours has no IANA id of its own; two offsets need the rules.
    assert.equal(ianaZone('GMT+05.30'), undefined);
    assert.deepEqual(nameOffsets('GMT+05.30'), [330]);
    assert.equal(ianaZone('GMT +0100 (Standard) / GMT +0200 (Daylight)'), undefined);
    assert.deepEqual(nameOffsets('GMT +0100 (Standard) / GMT +0200 (Daylight)'), [60, 120]);
    assert.equal(ianaZone('Customized Time Zone'), undefined);
    assert.equal(ianaZone('tzone://Microsoft/Custom'), undefined);
    assert.equal(nameOffsets('Eastern'), undefined);
});

/** One event's text, its start and end on the TZID given (with its VTIMEZONE when given). */
const eventIn = (tzid, vtimezone, start, end, extra = []) => ics(
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Zones//EN', vtimezone ?? [],
    'BEGIN:VEVENT', `UID:z-${start}@test`, 'DTSTAMP:20261001T000000Z', 'SUMMARY:Call',
    `DTSTART;TZID="${tzid}":${start}`, `DTEND;TZID="${tzid}":${end}`, extra, 'END:VEVENT',
    'END:VCALENDAR',
);

/** The instants of each occurrence of a file's events, as UTC 'YYYY-MM-DDTHH:MM'. */
const startsOf = (text, zone, from = '2026-01-01T00:00:00Z', to = '2027-01-01T00:00:00Z') => {
    const { events } = readIcs(text, { zone, now: NOW });
    return occurrences(events, { from: Date.parse(from), to: Date.parse(to), zone }).map((o) => iso(o.start));
};

const LOTUS_EASTERN = [
    'BEGIN:VTIMEZONE',
    'TZID:Eastern',
    'BEGIN:STANDARD',
    'DTSTART:19501105T020000',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'RRULE:FREQ=YEARLY;BYMINUTE=0;BYHOUR=2;BYDAY=1SU;BYMONTH=11',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:19500312T020000',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'RRULE:FREQ=YEARLY;BYMINUTE=0;BYHOUR=2;BYDAY=2SU;BYMONTH=3',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
];

test('a Lotus Notes zone ("Eastern") reads as New York, on both sides of the change to standard time', () => {
    // A weekly Thursday call at 09:30: the first before 1 November 2026, when daylight saving ends there.
    const text = ics(
        'BEGIN:VCALENDAR', 'X-LOTUS-CHARSET:UTF-8', 'VERSION:2.0', 'PRODID:-//Lotus Development Corporation//NONSGML Notes 9.0.1//EN_C',
        'METHOD:PUBLISH', LOTUS_EASTERN,
        'BEGIN:VEVENT', 'DTSTART;TZID="Eastern":20261029T093000', 'DTEND;TZID="Eastern":20261029T103000', 'TRANSP:OPAQUE',
        'RRULE:FREQ=WEEKLY;COUNT=3;INTERVAL=1;BYDAY=TH', 'DTSTAMP:20261012T151500Z', 'SEQUENCE:0', 'CLASS:PUBLIC', 'SUMMARY:Status call',
        'UID:8F2A6C1E0B3D4C5A85257A1B004C1D2E-Lotus_Notes_Generated', 'X-LOTUS-SUMMARYDATAONLY:FALSE', 'X-LOTUS-APPTTYPE:3', 'END:VEVENT',
        'END:VCALENDAR',
    );
    // Read by someone in Berlin, whose own clock changed a week earlier.
    const { events } = readIcs(text, { zone: 'Europe/Berlin', now: NOW });
    assert.deepEqual(events[0].start, { local: '2026-10-29T09:30:00', tz: 'America/New_York' });
    assert.deepEqual(startsOf(text, 'Europe/Berlin'), ['2026-10-29T13:30', '2026-11-05T14:30', '2026-11-12T14:30']);
});

test('an older Outlook zone with no IANA name reads by its own rules, on both sides of the change to summer time', () => {
    // Outlook 2000's name for Central European time; the series starts before 29 March 2026.
    const tzid = 'GMT +0100 (Standard) / GMT +0200 (Daylight)';
    const vtimezone = [
        'BEGIN:VTIMEZONE', `TZID:${tzid}`,
        'BEGIN:STANDARD', 'DTSTART:20001029T030000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100',
        'TZNAME:Standard Time', 'END:STANDARD',
        'BEGIN:DAYLIGHT', 'DTSTART:20000326T020000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200',
        'TZNAME:Daylight Savings Time', 'END:DAYLIGHT',
        'END:VTIMEZONE',
    ];
    const text = eventIn(tzid, vtimezone, '20260316T090000', '20260316T100000', ['RRULE:FREQ=WEEKLY;COUNT=4']);
    // Read on the American west coast, which changed on 8 March: never floating, never off by the reader's own change.
    assert.deepEqual(startsOf(text, 'America/Los_Angeles'), ['2026-03-16T08:00', '2026-03-23T08:00', '2026-03-30T07:00', '2026-04-06T07:00']);
    const [event] = readIcs(text, { zone: 'America/Los_Angeles', now: NOW }).events;
    assert.equal(event.start.local, '2026-03-16T09:00:00');
    assert.ok(['Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam', 'Europe/Brussels'].includes(event.start.tz), event.start.tz);
    // The same name with no VTIMEZONE says only its standard offset.
    assert.deepEqual(startsOf(eventIn(tzid, null, '20260701T090000', '20260701T100000'), 'America/Los_Angeles'), ['2026-07-01T08:00']);
});

test('a zone whose rules changed since the file was written reads as the zone it is, by its offsets', () => {
    // US daylight saving as it was before 2007 (April to October), under a name no one else uses.
    const vtimezone = [
        'BEGIN:VTIMEZONE', 'TZID:Eastern Time (old rules)',
        'BEGIN:STANDARD', 'DTSTART:19671029T020000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD',
        'BEGIN:DAYLIGHT', 'DTSTART:19870405T020000', 'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'END:DAYLIGHT',
        'END:VTIMEZONE',
    ];
    const text = eventIn('Eastern Time (old rules)', vtimezone, '20260120T090000', '20260120T100000', ['RRULE:FREQ=MONTHLY;COUNT=7']);
    const { events } = readIcs(text, { zone: 'Asia/Tokyo', now: NOW });
    assert.equal(events[0].start.tz, 'America/New_York');
    assert.deepEqual(startsOf(text, 'Asia/Tokyo'), [
        '2026-01-20T14:00', '2026-02-20T14:00', '2026-03-20T13:00', '2026-04-20T13:00', '2026-05-20T13:00', '2026-06-20T13:00', '2026-07-20T13:00',
    ]);
});

test('"GMT+01.00" zones are fixed offsets, unless their VTIMEZONE says otherwise', () => {
    const fixed = (tzid, offset) => ['BEGIN:VTIMEZONE', `TZID:${tzid}`, 'BEGIN:STANDARD', 'DTSTART:19500101T000000', `TZOFFSETFROM:${offset}`, `TZOFFSETTO:${offset}`, 'END:STANDARD', 'END:VTIMEZONE'];
    // In summer too: 09:00 at +01:00 is 08:00 UTC, whatever Berlin's clock says.
    const lotus = eventIn('GMT+01.00', fixed('GMT+01.00', '+0100'), '20260715T090000', '20260715T100000');
    assert.deepEqual(readIcs(lotus, { zone: 'Europe/Berlin', now: NOW }).events[0].start, { local: '2026-07-15T09:00:00', tz: 'Etc/GMT-1' });
    assert.deepEqual(startsOf(lotus, 'Europe/Berlin'), ['2026-07-15T08:00']);
    // Without a VTIMEZONE: the name alone.
    assert.deepEqual(startsOf(eventIn('GMT-05.00', null, '20260715T090000', '20260715T100000'), 'Europe/Berlin'), ['2026-07-15T14:00']);
    assert.deepEqual(startsOf(eventIn('GMT+05.30', null, '20260715T090000', '20260715T100000'), 'Europe/Berlin'), ['2026-07-15T03:30']);
    // Its offset written as +01:00, against the RFC: still +01:00.
    assert.deepEqual(startsOf(eventIn('Custom', fixed('Custom', '+01:00'), '20260715T090000', '20260715T100000'), 'America/New_York'), ['2026-07-15T08:00']);
    // A "GMT+01.00" whose VTIMEZONE has summer time: the VTIMEZONE's rules hold.
    const withSummer = [
        'BEGIN:VTIMEZONE', 'TZID:GMT+01.00',
        'BEGIN:STANDARD', 'DTSTART:19501029T030000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD',
        'BEGIN:DAYLIGHT', 'DTSTART:19500326T020000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'END:DAYLIGHT',
        'END:VTIMEZONE',
    ];
    assert.deepEqual(startsOf(eventIn('GMT+01.00', withSummer, '20260715T090000', '20260715T100000'), 'America/New_York'), ['2026-07-15T07:00']);
});

test('a VTIMEZONE no IANA zone matches reads by its standard offset, never as floating', () => {
    // Daylight saving at offsets no zone has: the last resort is the standard offset, +01:15.
    const odd = [
        'BEGIN:VTIMEZONE', 'TZID:Odd',
        'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'TZOFFSETFROM:+0215', 'TZOFFSETTO:+0115', 'END:STANDARD',
        'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'TZOFFSETFROM:+0115', 'TZOFFSETTO:+0215', 'END:DAYLIGHT',
        'END:VTIMEZONE',
    ];
    const text = eventIn('Odd', odd, '20260115T090000', '20260115T100000');
    for (const zone of ['America/New_York', 'Asia/Tokyo']) {
        const [event] = readIcs(text, { zone, now: NOW }).events;
        assert.deepEqual(event.start, { local: '2026-01-15T07:45:00', tz: 'UTC' });
        assert.equal(instantOf(event.start, zone), Date.parse('2026-01-15T07:45:00Z'));
    }
    // A STANDARD part whose start can't be read: its offset still counts.
    const broken = ['BEGIN:VTIMEZONE', 'TZID:Broken', 'BEGIN:STANDARD', 'DTSTART:sometime', 'TZOFFSETTO:-0300', 'END:STANDARD', 'END:VTIMEZONE'];
    assert.deepEqual(startsOf(eventIn('Broken', broken, '20260115T090000', '20260115T100000'), 'Europe/Berlin'), ['2026-01-15T12:00']);
    // A TZID nothing defines or names stays floating: read on the user's clock.
    assert.deepEqual(readIcs(eventIn('Nowhere', null, '20260115T090000', '20260115T100000'), { zone: 'Europe/Berlin', now: NOW }).events[0].start, { local: '2026-01-15T09:00:00', tz: null });
});

// ── Writing back ──────────────────────────────────────────────────────

const OUTLOOK_TZID = '(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna';

/** Outlook 2010's file: the zone's display name as its TZID, the commas escaped in the VTIMEZONE. */
const OUTLOOK_FILE = ics(
    'BEGIN:VCALENDAR',
    'PRODID:-//Microsoft Corporation//Outlook 14.0 MIMEDIR//EN',
    'VERSION:2.0',
    'METHOD:PUBLISH',
    'X-MS-OLK-FORCEINSPECTOROPEN:TRUE',
    'BEGIN:VTIMEZONE',
    'TZID:(UTC+01:00) Amsterdam\\, Berlin\\, Bern\\, Rome\\, Stockholm\\, Vienna',
    'BEGIN:STANDARD',
    'DTSTART:16011028T030000',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:16010325T020000',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'CLASS:PUBLIC',
    'CREATED:20261001T101500Z',
    `DTEND;TZID="${OUTLOOK_TZID}":20261020T100000`,
    'DTSTAMP:20261001T101500Z',
    `DTSTART;TZID="${OUTLOOK_TZID}":20261020T090000`,
    'LAST-MODIFIED:20261001T101500Z',
    'PRIORITY:5',
    'SEQUENCE:0',
    'SUMMARY;LANGUAGE=de:Planung',
    'TRANSP:OPAQUE',
    'UID:040000008200E00074C5B7101A82E0080000000080D1E5A6B4D8DC01000000000000000010000000B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6',
    'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
    'X-MICROSOFT-CDO-IMPORTANCE:1',
    'X-MICROSOFT-DISALLOW-COUNTER:FALSE',
    'X-MS-OLK-AUTOFILLLOCATION:FALSE',
    'X-MS-OLK-CONFTYPE:0',
    'END:VEVENT',
    'END:VCALENDAR',
);

test('an Outlook file keeps its own zone and VTIMEZONE when it is written back', () => {
    const zone = 'America/Chicago';
    const { events } = readIcs(OUTLOOK_FILE, { zone, now: NOW });
    const [event] = events;
    assert.deepEqual(event.start, { local: '2026-10-20T09:00:00', tz: 'Europe/Amsterdam' });
    assert.equal(instantOf(event.start, zone), Date.parse('2026-10-20T07:00:00Z'));
    // Another field changed: the times stay as written, and the VTIMEZONE they need with them.
    const renamed = unfolded(editIcs(OUTLOOK_FILE, [{ uid: event.uid, record: { ...event, title: 'Planung Q4' } }], { now: NOW, zone }));
    assert.ok(renamed.includes(`\r\nDTSTART;TZID="${OUTLOOK_TZID}":20261020T090000\r\n`));
    assert.ok(renamed.includes('\r\nTZID:(UTC+01:00) Amsterdam\\, Berlin\\, Bern\\, Rome\\, Stockholm\\, Vienna\r\n'));
    assert.match(renamed, /X-MS-OLK-CONFTYPE:0/);
    assert.equal(parseIcs(renamed)[0].subs.filter((c) => c.name === 'VTIMEZONE').length, 1);
    // A new time after summer time ends: written on the file's own zone, which the file still defines.
    const later = { ...event, start: { local: '2026-11-03T10:00:00', tz: 'Europe/Amsterdam' }, end: { local: '2026-11-03T11:00:00', tz: 'Europe/Amsterdam' } };
    const moved = unfolded(editIcs(OUTLOOK_FILE, [{ uid: event.uid, record: later }], { now: NOW, zone }));
    assert.ok(moved.includes(`\r\nDTSTART;TZID="${OUTLOOK_TZID}":20261103T100000\r\n`));
    assert.ok(moved.includes(`\r\nDTEND;TZID="${OUTLOOK_TZID}":20261103T110000\r\n`));
    assert.doesNotMatch(moved, /Europe\/Amsterdam/);
    assert.equal(parseIcs(moved)[0].subs.filter((c) => c.name === 'VTIMEZONE').length, 1);
    const [back] = readIcs(moved, { zone, now: NOW }).events;
    assert.equal(instantOf(back.start, zone), Date.parse('2026-11-03T09:00:00Z'));
    // A zone the file doesn't have is written by its IANA id, with a VTIMEZONE of its own.
    const tokyo = unfolded(editIcs(OUTLOOK_FILE, [{ uid: event.uid, record: { ...event, start: { local: '2026-10-20T09:00:00', tz: 'Asia/Tokyo' }, end: { local: '2026-10-20T10:00:00', tz: 'Asia/Tokyo' } } }], { now: NOW, zone }));
    assert.match(tokyo, /\r\nDTSTART;TZID=Asia\/Tokyo:20261020T090000\r\n/);
    assert.match(tokyo, /\r\nBEGIN:VTIMEZONE\r\nTZID:Asia\/Tokyo\r\n/);
    assert.equal(parseIcs(tokyo)[0].subs.filter((c) => c.name === 'VTIMEZONE').length, 1);
});

test('a custom TZID and its VTIMEZONE round-trip', () => {
    const zone = 'Asia/Tokyo';
    const vtimezone = [
        'BEGIN:VTIMEZONE', 'TZID:Customized Time Zone',
        'BEGIN:STANDARD', 'DTSTART:16010101T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11', 'END:STANDARD',
        'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3', 'END:DAYLIGHT',
        'END:VTIMEZONE',
    ];
    const text = eventIn('Customized Time Zone', vtimezone, '20261029T093000', '20261029T103000', ['RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE;TZID="Customized Time Zone":20261105T093000']);
    const { events } = readIcs(text, { zone, now: NOW });
    const [series] = events;
    assert.deepEqual(startsOf(text, zone), ['2026-10-29T13:30', '2026-11-12T14:30']);
    // One more occurrence taken out: the EXDATEs are written anew on the file's own zone.
    const fewer = unfolded(editIcs(text, [{ uid: series.uid, record: { ...series, exdates: [...series.exdates, { local: '2026-11-12T09:30:00', tz: series.start.tz }] } }], { now: NOW, zone }));
    assert.ok(fewer.includes('\r\nEXDATE;TZID="Customized Time Zone":20261105T093000\r\nEXDATE;TZID="Customized Time Zone":20261112T093000\r\n'));
    assert.ok(fewer.includes('\r\nBEGIN:VTIMEZONE\r\nTZID:Customized Time Zone\r\n'));
    assert.ok(fewer.includes(`\r\nDTSTART;TZID="Customized Time Zone":20261029T093000\r\n`));
    assert.equal(parseIcs(fewer)[0].subs.filter((c) => c.name === 'VTIMEZONE').length, 1);
    assert.deepEqual(startsOf(fewer, zone), ['2026-10-29T13:30']);
});

test('people named by a urn:uuid or a principal\'s URL keep that address, with their email from EMAIL=', () => {
    const raw = ics('BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', 'UID:review', 'DTSTAMP:20261001T000000Z',
        'DTSTART:20261016T090000Z', 'DURATION:PT1H', 'SUMMARY:Review',
        'ORGANIZER;CN=Alice;EMAIL=alice@icloud.com:urn:uuid:1234567890',
        'ATTENDEE;EMAIL=alice@icloud.com;PARTSTAT=NEEDS-ACTION:urn:uuid:1234567890',
        'ATTENDEE;PARTSTAT=ACCEPTED:/99/principal/',
        'ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED:mailto:ann@example.com',
        'END:VEVENT', 'END:VCALENDAR');
    const [event] = readIcs(raw, { zone: 'UTC' }).events;
    assert.deepEqual(event.organizer, { email: 'alice@icloud.com', address: 'urn:uuid:1234567890', name: 'Alice' });
    assert.deepEqual(event.attendees, [
        { email: 'alice@icloud.com', address: 'urn:uuid:1234567890', status: 'needs-action' },
        { email: '/99/principal/', address: '/99/principal/', status: 'accepted' },
        { email: 'ann@example.com', name: 'Ann', status: 'accepted' },
    ]);
    // An answer written back changes only the answer: the address and its EMAIL stay.
    const answered = structuredClone(event);
    answered.attendees[0].status = 'accepted';
    const out = unfolded(editIcs(raw, [{ uid: 'review', record: answered }], { now: NOW, zone: 'UTC' }));
    assert.match(out, /\r\nATTENDEE;EMAIL=alice@icloud\.com;PARTSTAT=ACCEPTED[^:\r\n]*:urn:uuid:1234567890\r\n/);
    assert.match(out, /\r\nATTENDEE;PARTSTAT=ACCEPTED:\/99\/principal\/\r\n/);
    assert.match(out, /\r\nORGANIZER;CN=Alice;EMAIL=alice@icloud\.com:urn:uuid:1234567890\r\n/);
    // Someone new is named by email.
    const added = structuredClone(event);
    added.attendees.push({ email: 'bob@example.com', status: 'needs-action', role: 'required' });
    assert.match(unfolded(editIcs(raw, [{ uid: 'review', record: added }], { now: NOW, zone: 'UTC' })), /\r\nATTENDEE[^\r\n]*:mailto:bob@example\.com\r\n/);
});
