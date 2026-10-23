/**
 * Calendars kept in DSH only, in the plugin's own store: nothing
 * to sign in to and nothing to sync. Their events are iCalendar text like a
 * CalDAV server's, so moving one to a synced calendar keeps everything.
 *
 * @module dsh-plugin-calendar/sources/local
 */
import { createHash } from 'node:crypto';

export const kind = 'local';
export const style = 'ics';

/** A file name for an event: its uid when that's plain, else a hash of it. */
function fileName(uid) {
    return /^[A-Za-z0-9._@-]{1,120}$/.test(uid) ? `${uid}.ics` : `${createHash('sha256').update(uid).digest('hex').slice(0, 40)}.ics`;
}

const tagOf = (raw) => `"${createHash('sha256').update(raw).digest('hex').slice(0, 24)}"`;

export function create(account) {
    return {
        async calendars() {
            return (account.calendars ?? []).map((c) => ({ remoteId: c.remoteId, name: c.name, color: c.color }));
        },
        async sync(_calendar, state) {
            // The store is the calendar: nothing changes anywhere else.
            return { reset: false, items: [], removed: [], state: state ?? {} };
        },
        async put(_calendar, item, raw, uid) {
            return { remoteId: item?.remoteId ?? fileName(uid), etag: tagOf(raw) };
        },
        async remove() {},
    };
}
