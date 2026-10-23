/**
 * The shapes every part of the plugin shares: an event as the plugin keeps
 * it (a record), whatever account it came from, and the small helpers that
 * read times. Sources (lib/sources/*) turn what a server sends into records
 * and records into what it takes; the manager stores, expands and changes
 * them; the tools and the window show them.
 *
 * @module dsh-plugin-calendar/model
 */
import { isDay, isZone, normalLocal, toInstant, toLocal } from './zones.js';

/**
 * A time. All-day: `{date: 'YYYY-MM-DD'}`. Timed: a wall-clock time and
 * its zone, `{local: 'YYYY-MM-DDTHH:MM:SS', tz}`, where `tz` is an IANA id,
 * 'UTC', or null for a floating time (read in the user's zone). ical.js
 * reads a zone a file defines itself as the IANA zone it matches.
 * @typedef {{date: string} | {local: string, tz: string|null}} Time
 */

/**
 * Someone on an event.
 * @typedef {object} Person
 * @property {string} email - an email address; for someone a CalDAV server names only by `address`
 *   (with no EMAIL parameter), that address.
 * @property {string} [address] - the calendar user address the server names them by, where it isn't
 *   their mailto address: a urn:uuid, or a principal's URL. Written back as it was.
 * @property {string} [name]
 * @property {'needs-action'|'accepted'|'declined'|'tentative'|'delegated'} [status]
 * @property {'required'|'optional'|'chair'|'non-participant'} [role]
 * @property {boolean} [self] - this is the account's own address.
 */

/**
 * An event as the plugin keeps it. A recurring series is one record with
 * `rrule` (and `rdates`, `exdates`); a changed occurrence of it is another
 * record with the same `uid` and `recurrenceId` set to the start it
 * replaces. One with `thisAndFuture` (iCalendar's
 * RECURRENCE-ID;RANGE=THISANDFUTURE) stands for every later occurrence too:
 * each moves by as much as it moved its own start, lasts as long as it does
 * and takes its fields, unless a changed occurrence of its own (or a later
 * `thisAndFuture` one) stands in for it. A source that hands over
 * occurrences one by one (Microsoft's calendar view, Apple's EventKit) gives
 * each one `recurrenceId` and `seriesRemoteId`, and the calendar is in
 * 'instances' mode.
 * @typedef {object} Record
 * @property {string} uid - iCalendar UID (Google's iCalUID, Microsoft's iCalUId).
 * @property {string} [remoteId] - the server's own id for this event, if it has one apart from its item.
 * @property {string} title
 * @property {string} [description] - plain text.
 * @property {string} [location]
 * @property {string} [url]
 * @property {Time} start
 * @property {Time} end - exclusive; all-day: the day after the last day.
 * @property {boolean} allDay
 * @property {'confirmed'|'tentative'|'cancelled'} [status]
 * @property {boolean} [busy] - shows as busy (iCalendar TRANSP:OPAQUE, the default).
 * @property {'public'|'private'|'confidential'} [privacy]
 * @property {Person} [organizer]
 * @property {Person[]} [attendees]
 * @property {number[]} [alarms] - reminders, in minutes before the start.
 * @property {string} [rrule] - the RRULE value: 'FREQ=WEEKLY;BYDAY=MO,WE'.
 * @property {Time[]} [rdates]
 * @property {Time[]} [exdates]
 * @property {Time} [recurrenceId] - on a changed occurrence: the start it replaces.
 * @property {boolean} [thisAndFuture] - on a changed occurrence: it changes the later occurrences too (above).
 * @property {string} [seriesRemoteId] - instances mode: the series' remote id.
 * @property {string} [conference] - a meeting link.
 * @property {boolean} [guestsMayChange] - Google: its guests may change it (guestsCanModify), so a guest's change is made for everyone on it.
 * @property {string[]} [categories]
 * @property {string} [created] - ISO time.
 * @property {string} [updated] - ISO time.
 * @property {number} [sequence]
 */

/**
 * What a server holds as one thing: a CalDAV resource (a file with a series
 * and its changed occurrences), a Google or Microsoft event. `raw` is the
 * iCalendar text for sources that speak iCalendar, kept so a change writes
 * back everything the plugin doesn't model.
 * @typedef {object} Item
 * @property {string} remoteId - CalDAV href, Google or Microsoft event id.
 * @property {string} [etag]
 * @property {string} [raw]
 * @property {Record[]} events
 */

/** An all-day time. */
export const onDay = (date) => ({ date });

/** A timed time from an instant, as the wall clock in a zone reads it. */
export const atInstant = (ms, tz) => ({ local: toLocal(ms, tz ?? 'UTC'), tz: tz ?? 'UTC' });

/** Whether a value is a Time this plugin can read. */
export function isTime(time) {
    if (time === null || typeof time !== 'object') return false;
    if ('date' in time) return isDay(time.date);
    return typeof time.local === 'string' && normalLocal(time.local) !== undefined && (time.tz === null || typeof time.tz === 'string');
}

/**
 * The instant a time starts at. A day starts at midnight in the zone given
 * (the user's). A floating time is read in that zone too.
 * @param {Time} time
 * @param {string|object} fallback - the user's zone.
 * @param {(tzid: string) => string|object|undefined} [zoneOf] - the record's own zones (VTIMEZONE), by TZID.
 */
export function instantOf(time, fallback, zoneOf) {
    if ('date' in time) return toInstant(`${time.date}T00:00:00`, fallback, fallback);
    return toInstant(time.local, resolveZone(time.tz, zoneOf), fallback);
}

/**
 * The zone a TZID stands for: an IANA id the runtime knows, else the file's
 * own definition, else null (read as floating).
 */
export function resolveZone(tz, zoneOf) {
    if (tz === null || tz === undefined || tz === '') return null;
    if (tz === 'UTC') return 'UTC';
    if (isZone(tz)) return tz;
    return zoneOf?.(tz) ?? null;
}

/**
 * Whether two times name the same moment: the same day, or timed ones at
 * the same instant (floating ones read as UTC on both sides).
 */
export function sameTime(a, b) {
    if (!a || !b) return !a && !b;
    if ('date' in a || 'date' in b) return 'date' in a && 'date' in b && a.date === b.date;
    return toInstant(a.local, a.tz ?? 'UTC', 'UTC') === toInstant(b.local, b.tz ?? 'UTC', 'UTC');
}

/** A time as the server's API takes an all-day date or a wall clock: for logs and tests. */
export function timeText(time) {
    if (!time) return '';
    if ('date' in time) return time.date;
    return `${time.local}${time.tz ? ` ${time.tz}` : ''}`;
}

/** An email address: something@somewhere, with no path or scheme in it. */
export const isEmailAddress = (value) => typeof value === 'string' && /^[^@\s/:]+@[^@\s/:]+$/.test(value);

/**
 * A calendar user address (RFC 5545 CAL-ADDRESS) in the form two of them
 * compare by, '' for none: an email, from a mailto address or as it is,
 * in lower case; a urn in lower case; a principal's URL or path by its
 * path alone, since a server names its principals at more than one host
 * (iCloud: caldav.icloud.com and pNN-caldav.icloud.com).
 */
export function addressKey(value) {
    const text = String(value ?? '').trim();
    if (text === '') return '';
    const decode = (s) => {
        try {
            return decodeURIComponent(s);
        } catch {
            return s;
        }
    };
    const mail = /^mailto:(.*)$/i.exec(text);
    if (mail) return decode(mail[1]).trim().toLowerCase();
    if (isEmailAddress(text) || /^urn:/i.test(text)) return text.toLowerCase();
    let path;
    if (/^https?:\/\//i.test(text)) {
        try {
            path = new URL(text).pathname;
        } catch {
            return text.toLowerCase();
        }
    } else if (text.startsWith('/')) {
        path = text.split(/[?#]/)[0];
    } else {
        return text.toLowerCase();
    }
    path = decode(path).replace(/\/+$/, '');
    return `path:${path}/`;
}

/** The fields a record may carry, for copying and comparing. */
export const RECORD_FIELDS = [
    'uid', 'remoteId', 'title', 'description', 'location', 'url', 'start', 'end', 'allDay', 'status', 'busy', 'privacy',
    'organizer', 'attendees', 'alarms', 'rrule', 'rdates', 'exdates', 'recurrenceId', 'thisAndFuture', 'seriesRemoteId', 'conference',
    'guestsMayChange', 'categories', 'created', 'updated', 'sequence',
];

/** A record without empty fields, so stored records compare equal when they mean the same. */
export function cleanRecord(record) {
    const out = {};
    for (const key of RECORD_FIELDS) {
        const value = record[key];
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value) && value.length === 0) continue;
        out[key] = value;
    }
    out.title = typeof out.title === 'string' ? out.title : '';
    out.allDay = 'date' in (out.start ?? {});
    // Only a changed occurrence reaches the ones after it.
    if (out.thisAndFuture !== true || out.recurrenceId === undefined) delete out.thisAndFuture;
    return out;
}

export const ATTENDEE_STATUSES = ['needs-action', 'accepted', 'declined', 'tentative', 'delegated'];
export const ATTENDEE_ROLES = ['required', 'optional', 'chair', 'non-participant'];
