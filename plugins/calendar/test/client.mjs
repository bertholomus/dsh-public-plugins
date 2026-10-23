/**
 * The browser half's pure parts: lib/client.js loaded the way DSH loads it
 * (a classic script that hands its factory to DSH's module loader), with
 * stand-ins for React and DSH's primitives, and the helpers its views are
 * built on (module.exports.internals) checked on their own: days and zones,
 * repeat rules, where events go in the grid, and what a change may email.
 *
 *   node --test plugins/calendar/test/client.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Load the browser half the way DSH does; the primitives are stand-ins (a component is its own name). */
function loadClient({ loader = true } = {}) {
    let loaded;
    const window = { ...(loader ? { __ModuleLoader__: { load: (m) => { loaded = m; } } } : {}), addEventListener: () => {}, removeEventListener: () => {} };
    runInNewContext(SOURCE, { window, URL, console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask });
    if (!loaded) return { window };
    const ui = new Proxy({}, { get: (_target, name) => (typeof name === 'string' && /^[A-Z]/.test(name) ? name : undefined) });
    const modules = {
        react: {
            createElement: (type, props, ...children) => ({ type, props, children }), Fragment: 'Fragment',
            useState: (init) => [typeof init === 'function' ? init() : init, () => {}], useRef: (current) => ({ current }),
            useEffect: () => {}, useLayoutEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn(), useSyncExternalStore: (_s, get) => get(),
        },
        'react-dom': { createPortal: (node) => node },
        '@deepseek-ai/dsh-client-ui-primitives': ui,
    };
    return { id: loaded.id, client: loaded.factory((name) => modules[name]) };
}

/** A value from the client's realm as a plain one here (its arrays and objects have that realm's prototypes). */
const plain = (value) => JSON.parse(JSON.stringify(value));

const { id, client } = loadClient();
const I = client.internals;
const LA = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';

test('loads as DSH loads a browser half, and stays quiet without DSH', () => {
    assert.equal(id, 'dsh-plugin-calendar');
    assert.equal(typeof client.apply, 'function');
    assert.deepEqual(plain(client.inject), ['slots']);
    // No module loader (or no window at all): nothing happens, nothing throws.
    assert.doesNotThrow(() => loadClient({ loader: false }));
    assert.doesNotThrow(() => runInNewContext(SOURCE, {}));
    // A card for each calendar tool.
    assert.deepEqual([...I.TOOL_NAMES].sort(), ['calendar_create_event', 'calendar_delete_event', 'calendar_events', 'calendar_free_time', 'calendar_get_event',
        'calendar_list_calendars', 'calendar_respond', 'calendar_search', 'calendar_update_event']);
});

test('styles stay on the plugin\'s own roots and follow the wallpaper\'s public contract', () => {
    const css = I.CSS;
    assert.ok(css.includes('var(--wp-blur') && css.includes('var(--wp-tint') && css.includes('body.wp-still'));
    assert.ok(css.includes('data-ds-dark-theme'));
    // No rule for :root, html or body on their own, and no DSH class names.
    for (const rule of css.split('}')) {
        const selector = rule.split('{')[0].trim();
        if (!selector || selector.startsWith('@')) continue;
        assert.ok(!/(^|,)\s*(:root|html|body)\s*(,|$)/.test(selector), selector);
    }
    assert.ok(!/\[class\*="(?!dshcal-)|\._[a-z]/i.test(css), 'no DSH internals');
});

test('wall clocks and instants in a zone, across the clock changes', () => {
    // An ordinary day in Los Angeles (UTC-7 in October) and in Berlin.
    assert.equal(I.toInstant('2026-10-12T09:30', LA), Date.parse('2026-10-12T16:30:00Z'));
    assert.equal(I.toLocal(Date.parse('2026-10-12T16:30:00Z'), LA), '2026-10-12T09:30:00');
    assert.equal(I.toInstant('2026-10-12T09:30', BERLIN), Date.parse('2026-10-12T07:30:00Z'));
    // Spring forward: 02:30 doesn't happen on Mar 8, 2026 in Los Angeles; it takes the offset from before the gap.
    assert.equal(I.toInstant('2026-03-08T02:30', LA), Date.parse('2026-03-08T10:30:00Z'));
    // Fall back: 01:30 happens twice on Nov 1, 2026; the first is meant.
    assert.equal(I.toInstant('2026-11-01T01:30', LA), Date.parse('2026-11-01T08:30:00Z'));
    // A day's start, and how long the day of a change is.
    assert.equal(I.startOfDay('2026-11-01', LA), Date.parse('2026-11-01T07:00:00Z'));
    assert.equal(I.startOfDay('2026-11-02', LA) - I.startOfDay('2026-11-01', LA), 25 * 3_600_000);
    assert.equal(I.dayIn(Date.parse('2026-10-12T06:59:00Z'), LA), '2026-10-11');
    assert.equal(I.minutesIn(Date.parse('2026-10-12T16:30:00Z'), LA), 9 * 60 + 30);
    assert.ok(Number.isNaN(I.toInstant('not a time', LA)));
    assert.equal(I.toInstant('2026-10-12T09:30', 'UTC'), Date.parse('2026-10-12T09:30:00Z'));
});

test('days: adding, weeks, months', () => {
    assert.equal(I.addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(I.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(I.daysBetween('2026-10-11', '2026-11-11'), 31);
    assert.equal(I.weekdayOf('2026-10-11'), 0);
    assert.equal(I.weekStartOf('2026-10-14', 0), '2026-10-11');
    assert.equal(I.weekStartOf('2026-10-14', 1), '2026-10-12');
    assert.equal(I.weekStartOf('2026-10-11', 1), '2026-10-05');
    assert.equal(I.addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(I.addMonths('2026-11-15', 2), '2027-01-15');
    assert.equal(I.addMonths('2026-01-15', -1), '2025-12-15');
    assert.equal(I.isDay('2026-02-29'), false);
    assert.equal(I.isDay('2028-02-29'), true);
    assert.equal(I.weekStartFrom({ weekStart: 1 }), 1);
    assert.equal(I.weekStartFrom({ weekStart: 0 }), 0);
    assert.ok([0, 1, 6].includes(I.weekStartFrom({})));
});

test('what each view shows', () => {
    const week = I.rangeOf('week', '2026-10-14', 1, LA);
    assert.deepEqual([week.first, week.last, week.days.length], ['2026-10-12', '2026-10-18', 7]);
    assert.equal(week.from, I.startOfDay('2026-10-12', LA));
    assert.equal(week.to, I.startOfDay('2026-10-19', LA));
    // A narrow page's week: three days from the day.
    const narrow = I.rangeOf('week', '2026-10-14', 1, LA, { compact: true });
    assert.deepEqual(plain(narrow.days), ['2026-10-14', '2026-10-15', '2026-10-16']);
    // A month: whole weeks around it.
    const month = I.rangeOf('month', '2026-10-14', 0, LA);
    assert.deepEqual([month.first, month.last], ['2026-09-27', '2026-10-31']);
    const monthMon = I.rangeOf('month', '2026-11-03', 1, LA);
    assert.deepEqual([monthMon.first, monthMon.last], ['2026-10-26', '2026-12-06']);
    assert.equal(I.rangeOf('day', '2026-10-14', 1, LA).days.length, 1);
    assert.equal(I.rangeOf('agenda', '2026-10-14', 1, LA).days.length, 30);
    assert.equal(I.stepFrom('week', '2026-10-14', 1), '2026-10-21');
    assert.equal(I.stepFrom('week', '2026-10-14', -1, true), '2026-10-11');
    assert.equal(I.stepFrom('month', '2026-10-31', 1), '2026-11-01');
});

test('a view\'s title, then shorter forms for a header short of room', () => {
    // As the browser's language writes them; this year's days without their year.
    const words = (day, options) => new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
    const span = (a, b, options) => new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).formatRange(new Date(`${a}T12:00:00Z`), new Date(`${b}T12:00:00Z`));
    const year = I.dayIn(Date.now(), LA).slice(0, 4);
    const day = `${year}-06-17`;
    const titles = (view, anchor) => plain(I.rangeOf(view, anchor, 1, LA).titles);
    assert.deepEqual(titles('day', day), [words(day, { weekday: 'long', month: 'long', day: 'numeric' }), words(day, { weekday: 'short', month: 'short', day: 'numeric' })]);
    assert.deepEqual(titles('month', day), [words(day, { month: 'long', year: 'numeric' }), words(day, { month: 'short', year: 'numeric' })]);
    const week = I.rangeOf('week', day, 1, LA);
    assert.deepEqual(plain(week.titles), [span(week.first, week.last, { month: 'short', day: 'numeric', year: 'numeric' }), span(week.first, week.last, { month: 'short', day: 'numeric' })]);
    const agenda = I.rangeOf('agenda', day, 1, LA);
    assert.deepEqual(plain(agenda.titles), [span(agenda.first, agenda.last, { month: 'short', day: 'numeric', year: 'numeric' }), span(agenda.first, agenda.last, { month: 'short', day: 'numeric' })]);
    // Another year's keep it; the title is the longest, and each form is shorter than the one before.
    const later = `${Number(year) + 2}-06-17`;
    assert.deepEqual(titles('day', later), [words(later, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), words(later, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })]);
    assert.equal(I.rangeOf('week', later, 1, LA).titles.length, 1);
    for (const view of I.VIEWS) {
        for (const anchor of [day, later, `${year}-05-01`]) {
            const r = I.rangeOf(view, anchor, 1, LA);
            assert.equal(r.title, r.titles[0]);
            assert.ok(r.titles.every((t, i) => i === 0 || t.length < r.titles[i - 1].length), `${view} ${anchor}: ${r.titles}`);
        }
    }
});

test('week numbers: ISO 8601\'s, and a row\'s for each first day of the week', () => {
    // Week 1 has the year's first Thursday: 2026 starts on one, so it has 53 weeks; 2021 started in 2020's week 53.
    const iso = (days) => days.map((day) => I.isoWeek(day));
    assert.deepEqual(iso(['2026-10-12', '2026-10-14', '2026-10-18', '2026-10-19']), [42, 42, 42, 43]);
    assert.deepEqual(iso(['2025-12-29', '2026-01-01', '2026-12-28', '2026-12-31', '2027-01-03', '2027-01-04']), [1, 1, 53, 53, 53, 1]);
    assert.deepEqual(iso(['2020-12-31', '2021-01-01', '2021-01-04', '2023-01-01', '2024-12-30']), [53, 53, 1, 52, 1]);
    // A row is numbered as most of its days are: from Monday, its own number; from Sunday or Saturday, its Monday's.
    assert.equal(I.weekNumberOf('2026-10-18', 1), 42);
    assert.equal(I.weekNumberOf('2026-10-18', 0), 43);
    assert.equal(I.weekNumberOf('2026-10-17', 6), 43);
    assert.equal(I.weekNumberOf('2026-10-16', 6), 42);
    assert.equal(I.weekNumberOf('2027-01-02', 0), 53);
    assert.equal(I.weekNumberOf('2027-01-03', 0), 1);
    assert.equal(I.weekNumberOf('2027-01-01', 6), 53);
    for (const weekStart of [1, 0, 6]) {
        for (let day = '2025-12-01'; day < '2028-02-01'; day = I.addDays(day, 1)) {
            const row = I.daySpan(I.weekStartOf(day, weekStart), I.addDays(I.weekStartOf(day, weekStart), 6));
            assert.equal(I.weekNumberOf(day, weekStart), I.isoWeek(row.find((d) => I.weekdayOf(d) === 1)), `${day} from ${weekStart}`);
        }
    }
    // The words by a view's title.
    assert.equal(I.weekWords(I.daySpan('2026-10-12', '2026-10-16'), 1), 'Week 42');
    assert.equal(I.weekWords(['2026-10-15', '2026-10-16', '2026-10-19'], 1), 'Weeks 42–43');
    assert.equal(I.weekWords(['2026-10-18'], 0), 'Week 43');
});

test('weekends hidden: the days Week and Month show, and how they step', () => {
    assert.deepEqual([I.isWeekend('2026-10-16'), I.isWeekend('2026-10-17'), I.isWeekend('2026-10-18'), I.isWeekend('2026-10-19')], [false, true, true, false]);
    // Every week's row keeps its five weekdays, whichever day it starts on.
    for (const weekStart of [1, 0, 6, 3]) {
        const row = I.daySpan(I.weekStartOf('2026-10-14', weekStart), I.addDays(I.weekStartOf('2026-10-14', weekStart), 6));
        assert.equal(I.visibleDays(row, true).length, 5);
        assert.ok(I.visibleDays(row, true).every((day) => !I.isWeekend(day)));
        assert.equal(I.visibleDays(row, false).length, 7);
    }
    assert.equal(I.addShownDays('2026-10-16', 1, true), '2026-10-19');
    assert.equal(I.addShownDays('2026-10-19', -1, true), '2026-10-16');
    assert.equal(I.addShownDays('2026-10-14', 3, true), '2026-10-19');
    assert.equal(I.addShownDays('2026-10-16', 1, false), '2026-10-17');
    assert.equal(I.firstShown('2026-10-17', true), '2026-10-19');
    assert.equal(I.firstShown('2026-10-17', false), '2026-10-17');
    // A day that shows in the same month: Aug 1, 2026 is a Saturday; May 31, 2026 a Sunday at the month's end.
    assert.equal(I.shownNear('2026-08-01', true), '2026-08-03');
    assert.equal(I.shownNear('2026-05-31', true), '2026-05-29');
    assert.equal(I.shownNear('2026-05-31', false), '2026-05-31');

    // Week: Monday to Friday, whether the week starts on Monday, Sunday or Saturday; it reads the whole week still.
    for (const weekStart of [1, 0, 6]) {
        const week = I.rangeOf('week', '2026-10-14', weekStart, LA, { hideWeekends: true });
        assert.deepEqual(plain(week.days), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
        assert.deepEqual([week.first, week.last], ['2026-10-12', '2026-10-16']);
        const all = I.rangeOf('week', '2026-10-14', weekStart, LA);
        assert.deepEqual([week.from, week.to, week.spanFirst, week.spanLast], [all.from, all.to, all.first, all.last]);
    }
    assert.equal(I.stepFrom('week', '2026-10-14', 1, false, true), '2026-10-21');
    // A narrow page's three days: the next weekdays, from Monday on a weekend's day; a step is three weekdays.
    const narrow = (day) => plain(I.rangeOf('week', day, 1, LA, { compact: true, hideWeekends: true }).days);
    assert.deepEqual(narrow('2026-10-15'), ['2026-10-15', '2026-10-16', '2026-10-19']);
    assert.deepEqual(narrow('2026-10-17'), ['2026-10-19', '2026-10-20', '2026-10-21']);
    assert.equal(I.rangeOf('week', '2026-10-17', 1, LA, { compact: true, hideWeekends: true }).spanFirst, '2026-10-17');
    assert.equal(I.stepFrom('week', '2026-10-15', 1, true, true), '2026-10-20');
    assert.equal(I.stepFrom('week', '2026-10-20', -1, true, true), '2026-10-15');
    assert.equal(I.stepFrom('week', '2026-10-17', 1, true, true), '2026-10-22');
    // Day and Agenda keep every day.
    assert.equal(I.rangeOf('day', '2026-10-17', 1, LA, { hideWeekends: true }).days[0], '2026-10-17');
    assert.equal(I.rangeOf('agenda', '2026-10-14', 1, LA, { hideWeekends: true }).days.length, 30);
    assert.equal(I.stepFrom('day', '2026-10-16', 1, false, true), '2026-10-17');

    // Month: rows of five; a row whose weekdays are all in the month before or after goes.
    const august = I.rangeOf('month', '2026-08-14', 1, LA, { hideWeekends: true });
    assert.equal(august.days.length, 25);
    assert.deepEqual([august.first, august.last, august.spanFirst, august.spanLast], ['2026-08-03', '2026-09-04', '2026-07-27', '2026-09-06']);
    assert.ok(august.days.every((day) => !I.isWeekend(day)));
    const may = I.rangeOf('month', '2026-05-10', 0, LA, { hideWeekends: true });
    assert.deepEqual([may.first, may.last, may.days.length], ['2026-04-27', '2026-05-29', 25]);
    assert.equal(I.rangeOf('month', '2026-05-10', 0, LA).days.length, 42);
});

test('weekends hidden: bars cut at the days on show, a short event on a hidden day left out', () => {
    const ev = (id, start, end) => ({ id, start: Date.parse(start), end: Date.parse(end) });
    const trip = { id: 'trip', allDay: true, startDay: '2026-10-16', lastDay: '2026-10-19', start: 0, end: 0 };
    const weekend = { id: 'weekend', allDay: true, startDay: '2026-10-17', lastDay: '2026-10-18', start: 0, end: 0 };
    const saturday = ev('saturday', '2026-10-17T17:00:00Z', '2026-10-17T18:00:00Z'); // 10:00–11:00 in Los Angeles
    const sundayNight = ev('late', '2026-10-19T05:00:00Z', '2026-10-19T08:00:00Z'); // Sunday 22:00 to Monday 01:00
    const bars = (days, hide = true) => plain(I.barItems([trip, weekend, saturday, sundayNight], days, LA, () => true, hide).map((b) => [b.key, b.a, b.b, b.contStart, b.contEnd]));
    // A week from Sunday or Monday: Monday to Friday, the trip going on past Friday, then on from before Monday.
    assert.deepEqual(bars(I.daySpan('2026-10-12', '2026-10-16')), [['trip', 4, 4, false, true]]);
    assert.deepEqual(bars(I.daySpan('2026-10-19', '2026-10-23')), [['trip', 0, 0, true, false]]);
    // The overnight event starts on the hidden Sunday, so it is left out; with weekends on show a row from Monday has it, as before.
    assert.deepEqual(bars(I.daySpan('2026-10-19', '2026-10-25'), false).map((b) => b[0]), ['trip', 'late']);
    // A week from Wednesday: the trip one bar over Friday and Monday, the weekend between them out of sight.
    assert.deepEqual(bars(['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20']), [['trip', 2, 3, false, false]]);
});

test('short times for a month\'s day follow the locale', () => {
    const at = (h, m) => Date.parse(`2026-10-12T${String(h + 7).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
    const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: LA }).formatToParts(at(9, 30));
    const period = parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
    if (/^[ap]\.?\s?m\.?$/i.test(period.trim())) {
        assert.equal(I.shortTime(at(9, 30), LA), '9:30am');
        assert.equal(I.shortTime(at(11, 0), LA), '11am');
        assert.equal(I.shortTime(at(15, 5), LA), '3:05pm');
    } else {
        // 24-hour clocks (and other ways of writing the half of the day) as the locale writes them.
        assert.equal(I.shortTime(at(9, 30), LA), parts.map((p) => p.value).join(''));
    }
});

test('text on a calendar\'s color is readable', () => {
    for (const color of I.PALETTE) {
        const text = I.textOn(color);
        const ratio = I.contrast(I.luminance(I.rgbOf(color)), I.luminance(I.rgbOf(text)));
        assert.ok(ratio >= 3, `${color} with ${text}: ${ratio.toFixed(2)}`);
    }
    assert.equal(I.textOn('#ffeb3b'), '#111412');
    assert.equal(I.textOn('#1e3a8a'), '#ffffff');
    assert.equal(I.textOn('not a color'), '#ffffff');
    assert.equal(I.colorOf('nope'), I.PALETTE[0]);
});

test('repeat rules: the Repeat field\'s choices and back', () => {
    const day = '2026-10-12'; // a Monday, the second in October
    const round = (mode) => I.ruleFromRepeat({ ...I.repeatFromRule('', day, false, LA), mode }, day, false, LA);
    assert.equal(round('weekly'), 'FREQ=WEEKLY;BYDAY=MO');
    assert.equal(round('weekdays'), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    assert.equal(round('monthly'), 'FREQ=MONTHLY;BYMONTHDAY=12');
    assert.equal(round('monthly-nth'), 'FREQ=MONTHLY;BYDAY=2MO');
    assert.equal(round('yearly'), 'FREQ=YEARLY');
    assert.equal(round('none'), '');
    for (const [rule, mode] of [['FREQ=WEEKLY;BYDAY=MO', 'weekly'], ['RRULE:FREQ=WEEKLY', 'weekly'], ['FREQ=DAILY', 'daily'], ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'weekdays'],
        ['FREQ=MONTHLY;BYMONTHDAY=12', 'monthly'], ['FREQ=MONTHLY;BYDAY=2MO', 'monthly-nth'], ['FREQ=YEARLY', 'yearly'], ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', 'custom'],
        ['FREQ=DAILY;COUNT=5', 'custom'], ['FREQ=WEEKLY;BYSETPOS=1;BYDAY=MO', 'keep'], ['FREQ=MONTHLY;BYDAY=3TU', 'keep'], ['garbage', 'keep']]) {
        assert.equal(I.repeatFromRule(rule, day, false, LA).mode, mode, rule);
    }
    // A rule the field can't show is kept exactly as it was.
    const odd = I.repeatFromRule('FREQ=WEEKLY;BYSETPOS=1;BYDAY=MO', day, false, LA);
    assert.equal(I.ruleFromRepeat(odd, day, false, LA), 'FREQ=WEEKLY;BYSETPOS=1;BYDAY=MO');
    // Custom: every 2 weeks on Monday and Wednesday, until a day (its last second on the event's clock).
    const custom = I.repeatFromRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', day, false, LA);
    custom.custom = { ...custom.custom, end: 'on', until: '2026-12-31' };
    assert.equal(I.ruleFromRepeat(custom, day, false, LA), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20270101T075959Z');
    const back = I.repeatFromRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20270101T075959Z', day, false, LA);
    assert.equal(back.custom.until, '2026-12-31');
    assert.equal(I.ruleFromRepeat({ ...custom, custom: { ...custom.custom, end: 'on' } }, day, true, LA), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231');
    assert.equal(I.repeatProblem({ mode: 'custom', custom: { ...custom.custom, days: [] } }, day), 'Pick at least one day of the week.');
    assert.equal(I.repeatProblem({ mode: 'custom', custom: { ...custom.custom, until: '2026-01-01' } }, day), 'The end date is on or after the start.');
});

test('events side by side in a day: close starts share the width, a later one goes over, indented', () => {
    const round = (n) => Number(n.toFixed(3));
    const place = (items, maxCols) => Object.fromEntries([...I.columnsOf(items, 20, 30, maxCols).places].map(([key, p]) => [key, [round(p.left), round(p.width), p.level]]));
    // Alone: the whole column.
    assert.deepEqual(place([{ key: 'a', from: 540, to: 600 }]), { a: [0, 1, 0] });
    // Starting together: halves.
    assert.deepEqual(place([{ key: 'a', from: 540, to: 600 }, { key: 'b', from: 540, to: 570 }]), { a: [0, 0.5, 0], b: [0.5, 0.5, 0] });
    // One that starts an hour into a long one: over it, indented, the first keeps its width.
    assert.deepEqual(place([{ key: 'long', from: 540, to: 720 }, { key: 'later', from: 600, to: 660 }]), { long: [0, 1, 0], later: [0.14, 0.86, 1] });
    // Back to back: no overlap, each the whole column.
    assert.deepEqual(place([{ key: 'a', from: 540, to: 600 }, { key: 'b', from: 600, to: 660 }]), { a: [0, 1, 0], b: [0, 1, 0] });
    // Four at the same time: quarters.
    const four = place(['a', 'b', 'c', 'd'].map((key) => ({ key, from: 600, to: 660 })));
    assert.deepEqual(Object.values(four).map((p) => p[1]), [0.25, 0.25, 0.25, 0.25]);
    assert.deepEqual(Object.values(four).map((p) => p[0]).sort(), [0, 0.25, 0.5, 0.75]);
    // More than fit side by side: the first ones in thirds, and "+2" in the last third for the others.
    const crowd = ['a', 'b', 'c', 'd'].map((key) => ({ key, from: 600, to: 660 }));
    const capped = I.columnsOf(crowd, 20, 30, 3);
    assert.deepEqual(Object.keys(place(crowd, 3)), ['a', 'b']);
    assert.deepEqual(plain(capped.more.map((m) => [round(m.left), round(m.width), m.from, m.to, m.count])), [[0.667, 0.333, 600, 660, 2]]);
    // Ones left out at different times get a "+N" each.
    const spread = [...crowd, { key: 'e', from: 600, to: 900 }, { key: 'f', from: 840, to: 870 }, { key: 'g', from: 840, to: 870 }];
    const runs = I.columnsOf(spread, 20, 30, 3).more.map((m) => [m.from, m.to, m.count]);
    assert.deepEqual(plain(runs), [[600, 660, 3], [840, 870, 1]]);
    // Room enough: nothing left out.
    assert.equal(I.columnsOf(crowd, 20, 30, 8).more.length, 0);
});

test('a day\'s timed events on its clock, and the all-day row\'s bars', () => {
    const ev = (id, start, end, extra = {}) => ({ id, start: Date.parse(start), end: Date.parse(end), ...extra });
    const late = ev('late', '2026-10-13T05:00:00Z', '2026-10-13T08:00:00Z'); // 22:00–01:00 in Los Angeles
    const segs = I.daySegments([late, ev('x', '2026-10-12T16:00:00Z', '2026-10-12T17:00:00Z')], '2026-10-12', LA);
    assert.deepEqual(plain(segs.map((s) => [s.key, s.from, s.to])), [['late', 22 * 60, 1440], ['x', 9 * 60, 10 * 60]]);
    assert.deepEqual(plain(I.daySegments([late], '2026-10-13', LA).map((s) => [s.from, s.to])), [[0, 60]]);
    const days = I.daySpan('2026-10-11', '2026-10-17');
    // An overnight event stays on the day it starts in a month's row; an all-day one spans its days, cut at the row's ends.
    const all = I.barItems([late, { id: 'trip', allDay: true, startDay: '2026-10-09', lastDay: '2026-10-12', start: 0, end: 0 }], days, LA, () => true);
    assert.deepEqual(plain(all.map((b) => [b.key, b.a, b.b, b.contStart, b.contEnd])), [['late', 1, 1, false, false], ['trip', 0, 1, true, false]]);
    // Lanes, and "+N more" where a day has more than fit.
    const layout = I.lanesOf([{ key: 'a', a: 0, b: 2 }, { key: 'b', a: 1, b: 1 }, { key: 'c', a: 1, b: 1 }], 7);
    assert.equal(layout.lanes, 3);
    const fit = I.fitLanes(layout, 2);
    assert.deepEqual(plain(fit.more), [{ day: 1, count: 2, lane: 1 }]);
    assert.deepEqual(plain(fit.pieces.map((p) => [p.key, p.a, p.b])), [['a', 0, 2]]);
});

test('a failed call in one sentence: the plugin\'s own words where it has them', () => {
    assert.equal(I.errorText({ code: 'calendar/refused', message: 'that calendar is read-only' }), 'That calendar is read-only.');
    assert.equal(I.errorText({ code: 'calendar/needs-notify', message: 'Saving this emails an update to ann@example.com' }), 'Saving this emails an update to ann@example.com.');
    assert.equal(I.errorText({ code: 'calendar/unreachable', message: 'x' }), I.TEXT.unreachable);
    assert.match(I.errorText({ code: 'calendar/failed', message: 'the server said no' }), /^That didn't work: The server said no\.$/);
    assert.equal(I.errorText(undefined), I.TEXT.unreachable);
});

test('who a change can email, as far as the window can tell', () => {
    const cal = (kind, canEmail = true) => ({ id: `c-${kind}`, kind, canEmail });
    const own = { id: 'ev-1', organizer: null };
    const organized = { id: 'ev-2', organizer: { email: 'me@example.com' } };
    const invitation = { id: 'ev-3', invitation: true, canRespond: true, organizer: { email: 'boss@example.com' } };
    const mode = (args) => { const m = I.mailMode(args); return `${m.mode}:${m.to}${m.cannot ? ':cannot' : ''}`; };
    // Nobody to tell.
    assert.equal(mode({ kind: 'create', calendar: cal('google'), guests: 0 }), 'none:guests');
    // Google emails only when asked: a box to tick.
    assert.equal(mode({ kind: 'create', calendar: cal('google'), guests: 2 }), 'ask:guests');
    assert.equal(mode({ kind: 'delete', calendar: cal('google'), occurrence: organized, guests: 2 }), 'ask:guests');
    // Microsoft emails them anyway: the host asks (needs-notify), the window says so ahead.
    assert.equal(mode({ kind: 'update', calendar: cal('microsoft'), occurrence: organized, guests: 1 }), 'always:guests');
    // A CalDAV server makes a meeting of the user's own event only when told to; one they organize gets emailed anyway.
    assert.equal(mode({ kind: 'create', calendar: cal('caldav'), guests: 1 }), 'ask:guests');
    assert.equal(mode({ kind: 'update', calendar: cal('caldav'), occurrence: own, guests: 1 }), 'ask:guests');
    assert.equal(mode({ kind: 'update', calendar: cal('caldav'), occurrence: organized, guests: 1 }), 'always:guests');
    // Calendars that can't email (kept in DSH, subscriptions, CalDAV without scheduling): never offered, and said.
    assert.equal(mode({ kind: 'create', calendar: cal('local', false), guests: 1 }), 'none:guests:cannot');
    assert.equal(mode({ kind: 'delete', calendar: cal('local', false), occurrence: own, guests: 1 }), 'none:guests');
    // Someone else's invitation: no change emails anyone, taking it out may tell the organizer.
    assert.equal(mode({ kind: 'update', calendar: cal('google'), occurrence: invitation, guests: 3 }), 'none:organizer');
    assert.equal(mode({ kind: 'delete', calendar: cal('google'), occurrence: invitation, guests: 3 }), 'ask:organizer');
    assert.equal(mode({ kind: 'delete', calendar: cal('microsoft'), occurrence: invitation, guests: 3 }), 'none:organizer');
    assert.equal(mode({ kind: 'delete', calendar: cal('caldav'), occurrence: invitation, guests: 3, scope: 'one' }), 'always:organizer');
    assert.equal(I.roleOf(invitation), 'guest');
    assert.equal(I.roleOf(own), 'own');
    assert.equal(I.roleOf(organized), 'organizer');
    assert.deepEqual(I.othersOf([{ email: 'me@example.com', self: true }, { email: 'ann@example.com' }, { name: 'no address' }]).map((p) => p.email), ['ann@example.com']);
});

test('notify goes to the host only after the user\'s own click', async () => {
    const draft = (extra = {}) => ({
        title: 'Review', allDay: false, startDay: '2026-10-12', startTime: '09:00', endDay: '2026-10-12', endTime: '10:00', timeZone: LA,
        repeat: { mode: 'none', custom: {} }, calendarId: 'c-1', location: '', url: '', description: '', alarms: [], guests: [{ email: 'ann@example.com' }],
        busy: true, private: false, notify: null, ...extra,
    });
    assert.equal(I.createInput(draft()).notify, undefined);
    assert.equal(I.createInput(draft({ notify: true })).notify, true);
    assert.equal(I.createInput(draft({ notify: true, guests: [] })).notify, undefined);
    const before = draft();
    assert.equal(I.changePatch(before, draft({ title: 'Review 2' }), { repeatTouched: false, originalRule: '' }).notify, undefined);
    assert.equal(I.changePatch(before, draft({ title: 'Review 2', notify: true }), { repeatTouched: false, originalRule: '' }).notify, true);
    // Nothing changed: no patch, so nobody is told anything.
    assert.deepEqual({ ...I.changePatch(before, draft({ notify: true }), { repeatTouched: false, originalRule: '' }) }, {});

    // The host says the change would email people: the user is asked, naming them; only yes makes it again,
    // with notify, held to the people the user was shown (approved).
    const refusal = { ok: false, error: { code: 'calendar/needs-notify', message: 'Saving this emails an update to ann@example.com', details: { people: ['ann@example.com', 7] } } };
    const calls = [];
    const make = (answer, first = refusal) => async (how) => { calls.push(plain(how)); return how.notify ? answer : first; };
    const asked = [];
    const ask = (send) => async (question) => { asked.push(question); return send; };
    const done = { ok: true, value: { occurrence: { id: 'ev-1', emailed: { what: 'an update', to: ['ann@example.com'] } } } };
    assert.deepEqual(await I.withConsent(ask(true), 'save', make(done)), done);
    assert.deepEqual(calls, [{}, { notify: true, approved: ['ann@example.com'] }]);
    assert.deepEqual(plain(asked.map((q) => [q.title, q.no, q.yes, q.people.map((p) => p.email)])), [['Email an update to ann@example.com?', 'Don\'t save', 'Save and email', ['ann@example.com']]]);
    calls.length = 0;
    const kept = await I.withConsent(ask(false), 'save', make(done));
    assert.equal(kept.kept, true);
    assert.deepEqual(calls, [{}]);
    // A refusal that names nobody: yes says notify alone, and the host holds the change to its own first look.
    calls.length = 0;
    const unnamed = { ok: false, error: { code: 'calendar/needs-notify', message: 'Saving this emails invitations' } };
    assert.deepEqual(await I.withConsent(ask(true), 'add', make(done, unnamed)), done);
    assert.deepEqual(calls, [{}, { notify: true }]);
    // The event changed between the question and yes, and the host doesn't say who it reaches now: its refusal as it is.
    calls.length = 0;
    const changed = { ok: false, error: { code: 'calendar/changed', message: 'The event changed since this change was looked at' } };
    assert.deepEqual(await I.withConsent(ask(true), 'save', make(changed)), changed);
    assert.equal(calls.length, 2);
    // Any other answer is the result as it is, asked nothing.
    calls.length = 0;
    asked.length = 0;
    const refused = { ok: false, error: { code: 'calendar/refused', message: 'read-only' } };
    assert.deepEqual(await I.withConsent(ask(true), 'save', async (how) => { calls.push(plain(how)); return refused; }), refused);
    assert.deepEqual([calls, asked], [[{}], []]);
});

test('a change that reaches anyone waits for the user to see who: approved on every repeat, asked again when it changed', async () => {
    const ann = 'ann@example.com';
    const bob = 'bob@example.com';
    const reach = (people) => ({ ok: false, error: { code: 'calendar/needs-approval', message: 'This would change it on the calendars of …', details: { people, mail: { reached: { how: 'change', to: people } } } } });
    const changed = (people) => ({ ok: false, error: { code: 'calendar/changed', message: 'The event changed since …', details: { people, mail: { reached: { how: 'change', to: people } } } } });
    const done = { ok: true, value: { occurrence: { id: 'ev-1' } } };
    const run = async (answers, replies) => {
        const calls = [];
        const questions = [];
        const make = async (how) => { calls.push(plain(how)); return answers[calls.length - 1]; };
        const ask = async (q) => { questions.push(q); return replies[questions.length - 1]; };
        return { result: await I.withConsent(ask, 'save', make), calls, questions };
    };
    // Reached without email (Google, the box unticked): yes makes it again with approved, and without notify.
    let r = await run([reach([ann]), done], [true]);
    assert.deepEqual(r.result, done);
    assert.deepEqual(r.calls, [{}, { approved: [ann] }]);
    assert.deepEqual(plain([r.questions[0].title, r.questions[0].yes, r.questions[0].no]), ['Also change it on ann@example.com\'s Google calendar?', 'Save', 'Don\'t save']);
    // It changed meanwhile: asked again with everyone it reaches now, the new one marked; yes holds it to them.
    r = await run([reach([ann]), changed([ann, bob]), done], [true, true]);
    assert.deepEqual(r.result, done);
    assert.deepEqual(r.calls, [{}, { approved: [ann] }, { approved: [ann, bob] }]);
    assert.equal(r.questions[1].changed, true);
    assert.deepEqual(plain(r.questions[1].people.map((p) => [p.email, p.fresh])), [[ann, false], [bob, true]]);
    // Not made after all: the change is kept, as 'changed', for the dialog to say so.
    r = await run([reach([ann]), changed([ann, bob])], [true, false]);
    assert.deepEqual(plain([r.result.kept, r.result.error.code, r.calls.length]), [true, 'calendar/changed', 2]);
    // A refusal that names no one isn't asked about: it's shown as it is.
    const nobody = { ok: false, error: { code: 'calendar/needs-approval', message: 'This would …', details: {} } };
    r = await run([nobody], []);
    assert.deepEqual([r.result, r.questions.length], [nobody, 0]);
    // It changed with nobody new to ask about ('changed' naming no one): not asked again, the refusal as it is, for the user to look at it again.
    const nobodyNew = { ok: false, error: { code: 'calendar/changed', message: 'The event changed on its server meanwhile …', details: { people: [] } } };
    r = await run([reach([ann]), nobodyNew], [true]);
    assert.deepEqual([r.result, r.calls.length, r.questions.length], [nobodyNew, 2, 1]);
    // A host that names someone new each time is asked four times at most: the fifth call stops it, saying why in the window's words.
    r = await run([reach([ann]), changed([bob]), changed([ann]), changed([bob]), changed([ann]), changed([bob])], [true, true, true, true, true, true]);
    assert.equal(r.calls.length, 5);
    assert.equal(r.questions.length, 4);
    const keepsChanging = 'It keeps changing on its server or in another app, so nothing was done. Look at it again first.';
    assert.deepEqual(plain(r.result), { ok: false, stopped: true, error: { code: 'calendar/changed', message: keepsChanging } });
    assert.equal(I.errorText(r.result.error), keepsChanging);
    // A fifth answer that asks nothing more is the result as it is.
    const refused = { ok: false, error: { code: 'calendar/refused', message: 'read-only' } };
    r = await run([reach([ann]), changed([bob]), changed([ann]), changed([bob]), refused], [true, true, true, true]);
    assert.deepEqual([r.result, r.calls.length], [refused, 5]);
    // What the answers add to a call: notify when ticked or said yes to, approved and dropChanges as given.
    assert.deepEqual(plain(I.asked(true, { approved: [ann] })), { notify: true, approved: [ann] });
    assert.deepEqual(plain(I.asked(false, { approved: [] })), { approved: [] });
    assert.deepEqual(plain(I.asked(undefined, { notify: true, dropChanges: true })), { notify: true, dropChanges: true });
    assert.deepEqual(plain(I.asked(false, {})), {});
});

test('the question before an email names everyone, with what they get and why, in the user\'s words', () => {
    const six = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com', 'f@example.com'];
    const why = 'Microsoft emails a meeting\'s guests about each change to it';
    let q = I.consentQuestion({ code: 'calendar/needs-notify', details: { people: six, mail: { emailed: { what: 'an update', to: six }, why } } }, 'save');
    assert.deepEqual(plain([q.title, q.why, q.no, q.yes, q.code, q.changed]), ['Email an update to 6 guests?', `${why}.`, 'Don\'t save', 'Save and email', 'needs-notify', false]);
    assert.deepEqual(plain(q.people.map((p) => p.email)), six);
    assert.ok(q.people.every((p) => p.gets === 'An update' && p.emailed && !p.fresh));
    // A delete to one person; invitations each read as one.
    q = I.consentQuestion({ code: 'calendar/needs-approval', details: { people: ['ann@example.com'], mail: { emailed: { what: 'a cancellation', to: ['ann@example.com'] } } } }, 'delete');
    assert.deepEqual(plain([q.title, q.why, q.yes, q.no]), ['Email a cancellation to ann@example.com?', 'You chose to tell them by email.', 'Delete and email', 'Don\'t delete']);
    q = I.consentQuestion({ code: 'calendar/needs-approval', details: { people: six.slice(0, 2), mail: { emailed: { what: 'invitations', to: six.slice(0, 2) } } } }, 'add');
    assert.deepEqual(plain([q.title, q.people[0].gets, q.yes]), ['Email invitations to 2 guests?', 'An invitation', 'Add and email']);
    // Reached without an email: on, off, or changed on their Google calendars.
    q = I.consentQuestion({ code: 'calendar/needs-approval', details: { people: six.slice(0, 3), mail: { reached: { how: 'add', to: six.slice(0, 3) } } } }, 'add');
    assert.deepEqual(plain([q.title, q.why, q.yes, q.people[2].gets]), ['Also put it on 3 guests\' Google calendars?', 'Google puts a meeting on its guests\' calendars by itself, without an email.', 'Add', 'Added to their calendar, no email']);
    q = I.consentQuestion({ code: 'calendar/needs-approval', details: { people: ['ann@example.com'], mail: { reached: { how: 'remove', to: ['ann@example.com'] } } } }, 'Don\'t move it');
    assert.deepEqual(plain([q.title, q.yes, q.no]), ['Also take it off ann@example.com\'s Google calendar?', 'Move', 'Don\'t move']);
    // Emailed some and reached others: the title counts those emailed, the list says what each gets.
    q = I.consentQuestion({ code: 'calendar/needs-approval', details: { people: six.slice(0, 2), mail: { emailed: { what: 'an update', to: [six[0]] }, reached: { how: 'change', to: [six[1]] } } } }, 'save');
    assert.deepEqual(plain([q.title, q.people.map((p) => p.gets)]), ['Email an update to a@example.com?', ['An update', 'Changed on their calendar, no email']]);
    // An older host's refusal names its people alone: they're emailed what the change sends, and nothing says why.
    q = I.consentQuestion({ code: 'calendar/needs-notify', details: { people: ['ann@example.com'] } }, 'add');
    assert.deepEqual(plain([q.title, q.why, q.people[0].gets]), ['Email invitations to ann@example.com?', '', 'An invitation']);
    // Asked again after it changed: everyone now, the ones the last question didn't name marked new.
    q = I.consentQuestion({ code: 'calendar/changed', details: { people: six.slice(0, 2), mail: { emailed: { what: 'an update', to: six.slice(0, 2) } } } }, 'save', [six[0]]);
    assert.deepEqual(plain([q.changed, q.people.map((p) => p.fresh)]), [true, [false, true]]);
    assert.deepEqual(plain([I.consentWords('Don\'t delete it').yes, I.consentWords('anything').yes]), ['Delete', 'Save']);
    // Someone else's Google meeting that lets its guests change it: the change is made for everyone on it, its organizer too.
    const olga = ['olga@example.com', 'pat@example.com'];
    q = I.consentQuestion({ code: 'calendar/needs-approval', details: { people: olga, mail: { reached: { how: 'change', to: olga } } } }, 'invitation');
    assert.deepEqual(plain([q.title, q.why, q.no, q.yes, q.people.map((p) => p.gets)]), [
        'Also change it on 2 people\'s Google calendars?', 'Its organizer lets guests change it, so Google makes your change for everyone on it, without an email.',
        'Don\'t save', 'Save', ['Changed on their calendar, no email', 'Changed on their calendar, no email']]);
    q = I.consentQuestion({ code: 'calendar/needs-approval', details: { people: [olga[0]], mail: { reached: { how: 'change', to: [olga[0]] } } } }, 'invitation');
    assert.equal(q.title, 'Also change it on olga@example.com\'s Google calendar?');
});

test('a series that would lose part of itself on a move asks first, then may ask about emails too', async () => {
    const words = 'Moving this series to Calendar would drop 1 occurrence changed on its own: Microsoft takes a new repeating event as its rule alone.';
    const drops = { ok: false, error: { code: 'calendar/drops-changes', message: words } };
    const needs = { ok: false, error: { code: 'calendar/needs-notify', message: 'Moving it emails invitations to ann@example.com', details: { people: ['ann@example.com'] } } };
    const done = { ok: true, value: { occurrence: { id: 'ev-9', calendarId: 'c-ms' } } };
    const run = async ({ dropAnswer, sendAnswer, answers, drop = true }) => {
        const calls = [];
        const questions = [];
        const make = async (how) => { calls.push(plain(how)); return answers[calls.length - 1]; };
        const ask = async (q) => { questions.push(['send', q.title]); return sendAnswer; };
        const dropAsk = async (text) => { questions.push(['drop', text]); return dropAnswer; };
        const result = await I.withConsent(ask, 'move', make, drop ? dropAsk : undefined);
        return { result, calls, questions };
    };
    // Move anyway: made again with dropChanges.
    let r = await run({ dropAnswer: true, answers: [drops, done] });
    assert.deepEqual(r.result, done);
    assert.deepEqual(r.calls, [{}, { dropChanges: true }]);
    assert.deepEqual(r.questions, [['drop', words]]);
    // Don't move it: nothing more is sent.
    r = await run({ dropAnswer: false, answers: [drops] });
    assert.equal(r.result.kept, true);
    assert.equal(r.result.error.code, 'calendar/drops-changes');
    assert.deepEqual(r.calls, [{}]);
    // Moved anyway, then it would email people: asked again, and Send keeps dropChanges.
    r = await run({ dropAnswer: true, sendAnswer: true, answers: [drops, needs, done] });
    assert.deepEqual(r.result, done);
    assert.deepEqual(r.calls, [{}, { dropChanges: true }, { dropChanges: true, notify: true, approved: ['ann@example.com'] }]);
    assert.deepEqual(r.questions.map((q) => q[0]), ['drop', 'send']);
    // Without a way to ask (no move there), the refusal is the answer.
    r = await run({ drop: false, answers: [drops] });
    assert.deepEqual(r.result, drops);
    assert.deepEqual(r.calls, [{}]);
});

test('the window\'s own refusals keep the host\'s words', () => {
    for (const code of ['calendar/changed', 'calendar/drops-changes', 'calendar/choose-calendar', 'calendar/needs-approval', 'calendar/half-moved']) {
        assert.equal(I.errorText({ code, message: 'the host says why' }), 'The host says why.');
    }
    assert.equal(I.CHOOSE_CALENDAR, 'Choose the calendar it goes to.');
});

test('the store asks the host\'s version and reads state again only when it moved; after a change, state as it is after it', async () => {
    const calls = [];
    let version = { ok: true, value: { version: 1, syncing: false } };
    let now = { version: 1, syncing: false, calendars: [], accounts: [] };
    let hold;
    const link = {
        async call(method) {
            calls.push(method);
            if (method === 'version') return version;
            if (method === 'state') {
                const value = now;
                if (hold) await hold;
                return { ok: true, value };
            }
            if (method === 'createEvent') {
                now = { ...now, version: now.version + 1, calendars: [{ id: 'cal-new' }] };
                return { ok: true, value: {} };
            }
            return { ok: false, error: { code: 'calendar/failed', message: 'No.' } };
        },
    };
    const store = I.calendarStore(link);
    await store.loadState();
    await store.poll();
    assert.deepEqual(plain(calls), ['state', 'version'], 'nothing moved: no state read');
    now = { ...now, version: 2 };
    version = { ok: true, value: { version: 2, syncing: false } };
    await store.poll();
    assert.deepEqual(plain(calls.slice(2)), ['version', 'state'], 'the version moved: state read');
    assert.equal(store.state().version, 2);
    version = { ok: true, value: { version: 2, syncing: true } };
    await store.poll();
    assert.deepEqual(plain(calls.slice(4)), ['version', 'state'], 'a sync started: state read');
    version = { ok: false, error: { code: 'dsh/unknown-method', message: 'No such method.' } };
    await store.poll();
    assert.deepEqual(plain(calls.slice(6)), ['version', 'state'], 'a host without version(): state read');
    // A state read that left before a change doesn't stand for the state after it.
    let release;
    hold = new Promise((resolve) => { release = resolve; });
    const early = store.loadState();
    const acting = store.act('createEvent', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    hold = undefined;
    release();
    await early;
    const result = await acting;
    assert.equal(result.ok, true);
    assert.equal(store.state().version, 3);
    assert.deepEqual(plain(store.state().calendars), [{ id: 'cal-new' }], 'the new calendar is there once the change is done');
    // A notice that stays until it's closed (a move that stopped halfway).
    store.keepNotice('It was copied to Work, but not taken out of Home.');
    store.keepNotice('Another one.');
    assert.deepEqual(plain(store.notices().map((n) => n.text)), ['It was copied to Work, but not taken out of Home.', 'Another one.']);
    store.closeNotice(store.notices()[0].id);
    assert.deepEqual(plain(store.notices().map((n) => n.text)), ['Another one.']);
});

test('what was emailed, in a sentence', () => {
    assert.equal(I.emailedText({ what: 'an update', to: ['ann@example.com', 'bob@example.com'] }), 'Emailed an update to ann@example.com and bob@example.com.');
    assert.equal(I.emailedText({ what: 'the invitation', to: ['a@x.org', 'b@x.org', 'c@x.org', 'd@x.org', 'e@x.org'] }), 'Emailed the invitation to a@x.org, b@x.org, c@x.org and 2 others.');
    assert.equal(I.emailedText({ to: [] }), '');
    assert.equal(I.emailedText(undefined), '');
    // A chat's record names everyone.
    assert.equal(I.emailedText({ what: 'the invitation', to: ['a@x.org', 'b@x.org', 'c@x.org', 'd@x.org', 'e@x.org'] }, true), 'Emailed the invitation to a@x.org, b@x.org, c@x.org, d@x.org and e@x.org.');
});

test('who a change emailed, and whose calendars it reached without email', () => {
    const ann = ['ann@example.com'];
    assert.equal(I.contactText({ reached: { how: 'add', to: ann } }), 'Put on the calendars of ann@example.com, without emailing anyone.');
    assert.equal(I.contactText({ reached: { how: 'remove', to: ['ann@example.com', 'bob@example.com'] } }), 'Taken off the calendars of ann@example.com and bob@example.com, without emailing anyone.');
    assert.equal(I.contactText({ reached: { how: 'change', to: ann } }), 'Changed on the calendars of ann@example.com, without emailing anyone.');
    assert.equal(I.contactText({ reached: { how: 'other', to: ann } }), 'Changed on the calendars of ann@example.com, without emailing anyone.');
    // Emailed some, reached others.
    assert.equal(I.contactText({ emailed: { what: 'a cancellation', to: ann }, reached: { how: 'add', to: ['bob@example.com'] } }),
        'Emailed a cancellation to ann@example.com. Put on the calendars of bob@example.com.');
    assert.equal(I.contactText({ emailed: { what: 'an update', to: ann } }), 'Emailed an update to ann@example.com.');
    for (const nothing of [undefined, {}, { reached: { how: 'add', to: [] } }, { reached: { how: 'add', to: [1, ''] } }, { reached: 'ann' }]) assert.equal(I.contactText(nothing), '');
    // A toast names three and a number; a chat's card, everyone.
    const five = ['a@x.org', 'b@x.org', 'c@x.org', 'd@x.org', 'e@x.org'];
    assert.equal(I.contactText({ emailed: { what: 'an update', to: five }, reached: { how: 'change', to: five } }),
        'Emailed an update to a@x.org, b@x.org, c@x.org and 2 others. Changed on the calendars of a@x.org, b@x.org, c@x.org and 2 others.');
    assert.equal(I.contactText({ emailed: { what: 'an update', to: five }, reached: { how: 'change', to: five } }, { all: true }),
        'Emailed an update to a@x.org, b@x.org, c@x.org, d@x.org and e@x.org. Changed on the calendars of a@x.org, b@x.org, c@x.org, d@x.org and e@x.org.');
});

test('after a move, the other changes go to the same occurrence in the moved event', () => {
    const moved = { id: 'ev-new.20261012T093000', eventId: 'ev-new', calendarId: 'c-2' };
    assert.equal(I.sameOccurrence(moved, { id: 'ev-old.20261019T093000' }).id, 'ev-new.20261019T093000');
    assert.equal(I.sameOccurrence({ id: 'ev-new', eventId: 'ev-new' }, { id: 'ev-old' }).id, 'ev-new');
    const before = { id: 'ev-old.20261019T093000' };
    assert.equal(I.sameOccurrence(undefined, before), before);
    // An answer the page can follow has its time; a move the host lost sight of answers with an id alone.
    assert.equal(I.placed({ id: 'ev-1', start: Date.UTC(2026, 9, 12, 9), end: Date.UTC(2026, 9, 12, 10) }), true);
    assert.equal(I.placed({ id: 'ev-1', allDay: true, startDay: '2026-10-12' }), true);
    for (const stub of [undefined, null, { id: 'ev-1' }, { id: 'ev-1', allDay: true }, { start: 1 }, { id: 'ev-1', start: Number.NaN }]) assert.equal(I.placed(stub), false);
});

test('a new event goes to the default calendar, or to one the user picks when there is none', () => {
    const calendars = [
        { id: 'c-work', account: 'Work', kind: 'google', name: 'Work', readOnly: false },
        { id: 'c-home', account: 'Home', kind: 'caldav', name: 'Home', readOnly: false },
        { id: 'c-feed', account: 'Holidays', kind: 'ics', name: 'Holidays', readOnly: true },
    ];
    const chosen = I.writableCalendars({ calendars, defaultCalendar: 'c-home' });
    assert.deepEqual(plain(chosen.list.map((c) => c.id)), ['c-work', 'c-home']);
    assert.equal(chosen.defaultId, 'c-home');
    // No default (nothing chosen, and no main calendar stands out): none is picked for the user.
    for (const defaultCalendar of [undefined, null, '', 'c-feed', 'c-gone']) assert.equal(I.writableCalendars({ calendars, defaultCalendar }).defaultId, '');
    const draft = I.draftFrom({ preset: { startDay: '2026-10-12', startTime: '09:00' }, state: { calendars }, zone: LA });
    assert.equal(draft.calendarId, '');
    assert.equal(I.draftFrom({ preset: { calendarId: 'c-work' }, state: { calendars }, zone: LA }).calendarId, 'c-work');
    assert.equal(I.draftFrom({ preset: {}, state: { calendars, defaultCalendar: 'c-work' }, zone: LA }).calendarId, 'c-work');
    // Saving asks for one, or, when none can be written, says so.
    const titled = { ...draft, title: 'Planning' };
    assert.deepEqual(plain(I.draftProblems(titled, 2)), { calendarId: 'Choose the calendar it goes to.' });
    assert.match(I.draftProblems(titled, 0).calendarId, /^There is no calendar that can be written/);
    assert.deepEqual(plain(I.draftProblems({ ...titled, calendarId: 'c-work' }, 2)), {});
    // A hidden calendar isn't offered for a new event, unless it's the default, the event's own, or all there is.
    const hidden = calendars.map((c) => (c.id === 'c-work' ? { ...c, hidden: true } : c));
    assert.deepEqual(plain(I.writableCalendars({ calendars: hidden }).list.map((c) => c.id)), ['c-home']);
    assert.deepEqual(plain(I.writableCalendars({ calendars: hidden, defaultCalendar: 'c-work' }).list.map((c) => c.id)), ['c-work', 'c-home']);
    assert.deepEqual(plain(I.writableCalendars({ calendars: hidden }, ['c-work']).list.map((c) => c.id)), ['c-work', 'c-home']);
    const allHidden = calendars.map((c) => ({ ...c, hidden: true }));
    assert.deepEqual(plain(I.writableCalendars({ calendars: allHidden }).list.map((c) => c.id)), ['c-work', 'c-home']);
    // Editing an event in a hidden calendar keeps that calendar in the choice.
    const inHidden = I.draftFrom({ occurrence: { id: 'ev-1', calendarId: 'c-work', title: 'Plan', allDay: true, startDay: '2026-10-12', lastDay: '2026-10-12' }, state: { calendars: hidden }, zone: LA });
    assert.equal(inHidden.calendarId, 'c-work');
});

test('an event dialog closed with changes not saved asks first: anything saving would keep, not the box to tell the guests alone', () => {
    const calendars = [{ id: 'c-work', account: 'Work', kind: 'google', name: 'Work', readOnly: false }, { id: 'c-home', account: 'Home', kind: 'caldav', name: 'Home', readOnly: false }];
    const state = { calendars, defaultCalendar: 'c-work' };
    const occurrence = {
        id: 'ev-1', eventId: 'ev-1', calendarId: 'c-work', title: 'Review', allDay: false, start: Date.parse('2026-10-12T16:00:00Z'), end: Date.parse('2026-10-12T17:00:00Z'),
        startLocal: '2026-10-12T09:00', endLocal: '2026-10-12T10:00', timeZone: LA, attendees: [{ email: 'ann@example.com', name: 'Ann' }], alarms: [10], busy: true,
        repeat: 'FREQ=WEEKLY;BYDAY=MO', recurring: true,
    };
    for (const initial of [
        I.draftFrom({ occurrence, state, zone: LA }),
        I.draftFrom({ occurrence, state, zone: LA, duplicate: true }),
        I.draftFrom({ preset: { startDay: '2026-10-12', startTime: '09:00' }, state, zone: LA }),
    ]) {
        const changed = (patch) => I.draftChanged(initial, { ...initial, ...patch });
        // As it opened, or only the box ticked, or a title with spaces around it: closed at once.
        assert.equal(I.draftChanged(initial, { ...initial }), false);
        assert.equal(changed({ notify: true }), false);
        assert.equal(changed({ title: ` ${initial.title} ` }), false);
        // Anything else saving would keep: asked first.
        for (const patch of [
            { title: 'Review (moved)' }, { startTime: '09:30' }, { endDay: '2026-10-13' }, { allDay: !initial.allDay }, { timeZone: BERLIN },
            { location: 'Room 4' }, { url: 'https://example.com/r' }, { description: 'Bring the plans.' }, { alarms: [30] },
            { guests: [...initial.guests, { email: 'bob@example.com' }] }, { busy: false }, { private: true }, { calendarId: 'c-home' },
            { repeat: { ...initial.repeat, mode: initial.repeat.mode === 'daily' ? 'weekly' : 'daily' } },
        ]) assert.equal(changed(patch), true, JSON.stringify(patch));
    }
});

test('after removing an account: DSH\'s access withdrawn, or the page to withdraw it on', () => {
    const google = { id: 'a-1', kind: 'google', name: 'ann@gmail.com' };
    const microsoft = { id: 'a-2', kind: 'microsoft', name: 'pat@outlook.com' };
    const caldav = { id: 'a-3', kind: 'caldav', name: 'Fastmail' };
    assert.deepEqual(plain(I.removalNotice(google, { revoked: true })), { toast: 'Removed ann@gmail.com. DSH\'s access was withdrawn at Google.' });
    // Google couldn't be reached: its page.
    const unreached = I.removalNotice(google, { revoked: false, manageUrl: 'https://myaccount.google.com/linkedapps' });
    assert.equal(unreached.toast, 'Removed ann@gmail.com.');
    assert.equal(unreached.manageUrl, 'https://myaccount.google.com/linkedapps');
    assert.match(unreached.text, /^Google couldn't be reached to withdraw DSH's access to ann@gmail\.com\./);
    // Microsoft: always its page, as an app can't withdraw its own access there.
    const ms = I.removalNotice(microsoft, { revoked: false, manageUrl: 'https://account.live.com/consent/Manage' });
    assert.equal(ms.manageUrl, 'https://account.live.com/consent/Manage');
    assert.match(ms.text, /^Microsoft doesn't let an app withdraw its own access/);
    // Neither: nothing more is said. A page only on https.
    assert.deepEqual(plain(I.removalNotice(caldav, {})), { toast: 'Removed Fastmail.' });
    assert.deepEqual(plain(I.removalNotice(caldav, undefined)), { toast: 'Removed Fastmail.' });
    assert.deepEqual(plain(I.removalNotice(microsoft, { manageUrl: 'http://account.live.com/consent/Manage' })), { toast: 'Removed pat@outlook.com.' });
    assert.deepEqual(plain(I.removalNotice(microsoft, { manageUrl: 'javascript:alert(1)' })), { toast: 'Removed pat@outlook.com.' });
});

test('a sign-in\'s way back to DSH, for the address to paste', () => {
    const ms = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A53122&response_type=code';
    assert.equal(I.returnAddress(ms), 'http://localhost:53122');
    const google = 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A4100%2F&client_id=y';
    assert.equal(I.returnAddress(google), 'http://127.0.0.1:4100');
    // Only an address on the computer DSH runs on.
    assert.equal(I.returnAddress('https://login.example.com/authorize?redirect_uri=https%3A%2F%2Fexample.com%2F'), '');
    assert.equal(I.returnAddress('not an address'), '');
    assert.equal(I.returnAddress(undefined), '');
});

test('a call\'s arguments for its card, as far as they have streamed', () => {
    assert.deepEqual({ ...I.callArgs({ argsRaw: '{"title":"Dentist","start":"2026-10-13T09:30","calendarId":"c"}' }) }, { title: 'Dentist', start: '2026-10-13T09:30' });
    assert.deepEqual({ ...I.callArgs({}, '{"title":"Dent') }, { title: 'Dent' });
    assert.deepEqual({ ...I.callArgs({ args: { text: (key) => (key === 'query' ? 'dentist' : undefined) } }) }, { query: 'dentist' });
    assert.equal(I.runningTitle('calendar_create_event', { title: 'Dentist', start: '2026-10-13T09:30' }).startsWith('Add “Dentist” at '), true);
    assert.equal(I.runningTitle('calendar_events', {}), 'Calendar for the week');
    // A move's card says where it went.
    assert.equal(I.doneTitle({ kind: 'moved', occurrence: { title: 'Team sync', calendar: 'Calendar' } }, {}, LA), 'Moved “Team sync” to Calendar');
    // Running or waiting for the user, a change names its event, found by the call's id.
    assert.deepEqual({ ...I.callArgs({ argsRaw: '{"id":"ev-1.20261013T093000","calendar_id":"c-2"}' }) }, { id: 'ev-1.20261013T093000', calendar_id: 'c-2' });
    assert.equal(I.runningTitle('calendar_update_event', {}, 'Lunch'), 'Change “Lunch”');
    assert.equal(I.runningTitle('calendar_update_event', { title: 'Brunch' }, 'Lunch'), 'Change “Lunch” to “Brunch”');
    assert.equal(I.runningTitle('calendar_update_event', { title: 'Brunch' }), 'Change event to “Brunch”');
    assert.equal(I.runningTitle('calendar_update_event', { calendar_id: 'c-2' }, 'Lunch', 'Work'), 'Move “Lunch” to Work');
    assert.equal(I.runningTitle('calendar_delete_event', {}, 'Lunch'), 'Delete “Lunch”');
    assert.equal(I.runningTitle('calendar_delete_event', {}), 'Delete event');
    assert.equal(I.runningTitle('calendar_respond', { answer: 'accepted' }, 'Offsite'), 'Answer “Offsite”: going');
    assert.equal(I.runningTitle('calendar_get_event', {}, 'Offsite'), 'Read “Offsite”');
});

test('a call that didn\'t work says what it didn\'t do, and why, without what it tells the agent', () => {
    assert.equal(I.failureText('Error: Not done: No event ev-1. Read the event again (calendar_get_event) and tell the user what changed before trying again.'), 'No event ev-1.');
    // The event changed meanwhile with nobody new ('changed', naming no one): the host's words for the user, the hint for the agent left out.
    const changedMeanwhile = 'The event changed on its server meanwhile (in another app, or by someone else), so nothing was done. Look at it again first.';
    assert.equal(I.failureText(`Error: Not done: ${changedMeanwhile} Read the event again (calendar_get_event) and tell the user what changed before trying again.`), changedMeanwhile);
    assert.equal(I.failureText('Error: Failed: Microsoft answered 503 (Service Unavailable)'), 'Microsoft answered 503 (Service Unavailable)');
    assert.equal(I.failureText('Not done: This would email an update to ann@example.com (Microsoft emails a meeting\'s guests about each change to it), so it\'s made only when they are to be told. '
        + 'If the user asked for them to be told, call again with notify_guests: true; otherwise ask the user first.'),
    'This would email an update to ann@example.com (Microsoft emails a meeting\'s guests about each change to it), so it\'s made only when they are to be told.');
    // A title in quotes is the user's, whatever it looks like.
    assert.equal(I.failureText('Not done: “team_sync” is in a calendar that can\'t be written.'), '“team_sync” is in a calendar that can\'t be written.');
    assert.equal(I.failureText(''), '');
    assert.equal(I.failureText('x'.repeat(500)).length, 400);
    // What it tells the agent to say to the user, or to ask, isn't for the user.
    assert.equal(I.failureText('Error: Not done: This event repeats: say scope "one" (this occurrence) or "all" (the series). Ask the user if they didn\'t say.'),
        'This event repeats: say scope "one" (this occurrence) or "all" (the series).');
    assert.equal(I.failureText('Error: Changing the user\'s calendars from chats is switched off in the calendar plugin\'s settings. Tell the user what you would change; they can do it on the Calendar page.'),
        'Changing the user\'s calendars from chats is switched off in the calendar plugin\'s settings.');
    // A move that stopped halfway: what was done, and what is left to do.
    const partly = 'Error: Done in part: It was copied to Work (invitations sent to ann@example.com), but not taken out of Home, which stopped: The server said no. '
        + 'Delete it from Home to finish the move; moving it again would make a second copy. Don\'t move it again: tell the user, and delete it from the calendar it came from only if they say so.';
    assert.equal(I.failureText(partly), 'It was copied to Work (invitations sent to ann@example.com), but not taken out of Home, which stopped: The server said no. '
        + 'Delete it from Home to finish the move; moving it again would make a second copy.');
    assert.deepEqual([I.saysPartly(partly), I.saysNotDone(partly), I.saysPartly('Error: Not done: no')], [true, true, false]);
    for (const text of ['Not done: no', 'Failed: timeout', 'Error: Failed: timeout', '  not done: x']) assert.equal(I.saysNotDone(text), true, text);
    for (const text of ['Added: Lunch', 'Changed.', '', undefined]) assert.equal(I.saysNotDone(text), false, String(text));
    assert.deepEqual(plain(I.NOT_DONE), { calendar_create_event: 'Not added', calendar_update_event: 'Not changed', calendar_delete_event: 'Not deleted', calendar_respond: 'Not answered' });
});

test('a chat call refused for its email says so in the window\'s words: who, why, and what to do', async () => {
    // The host's own words, as the tool gives them to the agent.
    const { refusalText } = await import('../lib/args.js');
    const { peopleWords } = await import('../lib/manager.js');
    const why = 'Microsoft emails a meeting\'s guests about each change to it';
    const refused = (what, to) => `Error: ${refusalText({ code: 'needs-notify', message: `This would email ${what} to ${peopleWords(to)} (${why}), so it's made only when they are to be told.` })}`;
    const twelve = Array.from({ length: 12 }, (_, i) => `p${i + 1}@example.com`);
    assert.equal(I.refusedEmailText('calendar_update_event', refused('an update', twelve)),
        `It would email an update to 12 guests (${why}). Ask again to send it, or change it in Calendar.`);
    assert.equal(I.refusedEmailText('calendar_update_event', refused('an update', ['ann@example.com', 'bob@example.com'])),
        `It would email an update to ann@example.com and bob@example.com (${why}). Ask again to send it, or change it in Calendar.`);
    assert.equal(I.refusedEmailText('calendar_create_event', refused('invitations', twelve.slice(0, 3))),
        `It would email invitations to p1@example.com, p2@example.com and p3@example.com (${why}). Ask again to send them, or add it in Calendar.`);
    assert.equal(I.refusedEmailText('calendar_delete_event', refused('a cancellation', twelve.slice(0, 6))),
        `It would email a cancellation to 6 guests (${why}). Ask again to send it, or delete it in Calendar.`);
    assert.equal(I.refusedEmailText('calendar_respond', refused('the answer', ['olga@example.com'])),
        `It would email the answer to olga@example.com (${why}). Ask again to send it, or answer it in Calendar.`);
    // Anything else is said as the host said it.
    for (const other of ['Error: Not done: No event ev-1.', '', undefined]) assert.equal(I.refusedEmailText('calendar_update_event', other), '');
});

test('a dragged event: a quarter hour at a time on the page\'s clock, its length kept', () => {
    const at = (iso) => Date.parse(iso);
    assert.equal(I.SNAP, 15);
    assert.deepEqual([I.snapTo(7), I.snapTo(8), I.snapTo(22), I.snapTo(23), I.snapTo(-8)], [0, 15, 15, 30, -15]);
    // 9:00–10:00 on Monday in Los Angeles, held at 9:30 and let go on Wednesday at 14:38: 14:15–15:15 (14:08, rounded).
    const ev = { id: 'e', start: at('2026-10-12T16:00:00Z'), end: at('2026-10-12T17:00:00Z') };
    const moved = I.movedTo(ev, LA, { day: '2026-10-12', minute: 570 }, { day: '2026-10-14', minute: 14 * 60 + 38 });
    assert.deepEqual(plain(moved), { start: at('2026-10-14T21:15:00Z'), end: at('2026-10-14T22:15:00Z') });
    // Over a clock change (Nov 1): the same time of day on the clock, an hour later in UTC.
    const saturday = { id: 's', start: at('2026-10-31T16:00:00Z'), end: at('2026-10-31T17:00:00Z') };
    assert.deepEqual(plain(I.movedTo(saturday, LA, { day: '2026-10-31', minute: 540 }, { day: '2026-11-02', minute: 540 })), { start: at('2026-11-02T17:00:00Z'), end: at('2026-11-02T18:00:00Z') });
    assert.deepEqual(plain(I.shiftedBy(saturday, LA, 2)), { start: at('2026-11-02T17:00:00Z'), end: at('2026-11-02T18:00:00Z') });
    // Its bottom edge: a new end on a quarter hour, a quarter hour after the start at least, on another day too.
    assert.deepEqual(plain(I.resizedTo(ev, LA, { day: '2026-10-12', minute: 680 })), { start: ev.start, end: at('2026-10-12T18:15:00Z') });
    assert.equal(I.resizedTo(ev, LA, { day: '2026-10-12', minute: 545 }).end, at('2026-10-12T16:15:00Z'));
    assert.equal(I.resizedTo(ev, LA, { day: '2026-10-13', minute: 60 }).end, at('2026-10-13T08:00:00Z'));
    // An all-day event moves by its days.
    const trip = { id: 't', allDay: true, startDay: '2026-10-09', lastDay: '2026-10-11', start: at('2026-10-09T07:00:00Z'), end: at('2026-10-12T07:00:00Z') };
    const later = I.shiftedBy(trip, LA, 3);
    assert.deepEqual([later.allDay, later.startDay, later.lastDay], [true, '2026-10-12', '2026-10-14']);
    assert.deepEqual(plain(I.coveredDays(later, LA)), ['2026-10-12', '2026-10-14']);
    assert.deepEqual(plain(I.coveredDays({ start: at('2026-10-13T06:00:00Z'), end: at('2026-10-13T08:00:00Z') }, LA)), ['2026-10-12', '2026-10-13']);
    // Shown at once where it went.
    assert.deepEqual([I.placedAt(ev, moved).start, I.placedAt(ev, moved).id], [moved.start, 'e']);
    assert.deepEqual([I.placedAt(trip, later).startDay, I.placedAt(trip, later).lastDay], ['2026-10-12', '2026-10-14']);
});

test('Alt and an arrow key: a quarter hour or a day a press, each from where the one before took it', () => {
    const at = (iso) => Date.parse(iso);
    // 9:00–10:00 on Friday, October 30 in Los Angeles.
    const ev = { id: 'e', start: at('2026-10-30T16:00:00Z'), end: at('2026-10-30T17:00:00Z') };
    assert.deepEqual(plain(I.keyedTo(ev, 'ArrowDown', LA)), { start: at('2026-10-30T16:15:00Z'), end: at('2026-10-30T17:15:00Z') });
    assert.deepEqual(plain(I.keyedTo(ev, 'ArrowUp', LA)), { start: at('2026-10-30T15:45:00Z'), end: at('2026-10-30T16:45:00Z') });
    // Twice: from where the first took it.
    const twice = I.keyedTo(I.placedAt(ev, I.keyedTo(ev, 'ArrowDown', LA)), 'ArrowDown', LA);
    assert.deepEqual(plain(twice), { start: at('2026-10-30T16:30:00Z'), end: at('2026-10-30T17:30:00Z') });
    // A day on, over the clock change (Nov 1) to Monday: 9:00 on the clock still.
    assert.deepEqual(plain(I.keyedTo(ev, 'ArrowRight', LA, { hideWeekends: true })), { start: at('2026-11-02T17:00:00Z'), end: at('2026-11-02T18:00:00Z') });
    assert.deepEqual(plain(I.keyedTo(ev, 'ArrowRight', LA)), { start: at('2026-10-31T16:00:00Z'), end: at('2026-10-31T17:00:00Z') });
    assert.deepEqual(plain(I.keyedTo(ev, 'ArrowLeft', LA)), { start: at('2026-10-29T16:00:00Z'), end: at('2026-10-29T17:00:00Z') });
    // In the all-day row, by days alone; any other key, nothing.
    const trip = { id: 't', allDay: true, startDay: '2026-10-09', lastDay: '2026-10-11', start: at('2026-10-09T07:00:00Z'), end: at('2026-10-12T07:00:00Z') };
    const on = I.keyedTo(trip, 'ArrowRight', LA, { byDays: true });
    assert.deepEqual([on.allDay, on.startDay, on.lastDay], [true, '2026-10-10', '2026-10-12']);
    assert.equal(I.keyedTo(trip, 'ArrowDown', LA, { byDays: true }), null);
    assert.equal(I.keyedTo(ev, 'Enter', LA), null);
    assert.ok(I.KEYS_PAUSE >= 1000 && I.KEYS_PAUSE <= 2000);
});

test('a drop\'s change for the host: instants for a timed event, days for an all-day one, nothing when it didn\'t move', () => {
    const at = (iso) => Date.parse(iso);
    const ev = { id: 'e', start: at('2026-10-12T16:00:00Z'), end: at('2026-10-12T17:00:00Z') };
    assert.equal(I.dropPatch(ev, { start: ev.start, end: ev.end }), undefined);
    assert.equal(I.dropPatch(ev, undefined), undefined);
    assert.deepEqual(plain(I.dropPatch(ev, { start: at('2026-10-14T21:15:00Z'), end: at('2026-10-14T22:15:00Z') })),
        { allDay: false, start: '2026-10-14T21:15:00.000Z', end: '2026-10-14T22:15:00.000Z' });
    const trip = { id: 't', allDay: true, startDay: '2026-10-09', lastDay: '2026-10-11', start: at('2026-10-09T07:00:00Z'), end: at('2026-10-12T07:00:00Z') };
    assert.deepEqual(plain(I.dropPatch(trip, I.shiftedBy(trip, LA, 3))), { allDay: true, start: '2026-10-12', end: '2026-10-14' });
    assert.equal(I.dropPatch(trip, I.shiftedBy(trip, LA, 0)), undefined);
    // What the consent helper hands back: notify only on the user's Send, approved only as a list.
    assert.deepEqual(plain(I.consentArgs(false)), {});
    assert.deepEqual(plain(I.consentArgs(true)), { notify: true });
    assert.deepEqual(plain(I.consentArgs({ notify: true, approved: ['ann@example.com'] })), { notify: true, approved: ['ann@example.com'] });
    assert.deepEqual(plain(I.consentArgs({ notify: false, approved: ['ann@example.com'] })), { approved: ['ann@example.com'] });
    assert.deepEqual(plain(I.consentArgs({ notify: 'yes', approved: 'ann@example.com' })), {});
    assert.deepEqual(plain(I.consentArgs(undefined)), {});
    // Only what the user may change drags: not a read-only calendar's, not someone else's invitation.
    assert.equal(I.canDrag(ev, { readOnly: false }), true);
    assert.equal(I.canDrag({ ...ev, organizer: { email: 'me@example.com' } }, undefined), true);
    assert.equal(I.canDrag({ ...ev, readOnly: true }, {}), false);
    assert.equal(I.canDrag(ev, { readOnly: true }), false);
    assert.equal(I.canDrag({ ...ev, invitation: true }, {}), false);
    assert.equal(I.canDrag({ ...ev, canRespond: true }, {}), false);
    assert.equal(I.canDrag(null, {}), false);
    // Who it reached, for the toast.
    assert.equal(I.movedWords({ emailed: { what: 'an update', to: ['ann@example.com'] } }), 'Emailed an update to ann@example.com.');
    assert.equal(I.movedWords({ reached: { how: 'change', to: ['ann@example.com', 'bob@example.com'] } }), 'Changed on the calendars of ann@example.com and bob@example.com, without emailing anyone.');
    assert.equal(I.movedWords({}), '');
    assert.equal(I.movedWords(undefined), '');
});

test('where Week and Day open: 7:30, or earlier for an earlier event; late in the day, before now', () => {
    assert.equal(I.openingMinute([]), 450);
    assert.equal(I.openingMinute(undefined), 450);
    assert.equal(I.openingMinute([{ minute: 420 }, { minute: 600 }]), 420);
    assert.equal(I.openingMinute([{ minute: 600 }]), 450);
    assert.equal(I.openingMinute([{ minute: 0 }]), 0);
    // After 15:00 on a day on show: four hours before now, unless an event still to come starts earlier.
    assert.equal(I.openingMinute([], 18 * 60, true), 14 * 60);
    assert.equal(I.openingMinute([{ minute: 13 * 60, upcoming: true }], 18 * 60, true), 13 * 60);
    assert.equal(I.openingMinute([{ minute: 9 * 60, upcoming: false }], 18 * 60, true), 14 * 60);
    assert.equal(I.openingMinute([], 10 * 60, true), 450);
    assert.equal(I.openingMinute([], 18 * 60, false), 450);
});

test('a drag\'s times on the user\'s clock, 12- or 24-hour as the locale writes them', () => {
    const format = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    const clock = (minutes) => format.format(Date.UTC(2000, 0, 3, 0, minutes));
    assert.equal(I.clockText(570), clock(570));
    assert.equal(I.clockRangeText(1380, 1440), `${clock(1380)} – ${clock(0)}`);
    const range = typeof format.formatRange === 'function' ? format.formatRange(Date.UTC(2000, 0, 3, 9, 30), Date.UTC(2000, 0, 3, 10, 30)) : `${clock(570)} – ${clock(630)}`;
    assert.equal(I.clockRangeText(570, 630), range);
});

test('what a search found, by day: still to come first, then the earlier ones, latest first', () => {
    const at = (iso) => Date.parse(iso);
    const now = at('2026-10-12T19:00:00Z'); // noon in Los Angeles
    const found = [
        { id: 'trip', allDay: true, startDay: '2026-10-11', lastDay: '2026-10-13', start: at('2026-10-11T07:00:00Z'), end: at('2026-10-14T07:00:00Z') },
        { id: 'a', start: at('2026-10-12T20:00:00Z'), end: at('2026-10-12T21:00:00Z') },
        { id: 'b', start: at('2026-10-12T22:00:00Z'), end: at('2026-10-12T23:00:00Z') },
        { id: 'c', start: at('2026-10-14T16:00:00Z'), end: at('2026-10-14T17:00:00Z') },
        { id: 'd', start: at('2026-10-10T16:00:00Z'), end: at('2026-10-10T17:00:00Z') },
        { id: 'e', start: at('2026-10-09T18:00:00Z'), end: at('2026-10-09T19:00:00Z') },
        { id: 'f', start: at('2026-10-09T16:00:00Z'), end: at('2026-10-09T17:00:00Z') },
        null,
    ];
    const groups = I.searchGroups(found, LA, now);
    const days = (list) => plain(list.map((g) => [g.day, g.list.map((o) => o.id)]));
    assert.deepEqual(days(groups.upcoming), [['2026-10-11', ['trip']], ['2026-10-12', ['a', 'b']], ['2026-10-14', ['c']]]);
    assert.deepEqual(days(groups.past), [['2026-10-10', ['d']], ['2026-10-09', ['e', 'f']]]);
    assert.deepEqual(plain(I.searchGroups(undefined, LA, now)), { upcoming: [], past: [] });
});

test('motion stops for the loading bar too, the view has its own tint, and one rule per note', () => {
    const css = I.CSS;
    assert.match(css, /body\.wp-still :is\([^)]*\) \*::after/);
    assert.match(css, /prefers-reduced-motion:reduce\)\{[^}]*\*::after/);
    assert.ok(css.includes('--cal-conv:rgba(10,13,12,calc(var(--wp-tint,.55) + .2))'));
    assert.ok(css.includes('.dshcal-main.dshcal-glass{background:var(--cal-conv)}'));
    assert.equal(css.match(/\.dshcal-note\{/g).length, 1);
    assert.equal(css.match(/\.dshcal-notice\{/g).length, 1);
});
