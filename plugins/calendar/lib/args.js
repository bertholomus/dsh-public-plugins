/**
 * A tool call's arguments as the manager takes them: times, the fields of
 * a change, which fields to empty, and which occurrences a change reaches.
 * The tools (tools.js) and the write gate (policy.js) read a call the same
 * way, so the gate's question describes what the tool would do.
 *
 * @module dsh-plugin-calendar/args
 */
import { CalendarError } from './manager.js';
import { addDays, dayIn, isDay, isZone, normalLocal, toInstant, toLocal } from './zones.js';

/** The fields calendar_update_event can empty (its `clear`). */
export const CLEARABLE = ['location', 'description', 'url', 'repeat'];

/** An optional text argument; an empty string counts as not given (some models send one for every field). */
export const given = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

/**
 * An instant from a tool argument: 'now', 'today', 'tomorrow', a day
 * (its midnight, or the next one with `end`), a wall clock in the user's
 * zone, or a time with Z or an offset.
 */
export function instantArg(value, zone, now, what, { end = false } = {}) {
    const text = String(value ?? '').trim();
    const lower = text.toLowerCase();
    if (lower === 'now') return now;
    if (lower === 'today' || lower === 'tomorrow' || lower === 'yesterday') {
        const shift = { today: 0, tomorrow: 1, yesterday: -1 }[lower] + (end ? 1 : 0);
        return toInstant(`${addDays(dayIn(now, zone), shift)}T00:00:00`, zone, zone);
    }
    if (isDay(text)) return toInstant(`${end ? addDays(text, 1) : text}T00:00:00`, zone, zone);
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
        const ms = Date.parse(text);
        if (Number.isFinite(ms)) return ms;
    }
    const local = normalLocal(text);
    if (local !== undefined) return toInstant(local, zone, zone);
    throw new CalendarError(`${what} "${text}" isn't a day (2026-10-12), a time (2026-10-12T09:30) or today/tomorrow.`);
}

/**
 * A start or end for a change, as the manager takes it: a day as is; a
 * wall clock read in `timeZone` when given, else in the user's zone (sent
 * with its offset, so an event in another zone stays in its own zone).
 */
export function timeArg(value, timeZone, zone) {
    const text = String(value ?? '').trim();
    if (text === '' || isDay(text) || timeZone || /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return text;
    const local = normalLocal(text);
    if (local === undefined) return text;
    const ms = toInstant(local, zone, zone);
    const offset = Math.round((Date.parse(`${toLocal(ms, zone)}Z`) - ms) / 60000);
    const sign = offset < 0 ? '-' : '+';
    const abs = Math.abs(offset);
    return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** The fields a create or update takes, from tool arguments. */
export function changeInput(args, zone) {
    const input = {};
    const tz = given(args.time_zone);
    if (tz !== undefined) {
        if (!isZone(tz) && tz !== 'UTC') throw new CalendarError(`"${tz}" isn't a time zone; use an IANA name like Europe/Berlin.`);
        input.timeZone = tz;
    }
    if (given(args.title) !== undefined) input.title = args.title;
    if (given(args.start) !== undefined) input.start = timeArg(args.start, tz, zone);
    if (given(args.end) !== undefined) input.end = timeArg(args.end, tz, zone);
    if (typeof args.all_day === 'boolean') input.allDay = args.all_day;
    for (const [from, to] of [['location', 'location'], ['description', 'description'], ['url', 'url'], ['repeat', 'repeat'], ['calendar_id', 'calendarId']]) {
        if (args[from] === null) input[to] = null;
        else if (given(args[from]) !== undefined) input[to] = args[from];
    }
    if (Array.isArray(args.reminders)) input.alarms = args.reminders;
    if (Array.isArray(args.guests)) input.attendees = args.guests;
    if (typeof args.busy === 'boolean') input.busy = args.busy;
    if (typeof args.private === 'boolean') input.privacy = args.private ? 'private' : 'public';
    for (const field of Array.isArray(args.clear) ? args.clear : []) if (CLEARABLE.includes(field)) input[field] = null;
    if (args.notify_guests === true) input.notify = true;
    if (args.drop_changes === true) input.dropChanges = true;
    return input;
}

/**
 * The scope a change to an event takes, from a call: 'all' for a single
 * event or a series named by its own id; for an occurrence of a repeating
 * event, the scope the call gives, and without one a refusal that tells the
 * model to ask (guessing would change more, or less, than the user meant).
 * Answers reach one occurrence or the series, never "following".
 */
export function scopeArg(manager, id, scope, { answer = false } = {}) {
    const s = given(scope);
    const at = manager.locate(id);
    if ((!at.series && !at.instance) || !at.recurrenceId) return 'all';
    if (answer) {
        if (s === undefined || s === 'following') throw new CalendarError('This event repeats: say scope "one" (this occurrence) or "all" (the series). Ask the user if they didn\'t say.');
        return s;
    }
    if (s === undefined) throw new CalendarError('This event repeats: say scope "one" (this occurrence), "following" (this and later ones) or "all" (the series). Ask the user if they didn\'t say.');
    return s;
}

/** What the model is told when a change would email people and the call didn't say to tell them. */
export const NOTIFY_HINT = 'If the user asked for them to be told, call again with notify_guests: true; otherwise ask the user first.';

/** What the model is told to do about a refusal, by its code. */
const HINTS = {
    'needs-notify': NOTIFY_HINT,
    'drops-changes': 'If the user agrees to lose them, call again with drop_changes: true; otherwise leave it where it is.',
    'choose-calendar': 'Give calendar_id (calendar_list_calendars lists the calendars), and ask the user which one if they didn\'t say.',
    changed: 'Read the event again (calendar_get_event) and tell the user what changed before trying again.',
    'half-moved': 'Don\'t move it again: tell the user, and delete it from the calendar it came from only if they say so.',
};

/** A refusal in words for the model: what wasn't done (or, for a move that stopped halfway, what was) and why, and what to do about it. */
export function refusalText({ message, code }) {
    return `${code === 'half-moved' ? 'Done in part' : 'Not done'}: ${message}${HINTS[code] ? ` ${HINTS[code]}` : ''}`;
}

