/**
 * Occurrences: when events happen inside a window of time. A series is
 * expanded from its rule (recur.js) on the wall clock of its own zone, so a
 * 9:30 meeting in Berlin stays 9:30 in Berlin through daylight saving; its
 * RDATEs add times, its EXDATEs take them out, and its changed occurrences
 * (records with the same uid and a recurrenceId) replace the ones they name.
 * A changed occurrence made for "this and the following ones"
 * (`thisAndFuture`, iCalendar's RANGE=THISANDFUTURE) also stands for every
 * later one, as RFC 5545 has it: each moves by as much as it moved its own
 * start (on the series' wall clock), lasts as long as it does and shows its
 * fields; a later changed occurrence still stands for its own, and the
 * nearest such change before an occurrence is the one that holds.
 *
 * @module dsh-plugin-calendar/expand
 */
import { instantOf } from './model.js';
import { expandWall, parseRule } from './recur.js';
import { addDays, dayIn, daysBetween, toInstant, toLocal, wallMs, wallOf } from './zones.js';

const DAY = 86_400_000;

/**
 * One time an event happens.
 * @typedef {object} Occurrence
 * @property {import('./model.js').Record} record - what happens: the event, or the changed occurrence that stands in for this one.
 * @property {import('./model.js').Record} [series] - the series' own record, when the event repeats.
 * @property {import('./model.js').Time} [recurrenceId] - which occurrence of the series: its original start.
 * @property {number} start - epoch ms.
 * @property {number} end - epoch ms.
 * @property {boolean} allDay
 * @property {string} [startDay] - all-day: the first day, 'YYYY-MM-DD'.
 * @property {string} [endDay] - all-day: the day after the last.
 */

/** Whether [start, end) touches [from, to); an event without length counts at its start. */
const overlaps = (start, end, from, to) => start < to && (end > from || (end === start && start >= from));

/** The span of a record: epoch ms, and the days when it's all-day. */
function spanOf(record, zone) {
    if (record.allDay || 'date' in record.start) {
        const startDay = record.start.date ?? record.start.local.slice(0, 10);
        let endDay = record.end?.date ?? record.end?.local?.slice(0, 10) ?? addDays(startDay, 1);
        if (endDay <= startDay) endDay = addDays(startDay, 1);
        return { allDay: true, startDay, endDay, start: toInstant(`${startDay}T00:00:00`, zone, zone), end: toInstant(`${endDay}T00:00:00`, zone, zone) };
    }
    const start = instantOf(record.start, zone);
    const end = record.end && !('date' in record.end) ? Math.max(start, instantOf(record.end, zone)) : start;
    return { allDay: false, start, end };
}

/** A key that names an occurrence of a series by its original start. */
function keyOf(time, zone) {
    if ('date' in time) return `D${time.date}`;
    return `T${instantOf(time, zone)}`;
}

/**
 * Where an occurrence of a series falls, to order it against a "this and
 * following" change: the day (as wall-clock ms) in an all-day series, else
 * the instant.
 */
function orderOf(time, allDay, zone) {
    if (allDay) return wallMs(`${'date' in time ? time.date : time.local.slice(0, 10)}T00:00:00`);
    return 'date' in time ? toInstant(`${time.date}T00:00:00`, zone, zone) : instantOf(time, zone);
}

/** A time on the series' wall clock (zone `tz`), as wall-clock ms; a day is its midnight. */
function wallIn(time, tz, zone) {
    return 'date' in time ? wallMs(`${time.date}T00:00:00`) : wallMs(toLocal(instantOf(time, zone), tz));
}

/**
 * A "this and following" change as it reaches later occurrences: from
 * which one on, how far it moved its own start on the series' wall clock,
 * and how long it lasts.
 */
function rangeOf(record, allDay, tz, zone) {
    const own = spanOf(record, zone);
    return {
        record,
        from: orderOf(record.recurrenceId, allDay, zone),
        shift: wallIn(record.start, tz, zone) - wallIn(record.recurrenceId, tz, zone),
        allDay: own.allDay,
        days: own.allDay ? Math.max(1, daysBetween(own.startDay, own.endDay)) : 0,
        length: own.end - own.start,
    };
}

/** The "this and following" change that holds at an occurrence (ranges sorted by `from`), or undefined. */
function rangeAt(ranges, order) {
    for (let i = ranges.length - 1; i >= 0; i--) if (ranges[i].from < order) return ranges[i];
    return undefined;
}

/** An occurrence that starts at `wall` (on the series' wall clock) moved as a "this and following" change says. */
function movedBy(range, wall, tz, zone) {
    const at = wall + range.shift;
    if (range.allDay) {
        const startDay = wallOf(at).slice(0, 10);
        const endDay = addDays(startDay, range.days);
        return { allDay: true, startDay, endDay, start: toInstant(`${startDay}T00:00:00`, zone, zone), end: toInstant(`${endDay}T00:00:00`, zone, zone) };
    }
    const start = toInstant(wallOf(at), tz, zone);
    return { allDay: false, start, end: start + range.length };
}

/**
 * The wall-clock UNTIL of a rule in the series' zone: a DATE is the whole
 * day; a UTC time is read in the series' zone (the user's for all-day and
 * floating series), a local time as is.
 */
function untilWall(until, allDay, zone) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(until);
    if (m === null) return undefined;
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map((v) => Number(v ?? 0));
    if (m[4] === undefined) return Date.UTC(y, mo - 1, d, allDay ? 0 : 23, allDay ? 0 : 59, allDay ? 0 : 59);
    if (m[7] === undefined) return Date.UTC(y, mo - 1, d, h, mi, s);
    return wallMs(toLocal(Date.UTC(y, mo - 1, d, h, mi, s), zone));
}

/**
 * The occurrences of one event's records that overlap [from, to): a
 * single event, or a series with its changed occurrences (same uid). Records
 * of other uids are expanded on their own.
 * @param {import('./model.js').Record[]} records
 * @param {object} opts
 * @param {number} opts.from - epoch ms.
 * @param {number} opts.to - epoch ms.
 * @param {string} opts.zone - the user's zone: all-day and floating times are read in it.
 * @param {'masters'|'instances'} [opts.mode] - 'instances': every record is one occurrence already; rules aren't expanded.
 * @param {number} [opts.limit] - the most occurrences one series gives (default 5000).
 * @param {string[]} [opts.warnings] - rules that can't be read are said here.
 * @returns {Occurrence[]}
 */
export function occurrences(records, opts) {
    const { from, to, zone, mode = 'masters', limit = 5000, warnings } = opts;
    const byUid = new Map();
    for (const record of records) {
        const list = byUid.get(record.uid);
        if (list === undefined) byUid.set(record.uid, [record]);
        else list.push(record);
    }
    const out = [];
    const single = (record, extra = {}) => {
        if (record.status === 'cancelled') return;
        const span = spanOf(record, zone);
        if (overlaps(span.start, span.end, from, to)) out.push({ record, ...extra, ...span });
    };
    for (const group of byUid.values()) {
        const master = group.find((r) => r.recurrenceId === undefined);
        const changed = group.filter((r) => r.recurrenceId !== undefined);
        const repeats = master !== undefined && mode !== 'instances' && (master.rrule !== undefined || master.rdates?.length > 0);
        if (!repeats) {
            if (master !== undefined) single(master);
            for (const record of changed) single(record, { recurrenceId: record.recurrenceId });
            continue;
        }
        expandSeries(master, changed, { from, to, zone, limit, warnings, out, single });
    }
    return out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.end - b.end
        || String(a.record.title).localeCompare(String(b.record.title)));
}

function expandSeries(master, changed, { from, to, zone, limit, warnings, out, single }) {
    const allDay = master.allDay || 'date' in master.start;
    const tz = allDay ? zone : (master.start.tz ?? zone);
    const span = spanOf(master, zone);
    const days = allDay ? daysBetween(span.startDay, span.endDay) : 0;
    const length = span.end - span.start;
    // Changed occurrences stand in for the ones they name; each shows where it now is.
    const replaced = new Set();
    for (const record of changed) {
        replaced.add(keyOf(record.recurrenceId, tz));
        if (allDay && !('date' in record.recurrenceId)) replaced.add(`D${record.recurrenceId.local.slice(0, 10)}`);
        single(record, { series: master, recurrenceId: record.recurrenceId });
    }
    // "This and following" changes reach the occurrences after theirs, which may move into the window from outside it.
    const ranges = changed.filter((r) => r.thisAndFuture).map((r) => rangeOf(r, allDay, tz, zone)).sort((a, b) => a.from - b.from);
    let longest = Math.max(length, days * DAY);
    let ahead = 0;
    let behind = 0;
    for (const range of ranges) {
        longest = Math.max(longest, range.allDay ? range.days * DAY : range.length);
        ahead = Math.max(ahead, range.shift);
        behind = Math.max(behind, -range.shift);
    }
    const excluded = new Set();
    const excludedDays = new Set();
    for (const time of master.exdates ?? []) {
        excluded.add(keyOf(time, tz));
        if ('date' in time) excludedDays.add(time.date);
    }
    const skip = (key, startMs) => replaced.has(key) || excluded.has(key)
        || (!allDay && excludedDays.size > 0 && excludedDays.has(dayIn(startMs, tz)));
    const seen = new Set();
    let count = 0;
    const emit = (recurrenceId, key, startMs) => {
        if (seen.has(key) || skip(key, startMs)) return;
        seen.add(key);
        const range = ranges.length > 0 ? rangeAt(ranges, allDay ? orderOf(recurrenceId, true, zone) : startMs) : undefined;
        let occurrence;
        if (range !== undefined) {
            occurrence = movedBy(range, allDay ? orderOf(recurrenceId, true, zone) : wallMs(toLocal(startMs, tz)), tz, zone);
        } else if (allDay) {
            const startDay = recurrenceId.date;
            const endDay = addDays(startDay, days);
            occurrence = {
                start: toInstant(`${startDay}T00:00:00`, zone, zone), end: toInstant(`${endDay}T00:00:00`, zone, zone),
                allDay: true, startDay, endDay,
            };
        } else {
            occurrence = { start: startMs, end: startMs + length, allDay: false };
        }
        const record = range?.record ?? master;
        if (record.status !== 'cancelled' && overlaps(occurrence.start, occurrence.end, from, to)) {
            out.push({ record, series: master, recurrenceId, ...occurrence });
            count++;
        }
    };
    const startWall = wallMs(allDay ? `${span.startDay}T00:00:00` : master.start.local);
    if (master.rrule !== undefined) {
        let rule;
        try {
            rule = parseRule(master.rrule);
        } catch (error) {
            warnings?.push(`"${master.title || master.uid}" repeats by a rule that can't be read (${error.message}).`);
        }
        if (rule !== undefined) {
            const until = rule.until === undefined ? undefined : untilWall(rule.until, allDay, tz);
            // Start early enough to catch an occurrence that began before the window and runs into it.
            const reach = longest + ahead + DAY;
            const skipTo = wallMs(toLocal(from - reach, tz));
            const stop = wallMs(toLocal(to, tz)) + DAY + behind;
            try {
                for (const wall of expandWall(rule, startWall, { until, stop, skipTo })) {
                    if (wall > stop || count >= limit) break;
                    const local = wallOf(wall);
                    if (allDay) {
                        const date = local.slice(0, 10);
                        emit({ date }, `D${date}`, 0);
                    } else {
                        const startMs = toInstant(local, tz, zone);
                        emit({ local, tz: master.start.tz }, `T${startMs}`, startMs);
                    }
                }
            } catch (error) {
                warnings?.push(`"${master.title || master.uid}" repeats by a rule that can't be expanded (${error.message}).`);
            }
        }
    } else {
        // RDATEs alone: the start itself is the first occurrence.
        if (allDay) emit({ date: span.startDay }, `D${span.startDay}`, 0);
        else emit(master.start, keyOf(master.start, tz), span.start);
    }
    for (const time of master.rdates ?? []) {
        if (count >= limit) break;
        if (allDay) {
            const date = time.date ?? time.local.slice(0, 10);
            emit({ date }, `D${date}`, 0);
        } else if ('date' in time) {
            const local = `${time.date}T${master.start.local.slice(11)}`;
            const startMs = toInstant(local, tz, zone);
            emit({ local, tz: master.start.tz }, `T${startMs}`, startMs);
        } else {
            const startMs = instantOf(time, zone);
            emit(time, `T${startMs}`, startMs);
        }
    }
}

/**
 * Whether a series has an occurrence starting at a time (its original
 * start), looking at the rule, RDATEs and EXDATEs: to check a recurrenceId
 * before changing that occurrence.
 */
export function hasOccurrence(master, recurrenceId, zone) {
    const allDay = master.allDay || 'date' in master.start;
    const tz = allDay ? zone : (master.start.tz ?? zone);
    const at = 'date' in recurrenceId ? toInstant(`${recurrenceId.date}T00:00:00`, zone, zone) : instantOf(recurrenceId, zone);
    const found = occurrences([{ ...master, recurrenceId: undefined }], { from: at - DAY, to: at + 2 * DAY, zone, limit: 500 });
    return found.some((o) => (allDay ? o.startDay === (recurrenceId.date ?? recurrenceId.local.slice(0, 10)) : keyOf(o.recurrenceId, tz) === keyOf(recurrenceId, tz)));
}

/**
 * The record an occurrence of a series stands for when a "this and
 * following" change reaches it (and no change of its own does): a copy of
 * that change at the occurrence's own place (its start moved by as much as
 * the change moved its own, its length the change's), naming the
 * occurrence, without `thisAndFuture`. Undefined when no such change reaches
 * it. For a change to that occurrence alone.
 * @param {import('./model.js').Record[]} records - the series and its changed occurrences.
 * @param {import('./model.js').Time} recurrenceId - the occurrence: its original start.
 * @param {string} zone - the user's zone.
 * @returns {import('./model.js').Record|undefined}
 */
export function rangeRecord(records, recurrenceId, zone) {
    const master = records.find((r) => r.recurrenceId === undefined);
    if (master === undefined) return undefined;
    const allDay = master.allDay || 'date' in master.start;
    const tz = allDay ? zone : (master.start.tz ?? zone);
    const changed = records.filter((r) => r.recurrenceId !== undefined);
    if (changed.some((r) => keyOf(r.recurrenceId, tz) === keyOf(recurrenceId, tz))) return undefined;
    const ranges = changed.filter((r) => r.thisAndFuture).map((r) => rangeOf(r, allDay, tz, zone)).sort((a, b) => a.from - b.from);
    const range = rangeAt(ranges, orderOf(recurrenceId, allDay, zone));
    if (range === undefined) return undefined;
    const moved = movedBy(range, allDay ? orderOf(recurrenceId, true, zone) : wallIn(recurrenceId, tz, zone), tz, zone);
    const record = structuredClone(range.record);
    delete record.thisAndFuture;
    record.recurrenceId = recurrenceId;
    record.allDay = moved.allDay;
    if (moved.allDay) {
        record.start = { date: moved.startDay };
        record.end = { date: moved.endDay };
    } else {
        const own = range.record.start.tz ?? null;
        record.start = { local: toLocal(moved.start, own ?? zone), tz: own };
        record.end = { local: toLocal(moved.end, own ?? zone), tz: own };
    }
    return record;
}

export { keyOf as occurrenceKey };
